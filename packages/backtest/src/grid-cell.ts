import { Engine, type FoldSchedule, type RunConfig } from '@wsr/core';
import { trainWickScores } from './fold-fit.js';
import type { FoldMetrics } from './fold-metrics.js';
import { PostEntryImbalanceObserver } from './imbalance.js';
import { MfeMaeTracker } from './mfe-mae.js';
import { minStrengthForPassRate } from './min-strength.js';
import { KahanSum, mean } from './numeric.js';
import { initialInstrument, replay, type ReplayPlan } from './replay.js';
import { buildTradeRecords, type TradeRecord } from './trade-record.js';
import { passFoldMetrics, tradingPass, type TradingPassSpec } from './trading-pass.js';
import { type Fold, inWindow } from './walk-forward.js';

// Spec §6.4 grid tasks. Each is one or two full-span replays and a pure
// function of (plan, folds, spec): workers are stateless across tasks (Spec §9.2).

// Fit (pass 1): the reaction-pass engine (Stage A, MinStrength 0, as in
// `wsr backtest`) of one fit group; per fold the MinStrength of every pass
// rate from the train-window WickLevel scores (L10: classifiedAt < trainEnd).
export interface FitSpec {
  readonly kind: 'fit';
  readonly cfg: RunConfig;
  readonly passRates: ReadonlyArray<number>;
}

// Trading replay (pass 2) with the fold schedule of MinStrength (Stage B off, A-48).
export interface CellSpec {
  readonly kind: 'cell';
  readonly cfg: RunConfig;
  readonly MinStrength: ReadonlyArray<number>;   // per fold
}

// One-at-a-time sensitivity: fit then trade in one task (the sensitivity
// parameters change the PivotStore, so no fit can be shared).
export interface SensitivitySpec {
  readonly kind: 'sens';
  readonly cfg: RunConfig;
}

// `wsr backtest --latency-sweep / --slippage-sweep` point (Spec §4.1, §9.4):
// one trading replay of the backtest's own config with one execution
// parameter overridden and the backtest's fold schedule (Stage B included).
export interface PointSpec {
  readonly kind: 'point';
  readonly cfg: RunConfig;
  readonly schedule: FoldSchedule;
}

// `wsr backtest --variants` (A-132): the run's full trading pass with one
// scenario variant's config; returns its FoldMetrics.
export interface VariantSpec extends TradingPassSpec {
  readonly kind: 'variant';
}

export type TaskSpec = FitSpec | CellSpec | SensitivitySpec | PointSpec | VariantSpec;

export interface FitResult {
  readonly kind: 'fit';
  readonly MinStrength: ReadonlyArray<ReadonlyArray<number>>;  // [fold][passRate]
  readonly nTrainWick: ReadonlyArray<number>;                  // per fold
  readonly events: number;
}

// Trade statistics of one window: `trades` = filled trades triggered in the
// window; expectancy and per-trade Sharpe over the realised pnl_bps.
export interface WindowStats {
  readonly trades: number;
  readonly realised: number;
  readonly expectancy_bps: number;
  readonly sharpeTrade_bps: number;
}

// Compact test-window trade (walk-forward composite, DSR, reality check).
export interface OosTrade {
  readonly tradeId: number;
  readonly foldId: number;
  readonly TriggerTime: number;
  readonly volumeDay: number;
  readonly pnl_bps: number;                 // realised trades only
}

export interface CellResult {
  readonly kind: 'cell';
  readonly folds: ReadonlyArray<{ readonly foldId: number; readonly train: WindowStats; readonly test: WindowStats }>;
  readonly oos: ReadonlyArray<OosTrade>;    // tradeId order
  readonly MinStrength: ReadonlyArray<number>;
  readonly events: number;
}

export interface VariantResult {
  readonly kind: 'variant';
  readonly foldMetrics: FoldMetrics[];
}

export type TaskResult = FitResult | CellResult | VariantResult;

export function sharpe(xs: ReadonlyArray<number>): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  const k = new KahanSum();
  for (const x of xs) k.add((x - m) ** 2);
  const sd = Math.sqrt(k.value / (xs.length - 1));
  return sd > 0 ? m / sd : NaN;
}

export function windowStats(records: ReadonlyArray<Pick<TradeRecord, 'pnl_bps' | 'pnl_R'>>): WindowStats {
  const pnl = records.filter((r) => Number.isFinite(r.pnl_bps) && Number.isFinite(r.pnl_R)).map((r) => r.pnl_bps);
  return { trades: records.length, realised: pnl.length, expectancy_bps: mean(pnl), sharpeTrade_bps: sharpe(pnl) };
}

export async function runFitTask(plan: ReplayPlan, folds: ReadonlyArray<Fold>, spec: Omit<FitSpec, 'kind'>): Promise<FitResult> {
  const engine = Engine.fromConfig(spec.cfg, plan.input.venue, initialInstrument(plan), {
    blacklist: plan.blacklist.blacklist, funding: plan.funding,
  });
  await replay(plan, engine);
  const rows = engine.store.snapshot();
  const scores = folds.map((fold) => trainWickScores(rows, fold, null));
  return {
    kind: 'fit',
    MinStrength: scores.map((s) => spec.passRates.map((p) => minStrengthForPassRate(s, p))),
    nTrainWick: scores.map((s) => s.length),
    events: engine.events,
  };
}

// Same schedule as `toFoldSchedule` with Stage B off.
export function stageASchedule(folds: ReadonlyArray<Fold>, MinStrength: ReadonlyArray<number>): FoldSchedule {
  return folds.map((fold, k) => ({ at: k === 0 ? -Infinity : fold.testStart, MinStrength: MinStrength[k]!, stageB: null }));
}

export async function runCellTask(plan: ReplayPlan, folds: ReadonlyArray<Fold>, spec: Omit<CellSpec, 'kind'>): Promise<CellResult> {
  return tradingTask(plan, folds, spec.cfg, stageASchedule(folds, spec.MinStrength), spec.MinStrength);
}

export async function runPointTask(plan: ReplayPlan, folds: ReadonlyArray<Fold>, spec: Omit<PointSpec, 'kind'>): Promise<CellResult> {
  return tradingTask(plan, folds, spec.cfg, spec.schedule, spec.schedule.map((e) => e.MinStrength));
}

async function tradingTask(
  plan: ReplayPlan, folds: ReadonlyArray<Fold>, cfg: RunConfig, schedule: FoldSchedule, MinStrength: ReadonlyArray<number>,
): Promise<CellResult> {
  const spec = { cfg, MinStrength };
  const tracker = new MfeMaeTracker({ TargetMults: [cfg.TargetMult], StopMults: [cfg.StopMult] });
  const observer = new PostEntryImbalanceObserver();
  const instrument = initialInstrument(plan);
  const engine = Engine.fromConfig(cfg, plan.input.venue, instrument, {
    blacklist: plan.blacklist.blacklist, funding: plan.funding, observers: [tracker, observer], foldSchedule: schedule,
  });
  await replay(plan, engine);
  // Warm-up trades are excluded as in `wsr backtest` (Spec §3.2.4).
  const paths = tracker.paths(engine).filter((x) => x.trade.TriggerTime >= plan.spanStart && x.trade.TriggerTime < plan.spanEnd);
  observer.finalize(engine);
  const records = buildTradeRecords({
    engine, paths, observer, folds, trainScores: folds.map(() => []), instrument, StopOffset: spec.cfg.StopOffset,
  });
  const oos: OosTrade[] = [];
  for (const r of records) {
    if (r.foldId < 0 || !Number.isFinite(r.pnl_bps) || !Number.isFinite(r.pnl_R)) continue;
    oos.push({ tradeId: r.tradeId, foldId: r.foldId, TriggerTime: r.TriggerTime, volumeDay: observer.trade(r.tradeId)?.volumeDay ?? -1, pnl_bps: r.pnl_bps });
  }
  return {
    kind: 'cell',
    folds: folds.map((fold) => ({
      foldId: fold.foldId,
      train: windowStats(records.filter((r) => inWindow(r.TriggerTime, fold, 'train'))),
      test: windowStats(records.filter((r) => inWindow(r.TriggerTime, fold, 'test'))),
    })),
    oos, MinStrength: spec.MinStrength, events: engine.events,
  };
}

export async function runSensitivityTask(plan: ReplayPlan, folds: ReadonlyArray<Fold>, spec: Omit<SensitivitySpec, 'kind'>): Promise<CellResult> {
  const fit = await runFitTask(plan, folds, { cfg: spec.cfg, passRates: [spec.cfg.minStrengthPassRate] });
  return runCellTask(plan, folds, { cfg: spec.cfg, MinStrength: fit.MinStrength.map((row) => row[0]!) });
}

export async function runVariantTask(plan: ReplayPlan, folds: ReadonlyArray<Fold>, spec: TradingPassSpec): Promise<VariantResult> {
  const pass = await tradingPass(plan, folds, spec);
  return { kind: 'variant', foldMetrics: passFoldMetrics(pass, folds, spec) };
}

export function executeTask(plan: ReplayPlan, folds: ReadonlyArray<Fold>, spec: TaskSpec): Promise<TaskResult> {
  switch (spec.kind) {
    case 'fit': return runFitTask(plan, folds, spec);
    case 'cell': return runCellTask(plan, folds, spec);
    case 'sens': return runSensitivityTask(plan, folds, spec);
    case 'point': return runPointTask(plan, folds, spec);
    case 'variant': return runVariantTask(plan, folds, spec);
  }
}
