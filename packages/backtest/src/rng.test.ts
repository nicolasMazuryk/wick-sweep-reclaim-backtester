import { describe, expect, it } from 'vitest';
import { rngStream, splitmix32, streamHash, Xoshiro128ss } from './rng.js';

describe('PRNG (Spec §9.2)', () => {
  it('xoshiro128** matches the reference output for state (1, 2, 3, 4)', () => {
    const x = new Xoshiro128ss(1, 2, 3, 4);
    expect(Array.from({ length: 10 }, () => x.nextU32())).toEqual([
      11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597, 4258142804,
    ]);
  });

  it('splitmix32 is a fixed uint32 sequence per seed (regression vector)', () => {
    const s = splitmix32(0);
    expect([s(), s(), s()]).toEqual([1684164658, 3653269916, 2939563536]);
    const t = splitmix32(0);
    expect(t()).toBe(1684164658);
  });

  it('rejects an all-zero state', () => {
    expect(() => new Xoshiro128ss(0, 0, 0, 0)).toThrow();
  });

  it('nextFloat ∈ [0, 1), nextInt(n) ∈ [0, n) and roughly uniform', () => {
    const x = rngStream(7, 'test');
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 100_000; i++) {
      const u = x.nextFloat();
      expect(u >= 0 && u < 1).toBe(true);
      counts[x.nextInt(10)]++;
    }
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(500);   // > 5σ
    expect(() => x.nextInt(0)).toThrow();
    expect(new Xoshiro128ss(1, 2, 3, 4).nextInt(1)).toBe(0);
  });

  it('streams depend on (seed, purpose, ids) only — never on creation order', () => {
    const draw = (seed: number, purpose: string, ...ids: number[]): number[] => {
      const r = rngStream(seed, purpose, ...ids);
      return [r.nextU32(), r.nextU32(), r.nextU32()];
    };
    const a = draw(1, 'bootstrap', 0);
    draw(1, 'randomLevels');
    draw(2, 'bootstrap', 0);
    expect(draw(1, 'bootstrap', 0)).toEqual(a);
    expect(draw(1, 'bootstrap', 1)).not.toEqual(a);
    expect(draw(2, 'bootstrap', 0)).not.toEqual(a);
    expect(draw(1, 'randomLevels', 0)).not.toEqual(a);
    expect(draw(1, 'bootstrap', 0, 0)).not.toEqual(a);
    expect(streamHash(1, 'ab', [1])).not.toBe(streamHash(1, 'a', [98, 1]));   // purpose/ids separated
    expect(() => rngStream(1, 'x', -1)).toThrow();
  });

  it('independent streams are uncorrelated', () => {
    const a = rngStream(1, 'workerShard', 0);
    const b = rngStream(1, 'workerShard', 1);
    const n = 20_000;
    let sxy = 0;
    for (let i = 0; i < n; i++) sxy += (a.nextFloat() - 0.5) * (b.nextFloat() - 0.5);
    expect(Math.abs(sxy / n) * 12).toBeLessThan(0.03);                          // corr, σ ≈ 0.007
  });
});
