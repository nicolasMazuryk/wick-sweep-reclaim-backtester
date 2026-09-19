import { computeGateConfigHash, type Engine, type FoldSchedule, type RunConfig, type StoredPivot, type TransitionRecord } from '@wsr/core';
import { dayEndMs, dayStartMs } from '@wsr/data';
import { ReplayInputError } from './blacklist-load.js';
import { type FoldFit, fitFolds, toFoldSchedule, trainWickScores } from './fold-fit.js';
import type { FoldMetrics, SweepPoint } from './fold-metrics.js';
import { type FromGrid, type FromGridFold, runFromGrid } from './from-grid.js';
import { type CellResult, executeTask, type TaskResult, type TaskSpec, type VariantResult } from './grid-cell.js';
import { BASELINE, type ConfigCount, type Variant, variantConfig, withOverrides } from './grid-space.js';
import type { GridWorkerData } from './grid-worker.js';
import { pathOutcome, type TradePath } from './mfe-mae.js';
import { mean } from './numeric.js';
import { PLACEBO_STOP_MULT, PLACEBO_TARGET_MULT, placeboSweptStats } from './placebo-sweep.js';
import { type ReactionRun, reactionKeyOf, runReactionTest, type StoredReaction, storedReactionMatches } from './reaction-run.js';
import type { ReplayInput, ReplayPlan } from './replay.js';
import { rngStream } from './rng.js';
import { targetValidation, type TargetValidation } from './target-validation.js';
import type { TradeRecord } from './trade-record.js';
import { passFoldMetrics, tradingPass, type TradingPassSpec, type WindowRef } from './trading-pass.js';
import { type Fold, FOLD_DAYS, type FoldDays, foldSchedule, inWindow } from './walk-forward.js';
import { defaultWorkerCount, type PoolTask, poolRunner, type TaskRunner } from './worker-pool.js';

// Spec §6.1.6 banners.
export const REFUSED_BANNER = 'REACTION TEST FAILED — P&L backtest not run';
export const FORCED_BANNER = 'P&L run despite failed reaction test (§9.2)';
// No stored reaction.json of the same inputs and no --run-reaction (A-136).
export const NO_REACTION_BANNER = 'NO REACTION TEST OF THESE INPUTS — P&L backtest not run';

export type GateOutcome = 'pass' | 'fail' | 'forced';

// Spec §4.1 latency sweep and §8.2 / §9.4 slippage curve (SlipCoef ×{1, 2, 4}).
export const LATENCY_SWEEP_MS: ReadonlyArray<number> = [0, 50, 150, 500];
export const SLIP_COEF_MULTS: ReadonlyArray<1 | 2 | 4> = [1, 2, 4];

export interface BacktestOptions {
  readonly B?: number;                      // bootstrap resamples (reaction test and mechanism CIs)
  // Hidden `--folds` diagnostic: other fold lengths, F ≥ 12 waived (run.json warning).
  readonly folds?: FoldDays;
  readonly forcePnl?: boolean;
  // runs/{runId}/reaction.json of an earlier `wsr reaction` for the same inputs, if any.
  readonly storedReaction?: StoredReaction | null;
  // `--latency-sweep` / `--slippage-sweep`: one extra trading replay per point (A-130).
  readonly latencySweep?: boolean;
  readonly slippageSweep?: boolean;
  // `--variants`: [baseline, …] from parseVariants; one trading pass per other variant (A-132).
  readonly variants?: ReadonlyArray<Variant>;
  // `--from-grid <runId>`: per-fold grid cell, fitted Stage B and target plateau (A-134).
  readonly fromGrid?: FromGrid;
  readonly workers?: number;                // sweep / variant replays: 0 = in-process; default availableParallelism − 1
  readonly runner?: TaskRunner<TaskSpec, TaskResult>;
}

// stageB.json entry: the fold's model plus fit diagnostics.
export interface StageBReport extends Omit<FoldFit, 'stageB'> {
  readonly model: FoldFit['stageB'];
}

export interface BacktestResult {
  readonly reaction: ReactionRun;
  readonly gate: GateOutcome;
  readonly gateReasons: readonly string[];
  readonly foldDays: FoldDays;
  readonly folds: ReadonlyArray<Fold>;
  // Empty / null when the P&L backtest was refused.
  readonly fits: ReadonlyArray<FoldFit>;
  readonly schedule: FoldSchedule;
  readonly engine: Engine | null;
  readonly paths: ReadonlyArray<TradePath>;
  readonly records: ReadonlyArray<TradeRecord>;
  readonly targetGrid: TargetValidation | null;
  readonly foldMetrics: ReadonlyArray<FoldMetrics>;
  // `--variants`: the other variants' FoldMetrics (folds.json `variants`, keyed `variant`).
  readonly variants: ReadonlyArray<VariantMetrics>;
  readonly stageB: ReadonlyArray<StageBReport>;
  readonly transitions: ReadonlyArray<TransitionRecord>;
  // Spec §6.4 N_configs of this run (one cell; latency points evaluated).
  readonly nConfigs: ConfigCount;
  // `--from-grid`: the cell and target pair of every fold (folds.json schedule); null otherwise.
  readonly fromGrid: ReadonlyArray<FromGridFold> | null;
  readonly warnings: readonly string[];
}

// One scenario variant's trading pass on the run's fold schedule (A-132).
export interface VariantMetrics {
  readonly variant: string;
  readonly overrides: Readonly<Record<string, string | boolean>>;
  readonly folds: ReadonlyArray<FoldMetrics>;
}

export interface ReactionGateOptions {
  readonly B?: number;
  readonly folds?: FoldDays;
  readonly forcePnl?: boolean;
  readonly storedReaction?: StoredReaction | null;
}

export interface ReactionGate {
  readonly reaction: ReactionRun;
  readonly gate: GateOutcome;
  readonly gateReasons: readonly string[];
  readonly foldDays: FoldDays;
  readonly folds: ReadonlyArray<Fold>;
  readonly warnings: string[];              // reaction + fold warnings, FORCED_BANNER when forced
}

// Shared by `wsr backtest` and `wsr grid`: fold schedule (usage errors
// first) → reaction replay (pass 1, Stage A, MinStrength 0) → §6.1.6 gate,
// taken from a stored reaction.json of the same inputs when there is one.
export async function reactionGate(input: ReplayInput, cfg: RunConfig, seed: number, opts: ReactionGateOptions = {}): Promise<ReactionGate> {
  const foldDays = opts.folds ?? FOLD_DAYS;
  const short = opts.folds !== undefined;
  const folds = foldSchedule(dayStartMs(input.from), dayEndMs(input.to), foldDays, { allowShort: short });
  const reaction = await runReactionTest(input, cfg, seed, { B: opts.B ?? 2000 });
  const warnings = [...reaction.warnings];
  if (short) {
    warnings.push(`--folds ${foldDays.train},${foldDays.test},${foldDays.step}: non-standard fold lengths (Spec §6.3: 56/14/14 days), F = ${folds.length}${folds.length < 12 ? ' < 12' : ''}`);
  }

  let gatePass = reaction.result.gate.pass;
  let gateReasons = reaction.result.gate.reasons;
  const stored = opts.storedReaction;
  if (stored !== undefined && stored !== null) {
    const key = reactionKeyOf(input.venue, input.symbol, reaction.result.span, computeGateConfigHash(cfg));
    if (storedReactionMatches(stored, key, reaction.result.B)) {
      gatePass = stored.gate.pass;
      gateReasons = stored.gate.reasons;
    } else {
      warnings.push('stored reaction.json is for other inputs (reactionKey or B mismatch) — gate taken from the fresh reaction test');
    }
  }
  const gate: GateOutcome = gatePass ? 'pass' : opts.forcePnl === true ? 'forced' : 'fail';
  if (gate === 'forced') warnings.push(FORCED_BANNER);
  return { reaction, gate, gateReasons, foldDays, folds, warnings };
}

// Spec §6 order: reactionGate → per-fold fits on the pass-1 PivotStore and
// observations (L10) → trading replay (pass 2) with the fold schedule,
// MFE/MAE tracker and post-entry observer → target validation, trade records
// and fold metrics. Trades are assigned to windows by TriggerTime.
export async function runBacktest(input: ReplayInput, cfg: RunConfig, seed: number, opts: BacktestOptions = {}): Promise<BacktestResult> {
  const B = opts.B ?? 2000;
  const { reaction, gate, gateReasons, foldDays, folds, warnings } = await reactionGate(input, cfg, seed, opts);
  const refused = {
    reaction, gate, gateReasons, foldDays, folds, fits: [], schedule: [], engine: null, paths: [], records: [], targetGrid: null,
    foldMetrics: [], variants: [], stageB: [], transitions: [], nConfigs: backtestConfigCount(1, 1), fromGrid: null, warnings,
  } satisfies BacktestResult;
  if (gate === 'fail') return refused;

  const rows: StoredPivot[] = reaction.engine.store.snapshot();
  const fits = fitFolds(rows, reaction.observations, folds, cfg);
  for (const f of fits) warnings.push(...f.warnings);
  const schedule = toFoldSchedule(folds, fits);
  const stageBOf = (xs: ReadonlyArray<FoldFit>): StageBReport[] => xs.map(({ stageB, ...rest }) => ({ ...rest, model: stageB }));

  if (opts.fromGrid !== undefined) {
    if (opts.latencySweep === true || opts.slippageSweep === true || (opts.variants ?? []).length > 1) {
      throw new ReplayInputError('--from-grid runs without --latency-sweep, --slippage-sweep and --variants (A-134)');
    }
    const fg = await runFromGrid({ input, cfg, seed, B, folds, reaction, configuredFits: fits, fromGrid: opts.fromGrid });
    warnings.push(...fg.warnings);
    return {
      reaction, gate, gateReasons, foldDays, folds, fits: fg.fits, schedule: [], engine: null, paths: fg.paths, records: fg.records,
      targetGrid: fg.targetGrid, foldMetrics: fg.foldMetrics, variants: [], stageB: stageBOf(fg.fits), transitions: [],
      nConfigs: backtestConfigCount(1, 1), fromGrid: fg.folds, warnings,
    };
  }

  const selected = (fit: FoldFit) => (cfg.strengthModel === 'stageB' ? fit.stageB : null);
  const trainScores = folds.map((fold, k) => trainWickScores(rows, fold, selected(fits[k]!)).filter(Number.isFinite).sort((a, b) => a - b));
  const plan = reaction.plan;
  const spec: TradingPassSpec = { cfg, schedule, trainScores, seed, B, placebo: true };
  const pass = await tradingPass(plan, folds, spec);
  const { engine, paths, records, observer, pathById, hit } = pass;

  // Sweep and variant replays (A-130, A-132): same fold schedule, one parameter / scenario rule changed.
  const variants = (opts.variants ?? [BASELINE]).filter((v) => v.id !== BASELINE.id);
  const extra = await runExtraTasks(plan, folds, spec, variants, opts);
  const sweep = extra.sweeps;
  const pick = (w: WindowRef) => (c: CellResult): SweepPoint => (w === 'pooled'
    ? { trades: c.folds.reduce((n, f) => n + f.test.trades, 0), expectancy_bps: mean(c.oos.map((t) => t.pnl_bps)) }
    : c.folds[w.k]![w.window]);
  const foldMetricsList = passFoldMetrics(pass, folds, spec, (w) => ({
    latencyPoints: sweep.latencyPoints.map((x) => ({ latencyMs: x.latencyMs, point: x.result === null ? null : pick(w)(x.result) })),
    slippagePoints: sweep.slippagePoints.map((x) => ({ slipCoefMult: x.slipCoefMult, point: x.result === null ? null : pick(w)(x.result) })),
  }));

  // Spec §6.1.4 second test, pooled test windows: actual setups vs placebo swept levels.
  const pl = pass.placebo!.results();
  const placeboSwept = placeboSweptStats(
    records.filter((r) => r.foldId >= 0).map((r) => ({
      volumeDay: observer.trade(r.tradeId)?.volumeDay ?? -1, hit: pathOutcome(pathById.get(r.tradeId)!, PLACEBO_TARGET_MULT, PLACEBO_STOP_MULT) === 'hit',
      hitConfigured: hit(r),
    })),
    pl.setups.filter((x) => folds.some((f) => inWindow(x.reclaimT, f, 'test'))), pl.levels,
    { B, rng: rngStream(seed, 'placeboSwept'), TargetMult: cfg.TargetMult, StopMult: cfg.StopMult },
  );

  return {
    reaction, gate, gateReasons, foldDays, folds, fits, schedule, engine, paths, records,
    targetGrid: { ...targetValidation(paths, folds, pass.grid, cfg.StopMult), placeboSwept }, foldMetrics: foldMetricsList,
    variants: extra.variants,
    stageB: stageBOf(fits),
    transitions: engine.book?.transitions ?? [], nConfigs: backtestConfigCount(1 + variants.length, sweep.latencyPoints.length), fromGrid: null,
    warnings,
  };
}

// Spec §6.4: N_configs = grid cells × scenario variants × latency points (one cell here).
export function backtestConfigCount(variants: number, latencyPoints: number): ConfigCount {
  return { cells: 1, variants, latencyPoints, N: variants * latencyPoints };
}

interface Sweeps {
  // null result = the run's own replay (the configured point).
  readonly latencyPoints: ReadonlyArray<{ readonly latencyMs: number; readonly result: CellResult | null }>;
  readonly slippagePoints: ReadonlyArray<{ readonly slipCoefMult: 1 | 2 | 4; readonly result: CellResult | null }>;
}

// Latency points = {0, 50, 150, 500} ∪ {configured}; SlipCoef ×{1, 2, 4} at
// the configured latency; one full trading pass per scenario variant. Tasks
// run on the grid worker pool; results are merged by task id, never arrival
// order (Spec §9.2).
async function runExtraTasks(
  plan: ReplayPlan, folds: ReadonlyArray<Fold>, spec: TradingPassSpec, variants: ReadonlyArray<Variant>, opts: BacktestOptions,
): Promise<{ readonly sweeps: Sweeps; readonly variants: VariantMetrics[] }> {
  const { cfg, schedule } = spec;
  const latencies = opts.latencySweep === true ? [...new Set([...LATENCY_SWEEP_MS, cfg.latencyMs])].sort((a, b) => a - b) : [cfg.latencyMs];
  const mults = opts.slippageSweep === true ? SLIP_COEF_MULTS : [1 as const];
  const tasks: PoolTask<TaskSpec>[] = [
    ...latencies.filter((ms) => ms !== cfg.latencyMs).map((ms) => ({
      taskId: `latency.${ms}`, spec: { kind: 'point', cfg: withOverrides(cfg, { latencyMs: ms }, 'latency sweep'), schedule } as const,
    })),
    ...mults.filter((m) => m !== 1).map((m) => ({
      taskId: `slippage.x${m}`, spec: { kind: 'point', cfg: withOverrides(cfg, { SlipCoef: cfg.SlipCoef * m }, 'slippage sweep'), schedule } as const,
    })),
    // Built up front: an invalid variant config is a usage error before any replay.
    ...variants.map((v) => ({
      taskId: `variant.${v.id}`,
      spec: { kind: 'variant', cfg: variantConfig(cfg, v), schedule, trainScores: spec.trainScores, seed: spec.seed, B: spec.B } as const,
    })),
  ];
  const results = new Map<string, TaskResult>();
  if (tasks.length > 0) {
    const data: GridWorkerData = { input: plan.input, folds, planCfg: cfg };
    const runner = opts.runner
      ?? poolRunner<TaskSpec, TaskResult>(Math.min(opts.workers ?? defaultWorkerCount(), tasks.length), data, (s) => executeTask(plan, folds, s));
    try {
      await runner.run(tasks, { onResult: (taskId, r) => { results.set(taskId, r); } });
    } finally {
      if (opts.runner === undefined) await runner.close();
    }
  }
  return {
    sweeps: {
      latencyPoints: latencies.map((ms) => ({ latencyMs: ms, result: ms === cfg.latencyMs ? null : results.get(`latency.${ms}`) as CellResult })),
      slippagePoints: mults.map((m) => ({ slipCoefMult: m, result: m === 1 ? null : results.get(`slippage.x${m}`) as CellResult })),
    },
    variants: variants.map((v) => ({
      variant: v.id, overrides: v.overrides, folds: (results.get(`variant.${v.id}`) as VariantResult).foldMetrics,
    })),
  };
}
