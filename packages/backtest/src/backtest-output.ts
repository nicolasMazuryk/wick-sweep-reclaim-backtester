import { join } from 'node:path';
import { FEATURE_NAMES, type Level, type StoredPivot, type TransitionRecord } from '@wsr/core';
import { atomicWriteFile, type RecordColumn, type RecordColumnType, writeRecordsParquet } from '@wsr/data';
import type { BacktestResult } from './backtest-run.js';
import type { FoldMetrics } from './fold-metrics.js';
import { reportValue, runDirOf, type RunManifest, toReportJson } from './output.js';
import { loadReportInputs, renderReport } from './report.js';
import type { TradeRecord } from './trade-record.js';

export interface BacktestOutputPaths {
  readonly runDir: string;
  readonly files: Readonly<Record<string, string>>;         // file name → path, in write order
}

type Column<R> = readonly [name: string, type: RecordColumnType, value: (r: R) => number | boolean | string | null];

// trades.parquet columns: TradeRecord flattened (`exit.kind` → `exit_kind`,
// `caps.g` → `caps_g`); firstPassage as a JSON utf8 column.
const TRADE_COLUMNS: ReadonlyArray<Column<TradeRecord>> = [
  ['tradeId', 'int', (r) => r.tradeId], ['levelId', 'int', (r) => r.levelId], ['Side', 'int', (r) => r.Side],
  ['foldId', 'int', (r) => r.foldId], ['cellId', 'utf8', (r) => r.cellId],
  ['WickLevel', 'int', (r) => r.WickLevel], ['SweepExtreme', 'int', (r) => r.SweepExtreme], ['SweepDepth', 'int', (r) => r.SweepDepth],
  ['VolUnit_created', 'float', (r) => r.VolUnit_created], ['VolUnit_now', 'float', (r) => r.VolUnit_now],
  ['WickStrength', 'float', (r) => r.WickStrength], ['WickStrength_0', 'float', (r) => r.WickStrength_0],
  ['WickStrength_B', 'float', (r) => r.WickStrength_B], ['decile', 'int', (r) => r.decile],
  ['WickStrength_sweep', 'float', (r) => r.WickStrength_sweep],
  ['TriggerTime', 'int', (r) => r.TriggerTime], ['FillTime', 'int', (r) => r.FillTime], ['EntryFill', 'int', (r) => r.EntryFill],
  ['Qty', 'float', (r) => r.Qty], ['FilledQty', 'float', (r) => r.FilledQty],
  ['touchAndReverse', 'bool', (r) => r.touchAndReverse], ['touchAndFly', 'bool', (r) => r.touchAndFly], ['burst', 'bool', (r) => r.burst],
  ['noPrintFallback', 'bool', (r) => r.noPrintFallback], ['StopLoss', 'int', (r) => r.StopLoss], ['Target', 'int', (r) => r.Target],
  ['exit_kind', 'utf8', (r) => r.exit.kind], ['exit_t', 'int', (r) => r.exit.t], ['exit_price', 'int', (r) => r.exit.price],
  ['exit_pnl_bps', 'float', (r) => r.exit.pnl_bps],
  ['exitOpt_kind', 'utf8', (r) => r.exitOpt.kind], ['exitOpt_t', 'int', (r) => r.exitOpt.t], ['exitOpt_price', 'int', (r) => r.exitOpt.price],
  ['exitOpt_pnl_bps', 'float', (r) => r.exitOpt.pnl_bps],
  ['exitPartial_kind', 'utf8', (r) => r.exitPartial?.kind ?? 'none'], ['exitPartial_t', 'int', (r) => r.exitPartial?.t ?? null],
  ['exitPartial_price', 'int', (r) => r.exitPartial?.price ?? null],
  ['MFE', 'float', (r) => r.MFE], ['MAE', 'float', (r) => r.MAE],
  ['firstPassage', 'utf8', (r) => JSON.stringify(reportValue(r.firstPassage))],
  ['holdBuckets', 'float', (r) => r.holdBuckets], ['RoundTripCost_bps', 'float', (r) => r.RoundTripCost_bps],
  ['fundingAccrued_bps', 'float', (r) => r.fundingAccrued_bps], ['pnl_bps', 'float', (r) => r.pnl_bps], ['pnl_R', 'float', (r) => r.pnl_R],
  ['BreakevenHitRate', 'float', (r) => r.BreakevenHitRate], ['regime', 'utf8', (r) => r.regime],
  ['TrendEfficiency', 'float', (r) => r.TrendEfficiency], ['hourOfDay', 'int', (r) => r.hourOfDay],
  ['SweepCount', 'float', (r) => r.SweepCount], ['PriorTouches', 'float', (r) => r.PriorTouches],
  ['ReturnSpeed', 'float', (r) => r.ReturnSpeed], ['ReturnImbalance', 'float', (r) => r.ReturnImbalance],
  ['postEntryImbalance2', 'float', (r) => r.postEntryImbalance2],
  ['caps_g', 'float', (r) => r.caps.g], ['caps_counterTrendHalved', 'bool', (r) => r.caps.counterTrendHalved],
  ['caps_liquidityCap', 'bool', (r) => r.caps.liquidityCap], ['caps_minQty', 'bool', (r) => r.caps.minQty],
];

const TRANSITION_COLUMNS: ReadonlyArray<Column<TransitionRecord>> = [
  ['t', 'int', (r) => r.t], ['seq', 'int', (r) => r.seq], ['levelId', 'int', (r) => r.levelId],
  ['from', 'utf8', (r) => r.from], ['to', 'utf8', (r) => r.to], ['reason', 'utf8', (r) => r.reason],
];

// levels.parquet: one row per level of the trading replay with its terminal
// State / stateReason (Spec §7.1); −1 = not set.
const LEVEL_COLUMNS: ReadonlyArray<Column<Level>> = [
  ['levelId', 'int', (l) => l.levelId], ['pivotId', 'int', (l) => l.pivotId], ['Side', 'int', (l) => l.Side],
  ['WickLevel', 'int', (l) => l.WickLevel], ['VolUnit_created', 'float', (l) => l.VolUnit_created],
  ['WickStrength', 'float', (l) => l.WickStrength], ['WickStrength_0', 'float', (l) => l.WickStrength_0],
  ['WickStrength_B', 'float', (l) => l.WickStrength_B], ['createdAt', 'int', (l) => l.createdAt], ['ExitTime', 'int', (l) => l.ExitTime],
  ['State', 'utf8', (l) => l.State], ['stateSince', 'int', (l) => l.stateSince], ['stateReason', 'utf8', (l) => l.stateReason],
  ['SweepExtreme', 'int', (l) => l.SweepExtreme], ['SweepDepth', 'int', (l) => l.SweepDepth],
  ['PriorTouches', 'int', (l) => l.PriorTouches], ['SweepCount', 'int', (l) => l.SweepCount], ['UseCount', 'int', (l) => l.UseCount],
  ['MinSweepDepth', 'int', (l) => l.MinSweepDepth], ['BreakoutDepth', 'int', (l) => l.BreakoutDepth],
  ['minSweepFloorBinding', 'utf8', (l) => l.minSweepFloorBinding], ['WickStrength_sweep', 'float', (l) => l.WickStrength_sweep],
  ['trades', 'utf8', (l) => JSON.stringify(l.trades)],
];

// pivots.parquet: the full PivotStore (Spec §7.1); features and ranks flattened.
const FEATURE_KEYS = [
  'SpikeSize', 'ApproachVolume', 'RejectVolume', 'ApproachDuration', 'RejectDuration', 'ApproachSpeed', 'RejectSpeed', 'SpeedAsymmetry',
  'ApproachImbalance', 'RejectImbalance', 'VolumeBurst', 'TopDwell', 'RetraceFraction', 'MaxTradeSize', 'MaxAggressorRun', 'MaxPrintGap',
  'EnterTime', 'ExitTime', 'Anchor', 'BandEdge', 'retraceAvailableAt',
] as const;
const PIVOT_COLUMNS: ReadonlyArray<Column<StoredPivot>> = [
  ['pivotId', 'int', (r) => r.pivot.pivotId], ['kind', 'utf8', (r) => r.pivot.kind], ['side', 'int', (r) => r.pivot.side],
  ['price', 'int', (r) => r.pivot.price], ['time', 'int', (r) => r.pivot.time], ['seq', 'int', (r) => r.pivot.seq],
  ['confirmed_at', 'int', (r) => r.pivot.confirmed_at], ['confirmedVol', 'float', (r) => r.pivot.confirmedVol],
  ['cls', 'utf8', (r) => r.cls], ['failed', 'utf8', (r) => r.failed.join(',')], ['classifiedAt', 'int', (r) => r.classifiedAt],
  ['featuresAvailable', 'bool', (r) => r.featuresAvailable],
  ...FEATURE_KEYS.map((k): Column<StoredPivot> => [`f_${k}`, 'float', (r) => (r.features === null ? null : r.features[k])]),
  ...FEATURE_NAMES.map((k, i): Column<StoredPivot> => [`rank_${k}`, 'float', (r) => (r.ranks === null ? null : r.ranks[i]!)]),
  ['WickStrength_0', 'float', (r) => r.WickStrength_0], ['WickStrength_B', 'float', (r) => r.WickStrength_B],
  ['levelId', 'int', (r) => r.levelId], ['note', 'utf8', (r) => r.note], ['finalState', 'utf8', (r) => r.finalState],
  ['reason', 'utf8', (r) => r.reason], ['VolUnit_created', 'float', (r) => r.VolUnit_created], ['availableVol', 'float', (r) => r.availableVol],
];

function columnsOf<R>(spec: ReadonlyArray<Column<R>>, rows: ReadonlyArray<R>): RecordColumn[] {
  return spec.map(([name, type, value]) => ({ name, type, values: rows.map(value) }));
}

// Spec §8.3: every Parquet output carries wsr.configHash, wsr.seed, wsr.runId.
function parquetMetadata(manifest: RunManifest): Record<string, string> {
  return { 'wsr.configHash': manifest.configHash, 'wsr.runId': manifest.runId, 'wsr.seed': String(manifest.seed) };
}

export interface BacktestOutputOptions {
  // Data root of the run: report §1 reads the span's hygiene reports from it.
  readonly dataRoot?: string;
}

// runs/{runId}/: run.json, reaction.json and report.md always; with a P&L
// run also trades.jsonl, trades.parquet, transitions.parquet, levels.parquet,
// pivots.parquet, folds.json, target_grid.json and stageB.json. Each file is
// written atomically; report.md last, rendered from the files just written
// (the same path as `wsr report`, so both give identical bytes).
export async function writeBacktestOutputs(
  runsRoot: string, manifest: RunManifest, result: BacktestResult, opts: BacktestOutputOptions = {},
): Promise<BacktestOutputPaths> {
  const runDir = runDirOf(runsRoot, manifest.runId);
  const files: Record<string, string> = {};
  const write = async (name: string, bytes: Uint8Array | string): Promise<void> => {
    const path = join(runDir, name);
    await atomicWriteFile(path, typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes));
    files[name] = path;
  };
  await write('run.json', toReportJson(manifest));
  await write('reaction.json', toReportJson(manifest, result.reaction.result as unknown as Record<string, unknown>));
  if (result.gate !== 'fail') {
    const kv = parquetMetadata(manifest);
    const jsonl = [JSON.stringify({ runManifest: reportValue(manifest) }), ...result.records.map((r) => JSON.stringify(reportValue(r)))];
    await write('trades.jsonl', `${jsonl.join('\n')}\n`);
    await write('trades.parquet', writeRecordsParquet(columnsOf(TRADE_COLUMNS, result.records), kv));
    await write('transitions.parquet', writeRecordsParquet(columnsOf(TRANSITION_COLUMNS, result.transitions), kv));
    const levels = result.engine?.book?.snapshot().levels ?? [];
    await write('levels.parquet', writeRecordsParquet(columnsOf(LEVEL_COLUMNS, levels), kv));
    await write('pivots.parquet', writeRecordsParquet(columnsOf(PIVOT_COLUMNS, result.engine?.store.snapshot() ?? []), kv));
    const schedule = result.folds.map((f, k) => {
      const g = result.fromGrid?.[k];
      return { ...f, MinStrength: result.fits[k]?.MinStrength ?? NaN, ...(g === undefined ? {} : { cellId: g.cellId, TargetMult: g.TargetMult, StopMult: g.StopMult, plateau: g.plateau }) };
    });
    await write('folds.json', toReportJson(manifest, { folds: result.foldMetrics as FoldMetrics[], schedule, nConfigs: result.nConfigs, variants: result.variants }));
    await write('target_grid.json', toReportJson(manifest, { ...(result.targetGrid as unknown as Record<string, unknown>) }));
    await write('stageB.json', toReportJson(manifest, { strengthModel: manifest.config.strengthModel, folds: result.stageB }));
  }
  await write('report.md', renderReport(await loadReportInputs(runDir, opts.dataRoot === undefined ? {} : { dataRoot: opts.dataRoot })));
  return { runDir, files };
}
