import { describe, expect, it } from 'vitest';
import { realityCheck, stationaryBootstrapIndices } from './reality-check.js';
import { rngStream } from './rng.js';

function gaussian(rng: ReturnType<typeof rngStream>, n: number, mu: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const u = 1 - rng.nextFloat();
    const v = rng.nextFloat();
    out[i] = mu + Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  return out;
}

describe('stationary bootstrap (Politis–Romano)', () => {
  it('mean block length ≈ L; L = 1 ⇒ independent draws', () => {
    const rng = rngStream(7, 'test');
    const n = 200_000;
    for (const L of [1, 4, 10]) {
      const idx = stationaryBootstrapIndices(n, L, rng);
      let blocks = 1;
      for (let t = 1; t < n; t++) if (idx[t] !== (idx[t - 1]! + 1) % n) blocks++;
      // With L = 1 a uniform draw continues the previous block with probability 1/n only.
      expect(n / blocks).toBeCloseTo(L, L === 1 ? 2 : 0);
      for (let t = 0; t < n; t++) expect(idx[t]! >= 0 && idx[t]! < n).toBe(true);
    }
  });

  it('seeded determinism', () => {
    const a = stationaryBootstrapIndices(50, 3, rngStream(1, 'realityCheck'));
    const b = stationaryBootstrapIndices(50, 3, rngStream(1, 'realityCheck'));
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(stationaryBootstrapIndices(50, 3, rngStream(2, 'realityCheck')))).not.toEqual(Array.from(a));
  });
});

describe('White reality check (Spec §6.4)', () => {
  it('a strong edge in the chosen cell ⇒ small p; the null ⇒ p not small; deterministic per seed', () => {
    const rng = rngStream(3, 'data');
    const nullCells = Array.from({ length: 40 }, () => gaussian(rng, 250, 0));
    const edge = gaussian(rng, 250, 0.5);
    const strong = realityCheck([...nullCells, edge], edge, { B: 500, meanBlock: 1, rng: rngStream(1, 'realityCheck') });
    expect(strong.p).toBeLessThan(0.01);
    expect(strong.V).toBeGreaterThan(5);
    // Chosen = the best of 40 null cells (data snooping): the check must not call it significant.
    const means = nullCells.map((c) => c.reduce((s, x) => s + x, 0));
    const best = nullCells[means.indexOf(Math.max(...means))]!;
    const snooped = realityCheck(nullCells, best, { B: 500, meanBlock: 1, rng: rngStream(1, 'realityCheck') });
    expect(snooped.p).toBeGreaterThan(0.1);
    const again = realityCheck(nullCells, best, { B: 500, meanBlock: 1, rng: rngStream(1, 'realityCheck') });
    expect(again).toEqual(snooped);
    expect(realityCheck([], new Float64Array(0), { B: 10, meanBlock: 1, rng: rngStream(1, 'x') }).p).toBeNaN();
  });
});
