import { type Engine, type FrozenStats, InvariantViolation, type PivotClass, PivotStore, type Side } from '@wsr/core';
import { describe, expect, it } from 'vitest';
import {
  type LevelSetId, type ReactionObservation, ReactionObserver, reactionStats, type RefLevel,
} from './reaction.js';
import { rngStream } from './rng.js';

// Engine surface the observer reads: store, stats.frozen (VolUnit_now,
// volumeDay), builder (Vol, BucketVolume). One lot per print, BucketVolume 1:
// RetraceWindow 5 = 5 prints, ReactionWindow 10 = 10 prints.
class Script {
  readonly store = new PivotStore();
  readonly stats = { frozen: { VolUnit_now: 7, volumeDay: 0 } as FrozenStats };
  readonly builder = { Vol: 0, BucketVolume: 1 };
  readonly observer: ReactionObserver;
  private seq = -1;
  private nextPivotId = 0;

  constructor(MaxAge = 200, spanStart?: number) {
    this.observer = new ReactionObserver({ seed: 1, RetraceWindow: 5, MaxAge, spanStart });
  }

  get t(): number { return (this.seq + 1) * 1000; }

  print(p: number, VolUnit_now?: number): void {
    this.seq++;
    this.builder.Vol += 1;
    if (VolUnit_now !== undefined) this.stats.frozen = { ...this.stats.frozen, VolUnit_now };
    this.observer.onPrint({ t: this.seq * 1000, seq: this.seq, p, q: 1, s: 1, n: 1 }, this as unknown as Engine);
  }

  prints(...ps: number[]): void { for (const p of ps) this.print(p); }

  // A pivot classified on the next print (availableAt = its t, availableVol = its Vol).
  classify(cls: PivotClass, price: number, side: Side = 1, VolUnit_created = 10, WickStrength_0 = 0.5): number {
    const pivotId = this.nextPivotId++;
    const t = this.t;
    this.store.add(
      { kind: side === 1 ? 'PivotHigh' : 'PivotLow', side, price, time: t - 500, seq: this.seq, confirmed_at: t, confirmedSeq: this.seq, confirmedVol: this.builder.Vol, pivotId },
      null, { cls, failed: [], classifiedAt: t }, null, WickStrength_0, NaN, -1, null, VolUnit_created, this.builder.Vol + 1,
    );
    return pivotId;
  }

  of(setId: LevelSetId): ReactionObservation[] {
    return this.observer.observations().filter((o) => o.level.setId === setId);
  }
}

describe('ReactionObserver — level sets (Spec §6.1.1)', () => {
  it('WickLevel → set 1 + four placebo shifts; SlowExtreme → set 2 at VolUnit_now; Burst / Unresolved / Merged in no set', () => {
    const s = new Script();
    s.classify('WickLevel', 100, 1, 10, 0.8);
    s.print(99);
    s.classify('SlowExtreme', 200, -1, 12);
    s.print(99, 9);
    for (const cls of ['BurstPivot', 'Unresolved', 'Merged'] as const) {
      s.classify(cls, 300);
      s.print(99);
    }
    const [wick] = s.of('wick');
    expect(wick!.level).toEqual({
      setId: 'wick', srcPivotId: 0, Side: 1, price: 100, VolUnit: 10, availableAt: 0, availableVol: 1, WickStrength: 0.8, decile: 1, shift: 0,
    } satisfies RefLevel);
    expect(s.of('placebo').map((o) => [o.level.price, o.level.shift, o.level.VolUnit, o.level.availableAt])).toEqual([
      [80, -2, 10, 0], [90, -1, 10, 0], [110, 1, 10, 0], [120, 2, 10, 0],
    ]);
    expect(s.of('slow').map((o) => [o.level.price, o.level.Side, o.level.VolUnit])).toEqual([[200, -1, 9]]);
    expect(s.observer.observations()).toHaveLength(6);
  });

  it('set-1 deciles of WickStrength over the span; undefined strength ⇒ decile −1', () => {
    const s = new Script();
    for (const w of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, NaN]) {
      s.classify('WickLevel', 1000, 1, 10, w);
      s.print(500);
    }
    expect(s.of('wick').map((o) => o.level.decile)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, -1]);
  });

  it('a SlowExtreme row not consumed on its classification print is an invariant violation', () => {
    const s = new Script();
    s.classify('SlowExtreme', 200);
    s.print(99);
    s.store.add(
      { kind: 'PivotHigh', side: 1, price: 1, time: 0, seq: 0, confirmed_at: 0, confirmedSeq: 0, confirmedVol: 0, pivotId: 99 },
      null, { cls: 'SlowExtreme', failed: [], classifiedAt: 0 }, null, NaN, NaN,
    );
    expect(() => s.print(99)).toThrow(InvariantViolation);
  });
});

describe('ReactionObserver — approach events and outcomes (Spec §6.1.2, §6.1.3)', () => {
  it('approach needs (b) a print ≥ 3 VolUnits away first and (a) RetraceWindow buckets since availability', () => {
    const s = new Script();
    s.classify('WickLevel', 100);                          // tol 2, far 30
    s.prints(99, 100, 101);                                // in the band, never far: no approach
    expect(s.of('wick')[0]!.status).toBe('pending');
    s.print(70);                                           // (b): 30 away
    s.print(99);                                           // Vol since availability 4 < 5: (a) fails
    expect(s.of('wick')[0]!.status).toBe('pending');
    s.print(101);                                          // 5 ≥ 5 ⇒ approach
    const o = s.of('wick')[0]!;
    expect([o.status, o.approachT, o.approachVol, o.block]).toEqual(['approached', 5000, 6, 0]);
    // ReactionHit: 100 − p ≥ 10 (Side +1 is favourable below) before p − 100 ≥ 10.
    s.prints(95, 90, 92, 94, 96, 98, 100, 102, 104);
    expect(s.of('wick')[0]!.complete).toBe(false);
    s.print(106);                                          // Vol_a + 10: p_end
    expect(s.of('wick')[0]).toMatchObject({ complete: true, ReactionHit: 1, unresolved: false });
    expect(s.of('wick')[0]!.ReactionDisplacement).toBeCloseTo(-0.6, 12);
  });

  it('adverse first ⇒ ReactionHit 0; neither ±1 VolUnit ⇒ unresolved, ReactionHit 0 (A-44)', () => {
    const s = new Script();
    s.classify('WickLevel', 100);
    s.classify('WickLevel', 500, -1);                      // lower level: favourable above
    s.prints(99, 70, 99, 530, 99, 100);                    // level 100 approaches at the 6th print
    s.prints(110, 85, 100, 100, 100, 100, 100, 100, 100, 100);
    expect(s.of('wick')[0]).toMatchObject({ status: 'approached', ReactionHit: 0, unresolved: false, complete: true });
    s.print(500);                                          // level 500: (b) held since 530 ⇒ approach
    s.prints(505, 495, 502, 503, 504, 505, 506, 507, 508, 509);
    const low = s.of('wick')[1]!;
    expect(low).toMatchObject({ status: 'approached', ReactionHit: 0, unresolved: true, complete: true });
    expect(low.ReactionDisplacement).toBeCloseTo(0.9, 12);                     // −1·(500 − 509)/10
  });

  it('a jump across the band is not an approach; a level older than MaxAge is notApproached (A-43)', () => {
    const s = new Script(20);
    s.classify('WickLevel', 100);
    s.prints(99, 70, 70, 70, 70, 70, 130, 130);            // far, then jumps over [98, 102]
    expect(s.of('wick')[0]!.status).toBe('pending');
    for (let i = 0; i < 13; i++) s.print(130);             // Vol since availability 20 = MaxAge
    expect(s.of('wick')[0]!.status).toBe('pending');
    s.print(130);
    expect(s.of('wick')[0]!.status).toBe('notApproached');
    s.print(100);                                          // too old: never approached
    expect(s.of('wick')[0]!.status).toBe('notApproached');
  });

  it('random level (set 4): an earlier print within one volume-day, same signed distance, approach = t_r (L12)', () => {
    const s = new Script();
    for (let i = 0; i < 30; i++) s.print(300 + (i % 7), 5 + (i % 3));
    s.classify('WickLevel', 100);
    s.prints(99, 70, 99, 100, 100, 101);                   // approach at p_a = 101: d = Side·(ℓ − p_a) = −1
    const ta = s.of('wick')[0]!.approachT;
    const [r] = s.of('random');
    expect(r).toBeDefined();
    const lvl = r!.level;
    expect(lvl.availableAt).toBeLessThanOrEqual(ta);
    expect([r!.status, r!.approachT, lvl.srcPivotId, lvl.Side, lvl.shift]).toEqual(['approached', lvl.availableAt, 0, 1, 0]);
    const k = lvl.availableAt / 1000;                      // print index of t_r
    const pr = k < 30 ? 300 + (k % 7) : [99, 70, 99, 100, 100, 101][k - 30]!;
    expect(lvl.price).toBe(pr - 1);
    expect(lvl.VolUnit).toBe(k < 30 ? 5 + (k % 3) : 7);
    const again = new Script();
    for (let i = 0; i < 30; i++) again.print(300 + (i % 7), 5 + (i % 3));
    again.classify('WickLevel', 100);
    again.prints(99, 70, 99, 100, 100, 101);
    expect(again.of('random')).toEqual(s.of('random'));   // seeded per source pivot
  });

  it('spanStart: warm-up-span prints only feed the history; levels classified before it are in no set (Spec §3.2.4)', () => {
    const s = new Script(200, 10_000);
    s.prints(300, 300, 300, 300, 300);
    s.classify('WickLevel', 100);
    s.print(99);                                          // t = 5 000: warm-up span
    s.classify('SlowExtreme', 200, -1);
    s.print(99);                                          // consumed (skipped) on its classification print: no assert
    s.prints(99, 99, 99);
    s.classify('WickLevel', 100);
    s.print(99);                                          // t = 10 000 = spanStart
    s.prints(70, 99, 100, 100, 101);
    expect(s.of('wick').map((o) => [o.level.availableAt, o.status])).toEqual([[10_000, 'approached']]);
    expect(s.of('slow')).toEqual([]);
    expect(s.of('placebo').map((o) => o.level.availableAt)).toEqual([10_000, 10_000, 10_000, 10_000]);
    const [r] = s.of('random');
    expect(r!.level.availableAt).toBeGreaterThanOrEqual(10_000);          // draws clip at spanStart
    expect(s.observer.counters).toEqual({ randomClipped: 0, firstSpanT: 10_000, preSpanPrints: 10 });
  });
});

// Planted observations: `n` per (set, block), wick deciles cycling 1..10.
function planted(wickDisp: (decile: number, j: number) => number, blocks = 30): ReactionObservation[] {
  const rng = rngStream(9, 'planted');
  const out: ReactionObservation[] = [];
  const obs = (setId: LevelSetId, block: number, d: number, decile = -1): ReactionObservation => ({
    level: { setId, srcPivotId: 0, Side: 1, price: 0, VolUnit: 1, availableAt: 0, availableVol: 0, WickStrength: decile / 10, decile, shift: 0 },
    status: 'approached', approachT: 0, approachVol: 0, block, complete: true, ReactionDisplacement: d, ReactionHit: d > 0 ? 1 : 0,
    unresolved: false, decidedAt: 0,
  });
  for (let b = 0; b < blocks; b++) {
    for (let j = 0; j < 20; j++) {
      const noise = (): number => rng.nextFloat() - 0.5;
      const decile = (j % 10) + 1;
      out.push(obs('wick', b, wickDisp(decile, j) + noise(), decile));
      for (const setId of ['slow', 'placebo', 'random'] as const) out.push(obs(setId, b, noise()));
    }
  }
  out.push({ ...obs('wick', -1, 0, 5), status: 'notApproached', complete: false, ReactionDisplacement: NaN });
  return out;
}

describe('reactionStats (Spec §6.1.4, §6.1.6)', () => {
  it('a planted, monotone WickLevel edge passes the gate', () => {
    const r = reactionStats(planted((d) => 0.1 * d), { B: 400, rng: rngStream(1, 'bootstrap', 0) });
    expect(r.sets.wick).toMatchObject({ n: 601, approached: 600, complete: 600, unresolvedShare: 0 });
    expect(r.contrasts['1-4'].diffDisp).toBeGreaterThan(0.4);
    expect(r.contrasts['1-4'].significant).toBe(true);
    expect(r.monotone.slope).toBeCloseTo(0.1, 1);
    expect(r.monotone.pass).toBe(true);
    expect(r.monotone.spearman).toBeGreaterThan(0.9);
    expect(r.wickByDecile.map((d) => d.decile)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(r.gate).toEqual({ pass: true, reasons: [] });
    expect([r.B, r.blocks]).toEqual([400, 30]);
  });

  it('noise fails the gate with the failing conditions listed', () => {
    const r = reactionStats(planted(() => 0), { B: 400, rng: rngStream(1, 'bootstrap', 0) });
    expect(r.gate.pass).toBe(false);
    expect(r.gate.reasons.length).toBeGreaterThan(0);
    expect(r.contrasts['1-4'].ci95[0]).toBeLessThan(r.contrasts['1-4'].diffDisp);
    expect(r.contrasts['1-4'].ci95[1]).toBeGreaterThan(r.contrasts['1-4'].diffDisp);
  });

  it('is deterministic per bootstrap stream; empty input gives NaN statistics and a failed gate', () => {
    const obs = planted((d) => 0.05 * d, 10);
    const a = reactionStats(obs, { B: 100, rng: rngStream(2, 'bootstrap', 0) });
    const b = reactionStats(obs, { B: 100, rng: rngStream(2, 'bootstrap', 0) });
    expect(b).toEqual(a);
    const empty = reactionStats([], { B: 10, rng: rngStream(2, 'bootstrap', 0) });
    expect([empty.sets.wick.meanDisp, empty.gate.pass]).toEqual([NaN, false]);
  });
});
