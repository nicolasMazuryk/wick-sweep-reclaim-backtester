import { sigmoid } from '@wsr/core';
import { describe, expect, it } from 'vitest';
import { fitLogistic, solveSymmetric } from './logistic.js';
import { rngStream } from './rng.js';

function synthetic(n: number, beta0: number, beta: number[], seed = 1): { X: Float64Array[]; y: number[] } {
  const rng = rngStream(seed, 'logistic-test');
  const X: Float64Array[] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = Float64Array.from(beta, () => 2 * rng.nextFloat() - 1);
    const p = sigmoid(beta0 + beta.reduce((s, b, j) => s + b * x[j]!, 0));
    X.push(x);
    y.push(rng.nextFloat() < p ? 1 : 0);
  }
  return { X, y };
}

describe('fitLogistic (Spec §3.7.4: IRLS / Newton, deterministic)', () => {
  it('recovers known coefficients on seeded synthetic data (λ = 0)', () => {
    const truth = [1.5, -2, 0.5];
    const { X, y } = synthetic(20_000, -0.3, truth);
    const fit = fitLogistic(X, y, y.map(() => 1), 0);
    expect(fit.converged).toBe(true);
    expect(fit.iterations).toBeLessThanOrEqual(10);
    // Standard errors ≈ 0.03 at n = 20 000: allow ~5σ.
    expect(Math.abs(fit.beta0 + 0.3)).toBeLessThan(0.15);
    truth.forEach((b, j) => expect(Math.abs(fit.beta[j]! - b)).toBeLessThan(0.15));
  });

  it('λ shrinks β toward 0 but leaves the intercept unpenalised', () => {
    const { X, y } = synthetic(500, 0.8, [2, -1]);
    const w = y.map(() => 1);
    const norm = (b: Float64Array): number => Math.hypot(...b);
    const f0 = fitLogistic(X, y, w, 0);
    const f1 = fitLogistic(X, y, w, 10);
    const f2 = fitLogistic(X, y, w, 1000);
    expect(norm(f1.beta)).toBeLessThan(norm(f0.beta));
    expect(norm(f2.beta)).toBeLessThan(norm(f1.beta));
    const share = y.reduce((s, v) => s + v, 0) / y.length;
    expect(sigmoid(f2.beta0)).toBeCloseTo(share, 1);                // β ≈ 0 ⇒ intercept = logit(ȳ)
  });

  it('weights act as replication: w = 2 equals the row duplicated', () => {
    const { X, y } = synthetic(300, 0, [1, 1], 2);
    const w = y.map((_, i) => (i % 3 === 0 ? 2 : 1));
    const Xd = X.flatMap((x, i) => (i % 3 === 0 ? [x, x] : [x]));
    const yd = y.flatMap((v, i) => (i % 3 === 0 ? [v, v] : [v]));
    const a = fitLogistic(X, y, w, 1);
    const b = fitLogistic(Xd, yd, yd.map(() => 1), 1);
    expect(a.beta0).toBeCloseTo(b.beta0, 8);
    for (let j = 0; j < 2; j++) expect(a.beta[j]).toBeCloseTo(b.beta[j]!, 8);
  });

  it('separable data (λ = 0) terminates with finite coefficients; a constant column does not break the solve', () => {
    const X = Array.from({ length: 40 }, (_, i) => Float64Array.of(i < 20 ? -1 - i / 10 : 1 + i / 10, 0.5));
    const y = X.map((x) => (x[0]! > 0 ? 1 : 0));
    const fit = fitLogistic(X, y, y.map(() => 1), 0);
    expect(fit.iterations).toBeLessThanOrEqual(50);
    expect([fit.beta0, ...fit.beta].every(Number.isFinite)).toBe(true);
    expect(fit.beta[0]).toBeGreaterThan(1);
  });

  it('is deterministic (same inputs ⇒ identical bits); empty input ⇒ zeros', () => {
    const { X, y } = synthetic(200, 0.2, [0.7, -0.4, 1.1], 3);
    const a = fitLogistic(X, y, y.map(() => 1), 1);
    const b = fitLogistic(X, y, y.map(() => 1), 1);
    expect(Array.from(a.beta)).toEqual(Array.from(b.beta));
    expect(a.beta0).toBe(b.beta0);
    expect(fitLogistic([], [], [], 1)).toMatchObject({ beta0: 0, converged: true });
  });

  it('solveSymmetric: Cholesky, then pivoted elimination for an indefinite system', () => {
    const x = solveSymmetric(Float64Array.of(4, 2, 2, 3), Float64Array.of(2, 1), 2)!;
    expect(x[0]).toBeCloseTo(0.5, 12);
    expect(x[1]).toBeCloseTo(0, 12);
    const y = solveSymmetric(Float64Array.of(0, 1, 1, 0), Float64Array.of(3, 5), 2)!;    // not positive definite
    expect(Array.from(y)).toEqual([5, 3]);
  });
});
