import { Engine, type EngineObserver, type EngineTestOptions, type Level, type MergedEvent, type RunConfig } from '@wsr/core';
import { hitRateOf, MfeMaeTracker } from './mfe-mae.js';
import { minStrengthForPassRate } from './min-strength.js';
import { reactionConfigFrom, ReactionObserver, reactionStats, type ReactionStats } from './reaction.js';
import { rngStream } from './rng.js';
import { SYNTHETIC_INSTRUMENT, SYNTHETIC_TEST, SYNTHETIC_VENUE, syntheticRunConfig } from './synthetic-config.js';
import { randomWalk, type RandomWalkOptions, runStream } from './synthetic.js';

// Spec §11.3 synthetic paths, as run by the acceptance tests and by
// `wsr backtest --synthetic driftless --trades N` (Spec §12.2): a walk from
// UTC midnight at one print per 5 s, warm-up shortened to one UTC day +
// UnitWindow buckets.

export const SYNTHETIC_WALK = { p0: 100_000, t0: Date.UTC(2025, 0, 1), dtMs: 5000, q: 10 } as const;

export interface SyntheticWalkRun {
  readonly cfg: RunConfig;
  readonly observers: EngineObserver[];
  readonly walk: Omit<RandomWalkOptions, 'p0' | 't0' | 'dtMs' | 'q'>;
  readonly stream: number;                  // rngStream(seed, 'walk', stream)
  readonly test?: EngineTestOptions;
  readonly stop?: (engine: Engine) => boolean;   // checked every 1024 prints
}

export function runSyntheticWalk(o: SyntheticWalkRun): { engine: Engine; levels: Level[]; events: number } {
  const engine = Engine.fromConfig(o.cfg, SYNTHETIC_VENUE, SYNTHETIC_INSTRUMENT, {
    test: o.test ?? SYNTHETIC_TEST, MinStrength: minStrengthForPassRate([], o.cfg.minStrengthPassRate), observers: o.observers,
    warmupDone: (e) => e.builder.daysConsumed >= 1 && e.builder.completedCount >= e.cfg.UnitWindow && e.warmupEvents >= 500,
  });
  const walk = randomWalk(rngStream(o.cfg.seed, 'walk', o.stream), { ...SYNTHETIC_WALK, ...o.walk });
  const stop = o.stop;
  let events = 0;
  function* until(): Generator<MergedEvent> {
    for (const e of walk) {
      yield e;
      events++;
      if (stop !== undefined && (events & 1023) === 0 && stop(engine)) return;
    }
  }
  runStream(engine, until());
  const levels: Level[] = [];
  for (let i = 0; engine.book!.byId(i) !== undefined; i++) levels.push(engine.book!.byId(i)!);
  return { engine, levels, events };
}

// σ of a HitRate estimate under H0: HitRate = 1/3.
export function sigmaThird(n: number): number {
  return Math.sqrt((1 / 3) * (2 / 3) / n);
}

export const DRIFTLESS_MAX_EVENTS = 100_000_000;
export const DRIFTLESS_REACTION_EVENTS = 1_000_000;

export interface SyntheticDriftlessResult {
  readonly seed: number;
  readonly events: number;                  // prints of the trade walk
  readonly trades: number;                  // tracked paths
  readonly hits: number;
  readonly unresolved: number;
  readonly HitRate: number;                 // HitRate(2, 1)
  readonly HitRate_0: number;               // 1/3
  readonly sigma: number;                   // under H0
  readonly z: number;                       // (HitRate − 1/3)/σ
  readonly within3Sigma: boolean;
  readonly reactionEvents: number;
  readonly reaction: ReactionStats;         // the gate on a separate walk stream
}

// Driftless walk (A-133): (1) trade walk (stream 0) until `trades` paths plus
// 100 are triggered, paths tracked to resolution (A-54), HitRate(2, 1) vs 1/3
// ± 3σ; (2) reaction test on `reactionEvents` prints of stream 1 and its gate.
export function syntheticDriftless(o: { readonly trades: number; readonly seed: number; readonly B?: number; readonly reactionEvents?: number }): SyntheticDriftlessResult {
  const cfg = syntheticRunConfig({ seed: o.seed });
  const tracker = new MfeMaeTracker({ TargetMults: [2], StopMults: [1], maxSweepLegs: Infinity });
  const run = runSyntheticWalk({
    cfg, observers: [tracker], walk: { events: DRIFTLESS_MAX_EVENTS }, stream: 0, stop: (e) => e.exec!.trades().length >= o.trades + 100,
  });
  const h = hitRateOf(tracker.paths(run.engine), 2, 1);
  const sigma = sigmaThird(h.n);
  const z = (h.HitRate - 1 / 3) / sigma;
  const reactionEvents = o.reactionEvents ?? DRIFTLESS_REACTION_EVENTS;
  const reaction = new ReactionObserver(reactionConfigFrom(cfg));
  runSyntheticWalk({ cfg, observers: [reaction], walk: { events: reactionEvents }, stream: 1 });
  const stats = reactionStats(reaction.observations(), { rng: rngStream(cfg.seed, 'bootstrap', 0), ...(o.B === undefined ? {} : { B: o.B }) });
  return {
    seed: o.seed, events: run.events, trades: h.n, hits: h.hits, unresolved: h.unresolved, HitRate: h.HitRate, HitRate_0: 1 / 3, sigma, z,
    within3Sigma: Math.abs(h.HitRate - 1 / 3) <= 3 * sigma, reactionEvents, reaction: stats,
  };
}
