import { describe, expect, it } from 'vitest';
import { deflatedSharpe, erfc, expectedMaxSharpe, kurtosis, normCdf, normInv, skewness } from './deflated-sharpe.js';

describe('normal distribution helpers', () => {
  it('Φ at reference points', () => {
    expect(normCdf(0)).toBe(0.5);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021048517795, 14);
    expect(normCdf(-1)).toBeCloseTo(0.15865525393145707, 14);
    expect(normCdf(-5)).toBeCloseTo(2.866515718791939e-7, 18);
    expect(normCdf(-5) / 2.866515718791939e-7).toBeCloseTo(1, 12);
    expect(erfc(3)).toBeCloseTo(2.209049699858544e-5, 17);
    expect(erfc(0.5)).toBeCloseTo(0.4795001221869535, 14);
  });

  it('Φ⁻¹ ∘ Φ round-trips across the range; tails and bounds', () => {
    // Upper tail limited by the spacing of doubles near 1 (Φ(6) = 1 − 1e-9).
    for (const z of [-8, -5, -3, -2.5, -1, -0.1, 0, 0.3, 1.2, 2.2, 4]) expect(normInv(normCdf(z))).toBeCloseTo(z, 9);
    for (const p of [1e-10, 0.001, 0.02425, 0.3, 0.5, 0.9, 0.975, 0.999999]) expect(normCdf(normInv(p)) / p).toBeCloseTo(1, 12);
    expect(normInv(0.975)).toBeCloseTo(1.959963984540054, 12);
    expect(normInv(0)).toBe(-Infinity);
    expect(normInv(1)).toBe(Infinity);
    expect(normInv(1.1)).toBeNaN();
  });

  it('skewness (population moments) and raw kurtosis', () => {
    expect(skewness([1, 2, 3])).toBeCloseTo(0, 15);
    expect(skewness([0, 0, 0, 1])).toBeCloseTo(1.1547005383792515, 14);
    expect(kurtosis([-1, 1, -1, 1])).toBeCloseTo(1, 15);
    expect(kurtosis([0, 0, 0, 1])).toBeCloseTo(2.333333333333333, 14);
    expect(kurtosis([1, 1, 1, 1])).toBeNaN();
  });
});

describe('deflated Sharpe ratio (Spec §6.4)', () => {
  it('hand-worked value', () => {
    const trialSharpes = [0.1, 0.2, 0.3, 0.05, 0.15];
    const V = 0.00925;                                      // sample variance of the trials
    const N = 100;
    const SR0 = Math.sqrt(V) * ((1 - 0.5772) * normInv(1 - 1 / N) + 0.5772 * normInv(1 - 1 / (N * Math.E)));
    const r = deflatedSharpe({ SR: 0.2, nTrades: 250, skew: -0.5, kurt: 4, trialSharpes, N });
    expect(r.VSR).toBeCloseTo(V, 15);
    expect(r.SR0).toBeCloseTo(SR0, 14);
    expect(r.SR0).toBeCloseTo(0.24339, 4);                  // by hand: 0.09618·(0.4228·2.3263 + 0.5772·2.6801)
    const z = ((0.2 - SR0) * Math.sqrt(249)) / Math.sqrt(1 + 0.5 * 0.2 + (3 / 4) * 0.04);
    expect(r.DSR).toBeCloseTo(normCdf(z), 14);
    expect(r.trials).toBe(5);
  });

  it('N ≤ 1 ⇒ SR₀ = 0 (plain probabilistic Sharpe); DSR decreases in N; undefined inputs ⇒ NaN', () => {
    const base = { SR: 0.15, nTrades: 300, skew: 0, kurt: 3, trialSharpes: [0.1, 0.2, NaN, 0.05] };
    expect(expectedMaxSharpe(0.01, 1)).toBe(0);
    const one = deflatedSharpe({ ...base, N: 1 });
    expect(one.SR0).toBe(0);
    expect(one.DSR).toBeCloseTo(normCdf((0.15 * Math.sqrt(299)) / Math.sqrt(1 + 0.5 * 0.0225)), 14);
    const ds = [2, 10, 100, 1296, 3888].map((N) => deflatedSharpe({ ...base, N }).DSR);
    for (let i = 1; i < ds.length; i++) expect(ds[i]!).toBeLessThan(ds[i - 1]!);
    expect(deflatedSharpe({ ...base, N: 10, nTrades: 1 }).DSR).toBeNaN();
    expect(deflatedSharpe({ ...base, N: 10, SR: NaN }).DSR).toBeNaN();
  });
});
