import { Engine, type FoldSchedule, type RunConfig } from '@wsr/core';
import { costFloorDiagnostic } from './cost-floor.js';
import { type FoldMetrics, foldMetrics, type FoldMetricsContext } from './fold-metrics.js';
import { PostEntryImbalanceObserver } from './imbalance.js';
import { DEFAULT_STOP_MULTS, DEFAULT_TARGET_MULTS, DEFAULT_TARGET_UNITS, MfeMaeTracker, pathOutcome, type TradePath } from './mfe-mae.js';
import { PLACEBO_STOP_MULT, PLACEBO_TARGET_MULT, PlaceboSweepObserver, placeboSweepConfigFrom } from './placebo-sweep.js';
import { initialInstrument, replay, type ReplayPlan } from './replay.js';
import { buildTradeRecords, decileIn, type TradeRecord } from './trade-record.js';
import { type Fold, type FoldWindow, inWindow, windowOf } from './walk-forward.js';

// Spec §6 pass 2 (the trading replay) of `wsr backtest`, shared by the run
// itself and its `--variants` replays (grid worker `variant` tasks): engine
// with the fold schedule, MFE/MAE tracker, post-entry observer (and the
// placebo-sweep observer for the run), trade records and fold metrics.

export interface TradingPassSpec {
  readonly cfg: RunConfig;
  readonly schedule: FoldSchedule;
  // Per fold: finite, sorted train-window WickLevel scores of the selected model (deciles).
  readonly trainScores: ReadonlyArray<ReadonlyArray<number>>;
  readonly seed: number;
  readonly B: number;
  readonly placebo?: boolean;               // attach the Spec §6.1.4 placebo-sweep observer
  readonly cellId?: string;                 // TradeRecord.cellId (default 'base')
  readonly grid?: TargetGrid;               // tracked (TargetMult, StopMult) grid; default targetGridOf(cfg)
}

export interface TargetGrid {
  readonly TargetMults: number[];
  readonly StopMults: number[];
  readonly TargetUnits: ReadonlyArray<number>;
}

export interface TradingPass {
  readonly engine: Engine;
  readonly paths: TradePath[];
  readonly records: TradeRecord[];
  readonly observer: PostEntryImbalanceObserver;
  readonly placebo: PlaceboSweepObserver | null;
  readonly grid: TargetGrid;
  readonly pathById: ReadonlyMap<number, TradePath>;
  readonly hit: (r: TradeRecord) => boolean;           // path outcome at the configured (TargetMult, StopMult)
}

function withValues(grid: ReadonlyArray<number>, fallback: ReadonlyArray<number>, extra: ReadonlyArray<number>): number[] {
  return [...new Set([...(grid.length > 0 ? grid : fallback), ...extra])].sort((a, b) => a - b);
}

// Tracked (TargetMult, StopMult) grid: config `search.targetGrid` or the Spec
// §6.2 defaults, plus the configured pair, 1 (two-stage table) and (2, 1)
// (placebo-swept test, Spec §6.1.4).
export function targetGridOf(cfg: RunConfig): TargetGrid {
  return {
    TargetMults: withValues(cfg.search.targetGrid.TargetMult, DEFAULT_TARGET_MULTS, [cfg.TargetMult, 1, PLACEBO_TARGET_MULT]),
    StopMults: withValues(cfg.search.targetGrid.StopMult, DEFAULT_STOP_MULTS, [cfg.StopMult, PLACEBO_STOP_MULT]),
    TargetUnits: DEFAULT_TARGET_UNITS,
  };
}

export async function tradingPass(plan: ReplayPlan, folds: ReadonlyArray<Fold>, spec: TradingPassSpec): Promise<TradingPass> {
  const cfg = spec.cfg;
  const grid = spec.grid ?? targetGridOf(cfg);
  const tracker = new MfeMaeTracker(grid);
  const observer = new PostEntryImbalanceObserver();
  const placebo = spec.placebo === true ? new PlaceboSweepObserver(placeboSweepConfigFrom(cfg, plan.spanStart)) : null;
  const engine = Engine.fromConfig(cfg, plan.input.venue, initialInstrument(plan), {
    blacklist: plan.blacklist.blacklist, funding: plan.funding, observers: placebo === null ? [tracker, observer] : [tracker, observer, placebo],
    foldSchedule: spec.schedule,
  });
  await replay(plan, engine);
  // Trades triggered in the warm-up span are excluded from every statistic (Spec §3.2.4).
  const paths = tracker.paths(engine).filter((x) => x.trade.TriggerTime >= plan.spanStart && x.trade.TriggerTime < plan.spanEnd);
  observer.finalize(engine);
  const records = buildTradeRecords({
    engine, paths, observer, folds, trainScores: spec.trainScores, instrument: initialInstrument(plan), StopOffset: cfg.StopOffset,
    ...(spec.cellId === undefined ? {} : { cellId: spec.cellId }),
  });
  const pathById = new Map(paths.map((x) => [x.tradeId, x]));
  const hit = (r: TradeRecord): boolean => pathOutcome(pathById.get(r.tradeId)!, cfg.TargetMult, cfg.StopMult) === 'hit';
  return { engine, paths, records, observer, placebo, grid, pathById, hit };
}

// Which FoldMetrics a sweep point is picked for.
export type WindowRef = { readonly k: number; readonly window: FoldWindow } | 'pooled';

// One FoldMetrics per fold × {train, test}, then the pooled test set; with
// `only` = k just fold k's train and test windows.
export function passFoldMetrics(
  pass: TradingPass, folds: ReadonlyArray<Fold>, spec: TradingPassSpec, sweep?: (w: WindowRef) => FoldMetricsContext['sweep'], only?: number,
): FoldMetrics[] {
  const { engine, observer, records, hit } = pass;
  const cfg = spec.cfg;
  const levels = engine.book?.snapshot().levels ?? [];
  const ruleBinding = ruleBindingOf(engine);
  const metrics = (members: ReadonlyArray<TradeRecord>, foldId: number | 'pooled', window: FoldWindow, from: number, to: number,
    decile: (r: TradeRecord) => number, ref: WindowRef): FoldMetrics => {
    const inSpan = levels.filter((l) => l.createdAt >= from && l.createdAt < to);
    const cf = costFloorDiagnostic(inSpan, []);
    const points = sweep?.(ref);
    const ctx: FoldMetricsContext = {
      foldId, window, from, to, TargetMult: cfg.TargetMult, StopMult: cfg.StopMult, hit,
      decile, volumeDayOf: (r) => observer.trade(r.tradeId)?.volumeDay ?? -1,
      volumeDays: observer.volumeDaysIn(from, to), blacklistedBucketShare: observer.blacklistedBucketShare(from, to),
      killSwitchTrips: observer.killSwitchTripsIn(from, to), ringUnderflow: observer.ringUnderflowIn(from, to), ruleBinding,
      costFloor: { minSweepSetByCost: cf.minSweepSetByCost, shareOfSpikes: cf.shareOfSpikes }, latencyMs: cfg.latencyMs, seed: spec.seed, B: spec.B,
      ...(points === undefined ? {} : { sweep: points }),
    };
    return foldMetrics(members, ctx);
  };
  const out: FoldMetrics[] = [];
  folds.forEach((fold, k) => {
    if (only !== undefined && k !== only) return;
    for (const window of ['train', 'test'] as const) {
      const w = windowOf(fold, window);
      const members = records.filter((r) => inWindow(r.TriggerTime, fold, window));
      out.push(metrics(members, fold.foldId, window, w.from, w.to, (r) => decileIn(spec.trainScores[k]!, r.WickStrength), { k, window }));
    }
  });
  if (only !== undefined) return out;
  // Pooled test: each trade's decile vs the train WickLevels of its own fold.
  out.push(metrics(records.filter((r) => r.foldId >= 0), 'pooled', 'test', folds[0]!.testStart, folds[folds.length - 1]!.testEnd, (r) => r.decile,
    'pooled'));
  return out;
}

// Spec §5 RuleBindingStats: LevelBook, ExecutionModel and post-warm-up engine counters (whole replay).
export function ruleBindingOf(engine: Engine): Record<string, number> {
  return { ...prefixed('book.', engine.book?.counters ?? {}), ...prefixed('engine.', engine.counters), ...prefixed('exec.', engine.exec?.counters ?? {}) };
}

function prefixed(prefix: string, counters: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.keys(counters).sort().map((k) => [`${prefix}${k}`, counters[k]!]));
}
