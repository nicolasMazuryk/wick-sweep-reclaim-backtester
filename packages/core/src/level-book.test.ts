import { describe, expect, it } from 'vitest';
import type { LevelBookConfig } from './level-book.js';
import { ALLOWED_TRANSITIONS, levelGeometry, TABLE_TRANSITIONS, transitionKey } from './level.js';
import { LevelScript } from './testing/level-script.js';
import type { FrozenStats } from './stats.js';

// Every script built here; the last test checks their union covers the table.
const scripts: LevelScript[] = [];
function script(cfg: Partial<LevelBookConfig> = {}, options: { MinStrength?: number; mirror?: number } = {}, frozen: Partial<FrozenStats> = {}): LevelScript {
  const b = new LevelScript(cfg, options, frozen);
  scripts.push(b);
  return b;
}

// Upper level at 1000 (VolUnit 10: MinSweepDepth 5, BreakoutDepth 25).
// Sweep to 1008, confirm at 996 (≤ 1008 − PivotReversal 12): SweepDepth 8,
// StopLoss 1009, Target 1000 − 16 = 984. RestEarly arms on the confirmation print.
function armedUpper(b: LevelScript, WickStrength = 0.7): number {
  const l = b.level(1000, { WickStrength })!;
  b.prints(1005, 1008, 996);
  return l.levelId;
}

function lastTransition(b: LevelScript, levelId = 0): string {
  const own = b.log.filter((x) => x.startsWith(`${levelId}:`));
  return own[own.length - 1]!.slice(`${levelId}: `.length);
}

describe('LevelBook — Spec §3.9.6 table, one scripted path per row', () => {
  it('PIVOT_PENDING → WICK_ACTIVE (register)', () => {
    const b = script();
    const l = b.level(1000, { WickStrength: 0.65, PriorTouches: 2 })!;
    expect(l.State).toBe('WICK_ACTIVE');
    expect([l.WickLevel, l.VolUnit_created, l.MinSweepDepth, l.BreakoutDepth, l.minSweepFloorBinding]).toEqual([1000, 10, 5, 25, 'mult']);
    expect([l.WickStrength, l.PriorTouches, l.UseCount, l.SweepExtreme]).toEqual([0.65, 2, 0, -1]);
    expect(b.store.byId(l.pivotId)!.levelId).toBe(l.levelId);
    expect(b.book.live(1)).toEqual([l]);
  });

  it.each([
    ['Unresolved (iIn = −1)', { cls: 'Unresolved' as const }],
    ['BurstPivot (burst overlap)', { cls: 'BurstPivot' as const }],
    ['SlowExtreme (early G2 / gate failure / PendingLimit)', { cls: 'SlowExtreme' as const }],
    ['WickLevel featuresFinal event (already handled at classification)', { phase: 'featuresFinal' as const }],
  ])('PIVOT_PENDING → — : %s creates no level', (_name, o) => {
    const b = script();
    expect(b.level(1000, o)).toBeNull();
    expect(b.book.live(1)).toEqual([]);
    expect(b.book.transitions).toEqual([]);
  });

  it('WICK_ACTIVE → INVALIDATED (breakout)', () => {
    const b = script();
    b.level(1000);
    b.print(1025);                                        // P ≥ W + BreakoutDepth
    expect(b.log).toEqual(['0: PIVOT_PENDING → WICK_ACTIVE (register)', '0: WICK_ACTIVE → INVALIDATED (breakout)']);
    expect(b.store.byId(0)!.finalState).toBe('INVALIDATED');
    expect(b.store.byId(0)!.reason).toBe('breakout');
    expect(b.book.live(1)).toEqual([]);
  });

  it('WICK_ACTIVE → SWEEPING (sweep)', () => {
    const b = script();
    b.level(1000);
    b.print(1004);                                        // below MinSweepDepth: nothing
    expect(b.state(0)).toBe('WICK_ACTIVE');
    b.print(1005, 3);
    const l = b.book.byId(0)!;
    expect(lastTransition(b)).toBe('WICK_ACTIVE → SWEEPING (sweep)');
    expect([l.SweepRunningMax, l.sweepStartVol, l.SweepCount, l.SweepExtreme]).toEqual([1005, 4, 1, -1]);
  });

  it('WICK_ACTIVE → WICK_ACTIVE (merge): PriorTouches += 1, WickLevel moves outward only', () => {
    const b = script();
    const l = b.level(1000)!;
    expect(b.book.onPivot(b.pivot(1002))).toBe(true);    // |1002 − 1000| ≤ ceil(0.25·10) = 3
    expect([l.WickLevel, l.PriorTouches]).toEqual([1002, 1]);
    expect(b.book.onPivot(b.pivot(999))).toBe(true);     // inside: WickLevel stays
    expect([l.WickLevel, l.PriorTouches]).toEqual([1002, 2]);
    expect(b.book.onPivot(b.pivot(1006))).toBe(false);   // 4 > 3: a new pivot, not a touch
    expect(b.book.onPivot(b.pivot(1002, -1))).toBe(false); // other side
    expect(lastTransition(b)).toBe('WICK_ACTIVE → WICK_ACTIVE (merge)');
    const merged = b.store.snapshot().filter((r) => r.cls === 'Merged');
    expect(merged.map((r) => [r.pivot.price, r.levelId])).toEqual([[1002, 0], [999, 0]]);
    // Merged pivots count as touches for later PriorTouches (A-26).
    expect(b.store.countNear(1, 1000, 3, 0, 1e9)).toBe(3);
  });

  it('WICK_ACTIVE → RETIRED (nestedInner): outer Spike retires a WICK_ACTIVE inner level', () => {
    const b = script();
    b.level(1000);
    b.level(1010);                                        // outer, within BreakoutMult·max(VolUnit) = 25
    expect(b.log).toContain('0: WICK_ACTIVE → RETIRED (nestedInner)');
    expect(b.book.live(1).map((l) => l.levelId)).toEqual([1]);
    expect(b.book.counters.retiredNestedInner).toBe(1);
  });

  it('WICK_ACTIVE → EXPIRED (age)', () => {
    const b = script();
    b.level(1000);
    b.print(990, 7200);
    b.close();
    expect(b.state(0)).toBe('WICK_ACTIVE');              // Age = 720, not > MaxAge
    b.print(990, 1);
    b.close();
    expect(lastTransition(b)).toBe('WICK_ACTIVE → EXPIRED (age)');
  });

  it('WICK_ACTIVE → INVALIDATED (regime)', () => {
    const b = script();
    b.level(1000);
    b.close({ VolUnit_now: 25 });                         // ratio 2.5: inside
    expect(b.state(0)).toBe('WICK_ACTIVE');
    b.close({ VolUnit_now: 26 });
    expect(lastTransition(b)).toBe('WICK_ACTIVE → INVALIDATED (regime)');
    const c = script();
    c.level(1000);
    c.close({ VolUnit_now: 3 });                          // ratio 0.3 < 0.4
    expect(lastTransition(c)).toBe('WICK_ACTIVE → INVALIDATED (regime)');
  });

  it('SWEEPING → INVALIDATED (breakout): R > W + BreakoutDepth', () => {
    const b = script();
    b.level(1000);
    b.prints(1005, 1025);
    expect(b.state(0)).toBe('SWEEPING');                  // R = W + BreakoutDepth is still a sweep
    b.print(1026);
    expect(lastTransition(b)).toBe('SWEEPING → INVALIDATED (breakout)');
  });

  it('SWEEPING → SWEEPING (otherwise): R = max(R, P), sweepExtremeVol follows R', () => {
    const b = script({}, { MinStrength: 1 });
    b.level(1000);
    b.prints(1005, 1010, 1003, 1012, 1001);
    const l = b.book.byId(0)!;
    expect(l.State).toBe('SWEEPING');
    expect([l.SweepRunningMax, l.sweepExtremeVol, l.SweepExtreme]).toEqual([1012, 4, -1]);
    expect(b.log.length).toBe(2);
  });

  it('SWEEPING → SWEEP_CONFIRMED (confirm): SweepExtreme, SweepDepth, sweep-leg duration and pivot', () => {
    const b = script({}, { MinStrength: 1 });
    b.level(1000);
    b.prints(1005, 1008, 997);
    expect(b.state(0)).toBe('SWEEPING');                  // 997 > 1008 − 12
    const piv = b.pivotNext(1008);
    b.print(996);
    const l = b.book.byId(0)!;
    expect(lastTransition(b)).toBe('SWEEPING → SWEEP_CONFIRMED (confirm)');
    expect([l.SweepExtreme, l.SweepDepth, l.sweepLegDurationBuckets, l.sweepPivotId]).toEqual([1008, 8, 0.3, piv.pivotId]);
    expect(l.suppressed).toBe('minStrength');
  });

  it('SWEEPING → EXPIRED (age) / INVALIDATED (regime)', () => {
    const b = script();
    b.level(1000);
    b.print(1005, 7300);
    b.close();
    expect(lastTransition(b)).toBe('SWEEPING → EXPIRED (age)');
    const c = script();
    c.level(1000);
    c.print(1005);
    c.close({ VolUnit_now: 30 });
    expect(lastTransition(c)).toBe('SWEEPING → INVALIDATED (regime)');
  });

  it('SWEEP_CONFIRMED → INVALIDATED (breakout)', () => {
    const b = script({}, { MinStrength: 1 });
    b.level(1000);
    b.prints(1005, 1008, 996, 1026);
    expect(lastTransition(b)).toBe('SWEEP_CONFIRMED → INVALIDATED (breakout)');
  });

  it('SWEEP_CONFIRMED → SWEEPING (resweep) and → INVALIDATED (maxSweeps)', () => {
    const b = script({}, { MinStrength: 1 });
    b.level(1000);
    b.prints(1005, 1008, 996, 1009);
    const l = b.book.byId(0)!;
    expect(lastTransition(b)).toBe('SWEEP_CONFIRMED → SWEEPING (resweep)');
    expect([l.SweepCount, l.SweepRunningMax, l.SweepExtreme, l.sweepStartVol]).toEqual([2, 1009, 1008, 4]);
    b.prints(1015, 1002);                                 // re-confirmed: new extreme 1015
    expect(lastTransition(b)).toBe('SWEEPING → SWEEP_CONFIRMED (confirm)');
    expect([l.SweepExtreme, l.SweepDepth]).toEqual([1015, 15]);
    b.print(1016);                                        // third sweep: SweepCount 3 ≥ MaxSweeps
    expect(lastTransition(b)).toBe('SWEEP_CONFIRMED → INVALIDATED (maxSweeps)');
    expect(b.book.counters.resweeps).toBe(2);
  });

  it('SWEEP_CONFIRMED → ORDER_ARMED (arm): entry at TriggerPrice = W − TriggerOffset', () => {
    const b = script({ TriggerOffset: 1 });
    armedUpper(b);
    const l = b.book.byId(0)!;
    expect(lastTransition(b)).toBe('SWEEP_CONFIRMED → ORDER_ARMED (arm)');
    expect(b.port.of('arm')).toEqual([{ kind: 'arm', levelId: 0, id: 0, price: 999, seq: -1 }]);
    expect([l.OrderIds.entry, l.StopLoss, l.Target, l.suppressed]).toEqual([0, 1009, 984, 'none']);
    expect(l.regimeAtArm).toEqual({ TrendEfficiency: 0, TrendSign: 0, counterTrend: false });
    expect(b.book.armed()).toEqual([l]);
  });

  it('SWEEP_CONFIRMED → SWEEP_CONFIRMED (missedReclaim) → CANCELLED (missedReclaim) after RetraceWindow buckets (A-29)', () => {
    const b = script({}, { MinStrength: 1 });
    b.level(1000);
    b.prints(1005, 1008, 996);
    b.print(995);                                         // reclaimed without an order
    expect(lastTransition(b)).toBe('SWEEP_CONFIRMED → SWEEP_CONFIRMED (missedReclaim)');
    expect(b.book.counters['missedReclaim.minStrength']).toBe(1);
    b.print(1002, 500);                                   // above W: the cancel timer does not run
    b.print(999, 48);                                     // 1 + 48 < RetraceWindow·BucketVolume = 50
    expect(b.state(0)).toBe('SWEEP_CONFIRMED');
    b.print(999, 1);
    expect(lastTransition(b)).toBe('SWEEP_CONFIRMED → CANCELLED (missedReclaim)');
  });

  it('A-29: after a missed reclaim the level cannot arm until it is re-swept', () => {
    const b = script({}, { MinStrength: 1 });
    b.level(1000);
    b.prints(1005, 1008, 996);
    b.print(995);                                         // reclaimed while minStrength-suppressed
    expect(lastTransition(b)).toBe('SWEEP_CONFIRMED → SWEEP_CONFIRMED (missedReclaim)');
    b.book.setMinStrength(0);                             // the suppression clears
    b.print(1001);
    expect(b.state(0)).toBe('SWEEP_CONFIRMED');           // still consumed: no arm
    b.print(1009);                                        // re-sweep beyond SweepExtreme 1008
    b.print(996);
    expect(b.book.byId(0)!.reclaimVol).toBe(-1);
    expect(b.state(0)).toBe('ORDER_ARMED');
  });

  it('SWEEP_CONFIRMED → EXPIRED (age) / INVALIDATED (regime)', () => {
    const b = script({}, { MinStrength: 1 });
    b.level(1000);
    b.prints(1005, 1008);
    b.print(996, 7300);
    b.close();
    expect(lastTransition(b)).toBe('SWEEP_CONFIRMED → EXPIRED (age)');
    const c = script({}, { MinStrength: 1 });
    c.level(1000);
    c.prints(1005, 1008, 996);
    c.close({ VolUnit_now: 30 });
    expect(lastTransition(c)).toBe('SWEEP_CONFIRMED → INVALIDATED (regime)');
  });

  it('ORDER_ARMED → INVALIDATED (breakout): entry cancelled', () => {
    const b = script();
    armedUpper(b);
    b.print(1026);
    expect(lastTransition(b)).toBe('ORDER_ARMED → INVALIDATED (breakout)');
    expect(b.port.of('cancelEntry').map((c) => [c.levelId, c.id])).toEqual([[0, 0]]);
    expect(b.book.armed()).toEqual([]);
  });

  it('ORDER_ARMED → SWEEPING (resweep): entry unchanged; SWEEPING → ORDER_ARMED (reconfirm) replaces the StopLoss (A-30)', () => {
    const b = script();
    armedUpper(b);
    b.print(1012);
    const l = b.book.byId(0)!;
    expect(lastTransition(b)).toBe('ORDER_ARMED → SWEEPING (resweep)');
    expect([l.OrderIds.entry, l.SweepExtreme, l.StopLoss]).toEqual([0, 1008, 1009]);
    expect(b.port.of('cancelEntry')).toEqual([]);
    b.print(1000 + 1);                                    // 1001 > 1012 − 12: not re-confirmed, no trigger
    b.print(1015);
    b.print(1003);                                        // 1003 ≤ 1015 − 12
    expect(lastTransition(b)).toBe('SWEEPING → ORDER_ARMED (reconfirm)');
    expect([l.SweepExtreme, l.SweepDepth, l.StopLoss, l.Target]).toEqual([1015, 15, 1016, 970]);
    expect(b.port.of('replaceStop')).toEqual([{ kind: 'replaceStop', levelId: 0, id: 0, price: 1016, seq: -1 }]);
    expect(b.port.of('arm').length).toBe(1);
  });

  it('SWEEPING → IN_TRADE (trigger): entry triggers during the re-sweep leg with the old SweepExtreme (A-30)', () => {
    const b = script();
    armedUpper(b);
    b.prints(1012, 1000);
    const l = b.book.byId(0)!;
    expect(lastTransition(b)).toBe('SWEEPING → IN_TRADE (trigger)');
    expect([l.SweepExtreme, l.StopLoss, l.Target]).toEqual([1008, 1009, 984]);
  });

  it('ORDER_ARMED → INVALIDATED (maxSweeps): entry cancelled', () => {
    const b = script({ MaxSweeps: 2 });
    armedUpper(b);
    b.print(1009);
    expect(lastTransition(b)).toBe('ORDER_ARMED → INVALIDATED (maxSweeps)');
    expect(b.port.of('cancelEntry').length).toBe(1);
  });

  it('ORDER_ARMED → IN_TRADE (trigger): the trigger print is the first print with P ≤ W − TriggerOffset after arming', () => {
    const b = script();
    armedUpper(b);                                        // armed on 996 (already below W): not a trigger
    expect(b.state(0)).toBe('ORDER_ARMED');
    const e = b.print(1000);
    const l = b.book.byId(0)!;
    expect(lastTransition(b)).toBe('ORDER_ARMED → IN_TRADE (trigger)');
    expect(b.port.of('enter')).toEqual([{ kind: 'enter', levelId: 0, id: 0, price: 1000, seq: e.seq }]);
    expect([l.tradeId, l.trades, l.OrderIds.entry, l.entryVol]).toEqual([0, [0], -1, 4]);
    expect(b.book.openTrade()).toBe(l);
    expect(b.port.of('exit')).toEqual([]);                // no exit on the trigger print
  });

  it.each([
    ['liquidity', (b: LevelScript) => b.close({ LiquidityGuard: true })],
    ['blacklist', (b: LevelScript) => { b.ctx.inBlacklist = true; }],
    ['killSwitch', (b: LevelScript) => { b.ctx.killSwitchActive = true; }],
    ['minStrength', (b: LevelScript) => b.book.setMinStrength(0.8)],
    ['counterTrendBlocked', (b: LevelScript) => { b.book.setMinStrength(0.6); b.close({ TrendEfficiency: 0.5, TrendSign: 1 }); }],
  ])('ORDER_ARMED → SWEEP_CONFIRMED (%s): entry pulled, re-arms when the check passes again', (reason, fail) => {
    const b = script();
    armedUpper(b);
    fail(b);
    b.print(1003);
    expect(lastTransition(b)).toBe(`ORDER_ARMED → SWEEP_CONFIRMED (${reason})`);
    expect(b.port.of('cancelEntry').length).toBe(1);
    expect(b.book.byId(0)!.suppressed).toBe(reason);
    b.print(1004);
    expect(b.state(0)).toBe('SWEEP_CONFIRMED');           // still failing: no churn
    expect(b.book.counters[`suppress.${reason}`]).toBe(1);
  });

  it('ORDER_ARMED → SWEEP_CONFIRMED (liquidity) then → ORDER_ARMED again once the guard clears (§8.10)', () => {
    const b = script();
    armedUpper(b);
    b.close({ LiquidityGuard: true });
    b.print(1003);
    b.close({ LiquidityGuard: false });
    b.print(1003);
    expect(b.log.slice(-2)).toEqual(['0: ORDER_ARMED → SWEEP_CONFIRMED (liquidity)', '0: SWEEP_CONFIRMED → ORDER_ARMED (arm)']);
    expect(b.port.of('arm').map((c) => c.id)).toEqual([0, 1]);
  });

  it('ORDER_ARMED → SWEEP_CONFIRMED (conflict): a stronger conflicting opposite-side setup arms (§8.9, check g)', () => {
    const b = script();
    b.level(1000, { WickStrength: 0.7 });
    b.prints(1005, 1020, 1008);                           // S = 1020, SweepDepth 20; armed at 1008
    expect(b.state(0)).toBe('ORDER_ARMED');
    b.level(1010, { side: -1, WickStrength: 0.8 });       // lower level above: sweeps down to 1004
    b.prints(1005, 1004, 1016);                           // confirm at 1016 ≥ 1004 + 12
    expect(b.state(1)).toBe('ORDER_ARMED');
    expect(lastTransition(b, 0)).toBe('ORDER_ARMED → SWEEP_CONFIRMED (conflict)');
    expect(b.book.armed().map((l) => l.levelId)).toEqual([1]);
  });

  it('ORDER_ARMED → SWEEP_CONFIRMED (nested): a stronger nested same-side level arms (§8.4, check h)', () => {
    const b = script();
    b.level(1000, { WickStrength: 0.7 });
    b.prints(1005, 1020, 1008);                           // armed, S = 1020
    b.level(1008, { WickStrength: 0.8 });                 // outer but level 0 is ORDER_ARMED: kept (A-24)
    expect(b.state(0)).toBe('ORDER_ARMED');
    b.prints(1013, 1018, 1006);                           // level 1 swept to 1018, confirmed at 1006
    expect(b.state(1)).toBe('ORDER_ARMED');
    expect(lastTransition(b, 0)).toBe('ORDER_ARMED → SWEEP_CONFIRMED (nested)');
  });

  // Checks g and h keep at most one ORDER_ARMED level per conflicting pair,
  // so two levels are ORDER_ARMED at once only through an entry left live
  // across a re-sweep (A-30). PivotReversal 3.
  function twoArmed(lowerW: number): LevelScript {
    const b = script({}, {}, { PivotReversal: 3 });
    b.level(1000);
    b.prints(1005, 1010, 1007);                           // U: S = 1010, SweepDepth 10, armed
    b.print(1012);                                        // U re-sweeps; entry stays live
    b.level(lowerW, { side: -1 });                        // D
    b.prints(1012, 1015);                                 // D: swept to 1012, confirmed at 1015; |ΔW| = 20 ≮ 2·10: no conflict
    expect([b.state(0), b.state(1)]).toEqual(['SWEEPING', 'ORDER_ARMED']);
    return b;
  }

  it('ORDER_ARMED → SWEEP_CONFIRMED (position): an entry fill un-arms every other armed level (check e)', () => {
    const b = twoArmed(1020);
    b.print(1012);                                        // U re-confirmed at 1012 ≤ 1015 − 3: both ORDER_ARMED
    expect([b.state(0), b.state(1)]).toEqual(['ORDER_ARMED', 'ORDER_ARMED']);
    b.print(1000);                                        // U triggers; corridor [970, 1016] excludes 1020
    expect(lastTransition(b, 0)).toBe('ORDER_ARMED → IN_TRADE (trigger)');
    expect(b.log.filter((x) => x.startsWith('1:')).slice(-2)).toEqual([
      '1: ORDER_ARMED → SWEEP_CONFIRMED (position)', '1: SWEEP_CONFIRMED → SWEEPING (resweep)',
    ]);
    expect(b.book.armed()).toEqual([]);
  });

  it('ORDER_ARMED → CANCELLED (conflictFilled): opposite-side armed level inside the filled trade\'s [Target, StopLoss] (§8.9)', () => {
    const b = twoArmed(1020);
    b.prints(1019, 1016);                                 // U re-confirmed: S = 1019, StopLoss 1020, Target 962
    expect([b.state(0), b.state(1)]).toEqual(['ORDER_ARMED', 'ORDER_ARMED']);
    b.print(1000);
    expect(lastTransition(b, 1)).toBe('ORDER_ARMED → CANCELLED (conflictFilled)');
    expect(b.store.byId(b.book.byId(1)!.pivotId)!.reason).toBe('conflictFilled');
    expect(b.book.counters.cancelledConflictFilled).toBe(1);
  });

  it('ORDER_ARMED → EXPIRED (age) / INVALIDATED (regime): entry cancelled', () => {
    const b = script();
    armedUpper(b);
    b.print(1003, 7300);
    b.close();
    expect(lastTransition(b)).toBe('ORDER_ARMED → EXPIRED (age)');
    expect(b.port.of('cancelEntry').length).toBe(1);
    const c = script();
    armedUpper(c);
    c.close({ VolUnit_now: 30 });
    expect(lastTransition(c)).toBe('ORDER_ARMED → INVALIDATED (regime)');
    expect(c.port.of('cancelEntry').length).toBe(1);
  });

  it('IN_TRADE → CLOSED (stop), UseCount += 1; CLOSED → RETIRED (usesExhausted)', () => {
    const b = script();
    armedUpper(b);
    b.prints(1000, 1008);
    expect(b.state(0)).toBe('IN_TRADE');
    const e = b.print(1009);                              // P ≥ StopLoss
    expect(b.log.slice(-2)).toEqual(['0: IN_TRADE → CLOSED (stop)', '0: CLOSED → RETIRED (usesExhausted)']);
    expect(b.port.of('exit')).toEqual([{ kind: 'exit', levelId: 0, id: 0, price: 1009, seq: e.seq, exit: 'stop' }]);
    expect(b.book.byId(0)!.UseCount).toBe(1);
    expect(b.book.openTrade()).toBeNull();
  });

  it('IN_TRADE → CLOSED (target): conservative rule P < Target − Tick; CLOSED → WICK_ACTIVE (reuse) when UseCount < MaxUses', () => {
    const b = script({ MaxUses: 2 });
    armedUpper(b);
    b.prints(1000, 984, 983);                             // touch and one tick beyond: no fill (L8)
    expect(b.state(0)).toBe('IN_TRADE');
    b.print(982);
    expect(b.log.slice(-2)).toEqual(['0: IN_TRADE → CLOSED (target)', '0: CLOSED → WICK_ACTIVE (reuse)']);
    const l = b.book.byId(0)!;
    expect([l.UseCount, l.SweepExtreme, l.SweepDepth, l.SweepCount, l.OrderIds.entry, l.PriorTouches]).toEqual([1, -1, -1, 0, -1, 0]);
    // The reused level runs a second setup.
    b.prints(1005, 1008, 996, 1000);
    expect(lastTransition(b)).toBe('ORDER_ARMED → IN_TRADE (trigger)');
    expect(l.trades).toEqual([0, 1]);
  });

  it('IN_TRADE → CLOSED (time): (Vol − entryVol)/BucketVolume ≥ MaxHold · sweepLegDurationBuckets', () => {
    const b = script({ timeStop: true });
    armedUpper(b);                                        // sweep leg 1005 → 996: 0.2 buckets ⇒ 0.8 buckets = 8 lots
    b.print(1000);
    b.print(1001, 7);
    expect(b.state(0)).toBe('IN_TRADE');
    b.print(1001, 1);
    expect(lastTransition(b)).toBe('CLOSED → RETIRED (usesExhausted)');
    expect(b.log).toContain('0: IN_TRADE → CLOSED (time)');
  });

  it('IN_TRADE → CLOSED (killSwitch): market exit; no re-arming while the switch is active (check d)', () => {
    const b = script({ MaxUses: 2 });
    armedUpper(b);
    b.print(1000);
    b.ctx.killSwitchActive = true;
    b.print(1001);
    expect(b.log.slice(-2)).toEqual(['0: IN_TRADE → CLOSED (killSwitch)', '0: CLOSED → WICK_ACTIVE (reuse)']);
    expect(b.port.of('exit')[0]!.exit).toBe('killSwitch');
    b.prints(1005, 1008, 996);
    expect(b.state(0)).toBe('SWEEP_CONFIRMED');
    expect(b.book.byId(0)!.suppressed).toBe('killSwitch');
  });

  it('exit priority: StopLoss before conservative Target before TimeStop before kill switch (§4.3.2)', () => {
    const b = script({ timeStop: true });
    armedUpper(b);
    b.print(1000);
    b.ctx.killSwitchActive = true;
    b.print(1009, 100);                                   // stop, time and kill all hold
    expect(b.port.of('exit')[0]!.exit).toBe('stop');
  });

  it('IN_TRADE → IN_TRADE (retireAfterClose): ageing / regime never touch an open trade (A-31)', () => {
    const b = script({ MaxUses: 3 });
    armedUpper(b);
    b.print(1000);
    b.close({ VolUnit_now: 30 });
    b.close({ VolUnit_now: 30 });
    expect(b.state(0)).toBe('IN_TRADE');
    expect(b.log.filter((x) => x.includes('retireAfterClose'))).toEqual(['0: IN_TRADE → IN_TRADE (retireAfterClose)']);
    b.print(1009);
    expect(b.log.slice(-2)).toEqual(['0: IN_TRADE → CLOSED (stop)', '0: CLOSED → RETIRED (usesExhausted)']);
  });

  it('WICK_ACTIVE → RETIRED (breakoutAfterUse): a used level broken by more than BreakoutDepth', () => {
    const b = script({ MaxUses: 2 });
    armedUpper(b);
    b.prints(1000, 982);                                  // target: back to WICK_ACTIVE with UseCount 1
    b.print(1025);                                        // = W + BreakoutDepth: a fresh level would be INVALIDATED
    expect(lastTransition(b)).toBe('WICK_ACTIVE → INVALIDATED (breakout)');
    const c = script({ MaxUses: 2 });
    armedUpper(c);
    c.prints(1000, 982, 1026);
    expect(lastTransition(c)).toBe('WICK_ACTIVE → RETIRED (breakoutAfterUse)');
  });

  it('any live state → INVALIDATED (tickChange) (Spec §3.11); an open trade is flattened, armed entries cancelled', () => {
    const b = script();
    armedUpper(b);
    b.level(900, { side: -1 });
    const e = b.print(1000);
    b.book.invalidateAll(e);
    expect(b.log.slice(-2)).toEqual(['0: IN_TRADE → INVALIDATED (tickChange)', '1: WICK_ACTIVE → INVALIDATED (tickChange)']);
    expect(b.port.of('exit')[0]!.exit).toBe('tickChange');
    expect(b.book.live(1)).toEqual([]);
    expect(b.book.live(-1)).toEqual([]);
    b.book.reset();
    for (const [ps, state] of [[[1005], 'SWEEPING'], [[1005, 1008, 996], 'ORDER_ARMED']] as const) {
      const c = script({}, {}, {});
      c.level(1000);
      c.prints(...ps);
      expect(c.state(0)).toBe(state);
      c.book.invalidateAll(c.print(1003));
      expect(lastTransition(c)).toBe(`${state} → INVALIDATED (tickChange)`);
      expect(c.book.armed()).toEqual([]);
    }
    const d = script({}, { MinStrength: 1 });
    d.level(1000);
    d.prints(1005, 1008, 996);
    d.book.invalidateAll(d.print(1003));
    expect(lastTransition(d)).toBe('SWEEP_CONFIRMED → INVALIDATED (tickChange)');
  });
});

describe('LevelBook — registration rules and arming checks (Spec §3.9.4, §3.9.5)', () => {
  it('nested (§8.4, A-24): an outer Spike does not retire an inner level that is already SWEEPING+', () => {
    const b = script({}, { MinStrength: 1 });
    b.level(1000);
    b.print(1005);
    b.level(1010);
    expect(b.state(0)).toBe('SWEEPING');
    expect(b.book.live(1).map((l) => l.levelId)).toEqual([0, 1]);
  });

  it('nested (§8.4): a new inner level keeps both; only the stronger may hold an order (check h)', () => {
    const b = script();
    b.level(1010, { WickStrength: 0.8 });
    b.level(1000, { WickStrength: 0.7 });                 // inner: both live
    expect(b.book.live(1).map((l) => l.WickLevel)).toEqual([1000, 1010]);
    b.prints(1015, 1020, 1008);                           // both swept (outer: 1015 ≥ 1010 + 5) and confirmed
    expect(b.state(1)).toBe('SWEEP_CONFIRMED');           // inner, weaker: suppressed nested
    expect(b.book.byId(1)!.suppressed).toBe('nested');
    expect(b.state(0)).toBe('ORDER_ARMED');
    expect(b.book.counters.suppressedNested).toBe(1);                 // Spec §5 name (was suppress.nested)
  });

  it('conflict (§8.9, check g): the weaker opposite-side setup is suppressed, not armed', () => {
    const b = script();
    b.level(1000, { WickStrength: 0.8 });
    b.prints(1005, 1020, 1008);
    b.level(1010, { side: -1, WickStrength: 0.6 });
    b.prints(1005, 1004, 1016);
    expect([b.state(0), b.state(1)]).toEqual(['ORDER_ARMED', 'SWEEP_CONFIRMED']);
    expect(b.book.byId(1)!.suppressed).toBe('conflict');
  });

  it('equal WickStrength ties break on higher Relevance, then lower levelId', () => {
    const b = script();
    b.level(1000, { WickStrength: 0.7 });
    b.prints(1005, 1020, 1008);
    b.print(1008, 500);                                   // level 0 ages 50 buckets
    b.level(1010, { side: -1, WickStrength: 0.7 });       // same WickStrength, younger: higher Relevance
    b.prints(1005, 1004, 1016);
    expect([b.state(0), b.state(1)]).toEqual(['SWEEP_CONFIRMED', 'ORDER_ARMED']);
    expect(lastTransition(b, 0)).toBe('ORDER_ARMED → SWEEP_CONFIRMED (conflict)');
    // Same WickStrength, same age, both Distance ≤ 0 (equal Relevance): lower levelId arms.
    const same = script();
    same.level(1010, { WickStrength: 0.7 });
    same.level(1000, { WickStrength: 0.7 });
    same.prints(1015, 1024, 1012);                        // both swept to 1024, both confirmed at 1012
    expect([same.state(0), same.state(1), same.book.byId(1)!.suppressed]).toEqual(['ORDER_ARMED', 'SWEEP_CONFIRMED', 'nested']);
  });

  it('sweep leg is a stronger Spike (§8.5, A-25): the new level registers, the setup keeps its trade and records WickStrength_sweep', () => {
    const b = script();
    b.level(1000, { WickStrength: 0.6 });
    b.prints(1005, 1008);
    const piv = b.pivotNext(1008);
    b.print(996);                                         // confirmation print: the zigzag emits the sweep-leg pivot
    b.print(1000);
    expect(b.state(0)).toBe('IN_TRADE');
    const outer = b.level(1008, { pivotId: piv.pivotId, WickStrength: 0.9 })!;
    const l = b.book.byId(0)!;
    expect([l.State, l.WickStrength_sweep, outer.UseCount, outer.State]).toEqual(['IN_TRADE', 0.9, 0, 'WICK_ACTIVE']);
    expect(b.book.counters.sweepLegStrongerSpike).toBe(1);
    const weaker = script();
    weaker.level(1000, { WickStrength: 0.6 });
    weaker.prints(1005, 1008);
    const p2 = weaker.pivotNext(1008);
    weaker.print(996);
    weaker.level(1008, { pivotId: p2.pivotId, WickStrength: 0.5 });
    expect(Number.isNaN(weaker.book.byId(0)!.WickStrength_sweep)).toBe(true);
  });

  it('MaxPending (check i): the weakest armed entry is pulled for a stronger setup, otherwise the new one is suppressed', () => {
    // With checks g/h at most one ORDER_ARMED level per conflicting pair, the
    // queue binds on an entry left live through a re-sweep (A-30).
    const strong = script({ MaxPending: 1 }, {}, { PivotReversal: 3 });
    strong.level(1000, { WickStrength: 0.6 });
    strong.prints(1005, 1010, 1007, 1012);
    strong.level(1020, { side: -1, WickStrength: 0.8 });
    strong.prints(1012, 1015);
    expect(strong.state(1)).toBe('ORDER_ARMED');
    expect(strong.book.byId(0)!.OrderIds.entry).toBe(-1);
    expect(strong.book.counters['unarmedInResweep.maxPending']).toBe(1);
    const weak = script({ MaxPending: 1 }, {}, { PivotReversal: 3 });
    weak.level(1000, { WickStrength: 0.8 });
    weak.prints(1005, 1010, 1007, 1012);
    weak.level(1020, { side: -1, WickStrength: 0.6 });
    weak.prints(1012, 1015);
    expect(weak.state(1)).toBe('SWEEP_CONFIRMED');
    expect(weak.book.byId(1)!.suppressed).toBe('maxPending');
    expect(weak.book.byId(0)!.OrderIds.entry).toBe(0);
  });

  it('kill switch (check d): armed entries pulled, no arming; IN_TRADE flattened', () => {
    const b = script();
    armedUpper(b);
    b.ctx.killSwitchActive = true;
    b.print(1003);
    expect(lastTransition(b)).toBe('ORDER_ARMED → SWEEP_CONFIRMED (killSwitch)');
    b.ctx.killSwitchActive = false;
    b.print(1003);
    expect(b.state(0)).toBe('ORDER_ARMED');
  });

  it('counter-trend (§8.1, check f): needs WickStrength ≥ MinStrength + 0.15 and halves size; counterTrendBlock suppresses', () => {
    const trend = { TrendEfficiency: 0.5, TrendSign: 1 };
    const weak = script({}, { MinStrength: 0.6 }, trend);
    armedUpper(weak, 0.7);
    expect(weak.book.byId(0)!.suppressed).toBe('counterTrendBlocked');
    const strong = script({}, { MinStrength: 0.6 }, trend);
    armedUpper(strong, 0.8);
    const l = strong.book.byId(0)!;
    expect([l.State, l.sizeHalved, l.regimeAtArm]).toEqual(['ORDER_ARMED', true, { TrendEfficiency: 0.5, TrendSign: 1, counterTrend: true }]);
    const blocked = script({ counterTrendBlock: true }, { MinStrength: 0.6 }, trend);
    armedUpper(blocked, 0.95);
    expect(blocked.book.byId(0)!.suppressed).toBe('counterTrendBlocked');
    const aligned = script({}, { MinStrength: 0.6 }, { TrendEfficiency: 0.5, TrendSign: -1 });
    armedUpper(aligned, 0.7);
    expect([aligned.state(0), aligned.book.byId(0)!.sizeHalved]).toEqual(['ORDER_ARMED', false]);
  });

  it('ArmOnApproach (§6.3, §8.6): arms within ArmDistance of W with ReturnSpeed ≥ MinReturnSpeed; a slow reclaim is skipped', () => {
    const fast = script({ ArmMode: 'ArmOnApproach' });
    fast.level(1000);
    fast.prints(1005, 1020, 1008);                        // confirmed at 1008 > W + ceil(0.5·10)
    expect(fast.book.byId(0)!.suppressed).toBe('approach');
    fast.print(1004, 1, -1);                              // (1020 − 1004)/(10 · 2/10) = 8
    const l = fast.book.byId(0)!;
    expect(l.State).toBe('ORDER_ARMED');
    expect([l.ReturnSpeed, l.ReturnImbalance]).toEqual([8, 0]);
    const slow = script({ ArmMode: 'ArmOnApproach' });
    slow.level(1000);
    slow.prints(1005, 1020, 1008);
    slow.print(1004, 100);                                // 16/(10 · 101/10) < 0.3
    expect(slow.state(0)).toBe('SWEEP_CONFIRMED');
    expect(slow.book.byId(0)!.suppressed).toBe('approach');
  });

  it('ReturnSpeed is 0 with no volume since the sweep extreme; ReturnImbalance = −Side·Σsq/Σq over the return leg', () => {
    const b = script();
    b.level(1000);
    b.print(1005, 1, 1);
    b.print(1008, 1, 1);
    b.print(1002, 3, -1);
    b.print(996, 1, 1);
    const l = b.book.byId(0)!;
    expect(l.ReturnImbalance).toBe(0.5);                  // −(−3 + 1)/4
    expect(l.ReturnSpeed).toBeCloseTo(12 / (10 * 0.4));
  });

  it('MinSweepDepth floors (§3.9.3) record the binding one; the cost floor is re-applied at arming', () => {
    const cfg = { MinSweepMult: 0.5, BreakoutMult: 2.5 };
    expect(levelGeometry(cfg, 10, 1, 0)).toEqual({ MinSweepDepth: 5, BreakoutDepth: 25, minSweepFloorBinding: 'mult' });
    expect(levelGeometry(cfg, 2, 1, 0)).toEqual({ MinSweepDepth: 3, BreakoutDepth: 5, minSweepFloorBinding: 'tick' });
    expect(levelGeometry(cfg, 10, 4, 0)).toEqual({ MinSweepDepth: 8, BreakoutDepth: 25, minSweepFloorBinding: 'spread' });
    expect(levelGeometry(cfg, 10, 1, 4)).toEqual({ MinSweepDepth: 8, BreakoutDepth: 25, minSweepFloorBinding: 'cost' });
    expect(levelGeometry(cfg, 7, 1, 0)).toEqual({ MinSweepDepth: 4, BreakoutDepth: 18, minSweepFloorBinding: 'mult' });
    const b = script();
    b.port.costTicks = () => 4;
    const l = b.level(1000)!;
    expect([l.MinSweepDepth, l.minSweepFloorBinding]).toEqual([8, 'cost']);
    b.print(1007);
    expect(l.State).toBe('WICK_ACTIVE');
    const c = script();
    c.level(1000);
    c.prints(1005, 1008);
    c.port.costTicks = () => 5;                        // cost rose: 2·5 > SweepDepth 8
    c.print(996);
    const m = c.book.byId(0)!;
    expect([m.State, m.suppressed, m.MinSweepDepth, m.minSweepFloorBinding]).toEqual(['SWEEP_CONFIRMED', 'costFloor', 10, 'cost']);
    expect(c.book.counters['minSweepFloor.mult']).toBe(1);
  });

  it('minQty: sizing refuses the order ⇒ suppressed, no transition', () => {
    const b = script();
    b.port.refuseArm = () => true;
    armedUpper(b);
    expect([b.state(0), b.book.byId(0)!.suppressed]).toEqual(['SWEEP_CONFIRMED', 'minQty']);
  });

  it('bound.* counts every failing check, suppress.* only the first (Spec §5 last paragraph)', () => {
    const b = script({}, { MinStrength: 0.9 });
    b.ctx.inBlacklist = true;
    armedUpper(b);
    expect(b.book.byId(0)!.suppressed).toBe('minStrength');
    expect(b.book.counters).toMatchObject({ 'suppress.minStrength': 1, 'bound.minStrength': 1, 'bound.blacklist': 1 });
    expect(b.book.counters['suppress.blacklist']).toBeUndefined();
  });

  it('scan set (§3.9.2): dormant levels far from price are not scanned but still age', () => {
    const b = script();
    b.level(2000);
    b.level(1000);
    b.prints(1005, 1030);
    expect([b.state(0), b.state(1)]).toEqual(['WICK_ACTIVE', 'INVALIDATED']);
    b.print(990, 7300);
    b.close();
    expect(b.state(0)).toBe('EXPIRED');
  });
});

describe('LevelBook — Spec §5 rule-binding counters', () => {
  it('conflictSuppressed / suppressedNested are the §8.9 / §8.4 first-reason counters', () => {
    const b = script();
    b.level(1000, { WickStrength: 0.8 });
    b.prints(1005, 1020, 1008);
    b.level(1010, { side: -1, WickStrength: 0.6 });
    b.prints(1005, 1004, 1016, 1003);
    expect(b.book.counters).toMatchObject({ conflictSuppressed: 1, 'bound.conflict': 1 });
    expect(b.book.counters['suppress.conflict']).toBeUndefined();
  });

  it('counterTrendAllowed at arming; counterTrendBlockedByStrength once per episode, not with the block variant (§8.1)', () => {
    const counter = { TrendEfficiency: 0.5, TrendSign: 1 };
    const allowed = script({}, { MinStrength: 0.5 }, counter);          // 0.7 ≥ 0.5 + 0.15
    armedUpper(allowed);
    expect(allowed.book.counters).toMatchObject({ counterTrendAllowed: 1, counterTrendHalved: 1 });
    const weak = script({}, { MinStrength: 0.6 }, counter);             // 0.7 < 0.75
    armedUpper(weak);
    weak.prints(1003, 1004, 1002);
    expect(weak.book.counters).toMatchObject({ counterTrendBlockedByStrength: 1, 'bound.counterTrendBlocked': 1 });
    expect(weak.book.counters.counterTrendAllowed).toBeUndefined();
    const blocked = script({ counterTrendBlock: true }, { MinStrength: 0.5 }, counter);
    armedUpper(blocked);
    expect(blocked.book.counters['bound.counterTrendBlocked']).toBe(1);
    expect(blocked.book.counters.counterTrendBlockedByStrength).toBeUndefined();
  });

  it('armsBlockedLiquidity (no order yet) vs ordersPulledLiquidity (live entry cancelled), once per episode (§8.8)', () => {
    const pulled = script();
    armedUpper(pulled);
    pulled.close({ LiquidityGuard: true });
    pulled.prints(1003, 1004, 1003);
    expect(pulled.book.counters).toMatchObject({ ordersPulledLiquidity: 1, 'bound.liquidity': 1 });
    expect(pulled.book.counters.armsBlockedLiquidity).toBeUndefined();
    const blocked = script({}, {}, { LiquidityGuard: true });
    armedUpper(blocked);
    blocked.prints(1003, 1004);
    expect(blocked.book.counters).toMatchObject({ armsBlockedLiquidity: 1, 'bound.liquidity': 1 });
    expect(blocked.book.counters.ordersPulledLiquidity).toBeUndefined();
  });

  it('un-arming passes the full failing mask: every failing check counts as "would also have bound"', () => {
    const b = script();
    armedUpper(b);
    b.ctx.inBlacklist = true;
    b.ctx.killSwitchActive = true;
    b.print(1003);
    expect(lastTransition(b)).toBe('ORDER_ARMED → SWEEP_CONFIRMED (blacklist)');
    expect(b.book.counters).toMatchObject({ 'suppress.blacklist': 1, 'bound.blacklist': 1, 'bound.killSwitch': 1 });
  });

  it('every evaluation refreshes the mask: a check that clears and fails again counts again', () => {
    const b = script({}, { MinStrength: 0.9 });
    b.ctx.inBlacklist = true;
    armedUpper(b);
    b.print(1003);
    b.ctx.inBlacklist = false;
    b.print(1004);
    b.ctx.inBlacklist = true;
    b.print(1003);
    expect(b.book.counters).toMatchObject({ 'suppress.minStrength': 1, 'bound.minStrength': 1, 'bound.blacklist': 2 });
  });

  it('priorTouchesHist {0, 1, 2, ≥3} and the reclaim class at the trigger (§8.3, §8.6)', () => {
    // Sweep pivot emitted on the confirming print; its RejectSpeed comes from the context.
    const trigger = (PriorTouches: number, returnQ: number, s: 1 | -1, rejectSpeed = 0.5): LevelScript => {
      const b = script();
      b.ctx.rejectSpeedOf = () => rejectSpeed;
      b.level(1000, { PriorTouches });
      b.prints(1005, 1008);
      const sweepPivot = b.pivotNext(1008);
      b.print(996, returnQ, s);                           // confirm + arm (RestEarly)
      b.print(1000, 1, s);                                // trigger
      const l = b.book.byId(0)!;
      expect([l.State, l.sweepPivotId]).toEqual(['IN_TRADE', sweepPivot.pivotId]);
      return b;
    };
    // Return leg 1008 → 1000 over 2 lots (0.2 buckets): ReturnSpeed 4, ReturnImbalance +1 (sells).
    const violent = trigger(0, 1, -1);
    expect(violent.book.byId(0)!).toMatchObject({ ReturnSpeed: 4, ReturnImbalance: 1, RejectSpeed_sweep: 0.5 });
    expect(violent.book.counters).toMatchObject({ 'priorTouchesHist.0': 1, reclaimViolent: 1 });
    expect(trigger(2, 1, 1).book.counters).toMatchObject({ 'priorTouchesHist.2': 1 });          // buys: not violent, not slow
    expect(trigger(2, 1, 1).book.counters.reclaimViolent).toBeUndefined();
    expect(trigger(5, 1, -1, NaN).book.counters).toMatchObject({ 'priorTouchesHist.3+': 1 });   // unknown RejectSpeed: never violent
    expect(trigger(5, 1, -1, NaN).book.counters.reclaimViolent).toBeUndefined();
    // 101 lots on the return leg: ReturnSpeed 8 / (10 · 10.1) < 0.3.
    const slow = trigger(1, 100, -1);
    expect(slow.book.counters).toMatchObject({ 'priorTouchesHist.1': 1, reclaimSlow: 1 });
  });

  it('skippedSlowReclaim: under ArmOnApproach a slow drift reclaims W without an order (§8.6)', () => {
    const b = script({ ArmMode: 'ArmOnApproach' }, {}, { PivotReversal: 3 });
    b.level(1000);
    b.prints(1005, 1010, 1007);                           // confirmed at 1007 (≤ 1010 − 3), not near (> 1000 + 5)
    b.print(1003, 200);                                   // near, ReturnSpeed 7 / (10 · 20.1) < 0.3
    expect([b.state(0), b.book.byId(0)!.suppressed]).toEqual(['SWEEP_CONFIRMED', 'approach']);
    b.print(1000);
    expect(b.book.counters).toMatchObject({ 'missedReclaim.approach': 1, skippedSlowReclaim: 1 });
    const fast = script({ ArmMode: 'ArmOnApproach' }, {}, { PivotReversal: 3 });
    fast.level(1000);
    fast.prints(1005, 1010, 1007, 1003);                  // ReturnSpeed 7 / (10 · 0.2) ≥ 0.3
    expect(fast.state(0)).toBe('ORDER_ARMED');
    expect(fast.book.counters.skippedSlowReclaim).toBeUndefined();
  });
});

describe('LevelBook — scenario variants (Spec §8.2 class variant)', () => {
  it('targetMode volUnit: Target = W − floor(TargetUnits·VolUnit_created) (§6.5)', () => {
    const b = script({ targetMode: 'volUnit', TargetUnits: 1.5 });
    armedUpper(b);
    expect([b.book.byId(0)!.Target, b.book.byId(0)!.Target1]).toEqual([985, -1]);
  });

  it('targetMode twoStage: first half at W − 1·SweepDepth, stop to EntryFill, rest at TargetMult (§6.5)', () => {
    const b = script({ targetMode: 'twoStage' });
    armedUpper(b);                                        // SweepDepth 8: Target1 992, Target 984, StopLoss 1009
    const l = b.book.byId(0)!;
    expect([l.Target1, l.Target, l.StopLoss]).toEqual([992, 984, 1009]);
    b.print(1000);                                        // trigger
    b.print(991);                                         // touch + 1 tick: conservative rule not met
    expect(b.port.of('partialExit')).toEqual([]);
    b.print(990);
    expect(lastTransition(b)).toBe('IN_TRADE → IN_TRADE (partialTarget)');
    expect([l.target1Done, l.StopLoss]).toEqual([true, 1000]);   // RecordingPort: EntryFill stand-in = W
    b.print(1000);                                        // back to the moved stop
    expect(b.log.slice(-2)).toEqual(['0: IN_TRADE → CLOSED (stop)', '0: CLOSED → RETIRED (usesExhausted)']);
    expect(b.port.of('exit').map((c) => c.exit)).toEqual(['stop']);
  });

  it('twoStage: both legs on one print; an unsplittable position keeps its stop', () => {
    const both = script({ targetMode: 'twoStage' });
    armedUpper(both);
    both.prints(1000, 982);
    expect(both.log.slice(-3)).toEqual(['0: IN_TRADE → IN_TRADE (partialTarget)', '0: IN_TRADE → CLOSED (target)', '0: CLOSED → RETIRED (usesExhausted)']);
    const one = script({ targetMode: 'twoStage' });
    one.port.partialStop = () => -1;
    armedUpper(one);
    one.prints(1000, 990);
    expect(one.book.byId(0)!.StopLoss).toBe(1009);
    one.print(1000);
    expect(one.state(0)).toBe('IN_TRADE');
  });

  it('ageClock wall: Age = minutes since ExitTime, EXPIRED on the close after MaxAge (§5, A-88)', () => {
    const b = script({ ageClock: 'wall' });
    b.level(1000);                                        // ExitTime = registration time
    b.printAt(720 * 60_000, 990);
    b.close();
    expect(b.state(0)).toBe('WICK_ACTIVE');              // Age = 720, not > MaxAge
    b.printAt(1, 990);
    b.close();
    expect(lastTransition(b)).toBe('WICK_ACTIVE → EXPIRED (age)');
    const v = script();                                   // the volume clock has barely moved
    v.level(1000);
    v.printAt(800 * 60_000, 990);
    v.close();
    expect(v.state(0)).toBe('WICK_ACTIVE');
  });
});

describe('LevelBook — side symmetry (Spec §3.12)', () => {
  // One script through most rows; run upright and mirrored around c.
  function run(mirror?: number): LevelScript {
    const b = new LevelScript({ MaxUses: 2, timeStop: true }, mirror === undefined ? {} : { mirror }, { PivotReversal: 3 });
    b.level(1000, { WickStrength: 0.7 });
    b.prints(1005, 1010, 1007, 1012);
    b.level(1020, { side: -1, WickStrength: 0.8 });
    b.prints(1012, 1015, 1019, 1016);
    b.print(1000, 2, -1);
    b.print(1001, 1, 1);
    b.close({ TrendEfficiency: 0.5, TrendSign: 1 });
    b.level(900, { side: -1, WickStrength: 0.75 });
    b.print(962, 3, -1);
    b.print(960, 1, 1);
    b.book.onPivot(b.pivot(901, -1));
    b.prints(905, 895, 890, 894, 900, 920);
    b.close({ VolUnit_now: 30 });
    b.print(1100, 20);
    return b;
  }

  it('mirrored path ⇒ identical transition log and timestamps, mirrored level prices and orders', () => {
    const c = 1500;
    const up = run();
    const down = run(c);
    expect(up.book.transitions.length).toBeGreaterThan(10);
    expect(down.book.transitions).toEqual(up.book.transitions);
    expect(down.book.counters).toEqual(up.book.counters);
    const mirrorPrice = (p: number): number => (p === -1 ? -1 : 2 * c - p);
    const a = up.book.snapshot().levels;
    const b = down.book.snapshot().levels;
    expect(b.map((l) => ({ ...l, Side: -l.Side, WickLevel: mirrorPrice(l.WickLevel), SweepExtreme: mirrorPrice(l.SweepExtreme), SweepRunningMax: mirrorPrice(l.SweepRunningMax), StopLoss: mirrorPrice(l.StopLoss), Target: mirrorPrice(l.Target), returnSq: -l.returnSq + 0, regimeAtArm: l.regimeAtArm && { ...l.regimeAtArm, TrendSign: -l.regimeAtArm.TrendSign + 0 } }))).toEqual(a);
    expect(down.port.calls.map((x) => ({ ...x, price: mirrorPrice(x.price) }))).toEqual(up.port.calls);
  });
});

describe('LevelBook — table coverage', () => {
  it('stateMachineClosed: the scripted rows exercise exactly the table-derived ALLOWED_TRANSITIONS', () => {
    const seen = new Set<string>();
    for (const b of scripts) for (const r of b.book.transitions) seen.add(transitionKey(r.from, r.to, r.reason));
    for (const key of seen) expect(ALLOWED_TRANSITIONS.has(key), key).toBe(true);
    // ORDER_ARMED → SWEEP_CONFIRMED (maxPending) needs two ORDER_ARMED levels
    // that neither conflict (g) nor nest (h) — impossible by geometry (see the
    // MaxPending test); check i binds on entries live through a re-sweep.
    const unreachable = new Set([transitionKey('ORDER_ARMED', 'SWEEP_CONFIRMED', 'maxPending')]);
    const missing = [...ALLOWED_TRANSITIONS].filter((k) => !seen.has(k) && !unreachable.has(k));
    expect(missing).toEqual([]);
    expect(TABLE_TRANSITIONS.length).toBeGreaterThan(40);
  });
});
