import { Engine, type MergedEvent } from '@wsr/core';
import { describe, expect, it } from 'vitest';
import { minStrengthForPassRate } from './min-strength.js';
import { rngStream } from './rng.js';
import { SYNTHETIC_INSTRUMENT, SYNTHETIC_OVERRIDES, SYNTHETIC_TEST, SYNTHETIC_VENUE, syntheticRunConfig } from './synthetic-config.js';
import { randomWalk, runStream } from './synthetic.js';

const T0 = Date.UTC(2025, 0, 1);

function walk(seed: number, events: number, drift = 0): MergedEvent[] {
  return [...randomWalk(rngStream(seed, 'walk'), { events, p0: 1000, t0: T0, dtMs: 250, q: 3, drift })];
}

describe('Spec §11.3 random walk', () => {
  it('±1 tick every print, constant size, fixed dt, monotone (t, seq)', () => {
    const path = walk(1, 5000);
    expect(path).toHaveLength(5000);
    let prev = 1000;
    path.forEach((e, i) => {
      expect(Math.abs(e.p - prev)).toBe(1);
      expect([e.t, e.seq, e.q, e.n]).toEqual([T0 + (i + 1) * 250, i, 3, 1]);
      prev = e.p;
    });
  });

  it('driftless: up-share and aggressor share ≈ ½, aggressor independent of the move', () => {
    const path = walk(2, 40_000);
    let up = 0;
    let buy = 0;
    let cov = 0;
    let prev = 1000;
    for (const e of path) {
      const dp = e.p - prev;
      prev = e.p;
      if (dp > 0) up++;
      if (e.s > 0) buy++;
      cov += dp * e.s;
    }
    const n = path.length;
    const sigma = 0.5 / Math.sqrt(n);
    expect(Math.abs(up / n - 0.5)).toBeLessThan(4 * sigma);
    expect(Math.abs(buy / n - 0.5)).toBeLessThan(4 * sigma);
    expect(Math.abs(cov / n)).toBeLessThan(4 / Math.sqrt(n));
  });

  it('drift d gives a mean step of d', () => {
    for (const drift of [0.2, -0.2]) {
      const path = walk(3, 20_000, drift);
      const mean = (path.at(-1)!.p - 1000) / path.length;
      expect(Math.abs(mean - drift)).toBeLessThan(4 / Math.sqrt(path.length));
    }
    expect(() => walk(3, 1, 1)).toThrow();
  });

  it('is deterministic per stream and streams lazily', () => {
    expect(walk(4, 100)).toEqual(walk(4, 100));
    const it = randomWalk(rngStream(4, 'walk'), { events: Number.MAX_SAFE_INTEGER, p0: 0, t0: 0, dtMs: 1, q: 1 });
    expect(it.next().value).toMatchObject({ seq: 0 });
  });
});

describe('syntheticRunConfig (Spec §11.3)', () => {
  it('applies the §11.3 settings after validation; MaxAge stays derived', () => {
    const cfg = syntheticRunConfig({ AgeScale: 300 });
    expect(cfg).toMatchObject(SYNTHETIC_OVERRIDES);
    expect([cfg.MaxAge, cfg.fees[SYNTHETIC_VENUE].TakerFee]).toEqual([900, 0]);
    expect(minStrengthForPassRate([], cfg.minStrengthPassRate)).toBe(-Infinity);
  });

  it('runStream feeds every event and resolves fills in flight', () => {
    const cfg = syntheticRunConfig();
    const e = Engine.fromConfig(cfg, SYNTHETIC_VENUE, SYNTHETIC_INSTRUMENT, { test: SYNTHETIC_TEST });
    runStream(e, walk(5, 1000));
    expect(e.events).toBe(1000);
  });
});
