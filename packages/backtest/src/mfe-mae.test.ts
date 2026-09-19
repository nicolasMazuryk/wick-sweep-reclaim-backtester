import type { Engine, FillResult, Level, Trade } from '@wsr/core';
import { describe, expect, it } from 'vitest';
import {
  censorPath, expectancyOf, hitRate0, hitRateOf, hitRateUnits, MfeMaeTracker, pathOutcome, pathOutcomeUnits, targetGridTable, targetUnitsTable,
  type TradePath,
} from './mfe-mae.js';
import { twoStageExpectancy } from './target-validation.js';

// Minimal Engine surface the tracker reads: builder.Vol / BucketVolume, exec.trades(), book.byId().
class StubEngine {
  readonly builder = { Vol: 0, BucketVolume: 1 };
  readonly tradeList: Trade[] = [];
  readonly exec = { trades: (): ReadonlyArray<Trade> => this.tradeList };
  readonly book = { byId: (): Partial<Level> => ({ sweepLegDurationBuckets: this.sweepLeg, VolUnit_created: this.volUnit }) };
  seq = -1;
  constructor(readonly tracker: MfeMaeTracker, public sweepLeg = 100, public volUnit = NaN) {}

  get engine(): Engine { return this as unknown as Engine; }

  print(p: number): void {
    this.seq++;
    this.builder.Vol += 1;
    this.tracker.onPrint({ t: this.seq * 1000, seq: this.seq, p, q: 1, s: 1, n: 1 }, this.engine);
  }

  // A trade whose entry triggered on the print just processed (Side +1, SweepDepth 10).
  trigger(): Trade {
    const tr = {
      tradeId: this.tradeList.length, levelId: 0, Side: 1, triggerSeq: this.seq, SweepDepth: 10, entry: null,
      exitKind: null, RoundTripCost_bps: NaN,
    } as unknown as Trade;
    this.tradeList.push(tr);
    return tr;
  }
}

function fill(tr: Trade, FillPrice: number, fillSeq: number): void {
  tr.entry = { FillPrice, fillSeq } as FillResult;
}

describe('MfeMaeTracker (Spec §6.2)', () => {
  it('starts at the entry fill print (resolved later), records first passages in path order, continues past the exit', () => {
    const s = new StubEngine(new MfeMaeTracker());
    s.print(1000);
    const tr = s.trigger();                                // trigger print seq 0 (never the fill print)
    s.print(1003);                                         // seq 1: the worst print → fill print
    s.print(1001);
    fill(tr, 1000, 1);                                     // resolves on seq 3, after its window
    s.print(998);
    expect(s.tracker.paths()).toHaveLength(1);
    s.print(993);                                          // m 0.7 ⇒ TargetMult 0.5
    s.print(990);                                          // m 1.0 ⇒ TargetMult 1
    tr.exitKind = 'target';                                // the actual exit does not stop tracking
    s.print(1008);                                         // m −0.8 ⇒ StopMult 0.75
    s.print(1011);                                         // m −1.1 ⇒ StopMult 1
    s.print(1016);                                         // m −1.6 ⇒ StopMult 1.25, 1.5 ⇒ end
    s.print(900);                                          // not tracked any more
    const [path] = s.tracker.paths();
    expect(path).toMatchObject({ tradeId: 0, fillSeq: 1, fillVol: 2, EntryFill: 1000, end: 'MAE', prints: 8 });
    expect(path!.MFE).toBeCloseTo(1, 12);
    expect(path!.MAE).toBeCloseTo(1.6, 12);
    expect(Array.from(path!.firstTIdx)).toEqual([3, 4, -1, -1, -1, -1, -1]);
    expect(Array.from(path!.firstSIdx)).toEqual([5, 6, 7, 7]);
    expect(Array.from(path!.firstTBuckets.slice(0, 2))).toEqual([3, 4]);       // Vol since the fill print
    expect(pathOutcome(path!, 1, 1)).toBe('hit');
    expect(pathOutcome(path!, 1.5, 1)).toBe('miss');
    expect(pathOutcome(path!, 0.5, 0.75)).toBe('hit');
    expect(() => pathOutcome(path!, 5, 1)).toThrow();
  });

  it('ends at MFE ≥ max TargetMult or after 8 × sweepLegDurationBuckets (A-46); unresolved if neither is reached', () => {
    const s = new StubEngine(new MfeMaeTracker({ TargetMults: [1, 2], StopMults: [1] }), 0.5);
    s.print(1000);
    const a = s.trigger();
    s.print(1000);
    fill(a, 1000, 1);
    s.print(1001);
    s.print(1002);
    s.print(1001);
    s.print(1000);                                         // 4 buckets since the fill ⇒ time
    s.print(1050);
    const b = s.trigger();
    s.print(1040);
    fill(b, 1040, s.seq);
    s.print(1030);
    s.print(1020);                                         // m 2 = max TargetMult ⇒ MFE
    const [pa, pb] = s.tracker.paths();
    expect([pa!.end, pa!.prints, pathOutcome(pa!, 1, 1)]).toEqual(['time', 5, 'unresolved']);
    expect([pb!.end, pathOutcome(pb!, 2, 1)]).toEqual(['MFE', 'hit']);
  });

  it('maxSweepLegs: ∞ tracks until a grid extreme is reached; a finite value moves the time cap', () => {
    const walk = (tracker: MfeMaeTracker): TradePath => {
      const s = new StubEngine(tracker, 0.5);
      s.print(1000);
      const tr = s.trigger();
      s.print(1000);
      fill(tr, 1000, 1);
      for (const p of [1001, 1002, 1001, 1000, 1001, 1002, 1005, 1010]) s.print(p);    // 1010: m = −1 = −max StopMult
      return s.tracker.paths()[0]!;
    };
    const unbounded = walk(new MfeMaeTracker({ TargetMults: [2], StopMults: [1], maxSweepLegs: Infinity }));
    expect([unbounded.end, unbounded.prints, pathOutcome(unbounded, 2, 1)]).toEqual(['MAE', 9, 'miss']);
    const capped = walk(new MfeMaeTracker({ TargetMults: [2], StopMults: [1], maxSweepLegs: 4 }));
    expect([capped.end, capped.prints]).toEqual(['time', 3]);                         // 2 buckets = 4 · 0.5
    expect(() => new MfeMaeTracker({ maxSweepLegs: 0 })).toThrow();
  });

  it('VolUnit-scaled first passages, back-to-entry after 1·SweepDepth, and the two-stage exit from the path (§6.5)', () => {
    const s = new StubEngine(new MfeMaeTracker({ TargetMults: [1, 2], StopMults: [1], TargetUnits: [1, 2] }), 100, 5);
    s.print(1000);
    const tr = s.trigger();
    (tr as { RoundTripCost_bps: number }).RoundTripCost_bps = 0;
    s.print(1000);                                         // fill print: idx 0
    fill(tr, 1000, 1);
    for (const p of [995, 990, 998, 1001, 985, 980]) s.print(p);
    const [path] = s.tracker.paths();
    // idx 1: m_u 1; idx 2: m 1, m_u 2; idx 4: m −0.1 after m ≥ 1; idx 6: m 2 = max TargetMult, m_u 4 ≥ 2 ⇒ end.
    expect([path!.VolUnit_created, path!.MFE_units, path!.end, path!.prints]).toEqual([5, 4, 'MFE', 7]);
    expect(Array.from(path!.firstTUIdx)).toEqual([1, 2]);
    expect(Array.from(path!.firstTIdx)).toEqual([2, 6]);
    expect(path!.firstBackToEntryAfter1Idx).toBe(4);
    expect([pathOutcomeUnits(path!, 1, 1), hitRateUnits([path!], 2, 1).HitRate]).toEqual(['hit', 1]);
    expect(targetUnitsTable([path!], [1, 2], [1]).map((c) => c.Expectancy)).toEqual([50, 100]);   // 5 / 10 ticks on 1000
    // Two-stage: half at 1·SweepDepth (idx 2); T = 1 fills the other half there; T = 2 comes after the return to entry ⇒ 0.
    expect(twoStageExpectancy([path!], 1).map((r) => [r.TargetMult, r.Expectancy])).toEqual([[1, 100], [2, 50]]);
  });

  it('with a finite VolUnit_created the path runs past max TargetMult until max TargetUnits', () => {
    const s = new StubEngine(new MfeMaeTracker({ TargetMults: [1], StopMults: [1], TargetUnits: [1] }), 100, 50);
    s.print(1000);
    const tr = s.trigger();
    s.print(1000);
    fill(tr, 1000, 1);
    s.print(990);                                          // m 1, m_u 0.2
    expect(s.tracker.paths()[0]!.end).toBe('open');
    s.print(950);                                          // m_u 1
    expect(s.tracker.paths()[0]!.end).toBe('MFE');
  });

  it('an entry resolved by Engine.finish() gets an empty, unresolved path', () => {
    const s = new StubEngine(new MfeMaeTracker());
    s.print(1000);
    const tr = s.trigger();
    fill(tr, 1000, s.seq + 1);
    const [path] = s.tracker.paths(s.engine);
    expect([path!.prints, path!.end, pathOutcome(path!, 2, 1)]).toEqual([0, 'open', 'unresolved']);
  });
});

function stubPath(firstT: number[], firstS: number[], RoundTripCost_bps = 0): TradePath {
  return {
    TargetMults: [1, 2], StopMults: [1], firstTIdx: Int32Array.from(firstT), firstSIdx: Int32Array.from(firstS),
    EntryFill: 1000, SweepDepth: 10, trade: { RoundTripCost_bps } as Trade,
  } as unknown as TradePath;
}

describe('HitRate, HitRate_0, Expectancy (Spec §6.2)', () => {
  const paths = [
    stubPath([2, 5], [7]),                                 // hit at (1,1) and (2,1)
    stubPath([2, -1], [4]),                                // hit (1,1), miss (2,1)
    stubPath([-1, -1], [3]),                               // miss
    stubPath([4, -1], [4]),                                // same-print tie: not a hit
    stubPath([-1, -1], [-1], NaN),                         // unresolved; open at the end (no realised cost)
  ];

  it('HitRate counts path order; ties and unresolved paths are not hits', () => {
    expect(hitRateOf(paths, 1, 1)).toEqual({ HitRate: 2 / 5, n: 5, hits: 2, unresolved: 1, unresolvedShare: 1 / 5 });
    expect(hitRateOf(paths, 2, 1).hits).toBe(1);
    expect(hitRateOf([], 2, 1).HitRate).toBeNaN();
    expect([hitRate0(2, 1), hitRate0(1, 1)]).toEqual([1 / 3, 1 / 2]);
  });

  it('Expectancy in bps of EntryFill, net of each trade\'s RoundTripCost', () => {
    // (2,1): +20 ticks once, −10 three times = −10/4 ticks = −25 bps; open trade left out.
    expect(expectancyOf(paths, 2, 1)).toEqual({ Expectancy: -25, n: 4 });
    const costly = [stubPath([2, 5], [7], 10), stubPath([-1, -1], [3], 10)];   // 10 bps = 1 tick
    expect(expectancyOf(costly, 2, 1).Expectancy).toBeCloseTo(((20 - 1) - (10 + 1)) / 2 * 10, 9);
    const table = targetGridTable(paths, [1, 2], [1]);
    expect(table.map((c) => [c.TargetMult, c.StopMult, c.HitRate, c.HitRate_0])).toEqual([[1, 1, 0.4, 0.5], [2, 1, 0.2, 1 / 3]]);
  });
});

describe('censorPath (A-134)', () => {
  it('first passages at or after tEnd become "not reached"; earlier ones stay', () => {
    const path = {
      firstTIdx: Int32Array.of(3, 9), firstSIdx: Int32Array.of(5), firstTUIdx: Int32Array.of(-1),
      firstTTime: Float64Array.of(100, 300), firstSTime: Float64Array.of(200), firstTUTime: Float64Array.of(NaN), firstBackToEntryAfter1Idx: 4,
    } as unknown as TradePath;
    const c = censorPath(path, 200);
    expect(Array.from(c.firstTIdx)).toEqual([3, -1]);
    expect(Array.from(c.firstSIdx)).toEqual([-1]);
    expect(c.firstBackToEntryAfter1Idx).toBe(-1);
    expect(Array.from(path.firstSIdx)).toEqual([5]);                                   // the original is untouched
    expect(Array.from(censorPath(path, 201).firstSIdx)).toEqual([5]);
  });
});
