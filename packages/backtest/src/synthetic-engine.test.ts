import { canonicalJson, Engine, type Level } from '@wsr/core';
import { describe, expect, it } from 'vitest';
import { costFloorDiagnostic } from './cost-floor.js';
import { hitRateOf, MfeMaeTracker, targetGridTable } from './mfe-mae.js';
import { minStrengthForPassRate } from './min-strength.js';
import { reactionConfigFrom, ReactionObserver, reactionStats } from './reaction.js';
import { breakdownBy } from './regime.js';
import { rngStream } from './rng.js';
import { SYNTHETIC_INSTRUMENT, SYNTHETIC_TEST, SYNTHETIC_VENUE, syntheticRunConfig } from './synthetic-config.js';
import { randomWalk, runStream } from './synthetic.js';
import { joinTradeOutcomes } from './trade-outcome.js';

// Smoke run of the Spec §11.3 wiring (the §11.3 acceptance tests, build step 9,
// live in synthetic-acceptance.test.ts): a driftless walk from UTC midnight at
// one print per 5 s. Warm-up is shortened to one UTC day (Vol100ms is an
// hour-of-day profile, so a full prior day is needed for non-trivial sizing)
// + UnitWindow buckets.
function run(events: number) {
  const cfg = syntheticRunConfig();
  const tracker = new MfeMaeTracker({ TargetMults: cfg.search.targetGrid.TargetMult, StopMults: cfg.search.targetGrid.StopMult });
  const reaction = new ReactionObserver(reactionConfigFrom(cfg));
  const engine = Engine.fromConfig(cfg, SYNTHETIC_VENUE, SYNTHETIC_INSTRUMENT, {
    test: SYNTHETIC_TEST, MinStrength: minStrengthForPassRate([], cfg.minStrengthPassRate), observers: [tracker, reaction],
    warmupDone: (e) => e.builder.daysConsumed >= 1 && e.builder.completedCount >= e.cfg.UnitWindow && e.warmupEvents >= 500,
  });
  runStream(engine, randomWalk(rngStream(cfg.seed, 'walk'), { events, p0: 100_000, t0: Date.UTC(2025, 0, 1), dtMs: 5000, q: 10 }));
  const levels: Level[] = [];
  for (let i = 0; engine.book!.byId(i) !== undefined; i++) levels.push(engine.book!.byId(i)!);
  return { cfg, engine, tracker, reaction, levels };
}

describe('synthetic driftless walk through Engine.fromConfig with the §11.3 settings (smoke)', () => {
  const EVENTS = 60_000;
  const a = run(EVENTS);

  it('produces trades, tracked paths and all reaction-test level sets', () => {
    const trades = a.engine.exec!.trades();
    const paths = a.tracker.paths(a.engine);
    expect(trades.length).toBeGreaterThan(0);
    expect(paths.map((x) => x.tradeId)).toEqual(trades.filter((tr) => tr.entry !== null).map((tr) => tr.tradeId));
    for (const tr of trades) {
      expect([tr.RoundTripCost_bps, tr.entry!.halfSpread, tr.entry!.Slippage]).toEqual([tr.exit ? 0 : NaN, 0, 0]);
    }
    expect(hitRateOf(paths, 2, 1).n).toBe(paths.length);
    expect(targetGridTable(paths, a.tracker.TargetMults, a.tracker.StopMults)).toHaveLength(28);
    const obs = a.reaction.observations();
    for (const setId of ['wick', 'placebo', 'random'] as const) {
      expect(obs.filter((o) => o.level.setId === setId && o.complete).length).toBeGreaterThan(10);
    }
    const stats = reactionStats(obs, { B: 50, rng: rngStream(a.cfg.seed, 'bootstrap', 0) });
    expect(stats.sets.wick.complete).toBeGreaterThan(0);
    const rows = joinTradeOutcomes(trades, (id) => a.engine.book!.byId(id), paths, { TargetMult: 2, StopMult: 1 });
    expect(breakdownBy(rows, (r) => r.regime).reduce((n, b) => n + b.trades, 0)).toBe(rows.length);
    expect(costFloorDiagnostic(a.levels, trades).minSweepSetByCost).toBe(0);                // zeroCosts: the floor never binds
  });

  it('property: L9 reactionSetIncludesInvalidated — set 1 holds every WickLevel of the PivotStore, including later INVALIDATED / EXPIRED / RETIRED ones', () => {
    const wickIds = a.engine.store.snapshot().filter((r) => r.cls === 'WickLevel').map((r) => r.pivot.pivotId);
    const set1 = a.reaction.observations().filter((o) => o.level.setId === 'wick').map((o) => o.level.srcPivotId);
    expect(set1).toEqual(wickIds);
    const terminal = a.engine.store.snapshot().filter((r) => r.cls === 'WickLevel' && r.finalState !== null && r.finalState !== 'CLOSED');
    expect(terminal.some((r) => r.finalState === 'INVALIDATED')).toBe(true);
    for (const r of terminal) expect(set1).toContain(r.pivot.pivotId);
  });

  it('property: L12 randomLevelCausal — every random level is drawn at or before its source approach', () => {
    const obs = a.reaction.observations();
    const approachOf = new Map(obs.filter((o) => o.level.setId === 'wick').map((o) => [o.level.srcPivotId, o.approachT]));
    const random = obs.filter((o) => o.level.setId === 'random');
    expect(random.length).toBeGreaterThan(0);
    for (const o of random) expect(o.level.availableAt).toBeLessThanOrEqual(approachOf.get(o.level.srcPivotId)!);
  });

  it('two runs are byte-identical (Spec §9.2)', () => {
    const b = run(EVENTS);
    expect(b.engine.snapshotHash()).toBe(a.engine.snapshotHash());
    const out = (x: typeof a): string => canonicalJson({
      paths: x.tracker.paths(x.engine).map((p) => ({ ...p, trade: p.trade.tradeId })),
      reaction: x.reaction.observations(),
    });
    expect(out(b)).toBe(out(a));
  });
});
