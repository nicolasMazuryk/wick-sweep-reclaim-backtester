import { hourOfDay } from './buckets.js';
import type { RunConfig, VenueId } from './config.js';
import { DEFAULT_FUNDING_INTERVAL_MS, type FundingRecord, fundingAccrued } from './funding.js';
import { assert, invariantFailed } from './invariant.js';
import type { ExecutionPort, ExitKind, LevelBookConfig } from './level-book.js';
import type { Level, RegimeAtArm } from './level.js';
import { ceilTicksConservative } from './numerics.js';
import { KillSwitch, type KillSwitchSnapshot, sizeOrder, type SizingResult } from './sizing.js';
import type { FrozenStats } from './stats.js';
import type { Lots, MergedEvent, Ms, Side, Ticks } from './types.js';

export interface ExecutionConfig {
  readonly latencyMs: Ms;
  readonly stopMode: 'client' | 'exchangeNative';
  readonly exchangeLatencyMs: Ms;
  readonly SlipTicks: Ticks;
  readonly SlipCoef: number;
  readonly FillWindow: Ms;                  // ×3 in a burst (§8.7)
  readonly targetMode: LevelBookConfig['targetMode'];
  readonly TargetMult: number;
  readonly StopMult: number;
  readonly RiskFraction: number;
  readonly equity: number;
  readonly DailyLossLimit: number;
  readonly TakerFee: number;
  readonly MakerFee: number;
  // Spec §11.3 synthetic paths: tests / `--synthetic` only (EngineTestOptions); never set from RunConfig.
  // Fees, half-spread, Slippage and funding are 0 (the no-print fallback fills at
  // the last print) and roundTripCostTicks is 0, so the cost floor never binds.
  readonly zeroCosts?: boolean;
}

export function executionConfigFrom(cfg: RunConfig, venue: VenueId): ExecutionConfig {
  const fees = cfg.fees[venue];
  return {
    latencyMs: cfg.latencyMs, stopMode: cfg.stopMode, exchangeLatencyMs: cfg.exchangeLatencyMs, SlipTicks: cfg.SlipTicks,
    SlipCoef: cfg.SlipCoef, FillWindow: cfg.FillWindow, targetMode: cfg.targetMode, TargetMult: cfg.TargetMult,
    StopMult: cfg.StopMult, RiskFraction: cfg.RiskFraction, equity: cfg.equity, DailyLossLimit: cfg.DailyLossLimit,
    TakerFee: fees.TakerFee, MakerFee: fees.MakerFee, zeroCosts: false,
  };
}

export interface ExecutionInstrument {
  readonly Tick: number;                    // quote currency per tick
  readonly LotSize: number;                 // base units per lot
}

export interface FundingSchedule {
  readonly records: ReadonlyArray<FundingRecord>;   // sorted by t
  readonly intervalMs: Ms;
}

// Read-only engine state: `t` of the print being processed, bucket statistics
// frozen at the last close (L5) and the hour-of-day Vol100ms profile (Spec §4.2.3).
export interface ExecutionContext {
  readonly t: Ms;
  readonly frozen: FrozenStats;
  readonly Vol100ms: ArrayLike<Lots>;
}

// Spec §4.2. `kind` adds `tickChange` (Spec §3.11, A-92) to the spec's list.
export type FillKind = 'entry' | 'stop' | 'time' | 'targetMarket' | 'kill' | 'tickChange';

export interface FillRequest {
  readonly side: Side; readonly ourAggressor: Side; readonly Qty: Lots; readonly triggerSeq: number;
  readonly TriggerTime: Ms; readonly FillTime: Ms; readonly kind: FillKind;
}

// Spec §4.1 latency of a market order: FillTime = TriggerTime + Latency; the
// split (client: latencySplit 0.4 : 0.3 : 0.3 of latencyMs; exchange-native
// stop: ExchangeLatency only) is recorded for the live comparison, SendTime =
// TriggerTime + ObsLatency + DecisionLatency.
export interface LatencyRecord {
  readonly Latency: Ms; readonly ObsLatency: Ms; readonly DecisionLatency: Ms; readonly ExchangeLatency: Ms; readonly SendTime: Ms;
}

export interface FillResult {
  readonly FillPrice: Ticks; readonly FilledQty: Lots; readonly fillSeq: number; readonly fillT: Ms;
  readonly windowPrints: number; readonly noPrintFallback: boolean; readonly touchAndReverse: boolean;
  readonly touchAndFly: boolean; readonly inBurst: boolean; readonly halfSpread: Ticks; readonly Slippage: Ticks;
  readonly latencySplit: LatencyRecord | null;   // null for limit fills (Target) and the tickChange exit
}

export type OptExitKind = ExitKind | 'targetOpt';

export interface Trade {
  readonly tradeId: number; readonly levelId: number; readonly Side: Side; readonly orderId: number;
  readonly TriggerPrice: Ticks; readonly triggerP: Ticks; readonly triggerSeq: number; readonly TriggerTime: Ms;
  readonly Qty: Lots; readonly sizing: SizingResult;
  readonly SweepDepth: Ticks; readonly StopLoss: Ticks; readonly Target: Ticks;
  readonly Target1: Ticks | -1;             // targetMode twoStage first-leg target (§6.5); −1 otherwise
  // Level state at the trigger (§9.4 breakdowns, Spec §7.1): a reused level (MaxUses > 1) resets them later.
  readonly WickLevel: Ticks; readonly SweepExtreme: Ticks; readonly PriorTouches: number; readonly SweepCount: number;
  readonly ReturnSpeed: number; readonly ReturnImbalance: number; readonly RejectSpeed_sweep: number;
  readonly regime: RegimeAtArm | null;
  WickStrength_sweep: number;               // §8.5; refreshed at the exit (the sweep pivot may resolve in the trade)
  entry: FillResult | null;
  FilledQty: Lots;
  partial: FillResult | null;               // twoStage first leg at Target1 (maker); null otherwise
  partialQty: Lots;                         // its size; the final exit closes FilledQty − partialQty
  exitKind: ExitKind | null;
  exitTriggerSeq: number;                   // print on which the exit triggered; −1 before
  exitRefPrice: Ticks | -1;                 // StopLoss / Target / exit trigger print
  exit: FillResult | null;
  exitOptKind: OptExitKind | null;          // alternate outcome with the optimistic Target (Spec §4.3.1)
  exitOpt: FillResult | null;
  targetQueueQ: Lots;                       // Σ q printed at Target since placement
  fundingAccrued: number;                   // quote currency, > 0 paid
  fundingMissing: number;
  pnl_ticks: number; pnl_bps: number; pnl_R: number; pnlOpt_R: number;
  RoundTripCost_bps: number;                // realised, Spec §4.4
  BreakevenHitRate: number;                 // general form (A-37)
}

interface PlannedOrder {
  readonly TriggerPrice: Ticks;
  readonly sizing: SizingResult;
}

// One market order waiting for its fill window to elapse (Spec §4.2.1),
// written in aggressor-normalised prices: the worst print for us is max(a·p).
interface PendingFill {
  readonly req: FillRequest;
  readonly latencySplit: LatencyRecord;
  readonly trade: Trade;
  readonly triggerP: Ticks;
  readonly windowEnd: Ms;
  readonly inBurst: boolean;
  readonly VolUnit_now: Ticks;
  readonly SpreadEst_t: Ticks;
  readonly reverseAbove: Ticks;             // Side·WickLevel + PivotReversal (entries)
  worstN: number;
  worstT: Ms;
  worstSeq: number;
  sumQ: Lots;
  windowPrints: number;
  lastP: Ticks;                             // last print at or before windowEnd
  sawNext: boolean;
  touchAndFly: boolean;
  checkedReverse: boolean;
  touchAndReverse: boolean;
  readonly window: MergedEvent[] | null;    // entries: prints up to windowEnd after the trigger (A-36 replay)
}

interface PnL { readonly ticks: number; readonly bps: number; readonly R: number; readonly costBps: number; readonly funding: number; readonly missing: number }

// Size still open: the final exit of a twoStage trade closes what the first leg left.
const openQty = (tr: Trade): Lots => tr.FilledQty - tr.partialQty;

// Spec §4.1 latencySplit ObsLatency : DecisionLatency : ExchangeLatency (not a RunConfig key, Spec §8.2).
const LATENCY_SPLIT = { ObsLatency: 0.4, DecisionLatency: 0.3, ExchangeLatency: 0.3 } as const;

const NO_PRINTS: ReadonlyArray<MergedEvent> = Object.freeze([]);

const QUEUE_PROXY_MULT = 5;
const TOUCH_AND_FLY_MULT = 2;
const BURST_JUMP_MULT = 3;
const BURST_MULT = 3;

export interface ExecutionSnapshot {
  readonly trades: Trade[];
  readonly counters: Record<string, number>;
  readonly pending: number;
  readonly openTradeId: number;
  readonly killSwitch: KillSwitchSnapshot;
}

// Spec §4: fills, exits, sizing, kill switch and funding behind LevelBook's
// ExecutionPort. `onPrint` is Spec §3.10 step 5 and runs before LevelBook
// (step 9), so a print that triggers an order is never its fill print (§9.5).
export class ExecutionModel implements ExecutionPort {
  readonly killSwitch: KillSwitch;
  private readonly orders = new Map<number, PlannedOrder>();
  private readonly pending: PendingFill[] = [];
  private readonly tradeLog: Trade[] = [];
  private readonly counterMap = new Map<string, number>();
  private readonly minQtyRefused = new Set<number>();
  private position: Trade | null = null;
  private nextOrderId = 0;
  private prevP: Ticks = NaN;               // print before the current one (burst jump)
  private curP: Ticks = NaN;
  private lastT: Ms = -Infinity;
  private lastSeq = -1;
  private lastQ: Lots = 0;
  private lastS: Side = 1;
  private lastN = 0;
  // Entry-window prints after the entry fill print, seen before the fill
  // resolved: LevelBook checks StopLoss / Target on them (A-36).
  private afterEntryFill: MergedEvent[] = [];
  private afterEntryFillTaken = true;

  constructor(
    private readonly cfg: ExecutionConfig,
    private instrument: ExecutionInstrument,
    private readonly funding: FundingSchedule | null,
    private readonly ctx: ExecutionContext,
  ) {
    this.killSwitch = new KillSwitch(cfg.DailyLossLimit);
  }

  trades(): ReadonlyArray<Readonly<Trade>> { return this.tradeLog; }

  get counters(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of [...this.counterMap.keys()].sort()) out[key] = this.counterMap.get(key)!;
    return out;
  }

  // ---------------------------------------------------------------- per print (Spec §3.10 step 5)

  onPrint(e: MergedEvent): void {
    this.killSwitch.sync(this.ctx.frozen.volumeDay);
    this.feed(e);
    this.trackOptimisticTarget(e);
    this.prevP = this.curP;
    this.curP = e.p;
    this.lastT = e.t;
    this.lastSeq = e.seq;
    this.lastQ = e.q;
    this.lastS = e.s;
    this.lastN = e.n;
  }

  private feed(e: MergedEvent): void {
    for (let i = 0; i < this.pending.length;) {
      const f = this.pending[i]!;
      const r = this.advance(f, e);
      if (r === null) { i++; continue; }
      this.pending.copyWithin(i, i + 1);                                  // splice(i, 1) without its result array
      this.pending.length--;
      this.complete(f, r);
    }
  }

  // Resolves every fill still waiting at the end of the stream from the prints
  // seen so far; the fill is stamped one seq after the last print.
  finish(): void {
    while (this.pending.length > 0) {
      const f = this.pending.shift()!;
      this.complete(f, this.resolve(f, null));
    }
  }

  // Spec §4.2.1 for one print. Returns the fill once `e` lies beyond the window.
  private advance(f: PendingFill, e: MergedEvent): FillResult | null {
    const a = f.req.ourAggressor;
    let joined = false;
    if (!f.sawNext) {
      // Touch-and-fly (§8.7): the print after the trigger jumps > 2·VolUnit_now
      // against us ⇒ it is a fill candidate. A jump in our favour is not (A-89:
      // Spec §4.2.1 writes |n.p − p|, but it would fill better than the trigger print).
      f.sawNext = true;
      if (a * (e.p - f.triggerP) > TOUCH_AND_FLY_MULT * f.VolUnit_now) {
        f.touchAndFly = true;
        joined = true;
        this.candidate(f, e);
      }
    }
    const after = e.t > f.req.FillTime || (e.t === f.req.FillTime && e.seq > f.req.triggerSeq);   // A-33
    if (after && !f.checkedReverse) {
      f.checkedReverse = true;
      if (f.req.kind === 'entry') f.touchAndReverse = f.req.side * e.p > f.reverseAbove;
    }
    if (e.t > f.windowEnd) return this.resolve(f, e);
    f.window?.push({ t: e.t, seq: e.seq, p: e.p, q: e.q, s: e.s, n: e.n });
    f.lastP = e.p;
    if (after) {
      f.windowPrints++;
      if (e.s === a && !joined) this.candidate(f, e);
    }
    return null;
  }

  private candidate(f: PendingFill, e: MergedEvent): void {
    const n = f.req.ourAggressor * e.p;
    if (n > f.worstN) {
      f.worstN = n;
      f.worstT = e.t;
      f.worstSeq = e.seq;
    }
    f.sumQ += e.q;
  }

  // Worst candidate ∓ (halfSpread + Slippage), or the no-print fallback
  // last ∓ SpreadEst. `at` is the first print beyond the window (null at finish()).
  private resolve(f: PendingFill, at: MergedEvent | null): FillResult {
    const { req } = f;
    const a = req.ourAggressor;
    let Slippage = this.slippage(req.Qty, f.VolUnit_now, req.FillTime);
    if (f.inBurst) Slippage *= BURST_MULT;
    const noPrintFallback = f.worstN === -Infinity;
    const zero = this.cfg.zeroCosts === true;
    const halfSpread = noPrintFallback || zero ? 0 : Math.ceil(f.SpreadEst_t / 2);
    const base = noPrintFallback ? f.lastP + (zero ? 0 : a * f.SpreadEst_t) : a * f.worstN;
    const FillPrice = base + a * (halfSpread + Slippage);
    // Exits fill in full (the position is closed at the worst price); only an
    // entry can be partial, its remainder cancelled at the window end (Spec §4.3.3).
    const FilledQty = noPrintFallback || req.kind !== 'entry' ? req.Qty : Math.min(req.Qty, f.sumQ);
    const fillSeq = noPrintFallback ? (at?.seq ?? this.lastSeq + 1) : f.worstSeq;
    const fillT = noPrintFallback ? (at?.t ?? Math.max(this.lastT, req.FillTime)) : f.worstT;
    if (!(fillSeq > req.triggerSeq)) invariantFailed(`ExecutionModel: fill seq ${fillSeq} on or before trigger seq ${req.triggerSeq} (L6)`);
    assert(noPrintFallback || a * FillPrice >= f.worstN + halfSpread, 'ExecutionModel: FillPrice better than a candidate ∓ halfSpread (L6)');
    if (noPrintFallback) this.bump('noPrintFallback');
    if (FilledQty < req.Qty) this.bump('partialFills');
    if (f.inBurst) this.bump('fillsInBurst');
    if (f.touchAndFly) this.bump('touchAndFly');
    if (f.touchAndReverse) this.bump('touchAndReverse');
    return {
      FillPrice, FilledQty, fillSeq, fillT, windowPrints: f.windowPrints, noPrintFallback,
      touchAndReverse: f.touchAndReverse, touchAndFly: f.touchAndFly, inBurst: f.inBurst, halfSpread, Slippage, latencySplit: f.latencySplit,
    };
  }

  // SlipTicks + ceil(SlipCoef·(Qty/Vol100ms[h])·VolUnit_now), h = hour of FillTime (Spec §4.2.1).
  private slippage(Qty: Lots, VolUnit_now: Ticks, FillTime: Ms): Ticks {
    if (this.cfg.zeroCosts) return 0;
    const v = Math.max(1, this.ctx.Vol100ms[hourOfDay(FillTime)] ?? 1);
    return this.cfg.SlipTicks + ceilTicksConservative((this.cfg.SlipCoef * Qty * VolUnit_now) / v);
  }

  private complete(f: PendingFill, r: FillResult): void {
    const tr = f.trade;
    if (f.req.kind === 'entry') {
      tr.entry = r;
      tr.FilledQty = r.FilledQty;
      this.afterEntryFill = f.window!.filter((b) => b.seq > r.fillSeq);
      this.afterEntryFillTaken = false;
      return;
    }
    tr.exit = r;
    this.close(tr);
  }

  // Optimistic Target (§7.3, A-35): Σ q at p == Target after placement > QueueProxy
  // before the primary exit triggers ⇒ the alternate outcome exits at Target.
  private trackOptimisticTarget(e: MergedEvent): void {
    const tr = this.position;
    if (tr === null || tr.entry === null || tr.exitKind !== null || tr.exitOpt !== null || e.p !== tr.Target) return;
    tr.targetQueueQ += e.q;
    const QueueProxy = QUEUE_PROXY_MULT * Math.max(1, this.ctx.Vol100ms[hourOfDay(e.t)] ?? 1);
    if (tr.targetQueueQ > QueueProxy) {
      tr.exitOptKind = 'targetOpt';
      tr.exitOpt = this.limitFill(tr, e);
    }
  }

  private limitFill(tr: Trade, e: MergedEvent): FillResult {
    return {
      FillPrice: tr.Target, FilledQty: openQty(tr), fillSeq: e.seq, fillT: e.t, windowPrints: 0, noPrintFallback: false,
      touchAndReverse: false, touchAndFly: false, inBurst: false, halfSpread: 0, Slippage: 0, latencySplit: null,
    };
  }

  // ---------------------------------------------------------------- ExecutionPort

  // Ex-ante Spec §4.4 cost in ticks at price p: taker fee on both legs plus
  // SlipTicks + halfSpread per leg.
  roundTripCostTicks(p: Ticks): Ticks {
    if (this.cfg.zeroCosts) return 0;
    const halfSpread = Math.ceil(this.ctx.frozen.SpreadEst_t / 2);
    return ceilTicksConservative(2 * this.cfg.TakerFee * p + 2 * (this.cfg.SlipTicks + halfSpread));
  }

  arm(level: Readonly<Level>, TriggerPrice: Ticks, MinStrength: number): number {
    const f = this.ctx.frozen;
    const zero = this.cfg.zeroCosts === true;               // E[Slippage] = 0 ⇒ RiskPerTrade = SweepDepth
    const sizing = sizeOrder({
      WickStrength: level.WickStrength, MinStrength, SweepDepth: level.SweepDepth, counterTrend: level.sizeHalved,
      SpreadEst_t: zero ? 0 : f.SpreadEst_t, VolUnit_now: f.VolUnit_now, Vol100ms: Math.max(1, this.ctx.Vol100ms[hourOfDay(this.ctx.t)] ?? 1),
      Tick: this.instrument.Tick, LotSize: this.instrument.LotSize, RiskFraction: this.cfg.RiskFraction,
      equity: this.cfg.equity, SlipTicks: zero ? 0 : this.cfg.SlipTicks, SlipCoef: zero ? 0 : this.cfg.SlipCoef,
    });
    if (sizing.caps.minQty) {
      if (!this.minQtyRefused.has(level.levelId)) this.bump('capMinQty');
      this.minQtyRefused.add(level.levelId);
      return -1;
    }
    this.minQtyRefused.delete(level.levelId);
    const id = this.nextOrderId++;
    this.orders.set(id, { TriggerPrice, sizing });
    return id;
  }

  cancelEntry(level: Readonly<Level>): void {
    this.orders.delete(level.OrderIds.entry);
  }

  // Bookkeeping only: the new StopLoss is read from the level at the trigger;
  // Qty stays as sized at arming.
  replaceStop(level: Readonly<Level>): void {
    if (!this.orders.has(level.OrderIds.entry)) invariantFailed(`ExecutionModel.replaceStop: level ${level.levelId} has no live entry`);
    this.bump('stopReplaced');
  }

  enter(level: Readonly<Level>, e: MergedEvent): number {
    if (this.position !== null) invariantFailed(`ExecutionModel.enter: level ${level.levelId} while trade ${this.position.tradeId} is open (onePositionPerSymbol)`);
    const orderId = level.OrderIds.entry;
    const order = this.orders.get(orderId);
    if (order === undefined) invariantFailed(`ExecutionModel.enter: level ${level.levelId} has no armed order`);
    this.orders.delete(orderId);
    const side = level.Side;
    const { sizing } = order;
    const tr: Trade = {
      tradeId: this.tradeLog.length, levelId: level.levelId, Side: side, orderId, TriggerPrice: order.TriggerPrice,
      triggerP: e.p, triggerSeq: e.seq, TriggerTime: e.t, Qty: sizing.Qty, sizing,
      SweepDepth: level.SweepDepth, StopLoss: level.StopLoss, Target: level.Target, Target1: level.Target1,
      WickLevel: level.WickLevel, SweepExtreme: level.SweepExtreme, PriorTouches: level.PriorTouches, SweepCount: level.SweepCount,
      ReturnSpeed: level.ReturnSpeed, ReturnImbalance: level.ReturnImbalance, RejectSpeed_sweep: level.RejectSpeed_sweep,
      regime: level.regimeAtArm && { ...level.regimeAtArm }, WickStrength_sweep: level.WickStrength_sweep,
      entry: null, FilledQty: 0, partial: null, partialQty: 0, exitKind: null, exitTriggerSeq: -1, exitRefPrice: -1, exit: null, exitOptKind: null, exitOpt: null,
      targetQueueQ: 0, fundingAccrued: 0, fundingMissing: 0,
      pnl_ticks: NaN, pnl_bps: NaN, pnl_R: NaN, pnlOpt_R: NaN, RoundTripCost_bps: NaN, BreakevenHitRate: NaN,
    };
    this.tradeLog.push(tr);
    this.position = tr;
    if (sizing.caps.g) this.bump('capG');
    if (sizing.caps.counterTrendHalved) this.bump('capCounterTrend');
    if (sizing.caps.liquidityCap) this.bump('capLiquidity');
    this.queue(tr, 'entry', (-side) as Side, sizing.Qty, e, this.cfg.stopMode === 'exchangeNative', side * level.WickLevel + this.ctx.frozen.PivotReversal);
    return tr.tradeId;
  }

  exit(level: Readonly<Level>, kind: ExitKind, e: MergedEvent): void {
    const tr = this.position;
    if (!(tr !== null && tr.levelId === level.levelId)) invariantFailed(`ExecutionModel.exit: level ${level.levelId} has no open trade`);
    if (tr.exitKind !== null) invariantFailed(`ExecutionModel.exit: trade ${tr.tradeId} already exiting`);
    tr.exitKind = kind;
    tr.exitTriggerSeq = e.seq;
    tr.WickStrength_sweep = level.WickStrength_sweep;
    const side = tr.Side;
    if (kind === 'tickChange') {
      // Prints after a tick-size change are in another tick unit: every open
      // fill resolves now from the prints seen, the exit at the last print ± (SpreadEst + Slippage).
      for (const f of this.pending.splice(0)) this.complete(f, this.resolve(f, e));
      tr.exitRefPrice = this.curP;
      const Slippage = this.slippage(openQty(tr), this.ctx.frozen.VolUnit_now, e.t);
      const spread = this.cfg.zeroCosts ? 0 : this.ctx.frozen.SpreadEst_t;
      tr.exit = {
        FillPrice: this.curP + side * (spread + Slippage), FilledQty: openQty(tr), fillSeq: e.seq, fillT: e.t,
        windowPrints: 0, noPrintFallback: true, touchAndReverse: false, touchAndFly: false, inBurst: false, halfSpread: 0, Slippage,
        latencySplit: null,
      };
      this.close(tr);
      return;
    }
    if (tr.entry === null) invariantFailed(`ExecutionModel.exit: trade ${tr.tradeId} exits before its entry fill (exits are not live)`);
    if (kind === 'target' && this.cfg.targetMode !== 'market') {
      tr.exitRefPrice = tr.Target;
      tr.exit = this.limitFill(tr, e);                                        // conservative rule: at Target, maker fee
      this.close(tr);
      return;
    }
    // twoStage: after the first leg the stop sits at EntryFill (level.StopLoss).
    tr.exitRefPrice = kind === 'stop' ? level.StopLoss : kind === 'target' ? tr.Target : e.p;
    const fillKind: FillKind = kind === 'stop' ? 'stop' : kind === 'time' ? 'time' : kind === 'target' ? 'targetMarket' : 'kill';
    this.queue(tr, fillKind, side, openQty(tr), e, kind === 'stop' && this.cfg.stopMode === 'exchangeNative', Infinity);
    if (e.seq < this.lastSeq) this.replayAfter(e.seq);
  }

  // twoStage first leg (§6.5): floor(FilledQty / 2) lots at Target1 by the
  // conservative limit rule (maker fee); the stop moves to EntryFill. A 1-lot
  // position cannot be split: no first leg, stop unchanged (A-87).
  partialExit(level: Readonly<Level>, e: MergedEvent): Ticks | -1 {
    const tr = this.position;
    assert(tr !== null && tr.levelId === level.levelId && tr.entry !== null && tr.exitKind === null && tr.partial === null,
      `ExecutionModel.partialExit: level ${level.levelId} has no open, unsplit position`);
    const q = Math.floor(tr.FilledQty / 2);
    if (q < 1) {
      this.bump('twoStageUnsplit');
      return -1;
    }
    tr.partialQty = q;
    tr.partial = {
      FillPrice: tr.Target1, FilledQty: q, fillSeq: e.seq, fillT: e.t, windowPrints: 0, noPrintFallback: false,
      touchAndReverse: false, touchAndFly: false, inBurst: false, halfSpread: 0, Slippage: 0, latencySplit: null,
    };
    this.bump('partialExits');
    return tr.entry.FillPrice;
  }

  // OCO (A-36): StopLoss and Target exist from the entry fill print on.
  exitsLive(level: Readonly<Level>): boolean {
    const tr = this.position;
    return tr !== null && tr.levelId === level.levelId && tr.entry !== null;
  }

  takePrintsAfterEntryFill(level: Readonly<Level>): ReadonlyArray<MergedEvent> {
    const tr = this.position;
    if (this.afterEntryFillTaken || tr === null || tr.levelId !== level.levelId || tr.entry === null) return NO_PRINTS;   // asked on every print in a trade
    this.afterEntryFillTaken = true;
    return this.afterEntryFill;
  }

  // An exit triggered by a print of the entry fill window (A-36) is fed the
  // prints after its trigger that this model has already seen: the rest of
  // the window and the current print.
  private replayAfter(triggerSeq: number): void {
    const tail = this.afterEntryFill.filter((b) => b.seq > triggerSeq);
    tail.push({ t: this.lastT, seq: this.lastSeq, p: this.curP, q: this.lastQ, s: this.lastS, n: this.lastN });
    for (const b of tail) {
      if (this.pending.length === 0) return;
      this.feed(b);
    }
  }

  // No position and no entry or exit in flight (one position per symbol).
  flat(): boolean { return this.position === null; }

  // Spec §4.1: an exchange-native stop (entry trigger or StopLoss) carries ExchangeLatency only.
  private latencySplitOf(native: boolean, TriggerTime: Ms): LatencyRecord {
    if (native) {
      const ExchangeLatency = this.cfg.exchangeLatencyMs;
      return { Latency: ExchangeLatency, ObsLatency: 0, DecisionLatency: 0, ExchangeLatency, SendTime: TriggerTime };
    }
    const Latency = this.cfg.latencyMs;
    const ObsLatency = LATENCY_SPLIT.ObsLatency * Latency;
    const DecisionLatency = LATENCY_SPLIT.DecisionLatency * Latency;
    return {
      Latency, ObsLatency, DecisionLatency, ExchangeLatency: LATENCY_SPLIT.ExchangeLatency * Latency,
      SendTime: TriggerTime + ObsLatency + DecisionLatency,
    };
  }

  private queue(tr: Trade, kind: FillKind, ourAggressor: Side, Qty: Lots, e: MergedEvent, native: boolean, reverseAbove: Ticks): void {
    const f = this.ctx.frozen;
    const inBurst = f.BurstFlag || (!Number.isNaN(this.prevP) && Math.abs(e.p - this.prevP) > BURST_JUMP_MULT * f.VolUnit_now);
    const split = this.latencySplitOf(native, e.t);
    const FillTime = e.t + split.Latency;                                   // the sum, not the rounded parts
    this.pending.push({
      latencySplit: split,
      req: { side: tr.Side, ourAggressor, Qty, triggerSeq: e.seq, TriggerTime: e.t, FillTime, kind },
      trade: tr, triggerP: e.p, windowEnd: FillTime + this.cfg.FillWindow * (inBurst ? BURST_MULT : 1), inBurst,
      VolUnit_now: f.VolUnit_now, SpreadEst_t: f.SpreadEst_t, reverseAbove,
      worstN: -Infinity, worstT: NaN, worstSeq: -1, sumQ: 0, windowPrints: 0, lastP: e.p,
      sawNext: false, touchAndFly: false, checkedReverse: false, touchAndReverse: false, window: kind === 'entry' ? [] : null,
    });
  }

  // ---------------------------------------------------------------- P&L

  // Net P&L of the primary exit, the alternate (optimistic Target) outcome,
  // realised RoundTripCost and BreakevenHitRate; feeds the kill switch.
  private close(tr: Trade): void {
    const exit = tr.exit!;
    const primary = this.pnl(tr, exit, tr.exitKind === 'target' && this.cfg.targetMode !== 'market');
    tr.fundingAccrued = primary.funding;
    tr.fundingMissing = primary.missing;
    tr.pnl_ticks = primary.ticks;
    tr.pnl_bps = primary.bps;
    tr.pnl_R = primary.R;
    tr.RoundTripCost_bps = primary.costBps;
    const costTicks = (primary.costBps * tr.entry!.FillPrice) / 1e4;
    const stopTicks = this.cfg.StopMult * tr.SweepDepth;
    // A-37 general form; targetMode volUnit: the target distance is W − Target, not TargetMult·SweepDepth.
    const winTicks = this.cfg.targetMode === 'volUnit' ? tr.Side * (tr.WickLevel - tr.Target) + stopTicks : (this.cfg.TargetMult + this.cfg.StopMult) * tr.SweepDepth;
    tr.BreakevenHitRate = (stopTicks + costTicks) / winTicks;
    if (tr.exitOpt === null) {
      tr.exitOpt = exit;
      tr.exitOptKind = tr.exitKind;
      tr.pnlOpt_R = primary.R;
    } else {
      tr.pnlOpt_R = this.pnl(tr, tr.exitOpt, true).R;
    }
    if (primary.missing > 0) this.bump('fundingMissing', primary.missing);
    const tripsBefore = this.killSwitch.trips;
    this.killSwitch.onTradeClosed(tr.pnl_R);
    if (this.killSwitch.trips > tripsBefore) this.bump('killSwitchTrips');
    this.position = null;
  }

  private pnl(tr: Trade, exit: FillResult, makerExit: boolean): PnL {
    if (tr.partial !== null) return this.twoLegPnl(tr, tr.partial, exit, makerExit);
    const { Tick, LotSize } = this.instrument;
    const side = tr.Side;
    const entryPx = tr.entry!.FillPrice;
    const unit = Tick * LotSize * tr.FilledQty;                               // quote currency per tick of the position
    const entryNotional = entryPx * unit;
    const exitNotional = exit.FillPrice * unit;
    const zero = this.cfg.zeroCosts === true;
    const fees = zero ? 0 : this.cfg.TakerFee * entryNotional + (makerExit ? this.cfg.MakerFee : this.cfg.TakerFee) * exitNotional;
    // A-38: without a schedule every settlement inside the trade is charged the fallback.
    const fund = zero
      ? { cost: 0, missing: 0 }
      : fundingAccrued(side, entryNotional, tr.entry!.fillT, exit.fillT, this.funding?.records ?? [], this.funding?.intervalMs ?? DEFAULT_FUNDING_INTERVAL_MS);
    const slipCostTicks = zero ? 0 : side * (tr.TriggerPrice - entryPx) + side * (exit.FillPrice - (exit === tr.exit ? tr.exitRefPrice : tr.Target));
    const net = side * (entryPx - exit.FillPrice) * unit - fees - fund.cost;
    const ticks = net / unit;
    return {
      ticks, bps: (net / entryNotional) * 1e4, R: ticks / tr.sizing.RiskPerTrade,
      costBps: ((fees + slipCostTicks * unit + fund.cost) / entryNotional) * 1e4, funding: fund.cost, missing: fund.missing,
    };
  }

  // twoStage (§6.5): first leg at Target1 (maker, no slippage) plus the rest at
  // `exit`; bps / R / cost relative to the whole position (entry fee on all of
  // it). Funding per leg on its own notional; missing settlements counted once
  // (the final leg is held longest).
  private twoLegPnl(tr: Trade, first: FillResult, exit: FillResult, makerExit: boolean): PnL {
    const { Tick, LotSize } = this.instrument;
    const side = tr.Side;
    const entry = tr.entry!;
    const entryPx = entry.FillPrice;
    const zero = this.cfg.zeroCosts === true;
    const unitAll = Tick * LotSize * tr.FilledQty;
    const entryNotional = entryPx * unitAll;
    let fees = zero ? 0 : this.cfg.TakerFee * entryNotional;
    let slip = zero ? 0 : side * (tr.TriggerPrice - entryPx) * unitAll;
    let gross = 0;
    let funding = 0;
    let missing = 0;
    const legs = [
      [tr.partialQty, first, true, tr.Target1],
      [tr.FilledQty - tr.partialQty, exit, makerExit, exit === tr.exit ? tr.exitRefPrice : tr.Target],
    ] as const;
    for (const [qty, fill, maker, ref] of legs) {
      const unit = Tick * LotSize * qty;
      gross += side * (entryPx - fill.FillPrice) * unit;
      if (zero) continue;
      fees += (maker ? this.cfg.MakerFee : this.cfg.TakerFee) * fill.FillPrice * unit;
      slip += side * (fill.FillPrice - ref) * unit;
      const f = fundingAccrued(side, entryPx * unit, entry.fillT, fill.fillT, this.funding?.records ?? [], this.funding?.intervalMs ?? DEFAULT_FUNDING_INTERVAL_MS);
      funding += f.cost;
      missing = f.missing;
    }
    const net = gross - fees - funding;
    const ticks = net / unitAll;
    return { ticks, bps: (net / entryNotional) * 1e4, R: ticks / tr.sizing.RiskPerTrade, costBps: ((fees + slip + funding) / entryNotional) * 1e4, funding, missing };
  }

  // ---------------------------------------------------------------- bookkeeping

  private bump(key: string, by = 1): void {
    this.counterMap.set(key, (this.counterMap.get(key) ?? 0) + by);
  }

  snapshot(): ExecutionSnapshot {
    return {
      trades: this.tradeLog.map((tr) => ({ ...tr })), counters: this.counters, pending: this.pending.length,
      openTradeId: this.position?.tradeId ?? -1, killSwitch: this.killSwitch.snapshot(),
    };
  }

  // Tick-size re-basing (after LevelBook.invalidateAll and finish()): no fill
  // may be in flight; armed orders and print history are dropped, trades and
  // counters kept. `instrument` carries the new Tick (Spec §3.11).
  reset(instrument?: ExecutionInstrument): void {
    assert(this.position === null && this.pending.length === 0, 'ExecutionModel.reset: a position or fill is still open');
    if (instrument !== undefined) this.instrument = instrument;
    this.orders.clear();
    this.minQtyRefused.clear();
    this.prevP = NaN;
    this.curP = NaN;
  }
}
