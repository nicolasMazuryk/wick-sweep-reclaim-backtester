import { describe, expect, it } from 'vitest';
import { BlockIndex, blockBootstrap, BlockSums, excludesZero, percentileCI, resampleBlockCounts } from './bootstrap.js';
import { rngStream } from './rng.js';

describe('block bootstrap (Spec §6.1.4)', () => {
  it('a resample draws nBlocks blocks with replacement; deterministic per stream', () => {
    const a = resampleBlockCounts(50, rngStream(1, 'bootstrap', 0));
    expect(a.reduce((x, y) => x + y, 0)).toBe(50);
    expect(Array.from(resampleBlockCounts(50, rngStream(1, 'bootstrap', 0)))).toEqual(Array.from(a));
    expect(Array.from(resampleBlockCounts(50, rngStream(1, 'bootstrap', 1)))).not.toEqual(Array.from(a));
  });

  it('BlockIndex maps block keys to dense ascending indices', () => {
    const b = new BlockIndex([7, 3, 7, 12]);
    expect([b.size, b.of(3), b.of(7), b.of(12)]).toEqual([3, 0, 1, 2]);
    expect(() => b.of(4)).toThrow();
  });

  it('BlockSums: count-weighted sums and ratios; null counts = the point estimate', () => {
    const s = new BlockSums(2, 3, 2);
    s.add(0, 0, 0, 1); s.add(0, 0, 1, 4);
    s.add(0, 2, 0, 2); s.add(0, 2, 1, 2);
    expect(s.ratio(0, 1, 0, null)).toBe(2);
    expect(s.ratio(0, 1, 0, [3, 0, 0])).toBe(4);
    expect(s.weighted(0, 1, [1, 5, 2])).toBe(8);
    expect(s.ratio(1, 1, 0, null)).toBeNaN();
  });

  it('the 95 % CI of a block mean covers the true mean and paired contrasts cancel shared block effects', () => {
    const rng = rngStream(3, 'data');
    const nBlocks = 60;
    const s = new BlockSums(2, nBlocks, 2);
    for (let b = 0; b < nBlocks; b++) {
      const shift = rng.nextFloat() - 0.5;                   // block effect shared by both rows
      for (let i = 0; i < 20; i++) {
        const x = 0.5 + shift + (rng.nextFloat() - 0.5);
        s.add(0, b, 0, 1); s.add(0, b, 1, x);
        s.add(1, b, 0, 1); s.add(1, b, 1, x + 0.1);
      }
    }
    const samples = blockBootstrap(nBlocks, 1000, rngStream(3, 'bootstrap', 0), (c) => {
      const m0 = s.ratio(0, 1, 0, c);
      return [m0, s.ratio(1, 1, 0, c) - m0];
    });
    const ci = percentileCI(samples[0]!);
    expect(ci[0]).toBeLessThan(0.5);
    expect(ci[1]).toBeGreaterThan(0.5);
    const diff = percentileCI(samples[1]!);
    expect(diff[0]).toBeCloseTo(0.1, 9);
    expect(diff[1]).toBeCloseTo(0.1, 9);
    expect(excludesZero(diff)).toBe(true);
    const again = blockBootstrap(nBlocks, 1000, rngStream(3, 'bootstrap', 0), (c) => [s.ratio(0, 1, 0, c)]);
    expect(Array.from(again[0]!)).toEqual(Array.from(samples[0]!));
  });

  it('percentileCI skips non-finite resamples; excludesZero', () => {
    expect(percentileCI([NaN, 1, 2, 3, NaN], 0.5)).toEqual([1.5, 2.5]);
    expect(percentileCI([NaN])).toEqual([NaN, NaN]);
    expect([excludesZero([0.1, 2]), excludesZero([-2, -0.1]), excludesZero([-1, 1]), excludesZero([0, 1]), excludesZero([NaN, NaN])])
      .toEqual([true, true, false, false, false]);
  });
});
