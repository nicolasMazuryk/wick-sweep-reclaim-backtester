import { Engine } from '@wsr/core';
import { describe, expect, it } from 'vitest';
import { minStrengthForPassRate } from './min-strength.js';
import { type ActualSetup, type PlaceboSetup, PlaceboSweepObserver, placeboSweepConfigFrom, placeboSweptStats } from './placebo-sweep.js';
import { rngStream } from './rng.js';
import { SYNTHETIC_INSTRUMENT, SYNTHETIC_TEST, SYNTHETIC_VENUE, syntheticRunConfig } from './synthetic-config.js';
import { randomWalk, runStream } from './synthetic.js';

// Spec §6.1.4 second, trade-specific test (plan item 8, A-131).

describe('PlaceboSweepObserver (placebo levels swept by construction)', () => {
  it('driftless walk: placebo HitRate(2,1) within 3σ of 1/3; every setup respects the sweep geometry', () => {
    const cfg = syntheticRunConfig();
    const t0 = Date.UTC(2025, 0, 1);
    const obs = new PlaceboSweepObserver({ ...placeboSweepConfigFrom(cfg, t0), maxSweepLegs: Infinity });   // resolve every path (A-54)
    const engine = Engine.fromConfig(cfg, SYNTHETIC_VENUE, SYNTHETIC_INSTRUMENT, {
      test: SYNTHETIC_TEST, MinStrength: minStrengthForPassRate([], cfg.minStrengthPassRate), observers: [obs],
      warmupDone: (e) => e.builder.daysConsumed >= 1 && e.builder.completedCount >= e.cfg.UnitWindow && e.warmupEvents >= 500,
    });
    runStream(engine, randomWalk(rngStream(cfg.seed, 'walk', 7), { events: 2_000_000, p0: 100_000, t0, dtMs: 5000, q: 10 }));
    const { levels, setups } = obs.results();
    expect(levels).toBeGreaterThan(1_000);
    expect(levels % 4).toBe(0);
    expect(setups.length).toBeGreaterThan(1_000);
    const resolved = setups.filter((s) => s.outcome !== 'unresolved');
    expect(setups.length - resolved.length).toBeLessThan(0.01 * setups.length);          // only paths open at the end
    const h = setups.filter((s) => s.outcome === 'hit').length / setups.length;
    expect(Math.abs(h - 1 / 3)).toBeLessThanOrEqual(3 * Math.sqrt((1 / 3) * (2 / 3) / setups.length));
    for (const s of setups) {
      expect(s.SweepDepth).toBeGreaterThan(0);
      expect([-2, -1, 1, 2]).toContain(s.shift);
    }
    for (let i = 1; i < setups.length; i++) expect(setups[i]!.reclaimT).toBeGreaterThanOrEqual(setups[i - 1]!.reclaimT);
  }, 120_000);
});

describe('placeboSweptStats', () => {
  const placebo = (volumeDay: number, outcome: PlaceboSetup['outcome']): PlaceboSetup => ({
    srcPivotId: 0, shift: 1, Side: 1, price: 100, SweepDepth: 5, reclaimT: volumeDay, volumeDay, outcome,
  });

  it('point estimates, paired contrast and the configured-pair CI; unresolved placebo setups are not hits', () => {
    const actual: ActualSetup[] = [];
    const pl: PlaceboSetup[] = [];
    for (let d = 0; d < 40; d++) {
      for (let i = 0; i < 10; i++) actual.push({ volumeDay: d, hit: i < 6, hitConfigured: i < 5 });
      for (let i = 0; i < 10; i++) pl.push(placebo(d, i < 3 ? 'hit' : i < 4 ? 'unresolved' : 'miss'));
    }
    const s = placeboSweptStats(actual, pl, 1_600, { B: 500, rng: rngStream(1, 'placeboSwept'), TargetMult: 1.5, StopMult: 1 });
    expect([s.TargetMult, s.StopMult, s.HitRate_0]).toEqual([2, 1, 1 / 3]);
    expect(s.blocks).toBe(40);
    expect(s.actual).toMatchObject({ n: 400, HitRate: 0.6 });
    expect(s.placebo).toMatchObject({ n: 400, HitRate: 0.3, levels: 1_600, unresolvedShare: 0.1 });
    expect(s.diff.value).toBeCloseTo(0.3, 12);
    // Every block has the same composition ⇒ every resample reproduces the point estimates.
    expect(s.diff.ci95[0]).toBeCloseTo(0.3, 12);
    expect(s.diff.significant).toBe(true);
    expect(s.configured).toMatchObject({ TargetMult: 1.5, StopMult: 1, n: 400, HitRate: 0.5 });
    expect(s.configured.ci95[1]).toBeCloseTo(0.5, 12);
  });

  it('no setups ⇒ NaN statistics and no CI', () => {
    const s = placeboSweptStats([], [], 0, { B: 10, rng: rngStream(1, 'placeboSwept'), TargetMult: 2, StopMult: 1 });
    expect(Number.isNaN(s.actual.HitRate) && Number.isNaN(s.placebo.HitRate)).toBe(true);
    expect(s.diff.ci95.every(Number.isNaN)).toBe(true);
    expect(s.diff.significant).toBe(false);
  });
});
