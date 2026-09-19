import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ScoredResolution } from './pivot-pipeline.js';
import { ReplayHarness, syntheticPath } from './testing/replay-harness.js';
import { FEATURE_COUNT, featureVector } from './wickstrength.js';

const EVENTS = 20_000;

function rankable(r: ScoredResolution): boolean {
  return r.featuresAvailable && (r.gate.cls === 'WickLevel' || r.gate.cls === 'SlowExtreme');
}

describe('PivotPipeline on a synthetic replay (Spec §3.5–§3.8)', () => {
  const h = new ReplayHarness().run(syntheticPath(1, { events: 25_000 }));
  const stored = h.store.snapshot();

  it('every class occurs; ranks and Stage A appear once MinRankPivots pivots are in the window', () => {
    const classes = new Set(stored.map((r) => r.cls));
    expect(classes).toEqual(new Set(['WickLevel', 'SlowExtreme', 'BurstPivot']));
    const ranked = stored.filter((r) => r.ranks !== null);
    expect(ranked.length).toBeGreaterThan(0);
    for (const r of ranked) {
      expect(r.WickStrength_0).toBeGreaterThan(0);
      expect(r.WickStrength_0).toBeLessThan(1);
      expect(Number.isNaN(r.WickStrength_B)).toBe(true);
      for (const x of r.ranks!) expect(x > 0 && x < 1).toBe(true);
    }
    // The first 50 rankable pivots are stored without ranks (A-19).
    const rankables = h.resolutions.filter(rankable);
    expect(rankables.slice(0, 50).every((r) => r.ranks === null)).toBe(true);
    expect(rankables.slice(50).every((r) => r.ranks !== null)).toBe(true);
  });

  it('rank windows hold exactly the rankable pivots, in scoring order (no BurstPivot / featuresAvailable=false)', () => {
    const x = new Float64Array(FEATURE_COUNT);
    const expected: number[][] = Array.from({ length: FEATURE_COUNT }, () => []);
    for (const r of h.resolutions.filter(rankable)) {
      featureVector(r.features!, r.PriorTouches, r.rvolTicks, x);
      x.forEach((v, j) => expected[j]!.push(v));
    }
    expect(h.pipeline.rankWindows.snapshot()).toEqual(expected.map((col) => col.slice(-h.cfg.RankWindow)));
    for (const r of h.resolutions.filter((r) => !rankable(r))) expect(r.ranks).toBeNull();
  });

  it('PriorTouches counts every earlier-confirmed same-side pivot within MergeTolerance·VolUnit_created, stored or still pending', () => {
    // Every pivot opened in the run: stored, or still PIVOT_PENDING at the end (confirmation order = pivotId order).
    const opened = [...stored.map((o) => ({ pivot: o.pivot, cls: o.cls })),
      ...h.pipeline.tracker.snapshot().pending.map((pp) => ({ pivot: pp.pivot as ScoredResolution['pivot'], cls: 'pending' }))];
    h.resolutions.forEach((r) => {
      if (!rankable(r)) return;
      const tol = Math.ceil(0.25 * r.VolUnit_created - 1e-9);
      // Replay < 1440 buckets: the volume cut-off does not bind. Unresolved (noEnter) pivots are classified at confirmation.
      const near = opened.filter((o) => o.pivot.pivotId < r.pivot.pivotId && o.pivot.side === r.pivot.side &&
        Math.abs(o.pivot.price - r.pivot.price) <= tol && o.cls !== 'Unresolved');
      expect(r.PriorTouches).toBe(near.length);
    });
  });

  // "Confirmed earlier, resolved later" needs a BucketVolume / VolUnit change between two confirmations,
  // which the synthetic paths do not produce; the tracker query is checked directly.
  it('PIVOT_PENDING pivots are counted until classified (an early-G2 SlowExtreme is already in the store)', () => {
    const events = syntheticPath(1, { events: 25_000 });
    const p = new ReplayHarness();
    let i = 0;
    const open = () => p.pipeline.tracker.snapshot().pending.filter((pp) => pp.classified === null);
    while (open().length === 0 || p.warmup) p.onPrint(events[i++]!);
    const piv = open()[0]!.pivot as ScoredResolution['pivot'];
    const count = (side: 1 | -1, before: number, from = 0): number => p.pipeline.tracker.countPendingNear(side, piv.price + 1, 1, 0, before, from);
    expect(count(piv.side, piv.pivotId + 1)).toBe(1);
    expect([count(piv.side, piv.pivotId), count(-piv.side as 1 | -1, piv.pivotId + 1), count(piv.side, piv.pivotId + 1, piv.pivotId + 1)]).toEqual([0, 0, 0]);
    expect(p.store.has(piv.pivotId)).toBe(false);
  });
});

describe('Spec §9.1 L1–L3 look-ahead properties', () => {
  const pathArb = fc.record({
    seed: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
    cuts: fc.array(fc.integer({ min: 1, max: EVENTS }), { minLength: 1, maxLength: 6 }),
  });

  it('property: pivotNotVisibleBeforeConfirmedAt / exitTimeCausal / retraceCausal — truncation: a prefix replay equals the full replay at the cut', () => {
    fc.assert(fc.property(pathArb, ({ seed, cuts }) => {
      const events = syntheticPath(seed, { events: EVENTS });
      const sorted = [...new Set(cuts)].sort((a, b) => a - b);
      const full = new ReplayHarness();
      for (const cut of sorted) {
        full.run(events, cut);
        const prefix = new ReplayHarness().run(events.slice(0, cut));
        expect(prefix.snapshot()).toEqual(full.snapshot());
        // L1: nothing stored before its confirmation print was consumed.
        for (const r of prefix.store.snapshot()) expect(r.pivot.confirmed_at).toBeLessThanOrEqual(prefix.lastT);
      }
    }), { seed: 42, numRuns: 60 });
  });

  it('property: retraceCausal — classifiedAt ≥ confirmed_at; WickLevel only after RetraceWindow buckets of volume past ExitTime', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
      const h = new ReplayHarness().run(syntheticPath(seed, { events: EVENTS }));
      for (const r of h.resolutions) {
        expect(r.gate.classifiedAt).toBeGreaterThanOrEqual(r.pivot.confirmed_at);
        if (r.features) {
          expect(r.features.retraceAvailableAt).toBeGreaterThanOrEqual(r.features.ExitTime);
          expect(r.features.retraceAvailableAt).toBeGreaterThanOrEqual(r.pivot.confirmed_at);
          expect(r.features.EnterTime).toBeLessThanOrEqual(r.pivot.time);                     // L11
          expect(r.features.ExitTime).toBeGreaterThan(r.pivot.time);
        }
        if (r.gate.cls === 'WickLevel') {
          expect(r.gate.classifiedAt).toBeGreaterThanOrEqual(r.features!.retraceAvailableAt);
          expect(r.resolvedVol - r.exitVol).toBeGreaterThanOrEqual(h.cfg.RetraceWindow * r.BucketVolume_c);
        }
      }
      // Stored classes never change after classification; early-G2 records keep classifiedAt.
      for (const s of h.store.snapshot()) {
        const events = h.resolutions.filter((r) => r.pivot.pivotId === s.pivot.pivotId);
        expect(new Set(events.map((r) => r.gate.cls)).size).toBe(1);
        expect(new Set(events.map((r) => r.gate.classifiedAt)).size).toBe(1);
      }
    }), { seed: 7, numRuns: 60 });
  });
});
