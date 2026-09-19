import { computeConfigHash, type RunConfig } from '@wsr/core';
import { sha256Hex } from '@wsr/data';
import { type GateOutcome, reactionGate, type ReactionGate } from './backtest-run.js';
import { deflatedSharpe, type DsrResult, kurtosis, skewness } from './deflated-sharpe.js';
import { type CellResult, executeTask, type FitResult, type OosTrade, sharpe, type TaskResult, type TaskSpec, type WindowStats } from './grid-cell.js';
import { centreOf, MIN_TRADES_TRAIN, selectPlateau } from './grid-select.js';
import {
  applyCell, BASELINE, type CellParams, cellIdOf, cellIndexOf, configCount, type ConfigCount, enumerateCells, type GridAxes, gridAxes,
  type GridCell, groupIdOf, type Variant, variantConfig, withOverrides,
} from './grid-space.js';
import { readTask, taskKeyOf, writeTask } from './grid-store.js';
import type { GridWorkerData } from './grid-worker.js';
import { KahanSum, mean } from './numeric.js';
import type { ReactionRun, StoredReaction } from './reaction-run.js';
import { realityCheck, type RealityCheckResult } from './reality-check.js';
import type { ReplayInput } from './replay.js';
import { rngStream } from './rng.js';
import { sensitivityPoints, type SensitivityRow } from './sensitivity.js';
import type { Fold, FoldDays } from './walk-forward.js';
import { defaultWorkerCount, type PoolTask, poolRunner, type TaskRunner } from './worker-pool.js';

export const REALITY_CHECK_B = 1000;
export const REALITY_CHECK_MEAN_BLOCK = 1;          // volume-days (Spec §6.4)

export interface GridOptions {
  // runs/{runId}: cells/{taskId}.json|.done are written here (resumable, Spec §10).
  readonly runDir: string;
  readonly folds?: FoldDays;                          // hidden `--folds`
  readonly forcePnl?: boolean;
  readonly B?: number;                                // reaction-test bootstrap (default 2000)
  readonly realityCheckB?: number;                    // default 1000
  readonly minTradesTrain?: number;                   // default 100
  readonly variants?: ReadonlyArray<Variant>;         // default [baseline]
  readonly workers?: number;                          // 0 = in-process; default availableParallelism − 1
  readonly runner?: TaskRunner<TaskSpec, TaskResult>; // overrides `workers`
  readonly workerUrl?: URL;                           // default dist/grid-worker.js
  readonly shouldStop?: () => boolean;
  readonly onProgress?: (p: GridProgress) => void;
  readonly storedReaction?: StoredReaction | null;
  // After the gate passed (or was forced), before any task: run.json for `--run-id`.
  readonly onStart?: (gate: ReactionGate) => Promise<void>;
}

export interface GridProgress {
  readonly phase: 'fit' | 'cell' | 'sensitivity';
  readonly taskId: string;
  readonly done: number;                              // computed so far in this phase
  readonly pending: number;                           // to compute in this phase
}

export interface TaskCounts {
  readonly total: number;
  readonly skipped: number;                           // valid .done found (resume)
  readonly ran: number;
}

export interface GridCellReport {
  readonly variant: string;
  readonly cellId: string;
  readonly params: CellParams;
  readonly MinStrength: ReadonlyArray<number>;        // per fold
  readonly folds: CellResult['folds'];
  readonly oos: PooledStats;
}

export interface PooledStats {
  readonly trades: number;                            // test-window trades
  readonly realised: number;
  readonly expectancy_bps: number;
  readonly sharpeTrade_bps: number;
}

export interface FoldChoice {
  readonly foldId: number;
  readonly admissible: number;
  readonly top: ReadonlyArray<string>;                // cellIds of the top 20 %
  readonly chosen: { readonly cellId: string; readonly params: CellParams } | null;
  readonly train: WindowStats | null;                 // chosen cell, this fold
  readonly test: WindowStats | null;
}

export interface WalkForward {
  readonly variant: string;
  readonly folds: ReadonlyArray<FoldChoice>;
  readonly pooled: PooledStats;                       // each fold's chosen cell on its own test window
}

export interface SensitivityReport {
  readonly centre: { readonly cellId: string; readonly params: CellParams } | null;
  readonly rows: ReadonlyArray<SensitivityRow>;       // base row first
}

export interface GridReport {
  readonly nConfigs: ConfigCount;
  readonly axes: GridAxes;
  readonly variants: ReadonlyArray<Variant>;
  readonly minTradesTrain: number;
  readonly foldDays: FoldDays;
  readonly folds: ReadonlyArray<{ readonly foldId: number; readonly trainFrom: string; readonly testFrom: string; readonly testTo: string }>;
  readonly walkForward: ReadonlyArray<WalkForward>;   // per variant, baseline first
  readonly centre: SensitivityReport['centre'];
  readonly dsr: DsrResult;
  readonly realityCheck: RealityCheckResult & { readonly firstVolumeDay: number };
  readonly cells: ReadonlyArray<GridCellReport>;
}

interface GridCommon {
  readonly reaction: ReactionRun;
  readonly gate: GateOutcome;
  readonly gateReasons: readonly string[];
  readonly foldDays: FoldDays;
  readonly folds: ReadonlyArray<Fold>;
  readonly nConfigs: ConfigCount;
  readonly warnings: readonly string[];
  readonly tasks: TaskCounts;
}

export type GridResult =
  | (GridCommon & { readonly status: 'refused' })
  | (GridCommon & { readonly status: 'interrupted' })
  | (GridCommon & { readonly status: 'complete'; readonly report: GridReport; readonly sensitivity: SensitivityReport });

interface KeyedTask extends PoolTask<TaskSpec> {
  readonly key: string;
}

const DAY_MS = 86_400_000;
const isoDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

function pooledOf(trades: number, oos: ReadonlyArray<OosTrade>): PooledStats {
  const pnl = oos.map((t) => t.pnl_bps);
  return { trades, realised: pnl.length, expectancy_bps: mean(pnl), sharpeTrade_bps: sharpe(pnl) };
}

function oosTradesOf(r: CellResult): number {
  return r.folds.reduce((n, f) => n + f.test.trades, 0);
}

// Spec §6.4 flow: reaction gate → fit tasks (per variant × fit group) →
// cell tasks (per variant × cell) → per-fold plateau and walk-forward →
// sensitivity around the centre of the baseline's fold plateaus → DSR and
// reality check. Tasks with a valid cells/{taskId}.done are not recomputed;
// a stop request leaves the run resumable (`status: 'interrupted'`).
export async function runGrid(input: ReplayInput, cfg: RunConfig, seed: number, opts: GridOptions): Promise<GridResult> {
  const variants = opts.variants ?? [BASELINE];
  if (variants[0]?.id !== BASELINE.id) throw new Error('runGrid: variants must start with the baseline');
  const axes = gridAxes(cfg);
  const nConfigs = configCount(axes, variants);
  const minTradesTrain = opts.minTradesTrain ?? MIN_TRADES_TRAIN;
  const g = await reactionGate(input, cfg, seed, opts);
  const { reaction, gate, gateReasons, foldDays, folds } = g;
  const warnings = g.warnings;
  if (cfg.strengthModel === 'stageB') warnings.push('grid scores with Stage A (A-48); strengthModel stageB applies to `wsr backtest` at the chosen cell only');
  if (minTradesTrain !== MIN_TRADES_TRAIN) warnings.push(`--min-trades-train ${minTradesTrain}: non-default MinTradesTrain (Spec §6.4: ${MIN_TRADES_TRAIN})`);
  const counts = { total: 0, skipped: 0, ran: 0 };
  const common = (): GridCommon => ({ reaction, gate, gateReasons, foldDays, folds, nConfigs, warnings, tasks: { ...counts } });
  if (gate === 'fail') return { ...common(), status: 'refused' };

  // Build every config up front: an out-of-range grid value is a usage error before any replay.
  const cells = enumerateCells(axes);
  const nPass = axes.minStrengthPassRate.length;
  const variantCells = variants.map((v) => {
    const vcfg = variantConfig(cfg, v);
    return cells.map((c) => applyCell(vcfg, c.params));
  });
  await opts.onStart?.(g);

  const plan = reaction.plan;
  const keyBase = {
    venue: input.venue, symbol: input.symbol, span: [plan.spanStart, plan.spanEnd], seed,
    folds: folds.map((f) => [f.trainStart, f.trainEnd, f.testStart, f.testEnd]),
    data: sha256Hex(Buffer.from(JSON.stringify(plan.dataChecksums))),
  };
  const keyOf = (spec: TaskSpec, extra: unknown): string => taskKeyOf({ ...keyBase, kind: spec.kind, configHash: computeConfigHash(spec.cfg), extra });

  const runner = opts.runner ?? defaultRunner(opts, { input, folds, planCfg: cfg }, (spec) => executeTask(plan, folds, spec));
  const stopped = (): boolean => opts.shouldStop?.() === true;
  const runPhase = async <R extends TaskResult>(phase: GridProgress['phase'], tasks: ReadonlyArray<KeyedTask>): Promise<Map<string, R> | null> => {
    const out = new Map<string, R>();
    const pending: KeyedTask[] = [];
    for (const t of tasks) {
      const stored = await readTask<R>(opts.runDir, t.taskId, t.key);
      if (stored.status === 'done') out.set(t.taskId, stored.result);
      else pending.push(t);
      if (stored.status === 'stale') warnings.push(`cells/${t.taskId}: ${stored.reason} — recomputed`);
    }
    counts.total += tasks.length;
    counts.skipped += tasks.length - pending.length;
    if (pending.length === 0) return out;
    const keyById = new Map(pending.map((t) => [t.taskId, t.key]));
    let done = 0;
    const r = await runner.run(pending, {
      shouldStop: stopped,
      onResult: async (taskId, result) => {
        out.set(taskId, await writeTask(opts.runDir, taskId, keyById.get(taskId)!, result as R));
        counts.ran++;
        opts.onProgress?.({ phase, taskId, done: ++done, pending: pending.length });
      },
    });
    return r.stopped ? null : out;
  };

  try {
    // Fit tasks: one per (variant, fit group); MinStrength per fold × pass rate.
    const fitTasks: KeyedTask[] = [];
    variants.forEach((v, vi) => {
      for (let group = 0; group * nPass < cells.length; group++) {
        const spec: TaskSpec = { kind: 'fit', cfg: variantCells[vi]![group * nPass]!, passRates: axes.minStrengthPassRate };
        fitTasks.push({ taskId: `${v.id}.fit.${groupIdOf(group)}`, spec, key: keyOf(spec, spec.passRates) });
      }
    });
    const fits = await runPhase<FitResult>('fit', fitTasks);
    if (fits === null) return { ...common(), status: 'interrupted' };
    variants.forEach((v) => {
      let undefinedFolds = 0;
      let groups = 0;
      for (const [id, f] of fits) {
        if (!id.startsWith(`${v.id}.fit.`)) continue;
        groups++;
        undefinedFolds += f.nTrainWick.filter((n) => n === 0).length;
      }
      if (undefinedFolds > 0) warnings.push(`${v.id}: ${undefinedFolds} of ${groups * folds.length} (fit group, fold) pairs have no scored train WickLevel — MinStrength undefined, nothing arms`);
    });

    // Cell tasks.
    const cellTasks: KeyedTask[] = [];
    variants.forEach((v, vi) => {
      for (const c of cells) {
        const fit = fits.get(`${v.id}.fit.${groupIdOf(c.group)}`)!;
        const MinStrength = fit.MinStrength.map((row) => row[c.cellIndex % nPass]!);
        const spec: TaskSpec = { kind: 'cell', cfg: variantCells[vi]![c.cellIndex]!, MinStrength };
        cellTasks.push({ taskId: `${v.id}.${c.cellId}`, spec, key: keyOf(spec, MinStrength) });
      }
    });
    const results = await runPhase<CellResult>('cell', cellTasks);
    if (results === null) return { ...common(), status: 'interrupted' };
    const resultOf = (v: Variant, c: GridCell): CellResult => results.get(`${v.id}.${c.cellId}`)!;

    const wf = variants.map((v) => walkForwardOf(v, cells, axes, folds, minTradesTrain, (c) => resultOf(v, c)));
    const walkForward = wf.map((x) => x.walkForward);
    const base = walkForward[0]!;
    const chosenTrades = wf[0]!.composite;

    // Sensitivity around the centre of the baseline's fold plateaus.
    const chosenParams = base.folds.flatMap((f) => (f.chosen === null ? [] : [f.chosen.params]));
    const centreParams = centreOf(chosenParams, axes);
    let sensitivity: SensitivityReport = { centre: null, rows: [] };
    if (centreParams === null) {
      warnings.push('no fold has an admissible cell — no plateau centre, sensitivity not run');
    } else {
      const centreCell = cells[cellIndexOf(axes, centreParams)]!;
      const centreCfg = variantCells[0]![centreCell.cellIndex]!;
      const points = sensitivityPoints();
      const sensTasks: KeyedTask[] = points.map((p) => {
        const spec: TaskSpec = { kind: 'sens', cfg: withOverrides(centreCfg, { [p.param]: p.value }, 'sensitivity') };
        return { taskId: p.taskId, spec, key: keyOf(spec, null) };
      });
      const sens = await runPhase<CellResult>('sensitivity', sensTasks);
      if (sens === null) return { ...common(), status: 'interrupted' };
      const centreResult = resultOf(variants[0]!, centreCell);
      const row = (param: SensitivityRow['param'], value: number | null, r: CellResult): SensitivityRow => {
        const s = pooledOf(oosTradesOf(r), r.oos);
        return { param, value, oosTrades: s.trades, expectancy_bps: s.expectancy_bps, sharpeTrade_bps: s.sharpeTrade_bps };
      };
      sensitivity = {
        centre: { cellId: centreCell.cellId, params: centreCell.params },
        rows: [row('base', null, centreResult), ...points.map((p) => row(p.param, p.value, sens.get(p.taskId)!))],
      };
    }

    // DSR on the baseline walk-forward composite; trials = every cell of every variant.
    const trialSharpes: number[] = [];
    const cellReports: GridCellReport[] = [];
    variants.forEach((v) => {
      for (const c of cells) {
        const r = resultOf(v, c);
        const pooled = pooledOf(oosTradesOf(r), r.oos);
        trialSharpes.push(pooled.sharpeTrade_bps);
        cellReports.push({ variant: v.id, cellId: c.cellId, params: c.params, MinStrength: r.MinStrength, folds: r.folds, oos: pooled });
      }
    });
    const pnl = chosenTrades.map((t) => t.pnl_bps);
    const dsr = deflatedSharpe({ SR: sharpe(pnl), nTrades: pnl.length, skew: skewness(pnl), kurt: kurtosis(pnl), trialSharpes, N: nConfigs.N });

    // Reality check on per-volume-day OOS P&L sums.
    const allOos = [...variants.flatMap((v) => cells.map((c) => resultOf(v, c).oos)), chosenTrades];
    let firstDay = Infinity;
    let lastDay = -Infinity;
    for (const list of allOos) {
      for (const t of list) {
        if (t.volumeDay < 0) continue;
        firstDay = Math.min(firstDay, t.volumeDay);
        lastDay = Math.max(lastDay, t.volumeDay);
      }
    }
    const nDays = Number.isFinite(firstDay) ? lastDay - firstDay + 1 : 0;
    const series = (list: ReadonlyArray<OosTrade>): Float64Array => {
      const k = Array.from({ length: nDays }, () => new KahanSum());          // Spec §9.2
      for (const t of list) if (t.volumeDay >= 0) k[t.volumeDay - firstDay]!.add(t.pnl_bps);
      return Float64Array.from(k, (x) => x.value);
    };
    const rc = realityCheck(allOos.slice(0, -1).map(series), series(chosenTrades), {
      B: opts.realityCheckB ?? REALITY_CHECK_B, meanBlock: REALITY_CHECK_MEAN_BLOCK, rng: rngStream(seed, 'realityCheck'),
    });

    const report: GridReport = {
      nConfigs, axes, variants, minTradesTrain, foldDays,
      folds: folds.map((f) => ({ foldId: f.foldId, trainFrom: isoDay(f.trainStart), testFrom: isoDay(f.testStart), testTo: isoDay(f.testEnd - DAY_MS) })),
      walkForward, centre: sensitivity.centre, dsr, realityCheck: { ...rc, firstVolumeDay: Number.isFinite(firstDay) ? firstDay : -1 },
      cells: cellReports,
    };
    return { ...common(), status: 'complete', report, sensitivity };
  } finally {
    if (opts.runner === undefined) await runner.close();
  }
}

function defaultRunner(
  opts: GridOptions, data: GridWorkerData, execute: (spec: TaskSpec) => Promise<TaskResult>,
): TaskRunner<TaskSpec, TaskResult> {
  return poolRunner(opts.workers ?? defaultWorkerCount(), data, execute, opts.workerUrl);
}

// Per fold: plateau over the train objective, the chosen cell and its
// train/test statistics; pooled = the chosen cells' own test windows.
function walkForwardOf(
  v: Variant, cells: ReadonlyArray<GridCell>, axes: GridAxes, folds: ReadonlyArray<Fold>, minTradesTrain: number,
  resultOf: (c: GridCell) => CellResult,
): { readonly walkForward: WalkForward; readonly composite: OosTrade[] } {
  const composite: OosTrade[] = [];
  let trades = 0;
  const choices = folds.map((fold, k): FoldChoice => {
    const sel = selectPlateau(cells.map((c) => {
      const train = resultOf(c).folds[k]!.train;
      return { cellIndex: c.cellIndex, params: c.params, trades: train.trades, expectancy_bps: train.expectancy_bps };
    }), axes, minTradesTrain);
    const top = sel.top.map(cellIdOf);
    if (sel.chosen === null) return { foldId: fold.foldId, admissible: sel.admissible, top, chosen: null, train: null, test: null };
    const cell = cells[cellIndexOf(axes, sel.chosen)]!;
    const r = resultOf(cell);
    trades += r.folds[k]!.test.trades;
    composite.push(...r.oos.filter((t) => t.foldId === fold.foldId));
    return {
      foldId: fold.foldId, admissible: sel.admissible, top, chosen: { cellId: cell.cellId, params: cell.params },
      train: r.folds[k]!.train, test: r.folds[k]!.test,
    };
  });
  return { walkForward: { variant: v.id, folds: choices, pooled: pooledOf(trades, composite) }, composite };
}
