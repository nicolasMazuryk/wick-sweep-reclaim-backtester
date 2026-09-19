import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Ms, TransitionRecord } from '@wsr/core';
import { eachDay, formatDay, type HygieneReport, parseDay, readHygiene, readRecordsParquet, summarizeCoverage } from '@wsr/data';
import { FORCED_BANNER, type GateOutcome, REFUSED_BANNER, type VariantMetrics } from './backtest-run.js';
import { ReplayInputError } from './blacklist-load.js';
import type { ComparisonFile } from './comparison.js';
import type { FoldMetrics } from './fold-metrics.js';
import type { GridReport, SensitivityReport } from './grid-run.js';
import { gridReportSection } from './grid-output.js';
import type { ConfigCount } from './grid-space.js';
import { olsSlope, percentile, spearman } from './numeric.js';
import type { RunManifest } from './output.js';
import type { PlaceboSweptStats } from './placebo-sweep.js';
import { CONCLUSION_ONLY_EXTREMUM, type ReactionTestResult } from './reaction-run.js';
import { LEVEL_SET_IDS } from './reaction.js';
import type { Breakdown } from './regime.js';
import { ci, finite, mdTable, num, pct } from './report-format.js';
import { plateauOf, type TargetValidation } from './target-validation.js';
import type { TradeRecord } from './trade-record.js';

// Spec §7.2 report.md, assembled from the artefacts of runs/{runId}/ (Spec
// §7.1). `wsr backtest` renders it right after writing them and `wsr report`
// re-renders it from the same files, so both give byte-identical output:
// everything is read back from the JSON / Parquet (NaN already null).

const DAY_MS = 86_400_000;
// Spec §4.1 / §7.1: "A strategy that dies between 50 and 150 ms is not tradable from a normal cloud region".
export const LATENCY_SENTENCE = 'A strategy that dies between 50 and 150 ms is not tradable from a normal cloud region (§7.1).';
// Appendix B Q3 / Q4: a sign / plateau counts as consistent in ≥ 75 % of folds.
const CONSISTENT_SHARE = 0.75;
// Index of PriorTouches in the 13-feature vector (Spec §3.7.1).
const PRIOR_TOUCHES_FEATURE = 11;

export interface FoldScheduleRow {
  readonly foldId: number;
  readonly trainStart: Ms; readonly trainEnd: Ms; readonly testStart: Ms; readonly testEnd: Ms;
  readonly MinStrength: number | null;
  // `--from-grid` runs (A-134): the fold's grid cell (null: none admissible) and target pair.
  readonly cellId?: string | null;
  readonly TargetMult?: number | null;
  readonly StopMult?: number | null;
}

// folds.json body.
export interface FoldsFile {
  readonly folds: ReadonlyArray<FoldMetrics>;
  readonly schedule: ReadonlyArray<FoldScheduleRow>;
  readonly nConfigs?: ConfigCount;          // absent in folds.json files written before the sweeps
  readonly variants?: ReadonlyArray<VariantMetrics>;   // `wsr backtest --variants` (A-132)
}

export interface StageBFoldJson {
  readonly foldId: number;
  readonly MinStrength: number | null;
  readonly nTrainWick: number;
  readonly stageBFit: { readonly nIpw: number; readonly nApproached: number; readonly nLabelled: number; readonly converged: boolean; readonly ipwConverged: boolean };
  readonly model: {
    readonly beta0: number | null; readonly beta: ReadonlyArray<number | null>;
    readonly calibration?: ReadonlyArray<{ readonly bin: number; readonly meanP: number | null; readonly meanY: number | null; readonly n: number }>;
  };
}

// stageB.json body.
export interface StageBFile {
  readonly strengthModel: string;
  readonly folds: ReadonlyArray<StageBFoldJson>;
}

// grid.json body.
export type GridFile = GridReport & { readonly gate: GateOutcome };

// levels.parquet row (Spec §7.1: one row per level incl. terminal outcome).
export interface LevelRow {
  readonly levelId: number; readonly Side: number; readonly State: string; readonly stateReason: string;
  readonly VolUnit_created: number | null; readonly MinSweepDepth: number | null; readonly minSweepFloorBinding: string;
}

export interface HygieneDay {
  readonly day: string;
  readonly report: HygieneReport | undefined;
}

// Parsed artefacts of one run directory; everything but run.json is optional.
export interface ReportInputs {
  readonly manifest: RunManifest;
  readonly reaction: ReactionTestResult | null;
  readonly folds: FoldsFile | null;
  readonly targetGrid: TargetValidation | null;
  readonly stageB: StageBFile | null;
  readonly trades: ReadonlyArray<TradeRecord> | null;
  readonly transitions: ReadonlyArray<TransitionRecord> | null;
  readonly levels: ReadonlyArray<LevelRow> | null;
  readonly grid: GridFile | null;
  readonly sensitivity: SensitivityReport | null;
  // Span days' hygiene reports from the data root (null: not loaded).
  readonly hygiene: ReadonlyArray<HygieneDay> | null;
  // runs/compare-*/comparison.json files that list this run (Appendix B Q9, A-135).
  readonly comparisons?: ReadonlyArray<ComparisonFile>;
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readJson<T>(runDir: string, name: string): Promise<T | null> {
  const bytes = await readOptional(join(runDir, name));
  return bytes === null ? null : (JSON.parse(bytes.toString('utf8')) as T);
}

async function readParquetRows<T>(runDir: string, name: string): Promise<T[] | null> {
  const bytes = await readOptional(join(runDir, name));
  return bytes === null ? null : (readRecordsParquet(bytes).rows as unknown as T[]);
}

// Reads what exists under runDir (run.json is required: ReplayInputError
// otherwise). With `dataRoot`, the hygiene report of every span day.
export async function loadReportInputs(runDir: string, opts: { readonly dataRoot?: string } = {}): Promise<ReportInputs> {
  const run = await readJson<{ runManifest: RunManifest }>(runDir, 'run.json');
  if (run === null) throw new ReplayInputError(`no run.json under ${runDir}`);
  const manifest = run.runManifest;
  const jsonl = await readOptional(join(runDir, 'trades.jsonl'));
  const trades = jsonl === null ? null
    : jsonl.toString('utf8').split('\n').filter((l) => l.length > 0).slice(1).map((l) => JSON.parse(l) as TradeRecord);
  let hygiene: HygieneDay[] | null = null;
  if (opts.dataRoot !== undefined) {
    hygiene = [];
    for (const day of eachDay(parseDay(manifest.span.from), parseDay(manifest.span.to))) {
      const report = await readHygiene(opts.dataRoot, manifest.venue, manifest.symbol, day).catch(() => undefined);
      hygiene.push({ day: formatDay(day), report });
    }
  }
  return {
    manifest,
    reaction: await readJson<ReactionTestResult>(runDir, 'reaction.json'),
    folds: await readJson<FoldsFile>(runDir, 'folds.json'),
    targetGrid: await readJson<TargetValidation>(runDir, 'target_grid.json'),
    stageB: await readJson<StageBFile>(runDir, 'stageB.json'),
    trades,
    transitions: await readParquetRows<TransitionRecord>(runDir, 'transitions.parquet'),
    levels: await readParquetRows<LevelRow>(runDir, 'levels.parquet'),
    grid: await readJson<GridFile>(runDir, 'grid.json'),
    sensitivity: await readJson<SensitivityReport>(runDir, 'sensitivity.json'),
    hygiene,
    comparisons: await readComparisons(runDir, manifest.runId),
  };
}

// Every runs/compare-*/comparison.json beside runDir that lists this run, by directory name.
async function readComparisons(runDir: string, runId: string): Promise<ComparisonFile[]> {
  const root = dirname(runDir);
  const names = (await readdir(root)).filter((n) => n.startsWith('compare-')).sort();
  const out: ComparisonFile[] = [];
  for (const name of names) {
    const c = await readJson<ComparisonFile>(join(root, name), 'comparison.json');
    if (c !== null && c.runIds.includes(runId)) out.push(c);
  }
  return out;
}

// Gate outcome of the run: grid.json records it; otherwise a forced run
// carries FORCED_BANNER in its warnings, and P&L artefacts without it mean
// the gate passed (possibly from a stored reaction.json, Spec §6.1.6).
export function reportGate(inp: Pick<ReportInputs, 'manifest' | 'reaction' | 'folds' | 'grid'>): GateOutcome {
  if (inp.grid !== null) return inp.grid.gate;
  if (inp.manifest.warnings.includes(FORCED_BANNER)) return 'forced';
  if (inp.folds !== null || inp.reaction === null) return 'pass';
  return inp.reaction.gate.pass ? 'pass' : 'fail';
}

const NOT_RUN = '_P&L backtest not run (reaction test failed, Spec §6.1.6)._';

function missing(file: string, command: string): string {
  return `_Not available — ${file} missing (run \`${command}\`)._`;
}

export function pooledOf(inp: ReportInputs): FoldMetrics | null {
  return inp.folds?.folds.find((m) => m.foldId === 'pooled') ?? null;
}

// Pooled test trades: those inside some fold's test window.
function pooledTrades(inp: ReportInputs): TradeRecord[] {
  return (inp.trades ?? []).filter((r) => r.foldId >= 0);
}

function finiteValues(xs: ReadonlyArray<number | null | undefined>): number[] {
  return xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
}

function percentileRow(label: string, xs: ReadonlyArray<number>, digits: number): string[] {
  return [label, String(xs.length), ...[0.1, 0.25, 0.5, 0.75, 0.9].map((q) => num(percentile(xs, q), digits))];
}

function share(n: number, of: number): string {
  return of === 0 ? `${n}` : `${n} (${pct(n / of)})`;
}

// ---------------------------------------------------------------- §0

function section0(inp: ReportInputs): string[] {
  const m = inp.manifest;
  const lines = ['## 0. Run manifest', '',
    `- runId: ${m.runId}`, `- createdAt: ${m.createdAt}`, `- configHash: ${m.configHash}`, `- seed: ${m.seed}`,
    `- gitCommit: ${m.gitCommit}`, `- wsrVersion: ${m.wsrVersion}`,
    `- venue / symbol / span: ${m.venue} ${m.symbol} ${m.span.from}…${m.span.to}`,
    `- data checksums: ${m.dataChecksums.length} partition(s)`,
    `- fees verifiedAt: ${m.feesVerifiedAt ?? 'unverified'}`,
    `- strengthModel: ${m.config.strengthModel}`,
    `- Parquet key-value metadata: wsr.configHash, wsr.seed, wsr.runId (Spec §8.3)`];
  const schedule = inp.folds?.schedule ?? [];
  if (schedule.length > 0) {
    const f0 = schedule[0]!;
    const step = schedule.length > 1 ? (schedule[1]!.testStart - f0.testStart) / DAY_MS : NaN;
    lines.push(`- folds: ${schedule.length} (${(f0.trainEnd - f0.trainStart) / DAY_MS}/${(f0.testEnd - f0.testStart) / DAY_MS}/${num(step, 0)} days)`);
  } else if (inp.grid !== null) {
    const d = inp.grid.foldDays;
    lines.push(`- folds: ${inp.grid.folds.length} (${d.train}/${d.test}/${d.step} days)`);
  }
  // Spec §8.1: configured and effective MinSweepMult (the 2·RoundTripCost floor).
  const levels = inp.levels ?? [];
  const ratios = finiteValues(levels.map((l) => (finite(l.MinSweepDepth) !== null && (finite(l.VolUnit_created) ?? 0) > 0
    ? l.MinSweepDepth! / l.VolUnit_created! : null)));
  const byCost = levels.filter((l) => l.minSweepFloorBinding === 'cost').length;
  lines.push(inp.levels === null
    ? `- MinSweepMult: configured ${m.config.MinSweepMult}; effective n/a (levels.parquet missing)`
    : `- MinSweepMult: configured ${m.config.MinSweepMult}; effective (MinSweepDepth/VolUnit_created over ${ratios.length} levels) median ${num(percentile(ratios, 0.5))}, p90 ${num(percentile(ratios, 0.9))}; cost floor binding on ${share(byCost, levels.length)} levels`);
  if (m.warnings.length > 0) lines.push('- warnings:', ...m.warnings.map((w) => `  - ${w}`));
  return lines;
}

// ---------------------------------------------------------------- §1

function section1(inp: ReportInputs): string[] {
  const m = inp.manifest;
  const lines = ['## 1. Data coverage & hygiene', ''];
  if (inp.hygiene === null) {
    lines.push('_Hygiene reports not loaded (no data root)._');
  } else if (inp.hygiene.every((h) => h.report === undefined)) {
    lines.push(`_No hygiene report found for the ${inp.hygiene.length} span day(s) under the data root._`);
  } else {
    const [row] = summarizeCoverage(inp.hygiene.map((h) => ({ venue: m.venue, symbol: m.symbol, day: parseDay(h.day), report: h.report })));
    const present = inp.hygiene.filter((h) => h.report !== undefined && !h.report.checksumFailed);
    const reports = present.map((h) => h.report!);
    const daysWhere = (f: (r: HygieneReport) => boolean): string[] => present.filter((h) => f(h.report!)).map((h) => h.day);
    const list = (days: string[]): string => (days.length === 0 ? '0' : `${days.length} (${days.join(', ')})`);
    const total = (f: (r: HygieneReport) => number): number => reports.reduce((n, r) => n + f(r), 0);
    lines.push(...mdTable(['days requested', 'present', 'suspect', 'checksum failed', 'blacklisted minutes'], [[
      String(row!.daysRequested), String(row!.daysPresent), String(row!.daysSuspect),
      String(inp.hygiene.filter((h) => h.report?.checksumFailed === true).length), String(row!.blacklistedMinutes),
    ]]), '',
    `- suspect days: ${list(daysWhere((r) => r.suspect))}`,
    `- feedKind aggregated: ${list(daysWhere((r) => r.aggregatedFeed))}`,
    `- tick-size changes: ${list(daysWhere((r) => r.tickSizeChange.detected))}`,
    `- gaps: ${total((r) => r.gaps.length)}; bad prints: ${total((r) => r.badPrints.count)}; duplicate tradeIds: ${total((r) => r.duplicateTradeIds.count)}; non-monotone timestamps: ${total((r) => r.nonMonotoneTimestamps)}; missing funding prints: ${total((r) => r.fundingMissing.length)}`);
    const absent = inp.hygiene.filter((h) => h.report === undefined).map((h) => h.day);
    if (absent.length > 0) lines.push(`- days without a hygiene report: ${list(absent)}`);
  }
  if (inp.reaction !== null) {
    const r = inp.reaction;
    lines.push('', `Blacklisted buckets (reaction replay, span): ${r.blacklistedBuckets}/${r.totalBuckets} (${pct(r.totalBuckets === 0 ? NaN : r.blacklistedBuckets / r.totalBuckets)}).`);
  }
  const perFold = (inp.folds?.folds ?? []).filter((f) => f.foldId !== 'pooled');
  if (perFold.length > 0) {
    lines.push('', ...mdTable(['fold', 'window', 'from', 'to', 'volume-days', 'blacklisted bucket share'],
      perFold.map((f) => [String(f.foldId), f.window, f.from, f.to, num(f.volumeDays, 2), pct(f.blacklistedBucketShare, 2)])));
  }
  return lines;
}

// ---------------------------------------------------------------- §2

type SetRow = { readonly n: number; readonly approached: number; readonly complete: number; readonly unresolvedShare: number; readonly meanDisp: number;
  readonly ci95Disp: [number, number]; readonly pHit: number; readonly ci95Hit: [number, number] };

function setCells(s: SetRow): string[] {
  return [String(s.n), String(s.approached), String(s.complete), `${num(s.meanDisp)} ${ci(s.ci95Disp)}`, `${num(s.pHit)} ${ci(s.ci95Hit)}`, num(s.unresolvedShare)];
}

function section2(inp: ReportInputs): string[] {
  const lines = ['## 2. Reaction test (§9.2)', ''];
  const r = inp.reaction;
  if (r === null) return [...lines, missing('reaction.json', 'wsr reaction')];
  lines.push(`B = ${r.B} volume-day block-bootstrap resamples over ${r.blocks} volume-days; random levels clipped at the span start: ${r.randomClipped}.`, '',
    ...mdTable(['set', 'n', 'approached', 'complete', 'E[ReactionDisplacement] (95 % CI)', 'P(ReactionHit) (95 % CI)', 'unresolved'],
      LEVEL_SET_IDS.map((id) => [id, ...setCells(r.sets[id])])),
    '', '### WickLevels by WickStrength decile', '',
    ...mdTable(['decile', 'n', 'approached', 'complete', 'E[ReactionDisplacement] (95 % CI)', 'P(ReactionHit) (95 % CI)', 'unresolved'],
      r.wickByDecile.map((d) => [String(d.decile), ...setCells(d)])),
    '', '### Contrasts', '',
    ...mdTable(['contrast', 'ΔDisp (95 % CI)', 'ΔHit (95 % CI)', 'significant'],
      (['1-4', '1-2', '1-3'] as const).map((k) => {
        const c = r.contrasts[k];
        return [`(${k.replace('-', ')−(')})`, `${num(c.diffDisp)} ${ci(c.ci95)}`, `${num(c.diffHit)} ${ci(c.ci95Hit)}`, c.significant ? 'yes' : 'no'];
      })),
    '', `Monotone in WickStrength: slope ${num(r.monotone.slope, 4)} ${ci(r.monotone.ci95, 4)}, Spearman ${num(r.monotone.spearman)} — ${r.monotone.pass ? 'PASS' : 'FAIL'}.`);
  if (r.conclusion12 !== null) lines.push('', `(1)−(2) CI contains 0: ${r.conclusion12}.`);
  lines.push('', `**GATE VERDICT: ${r.gate.pass ? 'PASS' : 'FAIL'}**`, ...r.gate.reasons.map((x) => `- ${x}`));
  return lines;
}

// ---------------------------------------------------------------- §3

function section3(inp: ReportInputs, gate: GateOutcome): string[] {
  const lines = ['## 3. Cost floor diagnostic (§7.4, §12.1)', ''];
  if (gate === 'fail') return [...lines, NOT_RUN];
  const pooled = pooledOf(inp);
  if (inp.trades === null || pooled === null) return [...lines, missing('trades.jsonl / folds.json', 'wsr backtest')];
  const trades = inp.trades;
  lines.push(`Trades triggered in the span: ${trades.length}. Percentiles are over trades with a finite value.`, '',
    ...mdTable(['quantity', 'n', 'p10', 'p25', 'p50', 'p75', 'p90'], [
      percentileRow('RoundTripCost_bps', finiteValues(trades.map((r) => r.RoundTripCost_bps)), 2),
      percentileRow('BreakevenHitRate', finiteValues(trades.map((r) => r.BreakevenHitRate)), 3),
    ]), '',
    `- MinSweepDepth set by the 2·RoundTripCost floor: ${pooled.costFloor.minSweepSetByCost} WickLevels created in the pooled test windows (${pct(pooled.costFloor.shareOfSpikes)} of them).`,
    `- Pooled test mean BreakevenHitRate ${num(pooled.BreakevenHitRate)} vs HitRate ${num(pooled.HitRate)} (HitRate_0 ${num(pooled.HitRate_0)}).`);
  return lines;
}

// ---------------------------------------------------------------- §4

function section4(inp: ReportInputs, gate: GateOutcome): string[] {
  const lines = ['## 4. Target validation (§6.5)', ''];
  if (gate === 'fail') return [...lines, NOT_RUN];
  const tg = inp.targetGrid;
  if (tg === null) return [...lines, missing('target_grid.json', 'wsr backtest')];
  lines.push('### Train plateau and OOS at the plateau, per fold', '',
    ...mdTable(['fold', 'train trades', 'test trades', 'train plateau (TargetMult, StopMult)', 'top / admissible cells', 'OOS n', 'OOS HitRate', 'HitRate_0', 'OOS Expectancy bps',
      'VolUnit plateau (TargetUnits, StopMult)', 'OOS HitRate (VolUnit)', 'HitRate_0 (VolUnit)', 'OOS Expectancy bps (VolUnit)'],
      tg.folds.map((f) => [String(f.foldId), String(f.trainTrades), String(f.testTrades),
        f.plateau === null ? 'n/a' : `(${f.plateau.TargetMult}, ${f.plateau.StopMult})`,
        f.plateau === null ? 'n/a' : `${f.plateau.cells} / ${f.plateau.admissible}`, String(f.oos?.n ?? 0),
        num(f.oos?.HitRate), num(f.oos?.HitRate_0), num(f.oos?.Expectancy, 2),
        f.unitsPlateau == null ? 'n/a' : `(${f.unitsPlateau.TargetUnits}, ${f.unitsPlateau.StopMult})`,
        num(f.unitsOos?.HitRate), num(f.unitsOos?.HitRate_0), num(f.unitsOos?.Expectancy, 2)])));
  lines.push('', tg.stability === null ? 'Plateau stability: no fold has a plateau.'
    : `Plateau stability: (${tg.stability.TargetMult}, ${tg.stability.StopMult}) in ${pct(tg.stability.share, 0)} of ${tg.stability.folds} folds (Appendix B Q4: ≥ 75 %).`);
  const us = tg.unitsStability;
  if (us !== undefined) {
    lines.push('', us === null ? 'VolUnit plateau stability: no fold has a plateau.'
      : `VolUnit plateau stability: (${us.TargetUnits}, ${us.StopMult}) in ${pct(us.share, 0)} of ${us.folds} folds.`);
  }
  lines.push('', '### (TargetMult × StopMult), pooled test windows', '',
    ...mdTable(['TargetMult', 'StopMult', 'n', 'HitRate', 'HitRate_0', 'Expectancy bps', 'unresolved'],
      tg.pooledTest.map((c) => [String(c.TargetMult), String(c.StopMult), String(c.n), num(c.HitRate), num(c.HitRate_0), num(c.Expectancy, 2), num(c.unresolvedShare)])));
  lines.push('', '### VolUnit-scaled Target (TargetUnits × StopMult), pooled test windows', '',
    'HitRate_0 = mean over trades of S_u/(TargetUnits + S_u), S_u = StopMult·SweepDepth/VolUnit_created (the stop in VolUnits; A-137).', '',
    ...mdTable(['TargetUnits', 'StopMult', 'n', 'HitRate', 'HitRate_0', 'Expectancy bps', 'unresolved'],
      tg.byTargetUnits.map((c) => [String(c.TargetUnits), String(c.StopMult), String(c.n), num(c.HitRate), num(c.HitRate_0), num(c.Expectancy, 2), num(c.unresolvedShare)])));
  lines.push('', '### HitRate(2, 1) | SweepDepth/VolUnit_created, pooled test windows', '',
    ...mdTable(['SweepDepth/VolUnit_created', 'n', 'HitRate', 'HitRate_0'], tg.conditional.map((c) => [c.bin, String(c.n), num(c.HitRate), num(c.HitRate_0)])));
  lines.push('', `### Two-stage exit (half at 1·SweepDepth, stop to EntryFill, half at TargetMult; StopMult ${inp.manifest.config.StopMult}), pooled test windows`, '',
    ...(tg.twoStage.length === 0 ? ['_Not available (TargetMult 1 or the configured StopMult missing from the grid)._']
      : mdTable(['TargetMult', 'n', 'Expectancy bps', 'first half hit', 'second half hit', 'second half unresolved'],
        tg.twoStage.map((x) => [String(x.TargetMult), String(x.n), num(x.Expectancy, 2), num(x.firstHalfHitRate), num(x.secondHalfHitRate), num(x.unresolvedShare)]))));
  lines.push('', '### Placebo swept levels (§9.2 second test, Spec §6.1.4), pooled test windows', '', ...placeboSweptLines(tg.placeboSwept));
  return lines;
}

// Actual setups vs 1/3 vs placebo levels swept by construction (A-131).
function placeboSweptLines(ps: PlaceboSweptStats | undefined): string[] {
  if (ps === undefined) return ['_Not available — target_grid.json has no placeboSwept (rerun `wsr backtest`)._'];
  const hr = `HitRate(${ps.TargetMult}, ${ps.StopMult}) (95 % CI)`;
  const third = (c: readonly [number | null, number | null]): string => {
    const lo = finite(c[0]);
    const hi = finite(c[1]);
    return lo === null || hi === null ? 'no CI' : lo > ps.HitRate_0 ? 'above 1/3' : hi < ps.HitRate_0 ? 'below 1/3' : 'contains 1/3';
  };
  return [
    `Placebo levels = every WickLevel shifted ±1, ±2 VolUnit_created (${ps.placebo.levels} levels), put through the sweep → confirm → reclaim geometry of the LevelBook; hypothetical entry at the reclaim print (no latency, no slippage); B = ${ps.B} volume-day block-bootstrap resamples over ${ps.blocks} volume-days, groups paired within each resample.`, '',
    ...mdTable(['setups', 'n', hr, 'HitRate_0', 'CI vs 1/3', 'unresolved'], [
      ['actual (filled trades)', String(ps.actual.n), `${num(ps.actual.HitRate)} ${ci(ps.actual.ci95)}`, num(ps.HitRate_0), third(ps.actual.ci95), ''],
      ['placebo swept', String(ps.placebo.n), `${num(ps.placebo.HitRate)} ${ci(ps.placebo.ci95)}`, num(ps.HitRate_0), third(ps.placebo.ci95), num(ps.placebo.unresolvedShare)],
    ]), '',
    `Actual − placebo: ${num(ps.diff.value)} ${ci(ps.diff.ci95)} — ${ps.diff.significant ? 'significant (CI excludes 0)' : 'not significant (CI contains 0)'}.`,
  ];
}

// ---------------------------------------------------------------- §5

// The fold's parameters: its grid cell and target pair in a `--from-grid` run
// (folds.json schedule, A-134), else the configured ones — never grid.json's
// choice, which this run's trades did not use.
function chosenCellOf(inp: ReportInputs, foldId: number): string {
  const row = inp.folds?.schedule.find((s) => s.foldId === foldId);
  if (row?.cellId === undefined) return 'configured';
  return row.cellId === null ? 'none (no admissible cell)' : `${row.cellId} (${row.TargetMult}, ${row.StopMult})`;
}

function section5(inp: ReportInputs, gate: GateOutcome): string[] {
  const lines = ['## 5. Walk-forward (§9.3)', ''];
  if (gate === 'fail') return [...lines, NOT_RUN];
  if (inp.folds === null) {
    return [...lines, inp.grid === null ? missing('folds.json', 'wsr backtest') : `${missing('folds.json', 'wsr backtest')} The grid walk-forward is in §11.`];
  }
  const strengthOf = new Map(inp.folds.schedule.map((s) => [s.foldId, s.MinStrength]));
  const fromGrid = inp.manifest.fromGrid;
  lines.push(fromGrid === undefined
    ? `Parameters: the configured ones in every fold (\`wsr backtest --from-grid <runId>\` trades each fold with its grid cell). HitRate at (TargetMult, StopMult) = (${inp.manifest.config.TargetMult}, ${inp.manifest.config.StopMult}); expectancies net of §7.4 costs.`
    : `Parameters: each fold's chosen cell of grid run ${fromGrid} with its fitted Stage B / MinStrength and train target plateau (TargetMult, StopMult), applied to its test window (A-134); HitRate at the fold's pair; expectancies net of §7.4 costs.`, '',
    ...mdTable(['fold', 'window', 'from', 'to', 'MinStrength', 'parameters', 'trades', 'HitRate', 'HitRate_0', 'Breakeven', 'HitRate − Breakeven', 'exp bps', 'exp R', 'PF', 'Sharpe/trade', 'Sharpe/day', 'MaxDD_R', 'hold buckets'],
      inp.folds.folds.map((m) => [String(m.foldId), m.window, m.from, m.to,
        m.foldId === 'pooled' ? '' : num(strengthOf.get(m.foldId), 4), m.foldId === 'pooled' ? '' : chosenCellOf(inp, m.foldId),
        String(m.trades), num(m.HitRate), num(m.HitRate_0), num(m.BreakevenHitRate), num(m.HitRateMinusBreakeven),
        num(m.expectancy_bps, 2), num(m.expectancy_R), num(m.profitFactor), num(m.sharpeTrade), num(m.sharpeDaily), num(m.maxDrawdown_R, 2),
        num(m.meanHoldBuckets, 1)])));
  return lines;
}

// ---------------------------------------------------------------- §6

// The §7.1 sentence applies when expectancy(150 ms) < 0 ≤ expectancy(50 ms).
export function latencySentenceApplies(curve: ReadonlyArray<{ readonly latencyMs: number; readonly expectancy_bps: number | null }>): boolean {
  const at = (ms: number): number | null => finite(curve.find((c) => c.latencyMs === ms)?.expectancy_bps);
  const e50 = at(50);
  const e150 = at(150);
  return e50 !== null && e150 !== null && e150 < 0 && e50 >= 0;
}

function section6(inp: ReportInputs, gate: GateOutcome): string[] {
  const lines = ['## 6. Latency and slippage curves (§7.1, §9.4)', ''];
  if (gate === 'fail') return [...lines, NOT_RUN];
  const pooled = pooledOf(inp);
  if (pooled === null) return [...lines, missing('folds.json', 'wsr backtest')];
  const curve = [...pooled.latencyCurve].sort((a, b) => a.latencyMs - b.latencyMs);
  lines.push('### Latency curve (pooled test windows)', '',
    ...mdTable(['latency ms', 'trades', 'expectancy bps'], curve.map((c) => [String(c.latencyMs), String(c.trades), num(c.expectancy_bps, 2)])));
  if (curve.length < 2) lines.push('', `Latency sweep not run (\`wsr backtest --latency-sweep\`): only the configured latency (${curve[0]?.latencyMs ?? inp.manifest.config.latencyMs} ms) was evaluated.`);
  if (latencySentenceApplies(curve)) lines.push('', `**${LATENCY_SENTENCE}**`);
  lines.push('', '### Slippage curve (SlipCoef × {1, 2, 4}, pooled test windows)', '',
    ...mdTable(['SlipCoef multiplier', 'expectancy bps'], pooled.slippageCurve.map((c) => [`×${c.slipCoefMult}`, num(c.expectancy_bps, 2)])));
  if (pooled.slippageCurve.length < 3) lines.push('', 'Slippage sweep not run (`wsr backtest --slippage-sweep`): only ×1 was evaluated.');
  const n = inp.folds?.nConfigs;
  if (n !== undefined) lines.push('', `N_configs (§6.4) = ${n.cells} cell × ${n.variants} variant(s) × ${n.latencyPoints} latency point(s) = ${n.N}.`);
  return lines;
}

// ---------------------------------------------------------------- §7

function section7(inp: ReportInputs, gate: GateOutcome): string[] {
  const lines = ['## 7. Execution realism (§7.2)', ''];
  if (gate === 'fail') return [...lines, NOT_RUN];
  const pooled = pooledOf(inp);
  if (inp.trades === null || pooled === null) return [...lines, missing('trades.jsonl / folds.json', 'wsr backtest')];
  const t = pooledTrades(inp);
  const count = (f: (r: TradeRecord) => boolean): string => share(t.filter(f).length, t.length);
  const kinds = ['stop', 'target', 'time', 'kill', 'none'] as const;
  lines.push(`Pooled test-window trades: ${t.length}.`, '',
    ...mdTable(['fill event', 'trades (share)'], [
      ['touch-and-reverse (filled, price back through the level)', count((r) => r.touchAndReverse)],
      ['touch-and-fly', count((r) => r.touchAndFly)],
      ['burst fill (300 ms window, 3× slippage)', count((r) => r['burst'])],
      ['no-print fallback', count((r) => r.noPrintFallback)],
      ['partial fill (FilledQty < Qty)', count((r) => (finite(r.FilledQty) ?? 0) < (finite(r.Qty) ?? 0))],
    ]), '',
    ...mdTable(['exit', ...kinds], [['trades', ...kinds.map((k) => String(t.filter((r) => r.exit.kind === k).length))]]), '',
    `Target fill: conservative (touch + FillWindow rule) ${num(pooled.targetFill.conservative, 2)} bps vs optimistic (touch = fill) ${num(pooled.targetFill.optimistic, 2)} bps expectancy; the conservative figure is the one used everywhere else.`);
  return lines;
}

// ---------------------------------------------------------------- §8

// Rows in key order; numeric keys (SweepCount, PriorTouches, …) numerically.
function breakdownTable(rows: ReadonlyArray<Breakdown>, keyLabel: string): string[] {
  if (rows.length === 0) return ['_No trades._'];
  const numeric = rows.every((b) => /^-?\d+(\.\d+)?$/.test(b.key));
  const sorted = numeric ? [...rows].sort((a, b) => Number(a.key) - Number(b.key)) : rows;
  return mdTable([keyLabel, 'trades', 'HitRate', 'HitRate_0', 'exp bps', 'exp R'],
    sorted.map((b) => [b.key, String(b.trades), num(b.HitRate), num(b.HitRate_0), num(b.expectancy_bps, 2), num(b.expectancy_R)]));
}

// §4.3 decile monotonicity (point estimates): Spearman ρ and OLS slope of
// expectancy_bps on the decile index over deciles 1..10 with trades.
export function decileVerdict(rows: ReadonlyArray<Breakdown>): string {
  const pts = rows.map((b) => ({ d: Number(b.key), e: finite(b.expectancy_bps) }))
    .filter((x): x is { d: number; e: number } => x.d >= 1 && x.e !== null);
  if (pts.length < 3) return `inconclusive (${pts.length} decile(s) with realised trades)`;
  const rho = spearman(pts.map((x) => x.d), pts.map((x) => x.e));
  const slope = olsSlope(pts.map((x) => x.d), pts.map((x) => x.e));
  const verdict = rho >= 0.5 && slope > 0 ? 'increasing in WickStrength' : rho <= -0.5 && slope < 0 ? 'decreasing in WickStrength' : 'not monotone';
  return `${verdict} (Spearman ρ ${num(rho)}, slope ${num(slope, 3)} bps/decile over ${pts.length} deciles; point estimates, no CI)`;
}

interface PriorTouchesSign {
  readonly positive: number;
  readonly negative: number;
  readonly folds: number;
  readonly verdict: 'positive' | 'negative' | 'inconclusive';
}

// Appendix B Q3: sign of the Stage B coefficient of PriorTouches per fold.
export function priorTouchesSign(stageB: StageBFile | null): PriorTouchesSign | null {
  if (stageB === null || stageB.folds.length === 0) return null;
  const coefs = stageB.folds.map((f) => finite(f.model.beta[PRIOR_TOUCHES_FEATURE]));
  const positive = coefs.filter((c) => c !== null && c > 0).length;
  const negative = coefs.filter((c) => c !== null && c < 0).length;
  const n = stageB.folds.length;
  const verdict = positive >= CONSISTENT_SHARE * n ? 'positive' : negative >= CONSISTENT_SHARE * n ? 'negative' : 'inconclusive';
  return { positive, negative, folds: n, verdict };
}

// Configured ArmMode of a variant (the armMode variant toggles it).
function armModeOf(inp: ReportInputs, variant: string): string {
  const cfg = inp.manifest.config;
  return variant === 'armMode' ? (cfg.ArmMode === 'RestEarly' ? 'ArmOnApproach' : 'RestEarly') : cfg.ArmMode;
}

// Pooled-test FoldMetrics of every backtest variant, baseline first (A-132).
function backtestVariants(inp: ReportInputs): Array<{ readonly variant: string; readonly overrides: string; readonly pooled: FoldMetrics }> {
  const base = pooledOf(inp);
  const vs = inp.folds?.variants ?? [];
  if (base === null || vs.length === 0) return [];
  const fmt = (o: Readonly<Record<string, string | boolean>>): string => Object.keys(o).sort().map((k) => `${k}=${String(o[k])}`).join(', ');
  return [{ variant: 'baseline', overrides: '', pooled: base }, ...vs.flatMap((v) => {
    const p = v.folds.find((m) => m.foldId === 'pooled');
    return p === undefined ? [] : [{ variant: v.variant, overrides: fmt(v.overrides), pooled: p }];
  })];
}

function variantRows(inp: ReportInputs): string[] {
  const wf = inp.grid?.walkForward ?? [];
  const bt = backtestVariants(inp);
  if (wf.length === 0 && bt.length === 0) return ['_No scenario variant ran (`wsr backtest --variants armMode` or `wsr grid --variants armMode`)._'];
  const lines: string[] = [];
  if (bt.length > 0) {
    lines.push('Backtest at the configured parameters: one trading pass per variant on the run\'s fold schedule (A-132).', '',
      ...mdTable(['variant', 'overrides', 'ArmMode', 'OOS trades', 'realised', 'HitRate', 'HitRate_0', 'exp bps', 'total OOS P&L bps', 'Sharpe/trade'],
        bt.map((v) => [v.variant, v.overrides, armModeOf(inp, v.variant), String(v.pooled.trades), String(v.pooled.realised), num(v.pooled.HitRate),
          num(v.pooled.HitRate_0), num(v.pooled.expectancy_bps, 2), num(totalPnl(v.pooled), 1), num(v.pooled.sharpeTrade)])));
  }
  if (wf.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Grid walk-forward (each fold\'s chosen cell on its test window):', '',
      ...mdTable(['variant', 'ArmMode', 'OOS trades', 'realised', 'exp bps', 'total OOS P&L bps', 'Sharpe/trade'],
        wf.map((w) => [w.variant, armModeOf(inp, w.variant), String(w.pooled.trades), String(w.pooled.realised), num(w.pooled.expectancy_bps, 2),
          num(totalPnl(w.pooled), 1), num(w.pooled.sharpeTrade_bps)])));
  }
  if (!wf.some((w) => w.variant === 'armMode') && !bt.some((v) => v.variant === 'armMode')) {
    lines.push('', 'ArmMode variant not run (`wsr backtest --variants armMode` or `wsr grid --variants armMode`).');
  }
  return lines;
}

function totalPnl(p: { readonly realised: number; readonly expectancy_bps: number | null }): number {
  const e = finite(p.expectancy_bps);
  return e === null ? (p.realised === 0 ? 0 : NaN) : e * p.realised;
}

function section8(inp: ReportInputs, gate: GateOutcome): string[] {
  const lines = ['## 8. Breakdowns (§9.4), pooled test windows', ''];
  if (gate === 'fail') return [...lines, NOT_RUN];
  const pooled = pooledOf(inp);
  if (pooled === null) return [...lines, missing('folds.json', 'wsr backtest')];
  const sign = priorTouchesSign(inp.stageB);
  lines.push('### WickStrength decile (vs the fold\'s train WickLevels; −1 = outside every test window)', '', ...breakdownTable(pooled.byDecile, 'decile'),
    '', `Monotonicity (§4.3): ${decileVerdict(pooled.byDecile)}.`,
    '', '### SweepDepth/VolUnit_created bin', '', ...breakdownTable(pooled.bySweepDepthBin, 'bin'),
    '', '### Regime at arming', '', ...breakdownTable(pooled.byRegime, 'regime'),
    '', '### Hour of day (UTC)', '', ...breakdownTable(pooled.byHour, 'hour'),
    '', '### SweepCount', '', ...breakdownTable(pooled.bySweepCount, 'SweepCount'),
    '', '### PriorTouches', '', ...breakdownTable(pooled.byPriorTouches, 'PriorTouches'),
    '', sign === null ? 'PriorTouches sign (§8.3): stageB.json missing.'
      : `PriorTouches sign (§8.3, Stage B coefficient per fold): ${sign.positive} positive, ${sign.negative} negative of ${sign.folds} folds — ${sign.verdict}.`,
    '', '### ReturnSpeed bin (VolUnit per bucket)', '', ...breakdownTable(pooled.byReturnSpeed, 'ReturnSpeed'),
    '', '### Scenario variants (grid walk-forward, OOS)', '', ...variantRows(inp));
  return lines;
}

// ---------------------------------------------------------------- §9

function mechanismVerdict(m: FoldMetrics['mechanism']): string {
  const lo = finite(m.ci95[0]);
  const hi = finite(m.ci95[1]);
  if (lo === null || hi === null) return 'inconclusive (no CI)';
  if (lo > 0) return 'yes — winners see more reclaim-direction aggression (CI excludes 0)';
  if (hi < 0) return 'no — opposite sign (CI excludes 0 below)';
  return 'no — CI contains 0';
}

function section9(inp: ReportInputs, gate: GateOutcome): string[] {
  const lines = ['## 9. Mechanism check (§1, §9.4)', ''];
  if (gate === 'fail') return [...lines, NOT_RUN];
  if (inp.folds === null) return [...lines, missing('folds.json', 'wsr backtest')];
  lines.push('postEntryImbalance2 = −Side·Σ s·q / Σ q over the 2 completed buckets after entry (positive = reclaim direction); winners have pnl_R > 0; 95 % volume-day block-bootstrap CI.', '',
    ...mdTable(['fold', 'window', 'winners mean', 'losers mean', 'diff (95 % CI)'],
      inp.folds.folds.filter((m) => m.window === 'test').map((m) => [String(m.foldId), m.window, num(m.mechanism.winnersMeanImb), num(m.mechanism.losersMeanImb),
        `${num(m.mechanism.diff)} ${ci(m.mechanism.ci95)}`])));
  const pooled = pooledOf(inp);
  if (pooled !== null) lines.push('', `Pooled verdict: ${mechanismVerdict(pooled.mechanism)}.`);
  return lines;
}

// ---------------------------------------------------------------- §10

// Per fold window; folds.json files written before the field existed count as none.
function ringUnderflows(folds: ReadonlyArray<FoldMetrics>): string {
  const hit = folds.filter((m) => m.foldId !== 'pooled' && (m.ringUnderflow as number | undefined ?? 0) > 0);
  return hit.length === 0 ? 'none in any fold window' : hit.map((m) => `fold ${m.foldId} ${m.window} ${m.ringUnderflow}`).join(', ');
}

function section10(inp: ReportInputs, gate: GateOutcome): string[] {
  const lines = ['## 10. Rule/cap binding (§5, §11) and level survivorship (§9.5)', ''];
  if (gate === 'fail') return [...lines, NOT_RUN];
  const pooled = pooledOf(inp);
  if (pooled === null) return [...lines, missing('folds.json', 'wsr backtest')];
  const counters = Object.keys(pooled.ruleBinding).sort();
  lines.push('### Rule-binding counters (whole replay)', '',
    ...(counters.length === 0 ? ['_None._'] : mdTable(['counter', 'count'], counters.map((k) => [k, String(pooled.ruleBinding[k])]))),
    '', `Kill-switch trips in the pooled test windows: ${pooled.killSwitchTrips}.`,
    '', `TradeRing underflows (Spec §3.1, capacity doubled): ${ringUnderflows(inp.folds!.folds)}.`);
  if (inp.trades !== null) {
    const t = pooledTrades(inp);
    const count = (f: (r: TradeRecord) => boolean): string => share(t.filter(f).length, t.length);
    lines.push('', '### Sizing caps on pooled test-window trades', '',
      ...mdTable(['cap', 'trades (share)'], [
        ['counter-trend size halved', count((r) => r.caps.counterTrendHalved)],
        ['liquidity cap', count((r) => r.caps.liquidityCap)],
        ['minimum Qty', count((r) => r.caps.minQty)],
      ]), '', `Median g: ${num(percentile(finiteValues(t.map((r) => r.caps.g)), 0.5))}.`);
  }
  if (inp.transitions !== null) {
    const counts = new Map<string, number>();
    for (const r of inp.transitions) {
      const key = `${r.from} ${r.to} ${r.reason}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    lines.push('', '### Level transitions by reason (whole replay)', '',
      ...mdTable(['from', 'to', 'reason', 'count'], rows.map(([k, n]) => [...k.split(' '), String(n)])));
  } else {
    lines.push('', missing('transitions.parquet', 'wsr backtest'));
  }
  if (inp.levels !== null) {
    const states = new Map<string, number>();
    for (const l of inp.levels) states.set(l.State, (states.get(l.State) ?? 0) + 1);
    const n = inp.levels.length;
    lines.push('', '### Level survivorship (state of every WickLevel at the end of the replay, levels.parquet)', '',
      ...mdTable(['state', 'levels (share)'], [...states.keys()].sort().map((s) => [s, share(states.get(s)!, n)])),
      '', `Share of WickLevels INVALIDATED: ${pct(n === 0 ? NaN : (states.get('INVALIDATED') ?? 0) / n)} of ${n}.`);
  } else {
    lines.push('', missing('levels.parquet', 'wsr backtest'));
  }
  return lines;
}

// ---------------------------------------------------------------- §11

function section11(inp: ReportInputs, gate: GateOutcome): string[] {
  const lines: string[] = [];
  if (gate === 'fail') return ['## 11. Parameter search (§9.3)', '', NOT_RUN];
  if (inp.grid !== null && inp.sensitivity !== null) lines.push(...gridReportSection(inp.grid, inp.sensitivity));
  else lines.push('## 11. Parameter search (§9.3)', '', missing('grid.json / sensitivity.json', 'wsr grid'));
  if (inp.stageB !== null) {
    lines.push('', `### Stage B per fold (strengthModel ${inp.stageB.strengthModel})`, '',
      ...mdTable(['fold', 'train WickLevels', 'IPW rows', 'approached', 'labelled', 'converged', 'IPW converged', 'MinStrength', 'β PriorTouches'],
        inp.stageB.folds.map((f) => [String(f.foldId), String(f.nTrainWick), String(f.stageBFit.nIpw), String(f.stageBFit.nApproached),
          String(f.stageBFit.nLabelled), f.stageBFit.converged ? 'yes' : 'no', f.stageBFit.ipwConverged ? 'yes' : 'no', num(f.MinStrength, 4),
          num(f.model.beta[PRIOR_TOUCHES_FEATURE], 4)])));
    lines.push('', ...stageBCalibration(inp.stageB));
  }
  return lines;
}

// Stage B calibration (Spec §3.7.4, §7.1 stageB.json): equal-count bins of
// P̂ over each fold's labelled train rows; the pooled rows are n-weighted.
function stageBCalibration(stageB: StageBFile): string[] {
  const rows = stageB.folds.flatMap((f) => (f.model.calibration ?? []).map((c) => ({ foldId: f.foldId, ...c })));
  if (rows.length === 0) return ['_No Stage B calibration in stageB.json._'];
  const bins = [...new Set(rows.map((r) => r.bin))].sort((a, b) => a - b);
  const pooled = bins.map((bin) => {
    const inBin = rows.filter((r) => r.bin === bin && r.n > 0);
    const n = inBin.reduce((a, r) => a + r.n, 0);
    const w = (key: 'meanP' | 'meanY'): number => (n === 0 ? NaN : inBin.reduce((a, r) => a + (finite(r[key]) ?? 0) * r.n, 0) / n);
    return [String(bin), String(n), num(w('meanP')), num(w('meanY'))];
  });
  return ['### Stage B calibration (labelled train rows, equal-count bins of P̂)', '',
    'Pooled over folds (n-weighted):', '', ...mdTable(['bin', 'n', 'mean P̂', 'mean y'], pooled),
    '', 'Per fold:', '', ...mdTable(['fold', 'bin', 'n', 'mean P̂', 'mean y'],
      rows.map((r) => [String(r.foldId), String(r.bin), String(r.n), num(r.meanP), num(r.meanY)]))];
}

// ---------------------------------------------------------------- §12

function ciExcludesZero(c: readonly [number | null, number | null]): boolean | null {
  const lo = finite(c[0]);
  const hi = finite(c[1]);
  return lo === null || hi === null ? null : lo > 0 || hi < 0;
}

// Appendix B verdicts, one per open question; 'not run' when the inputs are missing.
export function openQuestionVerdicts(inp: ReportInputs): string[] {
  const gate = reportGate(inp);
  const r = inp.reaction;
  const pnl = gate !== 'fail';
  const pooled = pooledOf(inp);
  const tg = inp.targetGrid;
  const out: string[] = [];

  out.push(r === null ? 'not run (`wsr reaction`)' : r.gate.pass ? 'yes — gate PASS' : 'no — gate FAIL; the pipeline stops (exit 3)');

  if (r === null) out.push('not run (`wsr reaction`)');
  else {
    const ex = ciExcludesZero(r.contrasts['1-2'].ci95);
    out.push(ex === null ? 'inconclusive (no CI)' : ex ? `yes — (1)−(2) ΔDisp ${num(r.contrasts['1-2'].diffDisp)} ${ci(r.contrasts['1-2'].ci95)} excludes 0`
      : `no — "${CONCLUSION_ONLY_EXTREMUM}"`);
  }

  const sign = priorTouchesSign(inp.stageB);
  out.push(!pnl ? 'not run' : sign === null ? 'not run (stageB.json missing)'
    : `${sign.verdict} (${sign.positive}+ / ${sign.negative}− of ${sign.folds} folds; ≥ 75 % needed)`);

  if (!pnl || pooled === null || tg === null) out.push('not run');
  else {
    const hr = finite(pooled.HitRate);
    const be = finite(pooled.BreakevenHitRate);
    const n = pooled.trades;
    if (hr === null || be === null || n === 0) out.push('inconclusive (no pooled test trades)');
    else {
      // Volume-day block-bootstrap CI of the placebo-swept test when present (A-131), else a normal approximation (A-84).
      const boot = tg.placeboSwept?.configured;
      const bootCI = boot === undefined ? null : [finite(boot.ci95[0]), finite(boot.ci95[1])] as const;
      const half = 1.96 * Math.sqrt(hr * (1 - hr) / n);
      const [ciLo, ciHi, how] = bootCI !== null && bootCI[0] !== null && bootCI[1] !== null
        ? [bootCI[0], bootCI[1], 'volume-day block bootstrap'] : [hr - half, hr + half, 'normal approx.'];
      const lo = ciLo - be;
      const above = lo > 0;
      const stable = tg.stability !== null && tg.stability.share >= CONSISTENT_SHARE;
      const stab = tg.stability === null ? 'no plateau' : `(${tg.stability.TargetMult}, ${tg.stability.StopMult}) in ${pct(tg.stability.share, 0)} of folds`;
      out.push(`${above && stable ? 'yes' : 'no'} — HitRate − Breakeven ${num(hr - be)} [${num(lo)}, ${num(ciHi - be)}] (${how}); plateau ${stab}`);
    }
  }

  if (!pnl || tg === null) out.push('not run');
  else {
    const sd = plateauOf(tg.pooledTest);
    const vu = plateauOf(tg.byTargetUnits.map((c) => ({ ...c, TargetMult: c.TargetUnits, HitRate_0: NaN })));
    const sdExp = sd === null ? null : finite(tg.pooledTest.find((c) => c.TargetMult === sd.TargetMult && c.StopMult === sd.StopMult)?.Expectancy);
    const vuExp = vu === null ? null : finite(tg.byTargetUnits.find((c) => c.TargetUnits === vu.TargetMult && c.StopMult === vu.StopMult)?.Expectancy);
    if (sdExp === null || vuExp === null) out.push('inconclusive (no plateau)');
    else {
      const winner = sdExp >= vuExp ? 'SweepDepth' : 'VolUnit';
      // A-137: per fold, OOS expectancy at each table's own train plateau.
      const both = tg.folds.map((f) => [finite(f.oos?.Expectancy), finite(f.unitsOos?.Expectancy)] as const)
        .filter((x): x is readonly [number, number] => x[0] !== null && x[1] !== null);
      const agree = both.filter(([a, b]) => (winner === 'SweepDepth' ? a >= b : b > a)).length;
      const folds = tg.folds.some((f) => f.unitsOos !== undefined)
        ? `; ${winner} ahead in ${agree} of ${both.length} folds (OOS at each fold's train plateaus) — ${both.length > 0 && agree >= CONSISTENT_SHARE * both.length ? 'consistent' : 'not consistent'} (≥ 75 %)`
        : '; pooled test only, per-fold consistency not measured';
      out.push(`${winner} — plateau expectancy ${num(sdExp, 2)} bps (SweepDepth ${sd!.TargetMult}×) vs ${num(vuExp, 2)} bps (VolUnit ${vu!.TargetMult}×)${folds}`);
    }
  }

  // Q6: the grid walk-forward when it ran the armMode variant, else the backtest variants (A-132).
  const wf = inp.grid?.walkForward ?? [];
  const bt = backtestVariants(inp);
  const gridPair = [wf.find((w) => w.variant === 'baseline'), wf.find((w) => w.variant === 'armMode')] as const;
  const btPair = [bt.find((v) => v.variant === 'baseline'), bt.find((v) => v.variant === 'armMode')] as const;
  const pair = gridPair[0] !== undefined && gridPair[1] !== undefined ? { a: totalPnl(gridPair[0].pooled), b: totalPnl(gridPair[1].pooled), src: 'grid walk-forward' }
    : btPair[0] !== undefined && btPair[1] !== undefined ? { a: totalPnl(btPair[0].pooled), b: totalPnl(btPair[1].pooled), src: 'backtest, configured parameters' }
      : null;
  if (!pnl || pair === null) out.push('not run (`wsr backtest --variants armMode` or `wsr grid --variants armMode`)');
  else {
    const cfgMode = inp.manifest.config.ArmMode;
    const other = cfgMode === 'RestEarly' ? 'ArmOnApproach' : 'RestEarly';
    out.push(!Number.isFinite(pair.a) || !Number.isFinite(pair.b) ? 'inconclusive'
      : `${pair.a >= pair.b ? cfgMode : other} — total OOS P&L ${cfgMode} ${num(pair.a, 1)} bps vs ${other} ${num(pair.b, 1)} bps (${pair.src})`);
  }

  out.push(!pnl || pooled === null ? 'not run' : mechanismVerdict(pooled.mechanism));

  if (!pnl || pooled === null) out.push('not run');
  else {
    const curve = [...pooled.latencyCurve].sort((a, b) => a.latencyMs - b.latencyMs);
    const dead = curve.find((c) => { const e = finite(c.expectancy_bps); return e !== null && e <= 0; });
    const sentence = latencySentenceApplies(curve) ? ` ${LATENCY_SENTENCE}` : '';
    if (curve.length < 2) {
      const c = curve[0];
      out.push(c === undefined ? 'not run' : dead !== undefined ? `expectancy ≤ 0 already at ${c.latencyMs} ms (only point evaluated; latency sweep not run)`
        : `inconclusive — expectancy ${num(c.expectancy_bps, 2)} bps at ${c.latencyMs} ms, the only point evaluated`);
    } else {
      out.push(dead !== undefined ? `edge gone at ${dead.latencyMs} ms${sentence}` : `expectancy > 0 at every evaluated latency (up to ${curve[curve.length - 1]!.latencyMs} ms)`);
    }
  }

  const cmp = inp.comparisons ?? [];
  out.push(cmp.length === 0 ? 'not answered by a single run — `wsr report --compare <a>,<b>` writes the cross-venue comparison (Spec §6.5)'
    : cmp.map((c) => `${c.verdict} (${c.compareId})`).join('; '));
  return out;
}

const APPENDIX_B: ReadonlyArray<readonly [string, string]> = [
  ['Is E[ReactionDisplacement] for WickLevels significantly above random and placebo levels, and monotone in WickStrength?', '§2 sets table, contrasts (1)−(4), (1)−(3), monotonicity; reaction.json gate'],
  ['Does "fast" matter: WickLevels vs SlowExtremes?', '§2 contrast (1)−(2)'],
  ['Sign of PriorTouches', '§8 byPriorTouches; §11 Stage B β PriorTouches per fold'],
  ['Is HitRate(2,1) above BreakevenHitRate, and is the optimal (TargetMult, StopMult) stable across folds?', '§4 target tables and placebo swept levels; §5 HitRate − Breakeven; plateau per fold'],
  ['Should the Target scale with SweepDepth or with VolUnit?', '§4 VolUnit-scaled table vs (TargetMult × StopMult) table; conditional table'],
  ['RestEarly vs ArmOnApproach: does requiring a violent Reclaim pay for the lost trades?', '§8 scenario variants (backtest / grid); byReturnSpeed'],
  ['Does post-entry aggressor imbalance separate winners from losers?', '§9 mechanism check'],
  ['Latency curve: where does the edge vanish?', '§6 latency curve'],
  ['Transfer across venues and symbols?', '§5 per (venue, symbol) + runs/compare-*/comparison.md'],
];

function section12(inp: ReportInputs): string[] {
  const verdicts = openQuestionVerdicts(inp);
  return ['## 12. Open questions (§12, Appendix B)', '',
    ...mdTable(['#', 'open question', 'answered by', 'verdict'], APPENDIX_B.map(([q, by], i) => [String(i + 1), q, by, verdicts[i]!]))];
}

// ---------------------------------------------------------------- report

// Spec §7.2 report.md: banner lines (Spec §6.1.6), title, sections 0–12.
export function renderReport(inp: ReportInputs): string {
  const m = inp.manifest;
  const gate = reportGate(inp);
  const lines: string[] = [];
  if (gate === 'fail') lines.push(REFUSED_BANNER, ...(inp.reaction?.gate.reasons ?? []).map((r) => `- ${r}`), '');
  if (gate === 'forced') lines.push(FORCED_BANNER, '');
  lines.push(`# WSR backtest — ${m.venue} ${m.symbol} ${m.span.from}…${m.span.to}`, '');
  if (m.feesVerifiedAt === null) lines.push('[VERIFY] fees unverified', '');
  const sections = [
    section0(inp), section1(inp), section2(inp), section3(inp, gate), section4(inp, gate), section5(inp, gate), section6(inp, gate),
    section7(inp, gate), section8(inp, gate), section9(inp, gate), section10(inp, gate), section11(inp, gate), section12(inp),
  ];
  lines.push(sections.map((s) => s.join('\n')).join('\n\n'));
  return `${lines.join('\n')}\n`;
}

// Section headings present in a rendered report ('0'…'12').
export function reportSections(markdown: string): string[] {
  return [...markdown.matchAll(/^## (\d+)\. /gm)].map((x) => x[1]!);
}
