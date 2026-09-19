import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BucketHistory } from './buckets.js';
import { RegimeStats } from './regime.js';
import { Ewma, SlidingOrderStats, SortedWindow, medianOf, percentileNearestRank, quickselect } from './stats-util.js';

interface BucketSpec {
  readonly high?: number; readonly low?: number; readonly vwap?: number;
  readonly wall?: number; readonly gap?: number;
}

// Appends buckets back to back in time and returns the history.
function appendAll(h: BucketHistory, specs: readonly BucketSpec[]): void {
  for (const b of specs) {
    const vwap = b.vwap ?? 1000;
    const tOpen = h.completedCount === 0 ? 0 : h.tClose(h.completedCount - 1);
    h.append({
      dayIndex: 0, tOpen, tClose: tOpen + (b.wall ?? 1000), volOpen: 0, volClose: 1,
      High_k: b.high ?? Math.ceil(vwap), Low_k: b.low ?? Math.floor(vwap), Imbalance_k: 0, Vwap_k: vwap, Count_k: 1,
      targetVolume: 1, maxPrintGap_k: b.gap ?? 0,
    });
  }
}

// Feeds each spec as a close to `regime` with fixed VolUnit_now / SpreadEst_t.
function closeAll(
  regime: RegimeStats, h: BucketHistory, specs: readonly BucketSpec[], VolUnit_now = 10, spreads?: readonly number[],
): void {
  specs.forEach((spec, i) => {
    appendAll(h, [spec]);
    regime.onBucketClose(h, h.completedCount - 1, VolUnit_now, spreads?.[i] ?? 1);
  });
}

describe('Ewma', () => {
  it('seeds with the first observation and uses α = 2/(N+1)', () => {
    const e = new Ewma(5);
    expect(e.seeded).toBe(false);
    expect(e.update(4)).toBe(4);
    expect(e.update(10)).toBeCloseTo(6, 12);
    expect(e.alpha).toBeCloseTo(1 / 3, 12);
  });
});

describe('stats-util', () => {
  it('medianOf averages the two middles of an even sample', () => {
    expect(medianOf(Float64Array.from([4, 1, 3, 2]), 4)).toBe(2.5);
    expect(medianOf(Float64Array.from([5, 1, 3]), 3)).toBe(3);
    expect(medianOf(new Float64Array(0), 0)).toBeNaN();
  });

  it('percentileNearestRank uses rank ceil(p·n)', () => {
    const values = Float64Array.from(Array.from({ length: 100 }, (_, i) => 100 - i));
    expect(percentileNearestRank(values.slice(), 100, 0.99)).toBe(99);
    expect(percentileNearestRank(values.slice(), 100, 0.1)).toBe(10);
    expect(percentileNearestRank(Float64Array.from([7]), 1, 0.1)).toBe(7);
  });

  it('property: quickselect agrees with sorting', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -50, max: 50 }), { minLength: 1, maxLength: 200 }), fc.nat(), (xs, r) => {
        const kth = r % xs.length;
        const sorted = [...xs].sort((a, b) => a - b);
        expect(quickselect(Float64Array.from(xs), xs.length, kth)).toBe(sorted[kth]);
      }),
      { seed: 7, numRuns: 300 },
    );
  });

  it('property: SlidingOrderStats.nearestRank matches percentileNearestRank on a sliding FIFO', () => {
    const ops = fc.array(fc.oneof(fc.integer({ min: 1, max: 40 }), fc.constant(0)), { minLength: 1, maxLength: 400 });
    fc.assert(
      fc.property(ops, fc.double({ min: 0, max: 1, noNaN: true }), (xs, pct) => {
        const s = new SlidingOrderStats();
        const window: number[] = [];
        for (const x of xs) {
          if (x === 0 && window.length > 0) expect(s.shift()).toBe(window.shift());   // 0 = pop the oldest
          else if (x > 0) { s.push(x); window.push(x); }
          expect(s.size).toBe(window.length);
          for (const p of [pct, 0.1, 0.5, 0.99, 1]) {
            const expected = window.length === 0 ? NaN : percentileNearestRank(Float64Array.from(window), window.length, p);
            expect(s.nearestRank(p)).toBe(expected);
          }
        }
        s.clear();
        expect(s.size).toBe(0);
        expect(s.nearestRank(0.5)).toBeNaN();
      }),
      { seed: 11, numRuns: 200 },
    );
  });

  it('property: SortedWindow median matches a brute-force rolling median', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.array(fc.integer({ min: 0, max: 30 }), { minLength: 1, maxLength: 300 }),
        (capacity, xs) => {
          const w = new SortedWindow(capacity);
          xs.forEach((x, i) => {
            w.push(x);
            const last = xs.slice(Math.max(0, i + 1 - capacity), i + 1);
            expect(w.size).toBe(last.length);
            expect(w.median()).toBe(medianOf(Float64Array.from(last), last.length));
          });
        },
      ),
      { seed: 11, numRuns: 200 },
    );
  });
});

describe('RegimeStats', () => {
  it('RVol is undefined until the first return, then |log return| on the seed', () => {
    const h = new BucketHistory();
    const r = new RegimeStats();
    closeAll(r, h, [{ vwap: 1000 }]);
    expect(r.RVol_5).toBeNaN();
    closeAll(r, h, [{ vwap: 1010 }]);
    expect(r.RVol_5).toBeCloseTo(Math.log(1010 / 1000), 12);
    expect(r.RVol_60).toBeCloseTo(Math.log(1010 / 1000), 12);
  });

  it('VolRatio is 1 before 60 buckets, RVol_5 / RVol_60 afterwards', () => {
    const h = new BucketHistory();
    const r = new RegimeStats();
    const specs = Array.from({ length: 59 }, (_, i) => ({ vwap: 1000 + (i % 2) * (1 + i) }));
    closeAll(r, h, specs);
    expect(r.VolRatio).toBe(1);
    closeAll(r, h, [{ vwap: 1200 }]);
    expect(r.VolRatio).toBeCloseTo(r.RVol_5 / r.RVol_60, 12);
    expect(r.VolRatio).not.toBe(1);
  });

  it('TrendEfficiency and TrendSign on a hand path, 0 until RegimeWindow + 1 buckets', () => {
    const h = new BucketHistory();
    const r = new RegimeStats({ RegimeWindow: 3 });
    closeAll(r, h, [
      { vwap: 100, high: 101, low: 99 },
      { vwap: 102, high: 103, low: 101 },
      { vwap: 101, high: 102, low: 100 },
    ]);
    expect(r.TrendEfficiency).toBe(0);
    expect(r.TrendSign).toBe(0);
    closeAll(r, h, [{ vwap: 94, high: 95, low: 93 }]);
    // |94 − 100| / (2 + 2 + 2 + 2)
    expect(r.TrendEfficiency).toBeCloseTo(0.75, 12);
    expect(r.TrendSign).toBe(-1);
  });

  it('TrendEfficiency is 0 when the range sum is 0', () => {
    const h = new BucketHistory();
    const r = new RegimeStats({ RegimeWindow: 2 });
    closeAll(r, h, [{ vwap: 100, high: 100, low: 100 }, { vwap: 100, high: 100, low: 100 }, { vwap: 100, high: 100, low: 100 }]);
    expect(r.TrendEfficiency).toBe(0);
  });

  it('BurstFlag on a print gap above 3·VolUnit_now, not at it', () => {
    const h = new BucketHistory();
    const r = new RegimeStats();
    closeAll(r, h, [{ gap: 30 }], 10);
    expect(r.BurstFlag).toBe(false);
    closeAll(r, h, [{ gap: 31 }], 10);
    expect(r.BurstFlag).toBe(true);
  });

  it('BurstFlag on VolRatio > 3', () => {
    const h = new BucketHistory();
    const r = new RegimeStats();
    closeAll(r, h, Array.from({ length: 60 }, (_, i) => ({ vwap: 1000 + (i % 2) })));
    expect(r.BurstFlag).toBe(false);
    closeAll(r, h, [{ vwap: 1100 }]);
    expect(r.VolRatio).toBeGreaterThan(3);
    expect(r.BurstFlag).toBe(true);
  });

  it('LiquidityGuard on SpreadEst_t > 2 × its 1440-close median', () => {
    const h = new BucketHistory();
    const r = new RegimeStats();
    closeAll(r, h, Array.from({ length: 10 }, () => ({})), 10, Array.from({ length: 10 }, () => 2));
    closeAll(r, h, [{}], 10, [4]);
    expect(r.LiquidityGuard).toBe(false);
    closeAll(r, h, [{}], 10, [5]);
    expect(r.LiquidityGuard).toBe(true);
  });

  it('LiquidityGuard on the last 5 buckets taking > 5 × 5 × median WallDuration (A-7)', () => {
    const quiet = Array.from({ length: 20 }, () => ({ wall: 1000 }));
    const h1 = new BucketHistory();
    const r1 = new RegimeStats();
    closeAll(r1, h1, [...quiet, ...Array.from({ length: 5 }, () => ({ wall: 5000 }))]);
    expect(r1.LiquidityGuard).toBe(false);
    const h2 = new BucketHistory();
    const r2 = new RegimeStats();
    closeAll(r2, h2, [...quiet, ...Array.from({ length: 5 }, () => ({ wall: 5001 }))]);
    expect(r2.LiquidityGuard).toBe(true);
  });
});
