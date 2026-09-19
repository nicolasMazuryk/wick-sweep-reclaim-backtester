import { describe, expect, it } from 'vitest';
import { type ExecutionConfig, ExecutionModel, type FundingSchedule, type Trade } from './execution.js';
import { FALLBACK_FUNDING_RATE, fundingAccrued } from './funding.js';
import type { LevelBookConfig } from './level-book.js';
import type { FrozenStats } from './stats.js';
import { LevelScript } from './testing/level-script.js';

const EXEC: ExecutionConfig = {
  latencyMs: 150, stopMode: 'client', exchangeLatencyMs: 30, SlipTicks: 1, SlipCoef: 0.05, FillWindow: 100,
  targetMode: 'sweepDepth', TargetMult: 2, StopMult: 1, RiskFraction: 0.0025, equity: 100_000, DailyLossLimit: 3,
  TakerFee: 0, MakerFee: 0,
};
const INST = { Tick: 1, LotSize: 1 };

interface SetupOptions {
  readonly level?: Partial<LevelBookConfig>;
  readonly mirror?: number;
  readonly frozen?: Partial<FrozenStats>;
  readonly Vol100ms?: number;
  readonly funding?: FundingSchedule;
}

// LevelScript stub stats: VolUnit 10, SpreadEst 1 (halfSpread 1), PivotReversal 12.
// Zero fees ⇒ roundTripCostTicks = 2·(SlipTicks + halfSpread) = 4, MinSweepDepth 8.
function setup(cfg: Partial<ExecutionConfig> = {}, o: SetupOptions = {}): LevelScript<ExecutionModel> {
  const Vol100ms = new Float64Array(24).fill(o.Vol100ms ?? 1000);
  return new LevelScript<ExecutionModel>(o.level ?? {}, {
    mirror: o.mirror,
    port: (ctx) => new ExecutionModel({ ...EXEC, ...cfg }, INST, o.funding ?? null, {
      get t() { return ctx.t; }, get frozen() { return ctx.frozen; }, Vol100ms,
    }),
  }, o.frozen ?? {});
}

// Upper level 1000 swept to 1010, confirmed at 997: SweepDepth 10, StopLoss 1011,
// Target 980. Sizing: g 0.7, E[Slippage] 3, RiskPerTrade 13 ⇒ Qty 13; fill
// Slippage = 1 + ceil(0.05·13·10/1000) = 2.
function armed(b: LevelScript<ExecutionModel>): number {
  const l = b.level(1000)!;
  b.prints(1005, 1010, 997);
  expect(b.state(l.levelId)).toBe('ORDER_ARMED');
  return l.levelId;
}

function onlyTrade(b: LevelScript<ExecutionModel>): Readonly<Trade> {
  expect(b.port.trades()).toHaveLength(1);
  return b.port.trades()[0]!;
}

describe('ExecutionModel — Trade carries the setup at the trigger (Spec §7.1, §9.4)', () => {
  it('PriorTouches, SweepCount, ReturnSpeed, regime, WickLevel / SweepExtreme; WickStrength_sweep refreshed at the exit', () => {
    const b = setup();
    b.level(1000, { PriorTouches: 2 });
    b.prints(1005, 1010, 997);
    b.print(999, 1, -1);                                  // trigger
    const l = b.book.byId(0)!;
    const tr = onlyTrade(b);
    expect(tr).toMatchObject({
      WickLevel: 1000, SweepExtreme: 1010, PriorTouches: 2, SweepCount: 1, ReturnSpeed: l.ReturnSpeed, ReturnImbalance: l.ReturnImbalance,
      regime: { TrendEfficiency: 0, TrendSign: 0, counterTrend: false },
    });
    expect(Number.isNaN(tr.WickStrength_sweep) && Number.isNaN(tr.RejectSpeed_sweep)).toBe(true);
    b.printAt(1000, 998);                                 // entry resolves
    l.WickStrength_sweep = 0.9;                           // §8.5 sweep leg registered during the trade
    b.print(1011, 1, 1);                                  // StopLoss
    expect(onlyTrade(b).WickStrength_sweep).toBe(0.9);
  });
});

describe('ExecutionModel — market fills (Spec §4.2)', () => {
  it('worst print on our aggressor side, minus half-spread and Slippage; partial fill = min(Qty, Σq)', () => {
    const b = setup();
    armed(b);
    b.print(999, 1, -1);                                  // trigger: FillTime +150, window to +250
    const trigger = b.ctx.seq;
    b.printAt(100, 990, 5, -1);                           // before FillTime: not in the window
    b.printAt(100, 996, 3, -1);                           // candidate
    b.printAt(20, 993, 4, 1);                             // buyer aggressor: not a candidate
    b.printAt(20, 998, 2, -1);                            // candidate
    expect(onlyTrade(b).entry).toBeNull();                // resolved only after the window elapses
    b.printAt(1000, 999);
    const tr = onlyTrade(b);
    expect(tr.Qty).toBe(13);
    expect(tr.entry).toMatchObject({
      FillPrice: 996 - 1 - 2, FilledQty: 5, halfSpread: 1, Slippage: 2, windowPrints: 3, noPrintFallback: false,
      inBurst: false, touchAndFly: false, touchAndReverse: false, fillT: b.ctx.t - 1000 - 40,
    });
    expect(tr.entry!.fillSeq).toBeGreaterThan(trigger);
    expect(b.port.counters.partialFills).toBe(1);
    expect(b.port.exitsLive(b.book.byId(0)!)).toBe(true);
  });

  it('A-36: a StopLoss crossed inside the entry fill window after the fill print closes the trade at that print', () => {
    const b = setup();
    armed(b);
    b.print(999, 1, -1);                                  // trigger: FillTime +150, window to +250
    b.printAt(160, 996, 3, -1);                           // fill print (worst candidate)
    const cross = b.printAt(20, 1011, 1, 1);              // StopLoss 1011 crossed, entry not yet resolved
    b.printAt(20, 1000, 1, 1);
    expect(onlyTrade(b).entry).toBeNull();
    b.printAt(1000, 999);                                 // resolves the entry; the stop was live on 1011
    const tr = onlyTrade(b);
    expect(tr.entry!.FillPrice).toBe(996 - 1 - 2);
    expect(tr.exitKind).toBe('stop');
    expect(tr.exitTriggerSeq).toBe(cross.seq);
    expect(tr.exit).not.toBeNull();
    expect(b.log).toContain('0: IN_TRADE → CLOSED (stop)');
  });

  it('A-36: prints before the fill print do not trigger exits', () => {
    const b = setup();
    armed(b);
    b.print(999, 1, -1);
    b.printAt(160, 1011, 1, 1);                           // before the fill print: exits not yet placed
    b.printAt(20, 996, 3, -1);                            // fill print
    b.printAt(1000, 999);
    expect(onlyTrade(b).exitKind).toBeNull();
  });

  it('Slippage rounds the size term up: SlipTicks + ceil(SlipCoef·Qty/Vol100ms·VolUnit_now)', () => {
    // Qty₀ 17.5 ⇒ E[Slippage] 1 + 1 + ceil(1.75) = 4, RiskPerTrade 14, Qty 12; fill: 10·12·10/1000 = 1.2 → 2.
    const b = setup({ SlipCoef: 10 });
    armed(b);
    b.print(999, 1, -1);
    b.printAt(200, 996, 20, -1);
    b.printAt(1000, 999);
    const tr = onlyTrade(b);
    expect([tr.Qty, tr.sizing.RiskPerTrade, tr.entry!.Slippage, tr.entry!.FillPrice, tr.entry!.FilledQty]).toEqual([12, 14, 3, 996 - 1 - 3, 12]);
  });

  it('burst at trigger (BurstFlag): FillWindow 300 ms and Slippage × 3', () => {
    const b = setup();
    armed(b);
    b.close({ BurstFlag: true });
    b.print(999, 1, -1);                                  // FillTime +150, window to +450
    b.printAt(400, 995, 2, -1);
    b.printAt(40, 999);
    expect(onlyTrade(b).entry).toBeNull();
    b.printAt(20, 999);                                   // +460: resolves
    const e = onlyTrade(b).entry!;
    expect([e.inBurst, e.Slippage, e.FillPrice]).toEqual([true, 6, 995 - 1 - 6]);
    expect(b.port.counters.fillsInBurst).toBe(1);
  });

  it('burst at trigger (print jump > 3·VolUnit_now from the previous print)', () => {
    const b = setup();
    armed(b);
    b.print(1003);
    b.print(972, 1, -1);                                  // jump 31 > 30 triggers the entry
    b.print(990);
    expect(onlyTrade(b).entry!.inBurst).toBe(true);
  });

  it('no print on our side in the window: last print − SpreadEst, FilledQty = Qty', () => {
    const b = setup();
    armed(b);
    b.print(999, 1, -1);
    const trigger = b.ctx.seq;
    b.print(1000);
    const e = onlyTrade(b).entry!;
    expect(e).toMatchObject({ FillPrice: 999 - 1 - 2, FilledQty: 13, noPrintFallback: true, halfSpread: 0, windowPrints: 0 });
    expect(e.fillSeq).toBe(trigger + 1);
    expect(b.port.counters.noPrintFallback).toBe(1);
  });

  it('touch-and-fly: a first print > 2·VolUnit_now beyond the trigger is a candidate, even before FillTime', () => {
    const b = setup();
    armed(b);
    b.print(999, 1, -1);
    b.printAt(50, 978, 1, 1);                             // 21 below the trigger, buyer aggressor
    b.printAt(1000, 985);
    const e = onlyTrade(b).entry!;
    expect([e.touchAndFly, e.FillPrice, e.FilledQty, e.noPrintFallback]).toEqual([true, 978 - 1 - 2, 1, false]);
    expect(b.port.counters.touchAndFly).toBe(1);
  });

  it('touch-and-fly is one-sided (A-89): a > 2·VolUnit_now jump in our favour is not a candidate', () => {
    const b = setup();
    armed(b);
    b.print(999, 1, -1);
    b.printAt(50, 1021, 1, 1);                            // 22 above the trigger: a better sell price
    b.printAt(1000, 1020);
    const e = onlyTrade(b).entry!;
    expect([e.touchAndFly, e.noPrintFallback]).toEqual([false, true]);
    expect(e.FillPrice).toBeLessThan(1021);
  });

  it('touchAndReverseMustFill: … 1001, 999 (trigger), 1015, 1016 fills at ≤ 999 − halfSpread − Slippage (L7)', () => {
    const b = setup();
    armed(b);
    b.print(1001);
    b.print(999, 1, -1);
    b.prints(1015, 1016);                                 // > WickLevel + PivotReversal = 1012
    const tr = onlyTrade(b);
    expect(tr.entry!.touchAndReverse).toBe(true);
    expect(tr.entry!.FillPrice).toBeLessThanOrEqual(999 - 1 - 2);
    expect(b.port.counters.touchAndReverse).toBe(1);
    expect(tr.exitKind).toBe('stop');                     // the reversal then stops the trade out
    expect(b.log).toContain('0: ORDER_ARMED → IN_TRADE (trigger)');
  });

  it('fillNeverOnTriggerPrint: latency 0 and same-ms prints — the trigger print is never a fill (L6, A-33)', () => {
    const b = setup({ latencyMs: 0 });
    armed(b);
    b.printAt(1000, 999, 50, -1);                         // trigger: the best price for a sell
    const trigger = b.ctx.seq;
    b.printAt(0, 998, 1, -1);                             // same ms, later seq: in the window
    b.printAt(0, 997, 1, 1);
    b.printAt(1000, 999);
    const e = onlyTrade(b).entry!;
    expect(e.fillSeq).toBe(trigger + 1);
    expect([e.FillPrice, e.FilledQty]).toEqual([998 - 1 - 2, 1]);
  });

  it('exchange-native stops: entry and stop latency = exchangeLatencyMs', () => {
    const b = setup({ stopMode: 'exchangeNative' });
    armed(b);
    b.print(999, 1, -1);
    b.printAt(40, 996, 1, -1);                            // +40 > FillTime +30: in the window
    b.printAt(1000, 999);
    const tr = onlyTrade(b);
    expect(tr.entry!.FillPrice).toBe(996 - 1 - 2);
    expect(tr.entry!.latencySplit).toEqual({ Latency: 30, ObsLatency: 0, DecisionLatency: 0, ExchangeLatency: 30, SendTime: tr.TriggerTime });
  });

  it('latencySplit (Spec §4.1): a client order records ObsLatency : DecisionLatency : ExchangeLatency = 0.4 : 0.3 : 0.3 and SendTime', () => {
    const b = setup({ latencyMs: 50 });
    armed(b);
    b.print(999, 1, -1);
    b.printAt(60, 996, 1, -1);
    b.printAt(1000, 999);
    const tr = onlyTrade(b);
    expect(tr.entry!.latencySplit).toEqual({ Latency: 50, ObsLatency: 20, DecisionLatency: 15, ExchangeLatency: 15, SendTime: tr.TriggerTime + 35 });
    b.print(978);                                         // Target 980: limit fill, no latency
    expect([tr.exitKind, tr.exit!.latencySplit]).toEqual(['target', null]);
  });
});

describe('ExecutionModel — exits (Spec §4.3)', () => {
  it('OCO is live only from the entry fill: a stop-level print while the entry is pending does nothing', () => {
    const b = setup();
    armed(b);
    b.print(999, 1, -1);
    b.printAt(50, 1012);                                  // ≥ StopLoss 1011, entry still pending
    expect(b.state(0)).toBe('IN_TRADE');
    expect(b.port.exitsLive(b.book.byId(0)!)).toBe(false);
    b.printAt(1000, 1000);                                // entry resolves; exits now live
    expect(b.state(0)).toBe('IN_TRADE');
    b.print(1011, 1, 1);                                  // stop triggers; market buy-back
    expect(b.port.flat()).toBe(false);                    // exit in flight
    b.printAt(200, 1013, 2, 1);
    b.printAt(1000, 1005);
    const tr = onlyTrade(b);
    expect([tr.exitKind, tr.exitRefPrice, tr.exit!.FillPrice]).toEqual(['stop', 1011, 1013 + 1 + 2]);
    expect(b.port.flat()).toBe(true);
    b.prints(970, 960);                                   // the Target leg of the OCO is gone
    expect(b.port.trades()).toHaveLength(1);
  });

  it('targetNotFilledOnTouch (L8): touch and one tick beyond do not fill; the next tick fills at Target with the maker fee', () => {
    const b = setup({ MakerFee: 0.0002, TakerFee: 0.0005 }, { level: { MaxUses: 1 } });
    // Taker fee raises roundTripCostTicks to ceil(2·0.0005·p + 4) = 5 at p ≈ 1000: MinSweepDepth 10.
    armed(b);
    b.print(999, 1, -1);
    b.print(1000);                                        // entry resolves: 999 − 1 − 2 = 996
    b.prints(980, 979);
    expect(b.state(0)).toBe('IN_TRADE');
    b.print(978);
    const tr = onlyTrade(b);
    expect([tr.exitKind, tr.exit!.FillPrice, tr.exit!.fillSeq]).toEqual(['target', 980, b.ctx.seq]);
    const unit = tr.FilledQty;
    const fees = 0.0005 * 996 * unit + 0.0002 * 980 * unit;
    expect(tr.pnl_ticks).toBeCloseTo(16 - fees / unit, 9);
    expect(tr.pnl_R).toBeCloseTo(tr.pnl_ticks / tr.sizing.RiskPerTrade, 12);
    expect(b.port.flat()).toBe(true);
  });

  it('targetMode market: fills on touch through the §4.2 market model with the taker fee', () => {
    const b = setup({ targetMode: 'market' }, { level: { targetMode: 'market' } });
    armed(b);
    b.print(999, 1, -1);
    b.print(1000);
    b.print(980, 1, 1);                                   // touch ⇒ market buy
    expect(onlyTrade(b).exit).toBeNull();
    b.printAt(200, 982, 3, 1);
    b.printAt(1000, 985);
    const tr = onlyTrade(b);
    expect([tr.exitKind, tr.exit!.FillPrice, tr.exit!.noPrintFallback]).toEqual(['target', 982 + 1 + 2, false]);
  });

  it('optimistic Target: Σq at Target > QueueProxy = 5·Vol100ms fills exitOpt; the primary path stays conservative', () => {
    const b = setup({}, { Vol100ms: 100 });               // QueueProxy 500; liquidity cap 50 does not bind
    armed(b);
    b.print(999, 1, -1);
    b.print(1000);
    b.print(980, 300);
    b.print(980, 201);                                    // Σq 501 > 500
    const opt = b.ctx.seq;
    b.print(1011);                                        // primary: stop
    b.print(1000);
    const tr = onlyTrade(b);
    expect([tr.exitKind, tr.exitOptKind, tr.exitOpt!.FillPrice, tr.exitOpt!.fillSeq, tr.targetQueueQ]).toEqual(['stop', 'targetOpt', 980, opt, 501]);
    expect(tr.pnlOpt_R).toBeGreaterThan(0);
    expect(tr.pnl_R).toBeLessThan(0);
  });

  it('without the queue proxy the alternate outcome equals the primary exit', () => {
    const b = setup();
    armed(b);
    b.print(999, 1, -1);
    b.print(1000);
    b.print(980, 50);
    b.print(1011);
    b.print(1000);
    const tr = onlyTrade(b);
    expect([tr.exitOptKind, tr.exitOpt, tr.pnlOpt_R]).toEqual([tr.exitKind, tr.exit, tr.pnl_R]);
  });

  it('realised RoundTripCost and BreakevenHitRate (Spec §4.4, A-37)', () => {
    const b = setup();
    armed(b);
    b.print(999, 1, -1);
    b.print(1000);                                        // entry 996 vs TriggerPrice 1000: 4 ticks
    b.print(1011);
    b.print(1000);                                        // exit 1011 + 1 + 2 = 1014 vs StopLoss 1011: 3 ticks
    const tr = onlyTrade(b);
    expect(tr.RoundTripCost_bps).toBeCloseTo((7 / 996) * 1e4, 9);
    expect(tr.BreakevenHitRate).toBeCloseTo((10 + 7) / 30, 9);
    expect(tr.pnl_ticks).toBe(996 - 1014);
  });
});

describe('ExecutionModel — target variants (Spec §6.5)', () => {
  // Entry: worst sell 996 − halfSpread 1 − Slippage 2 = 993, 13 lots.
  function entered(b: LevelScript<ExecutionModel>): Readonly<Trade> {
    armed(b);
    b.print(999, 1, -1);
    b.printAt(160, 996, 20, -1);
    b.printAt(1000, 995);
    const tr = onlyTrade(b);
    expect([tr.entry!.FillPrice, tr.FilledQty]).toEqual([993, 13]);
    return tr;
  }

  it('twoStage: 6 of 13 lots at Target1 (maker), stop moved to EntryFill, the other 7 closed by the stop; P&L over both legs', () => {
    const b = setup({ targetMode: 'twoStage' }, { level: { targetMode: 'twoStage' } });
    const tr = entered(b);
    expect([tr.Target1, tr.Target]).toEqual([990, 980]);
    b.print(988);                                         // < 990 − 1: first leg
    expect(tr.partial).toMatchObject({ FillPrice: 990, FilledQty: 6, Slippage: 0 });
    expect([tr.partialQty, b.book.byId(0)!.StopLoss]).toEqual([6, 993]);
    b.print(993, 1, 1);                                   // stop at EntryFill triggered
    b.printAt(160, 994, 5, 1);
    b.printAt(1000, 994);
    expect([tr.exitKind, tr.exit!.FilledQty, tr.exitRefPrice]).toEqual(['stop', 7, 993]);
    expect(tr.pnl_ticks).toBeCloseTo((6 * (993 - 990) + 7 * (993 - tr.exit!.FillPrice)) / 13, 12);
    expect(tr.pnl_R).toBeCloseTo(tr.pnl_ticks / tr.sizing.RiskPerTrade, 12);
    expect(b.port.counters.partialExits).toBe(1);
  });

  it('twoStage: a 1-lot position is not split (A-87)', () => {
    const b = setup({ targetMode: 'twoStage' }, { level: { targetMode: 'twoStage' } });
    armed(b);
    b.print(999, 1, -1);
    b.printAt(160, 996, 1, -1);                           // partial entry fill: 1 lot
    b.printAt(1000, 995);
    b.print(988);
    const tr = onlyTrade(b);
    expect([tr.FilledQty, tr.partial, b.book.byId(0)!.StopLoss, b.port.counters.twoStageUnsplit]).toEqual([1, null, 1011, 1]);
  });

  it('volUnit: Target = W − floor(TargetUnits·VolUnit_created); BreakevenHitRate uses that distance (A-37)', () => {
    const b = setup({ targetMode: 'volUnit' }, { level: { targetMode: 'volUnit', TargetUnits: 1.5 } });
    const tr = entered(b);
    expect(tr.Target).toBe(985);
    b.print(983);                                         // < 985 − 1
    expect([tr.exitKind, tr.exit!.FillPrice]).toEqual(['target', 985]);
    const costTicks = (tr.RoundTripCost_bps * 993) / 1e4;
    expect(tr.BreakevenHitRate).toBeCloseTo((10 + costTicks) / (15 + 10), 12);
  });
});

describe('ExecutionModel — kill switch (Spec §4.6)', () => {
  it('trips at −DailyLossLimit R of realised losses; resets on the next volumeDay', () => {
    // Each stop-out re-sweeps the reused level to its StopLoss; the exit-fill
    // print re-confirms and re-arms it (while the switch is off).
    const b = setup({}, { level: { MaxUses: 4 } });
    armed(b);
    const loseOnce = (): void => {
      b.print(999, 1, -1);
      b.print(1000);
      b.print(b.book.byId(0)!.StopLoss);
      b.print(1000);
    };
    loseOnce();
    b.print(997);
    loseOnce();
    expect(b.port.killSwitch.active).toBe(false);
    expect(b.state(0)).toBe('ORDER_ARMED');
    loseOnce();
    const lost = b.port.trades().reduce((sum, tr) => sum + tr.pnl_R, 0);
    expect(b.port.trades()).toHaveLength(3);
    expect(lost).toBeLessThanOrEqual(-3);
    expect(b.port.killSwitch.snapshot()).toMatchObject({ volumeDay: 0, active: true, trips: 1 });
    expect(b.port.counters.killSwitchTrips).toBe(1);
    expect(b.book.byId(0)!.State).toBe('SWEEP_CONFIRMED');
    expect(b.book.byId(0)!.suppressed).toBe('killSwitch');
    b.print(999, 1, -1);                                  // would have triggered
    expect(b.book.counters.tradesLostToKillSwitch).toBe(1);
    b.close({ volumeDay: 1 });
    b.print(1000);
    expect(b.port.killSwitch.active).toBe(false);
    expect(b.state(0)).toBe('SWEEP_CONFIRMED');           // reclaimed while suppressed: consumed (A-29)
    const extreme = b.book.byId(0)!.SweepExtreme;
    b.print(extreme + 1);                                     // re-sweep makes it eligible again
    b.print(extreme + 1 - 12);
    expect(b.state(0)).toBe('ORDER_ARMED');
  });

  it('a trip flattens the open trade at market and un-arms every armed order (→ SWEEP_CONFIRMED(killSwitch))', () => {
    const b = setup({}, { level: { MaxUses: 2 } });
    armed(b);
    b.print(999, 1, -1);
    b.print(1000);                                        // entry filled
    const lower = b.level(995, { side: -1 })!;            // swept to 985, confirmed at 997: arming blocked by the position
    b.prints(985, 997);
    expect(lower.suppressed).toBe('position');
    b.port.killSwitch.onTradeClosed(-3);                  // trips on a realised loss booked elsewhere
    b.print(1001, 1, -1);
    expect(b.log).toContain('0: IN_TRADE → CLOSED (killSwitch)');
    b.printAt(200, 1003, 2, 1);
    b.printAt(1000, 1000);
    expect(onlyTrade(b).exit!.FillPrice).toBe(1003 + 1 + 2);
    expect(lower.suppressed).toBe('killSwitch');
    expect(b.book.armed()).toEqual([]);
  });

  it('an armed order is pulled when the switch trips', () => {
    const b = setup();
    armed(b);
    b.port.killSwitch.onTradeClosed(-3);
    b.print(1002);
    expect(b.log.at(-1)).toBe('0: ORDER_ARMED → SWEEP_CONFIRMED (killSwitch)');
  });
});

describe('Funding (Spec §4.5)', () => {
  const H8 = 8 * 3_600_000;
  const recs = [{ t: H8, rate: 0.0001 }, { t: 2 * H8, rate: -0.0002 }, { t: 4 * H8, rate: 0.0003 }];

  it('[VERIFY] sign: a short (Side=+1) receives positive funding, a long pays it', () => {
    expect(fundingAccrued(1, 10_000, 0, H8, recs, H8)).toEqual({ cost: -1, missing: 0 });
    expect(fundingAccrued(-1, 10_000, 0, H8, recs, H8)).toEqual({ cost: 1, missing: 0 });
    expect(fundingAccrued(1, 10_000, H8, 2 * H8, recs, H8)).toEqual({ cost: 2, missing: 0 });   // short pays negative funding
  });

  it('settlements with entryT < tf ≤ exitT; a missing record charges 1 bp against the position (A-38)', () => {
    expect(fundingAccrued(1, 10_000, H8, H8 + 1, recs, H8)).toEqual({ cost: 0, missing: 0 });
    const r = fundingAccrued(-1, 10_000, H8 - 1, 4 * H8, recs, H8);   // H8, 2H8, 3H8 (missing), 4H8
    expect(r.missing).toBe(1);
    expect(r.cost).toBeCloseTo(1 - 2 + FALLBACK_FUNDING_RATE * 10_000 + 3, 12);
    expect(fundingAccrued(1, 10_000, H8 - 1, 4 * H8, recs, H8).cost).toBeCloseTo(-1 + 2 + 1 - 3, 12);
  });

  it('A-66: grid phased by the nearest record (KuCoin 04/12/20 UTC), ms-jittered stamps matched ±60 s', () => {
    const H4 = 4 * 3_600_000;
    const kucoin = [{ t: H4 + 7, rate: 0.0001 }, { t: H4 + H8 - 3, rate: 0.0002 }, { t: H4 + 2 * H8 + 59_000, rate: 0.0003 }];
    const r = fundingAccrued(-1, 10_000, 0, H4 + 2 * H8, kucoin, H8);
    expect(r).toEqual({ cost: 1 + 2 + 3, missing: 0 });
    expect(fundingAccrued(-1, 10_000, 0, H4 - 1, kucoin, H8)).toEqual({ cost: 0, missing: 0 });   // no 00:00 settlement
    const late = fundingAccrued(-1, 10_000, 0, H4 + H8, [{ t: H4, rate: 0.0001 }, { t: H4 + H8 + 61_000, rate: 0.0001 }], H8);
    expect(late.missing).toBe(1);                                                                 // > 60 s off: missing
  });

  it('A-38: no schedule at all ⇒ every 8 h settlement charged the fallback and counted', () => {
    const r = fundingAccrued(1, 10_000, 1, 3 * H8, [], H8);
    expect(r.missing).toBe(3);
    expect(r.cost).toBeCloseTo(3 * FALLBACK_FUNDING_RATE * 10_000, 12);
  });

  it('accrues on the trade between the entry and exit fills', () => {
    const b = setup({}, { funding: { records: [{ t: 1, rate: -0.01 }], intervalMs: 1 } });
    armed(b);
    b.print(999, 1, -1);
    b.print(1000);
    b.print(1011);
    b.print(1000);
    const tr = onlyTrade(b);
    const settlements = tr.exit!.fillT - tr.entry!.fillT;             // one per ms, only t = 1 recorded
    expect(tr.fundingMissing).toBe(settlements);
    expect(tr.fundingAccrued).toBeCloseTo(settlements * FALLBACK_FUNDING_RATE * 996 * tr.FilledQty, 6);
    expect(b.port.counters.fundingMissing).toBe(settlements);
  });
});

describe('ExecutionModel — Spec §11.3 test switches', () => {
  it('zeroCosts: fill = worst print (no half-spread, no Slippage), RoundTripCost_bps 0, cost floor never binds', () => {
    const b = setup({ zeroCosts: true, TakerFee: 0.0005, MakerFee: 0.0002 });
    expect(b.port.roundTripCostTicks(1000)).toBe(0);
    const levelId = armed(b);
    expect(b.book.byId(levelId)!.minSweepFloorBinding).toBe('mult');
    b.print(999, 1, -1);
    b.printAt(200, 996, 3, -1);
    b.printAt(1000, 1000);
    b.print(1011, 1, 1);                                  // stop triggers
    b.printAt(200, 1013, 2, 1);
    b.printAt(1000, 1000);
    const tr = onlyTrade(b);
    expect(tr.entry).toMatchObject({ FillPrice: 996, halfSpread: 0, Slippage: 0 });
    expect(tr.exit).toMatchObject({ FillPrice: 1013, halfSpread: 0, Slippage: 0 });
    expect([tr.sizing.ESlippage, tr.sizing.RiskPerTrade]).toEqual([0, 10]);
    expect([tr.RoundTripCost_bps, tr.fundingAccrued, tr.pnl_ticks]).toEqual([0, 0, 996 - 1013]);
    expect(tr.BreakevenHitRate).toBeCloseTo(1 / 3, 12);
  });

  it('zeroCosts: the no-print fallback fills at the last print', () => {
    const b = setup({ zeroCosts: true, latencyMs: 0 });
    armed(b);
    b.print(999, 1, 1);                                   // trigger; no seller print follows in the window
    b.print(1001);
    const e = onlyTrade(b).entry!;
    expect(e).toMatchObject({ FillPrice: 999, noPrintFallback: true, halfSpread: 0, Slippage: 0 });
  });

  it('targetOnTouch: the Target exits on touch (maker limit at Target); off by default', () => {
    for (const targetOnTouch of [false, true]) {
      const b = setup({ zeroCosts: true }, { level: { targetOnTouch } });
      armed(b);
      b.print(999, 1, -1);
      b.print(1000);                                      // entry resolves at 999; Target 980
      b.print(980);
      const tr = onlyTrade(b);
      if (!targetOnTouch) {
        expect([tr.exitKind, b.state(0)]).toEqual([null, 'IN_TRADE']);
        continue;
      }
      expect([tr.exitKind, tr.exit!.FillPrice, tr.exit!.fillSeq, b.state(0)]).toEqual(['target', 980, b.ctx.seq, 'RETIRED']);
    }
  });

  it('targetOnTouch: the stop is still checked first', () => {
    const b = setup({ zeroCosts: true }, { level: { targetOnTouch: true } });
    armed(b);
    b.print(999, 1, -1);
    b.print(1000);
    b.print(1011, 1, 1);
    expect(onlyTrade(b).exitKind).toBe('stop');
  });
});

describe('ExecutionModel — side symmetry (Spec §3.12)', () => {
  it('a mirrored script gives mirrored fills and identical P&L', () => {
    const run = (mirror?: number): ReadonlyArray<Readonly<Trade>> => {
      const b = setup({}, { mirror, Vol100ms: 100 });
      armed(b);
      b.print(999, 1, -1);
      b.printAt(200, 996, 3, -1);
      b.printAt(1000, 1000);
      b.print(980, 600);
      b.print(1011, 1, 1);
      b.printAt(160, 1013, 2, 1);
      b.printAt(1000, 1000);
      return b.port.trades();
    };
    const c = 5000;
    const m = (p: number): number => (p === -1 ? -1 : 2 * c - p);
    const up = run();
    const down = run(c);
    expect(up).toHaveLength(1);
    const [a, z] = [up[0]!, down[0]!];
    expect(z.Side).toBe(-a.Side);
    expect([z.TriggerPrice, z.triggerP, z.StopLoss, z.Target, z.exitRefPrice].map(m)).toEqual([a.TriggerPrice, a.triggerP, a.StopLoss, a.Target, a.exitRefPrice]);
    for (const k of ['entry', 'exit', 'exitOpt'] as const) {
      expect({ ...z[k]!, FillPrice: m(z[k]!.FillPrice) }).toEqual(a[k]);
    }
    expect([z.Qty, z.FilledQty, z.pnl_ticks, z.pnl_R, z.pnlOpt_R, z.exitKind, z.exitOptKind]).toEqual([a.Qty, a.FilledQty, a.pnl_ticks, a.pnl_R, a.pnlOpt_R, a.exitKind, a.exitOptKind]);
  });
});
