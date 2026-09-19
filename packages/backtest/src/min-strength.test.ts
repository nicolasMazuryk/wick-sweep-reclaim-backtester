import { describe, expect, it } from 'vitest';
import { minStrengthForPassRate } from './min-strength.js';

describe('minStrengthForPassRate (Spec §3.7.5)', () => {
  const scores = [0.9, 0.1, 0.5, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6, 1.0];

  it('the (1 − passRate) nearest-rank quantile: at least passRate of the scores pass', () => {
    for (const passRate of [0.3, 0.4, 0.5, 0.6]) {
      const x = minStrengthForPassRate(scores, passRate);
      const pass = scores.filter((y) => y >= x).length / scores.length;
      expect(pass).toBeGreaterThanOrEqual(passRate);
      expect(pass).toBeLessThan(passRate + 0.1 + 1e-9);
    }
    expect(minStrengthForPassRate(scores, 0.4)).toBe(0.6);
  });

  it('passRate 1 ⇒ −∞; non-finite scores ignored; no scores ⇒ NaN', () => {
    expect(minStrengthForPassRate([], 1)).toBe(-Infinity);
    expect(minStrengthForPassRate([NaN, 0.2, 0.4], 0.5)).toBe(0.2);
    expect(minStrengthForPassRate([NaN], 0.5)).toBeNaN();
    expect(() => minStrengthForPassRate(scores, 0)).toThrow();
  });
});
