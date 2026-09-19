import { parseRunConfig, type RunConfig, VENUE_IDS } from '@wsr/core';
import { describe, expect, it } from 'vitest';
import { costFloorDiagnostic } from './cost-floor.js';
import { hitRate0, MfeMaeTracker } from './mfe-mae.js';
import { breakdownBy } from './regime.js';
import { syntheticRunConfig } from './synthetic-config.js';
import { runSyntheticWalk, sigmaThird, syntheticDriftless, type SyntheticDriftlessResult } from './synthetic-run.js';
import { joinTradeOutcomes } from './trade-outcome.js';

// Spec §11.3 synthetic-path acceptance tests (build step 9): must pass before
// any real data is replayed. Same wiring as the smoke run in
// synthetic-engine.test.ts: a walk from UTC midnight at one print per 5 s,
// warm-up shortened to one UTC day + UnitWindow buckets.

const TIMEOUT = 300_000;
const run = runSyntheticWalk;
const sigma3 = sigmaThird;

describe('Spec §11.3 driftless random walk (the `wsr backtest --synthetic driftless` run)', () => {
  const cfg = syntheticRunConfig();
  let r: SyntheticDriftlessResult | undefined;
  it('HitRate(2,1) is within 3σ of 1/3 over ≥ 20 000 trades', () => {
    // Tracked to resolution (A-54): the A-46 cap would censor paths and bias HitRate below 1/3.
    const res = syntheticDriftless({ trades: 20_000, seed: cfg.seed });
    r = res;
    expect(res.trades).toBeGreaterThanOrEqual(20_000);
    expect(res.unresolved / res.trades).toBeLessThan(0.01);                         // only paths still open at the end
    expect(Math.abs(res.HitRate - 1 / 3)).toBeLessThanOrEqual(3 * sigma3(res.trades));
    expect(res.within3Sigma).toBe(true);
    expect(res.HitRate_0).toBe(1 / 3);
  }, TIMEOUT);

  it('E[ReactionDisplacement] ≈ 0 for every level set with overlapping CIs, and the gate fails', () => {
    r ??= syntheticDriftless({ trades: 20_000, seed: cfg.seed });
    const stats = r.reaction;
    // MaxSpikeDuration = ∞ ⇒ every gated spike is fast: no SlowExtreme, set (2) is empty (A-56).
    expect(stats.sets.slow.n).toBe(0);
    const sets = (['wick', 'placebo', 'random'] as const).map((id) => stats.sets[id]);
    for (const s of sets) {
      expect(s.complete).toBeGreaterThan(1_000);
      expect(s.ci95Disp[0]).toBeLessThanOrEqual(0);
      expect(s.ci95Disp[1]).toBeGreaterThanOrEqual(0);
    }
    for (const a of sets) {
      for (const b of sets) expect(Math.max(a.ci95Disp[0], b.ci95Disp[0])).toBeLessThanOrEqual(Math.min(a.ci95Disp[1], b.ci95Disp[1]));
    }
    expect(stats.gate.pass).toBe(false);
    expect(stats.gate.reasons.length).toBeGreaterThan(0);
  }, TIMEOUT);
});

describe('Spec §11.3 drift test: counter-trend asymmetry in byRegime (§12 weakness 3)', () => {
  for (const [drift, stream] of [[0.2, 2], [-0.2, 3]] as const) {
    it(`drift ${drift}: HitRate(trend_counter) < 1/3 < HitRate(trend_aligned), each ≥ 3σ from 1/3`, () => {
      const cfg = syntheticRunConfig();
      const tracker = new MfeMaeTracker();
      const { engine } = run({ cfg, observers: [tracker], walk: { events: 3_000_000, drift }, stream });
      const rows = joinTradeOutcomes(
        engine.exec!.trades(), (id) => engine.book!.byId(id), tracker.paths(engine), { TargetMult: 2, StopMult: 1 },
      );
      const byRegime = new Map(breakdownBy(rows, (r) => r.regime).map((b) => [b.key, b]));
      const counter = byRegime.get('trend_counter')!;
      const aligned = byRegime.get('trend_aligned')!;
      expect([counter.HitRate_0, aligned.HitRate_0]).toEqual([hitRate0(2, 1), hitRate0(2, 1)]);
      expect(counter.HitRate).toBeLessThan(1 / 3 - 3 * sigma3(counter.trades));
      expect(aligned.HitRate).toBeGreaterThan(1 / 3 + 3 * sigma3(aligned.trades));
    }, TIMEOUT);
  }
});

describe('Spec §11.3 cost test: the cost floor sets MinSweepDepth (§12 weakness 1)', () => {
  it('with §7.4 default costs and SweepDepth forced small, > 90 % of Spikes are cost-floored and BreakevenHitRate ≥ 1', () => {
    // Spec §2.2 placeholder fees (5 / 2 bps), SlipTicks / SlipCoef at their defaults.
    const fees = Object.fromEntries(
      VENUE_IDS.map((v) => [v, { TakerFee: 0.0005, MakerFee: 0.0002, verifiedAt: 'placeholder' }]),
    ) as RunConfig['fees'];
    const defaults = parseRunConfig({ fees, data: { lowCapSymbol: 'SYNTHUSDT' } });
    const cfg = syntheticRunConfig({ fees, SlipTicks: defaults.SlipTicks, SlipCoef: defaults.SlipCoef, MinSweepMult: 0.05 });
    const { engine, levels } = run({
      cfg, observers: [], walk: { events: 1_000_000 }, stream: 4, test: { targetOnTouch: true },
    });
    expect(levels.length).toBeGreaterThan(1_000);
    const d = costFloorDiagnostic(levels, engine.exec!.trades(), {
      MinSweepMult: cfg.MinSweepMult, TargetMult: 2, StopMult: 1, roundTripCostTicks: (p) => engine.exec!.roundTripCostTicks(p),
    });
    expect(d.shareOfSpikes).toBeGreaterThan(0.9);
    expect(d.BreakevenAtMultDepth!.n).toBe(levels.length);
    expect(d.BreakevenAtMultDepth!.p50).toBeGreaterThanOrEqual(1);                   // ex-ante, at the unfloored depth (A-55)
  }, TIMEOUT);
});
