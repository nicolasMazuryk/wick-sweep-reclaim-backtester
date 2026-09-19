import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Blacklist } from './blacklist.js';
import { fullHarness } from './testing/full-harness.js';
import { syntheticPath } from './testing/replay-harness.js';

const EVENTS = 20_000;
// CI scale (Spec §9.1: 200 paths × 20 cuts) via WSR_PROPERTY_RUNS=200.
const RUNS = Number(process.env.WSR_PROPERTY_RUNS ?? 40);

describe('Engine — Spec §9 look-ahead and determinism properties', () => {
  it('property: truncation (L1–L4) on the full engine — a prefix run hashes equal to the full run at every cut', () => {
    const pathArb = fc.record({
      seed: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
      // Spec §9.1: 20 cut points per path.
      cuts: fc.uniqueArray(fc.integer({ min: 1, max: EVENTS }), { minLength: 20, maxLength: 20 }),
    });
    fc.assert(fc.property(pathArb, ({ seed, cuts }) => {
      const events = syntheticPath(seed, { events: EVENTS });
      const full = fullHarness();
      for (const cut of [...cuts].sort((a, b) => a - b)) {
        full.run(events, cut);
        const prefix = fullHarness().run(events.slice(0, cut));
        expect(prefix.snapshotHash()).toBe(full.snapshotHash());
      }
    }), { seed: 42, numRuns: RUNS });
  });

  it('property: determinism (Spec §9.2) — two independent engines agree at 100 checkpoints and on every trade and transition', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
      const events = syntheticPath(seed, { events: EVENTS });
      const a = fullHarness();
      const b = fullHarness();
      for (let c = 1; c <= 100; c++) {
        const upto = Math.round((c * EVENTS) / 100);
        a.run(events, upto);
        b.run(events, upto);
        expect(a.snapshotHash()).toBe(b.snapshotHash());
      }
      a.finish();
      b.finish();
      expect(b.exec!.trades()).toEqual(a.exec!.trades());
      expect(b.book!.transitions).toEqual(a.book!.transitions);
      expect(b.snapshotHash()).toBe(a.snapshotHash());
    }), { seed: 5, numRuns: Math.max(5, Math.round(RUNS / 4)) });
  });

  it('property: blacklistNoLevels (Spec §2.6.3) — no level from a pivot confirmed in, or with an excursion overlapping, an interval; no arming inside one', () => {
    const arb = fc.record({
      seed: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
      // Unbiased: fast-check's default bias piles intervals onto the path ends (inside warm-up).
      intervals: fc.array(fc.tuple(fc.integer({ min: 0, max: 1_000 }).noBias(), fc.integer({ min: 1_000, max: 1_800_000 }).noBias()), { minLength: 1, maxLength: 8 }),
    });
    let blacklisted = 0;
    fc.assert(fc.property(arb, ({ seed, intervals }) => {
      const events = syntheticPath(seed, { events: EVENTS });
      const t0 = events[0]!.t;
      const span = events[EVENTS - 1]!.t - t0;
      const bl = new Blacklist(intervals.flatMap(([u, len]) => [t0 + Math.floor((u * span) / 1_000), t0 + Math.floor((u * span) / 1_000) + len]));
      const h = fullHarness({ blacklist: bl }).run(events).finish();
      const inside = (a: number, b: number): boolean => bl.overlaps(a, b);
      for (const l of h.book!.snapshot().levels) {
        const s = h.store.byId(l.pivotId)!;
        expect(inside(s.pivot.confirmed_at, s.pivot.confirmed_at)).toBe(false);
        expect(inside(s.features!.EnterTime, s.features!.retraceAvailableAt)).toBe(false);
      }
      for (const s of h.store.snapshot()) {
        if (s.cls === 'WickLevel') expect(inside(s.features!.EnterTime, s.features!.retraceAvailableAt)).toBe(false);
        if (s.note === 'blacklist') {
          blacklisted++;
          expect(s.levelId).toBe(-1);
          // Feature-less rows (burst / early G2 / PendingLimit): [EnterTime, resolution] observed so far (A-86).
          const hit = inside(s.pivot.confirmed_at, s.pivot.confirmed_at) || h.resolutions.some((r) => r.pivot.pivotId === s.pivot.pivotId &&
            inside(r.EnterTime, r.features?.retraceAvailableAt ?? r.resolvedAt));
          expect(hit).toBe(true);
        }
      }
      for (const r of h.book!.transitions) if (r.reason === 'arm') expect(bl.contains(r.t)).toBe(false);
    }), { seed: 23, numRuns: RUNS });
    expect(blacklisted).toBeGreaterThan(0);                 // the property is not vacuous
  });
});
