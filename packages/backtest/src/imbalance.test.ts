import { Engine } from '@wsr/core';
import { describe, expect, it } from 'vitest';
import { PostEntryImbalanceObserver } from './imbalance.js';
import { rngStream } from './rng.js';
import { SYNTHETIC_INSTRUMENT, SYNTHETIC_TEST, SYNTHETIC_VENUE, syntheticRunConfig } from './synthetic-config.js';
import { randomWalk, runStream } from './synthetic.js';

describe('PostEntryImbalanceObserver — TradeRing underflow per window (Spec §3.1)', () => {
  it('each underflow is timed at its bucket close; windows partition the count', () => {
    const cfg = syntheticRunConfig();
    const observer = new PostEntryImbalanceObserver();
    const engine = Engine.fromConfig(cfg, SYNTHETIC_VENUE, SYNTHETIC_INSTRUMENT, {
      test: SYNTHETIC_TEST, observers: [observer], ringCapacity: 1 << 10,
      warmupDone: (e) => e.builder.daysConsumed >= 1 && e.builder.completedCount >= e.cfg.UnitWindow && e.warmupEvents >= 500,
    });
    const t0 = Date.UTC(2025, 0, 1);
    runStream(engine, randomWalk(rngStream(cfg.seed, 'walk'), { events: 40_000, p0: 100_000, t0, dtMs: 5000, q: 10 }));
    const n = engine.counters.ringUnderflow;
    expect(n).toBeGreaterThan(0);
    const mid = t0 + 36 * 3_600_000;
    expect(observer.ringUnderflowIn(-Infinity, Infinity)).toBe(n);
    expect(observer.ringUnderflowIn(-Infinity, mid) + observer.ringUnderflowIn(mid, Infinity)).toBe(n);
  });
});
