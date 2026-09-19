import { describe, expect, it } from 'vitest';
import { averageRanks, KahanSum, mean, olsSlope, pearson, percentile, spearman, sum, variance } from './numeric.js';

describe('numeric helpers', () => {
  it('KahanSum is exact where naive summation loses the small terms', () => {
    const xs = [1e16, 1, -1e16];
    expect(xs.reduce((a, b) => a + b, 0)).toBe(0);
    expect(sum(xs)).toBe(1);
    const k = new KahanSum();
    let naive = 0;
    for (let i = 0; i < 1_000_000; i++) {
      k.add(0.1);
      naive += 0.1;
    }
    expect(naive).not.toBe(100_000);
    expect(k.value).toBe(100_000);
  });

  it('mean / variance (n − 1) / empty samples', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(32 / 7, 12);
    expect(mean([])).toBeNaN();
    expect(variance([1])).toBeNaN();
  });

  it('percentile interpolates linearly (type 7)', () => {
    const xs = [4, 1, 3, 2];
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 1)).toBe(4);
    expect(percentile(xs, 0.5)).toBe(2.5);
    expect(percentile(xs, 0.25)).toBe(1.75);
    expect(percentile([], 0.5)).toBeNaN();
    expect(() => percentile(xs, 1.1)).toThrow();
  });

  it('olsSlope recovers a line; NaN without spread in x', () => {
    const x = [1, 2, 3, 4, 5];
    expect(olsSlope(x, x.map((v) => 2 * v + 1))).toBeCloseTo(2, 12);
    expect(olsSlope(x, [2, 1, 4, 3, 6])).toBeCloseTo(1, 12);          // Σdx·dy = 10, Σdx² = 10
    expect(olsSlope([1, 1], [1, 2])).toBeNaN();
  });

  it('Spearman uses average ranks for ties', () => {
    expect(Array.from(averageRanks([10, 20, 20, 30]))).toEqual([1, 2.5, 2.5, 4]);
    expect(spearman([1, 2, 3, 4], [1, 8, 27, 64])).toBeCloseTo(1, 12);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 12);
    expect(spearman([1, 2, 3, 4, 5], [2, 1, 4, 3, 5])).toBeCloseTo(0.8, 12);
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNaN();
  });
});
