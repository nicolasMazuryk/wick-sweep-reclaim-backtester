import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  baselineOf, benchCoreLoop, benchEndToEnd, buildManifest, compareBaseline, comparisonLines, comparisonOf, defaultWorkerCount, loadReportInputs, parseFoldDays,
  findStoredReaction, fixtureSpan, fromGridOf, installReplayHooks, materialiseFixtureRoot, readE2eFixture, NO_REACTION_BANNER, parseVariants, reactionKeyFor, readReaction, storedReactionMatches, renderReport, reportGate, reportSections, reportValue, ReplayInputError, runBacktest, runDirOf, runGrid, runIdOf, RunInterrupted,
  runReactionTest, spanLabels, syntheticDriftless, writeBacktestOutputs, writeComparison, writeGridOutputs, writeRunOutputs, type BacktestOptions, type BacktestResult, type BenchBaseline,
  type E2eFixtureManifest, type FromGrid, type GridFile, type GridOptions, type GridResult, type ReactionRun, type ReplayInput, type ReplayPlan, type ReportInputs, type RunManifest, type StoredReaction,
} from '@wsr/backtest';
import { computeConfigHash, InvariantViolation, parseRunConfig, type RunConfig } from '@wsr/core';
import {
  atomicWriteFile,
  DataIntegrityError,
  VENUE_ORDER,
  dayStartMs,
  dayEndMs,
  fetchMeta,
  fetchPartitions,
  formatDay,
  isVenueId,
  loadHygiene,
  mergeStored,
  parseDay,
  rebuildHygiene,
  summarizeCoverage,
  verifyPartitions,
  type PartitionResult,
  type PipelineLogger,
  type UtcDay,
  type VenueId,
} from '@wsr/data';
import { Command, CommanderError, Option } from 'commander';
import pino from 'pino';
import { ExitCode, UsageError, exitCodeFor, type ExitCodeValue } from './exit-codes.js';
import { NO_RUN_LOG, openRunLog, ProgressTicker, type RunLog } from './run-log.js';
import {
  formatBacktest, formatBench, formatBenchEndToEnd, formatCoverageTable, formatGrid, formatPartitionLine, formatReaction, formatSynthetic,
} from './output.js';

// Spec §3.2.4 / §2.7: WarmupDays = 8 calendar days by default.
export const WARMUP_DAYS = 8;
const EXTRA_DAYS = 7;
const DEFAULT_SYMBOLS = ['ETHUSDT', 'BTCUSDT'];

export interface DataCommands {
  readonly fetchPartitions: typeof fetchPartitions;
  readonly mergeStored: typeof mergeStored;
  readonly rebuildHygiene: typeof rebuildHygiene;
  readonly loadHygiene: typeof loadHygiene;
  readonly verifyPartitions: typeof verifyPartitions;
  readonly fetchMeta: typeof fetchMeta;
}

// `wsr reaction` (Spec §6.1); injectable like DataCommands.
export interface ReactionCommands {
  readonly runReactionTest: (
    input: ReplayInput, cfg: RunConfig, seed: number, opts: { readonly B?: number },
  ) => Promise<Pick<ReactionRun, 'result' | 'warnings'> & { readonly plan: Pick<ReplayPlan, 'dataChecksums' | 'feesVerifiedAt'> }>;
  readonly writeRunOutputs: typeof writeRunOutputs;
}

// `wsr backtest` (Spec §6); injectable like ReactionCommands.
export interface BacktestCommands {
  readonly runBacktest: (input: ReplayInput, cfg: RunConfig, seed: number, opts: BacktestOptions) => Promise<BacktestResult>;
  readonly writeBacktestOutputs: typeof writeBacktestOutputs;
  // runs/{runId}/reaction.json of an earlier `wsr reaction`; null when absent.
  readonly readStoredReaction: (runDir: string) => Promise<StoredReaction | null>;
  // `--synthetic driftless` (Spec §11.3, §12.2); default syntheticDriftless.
  readonly syntheticDriftless?: typeof syntheticDriftless;
  // Spec §6.1.6: a matching runs/*/reaction.json under the runs root (default findStoredReaction).
  readonly findStoredReaction?: typeof findStoredReaction;
  // `--from-grid`: runs/{runId}/run.json + grid.json; null when either is absent.
  readonly readGridRun?: (runDir: string) => Promise<{ readonly manifest: RunManifest; readonly grid: GridFile } | null>;
}

// `wsr grid` (Spec §6.4); injectable like BacktestCommands.
export interface GridCommands {
  readonly runGrid: (input: ReplayInput, cfg: RunConfig, seed: number, opts: GridOptions) => Promise<GridResult>;
  readonly writeGridOutputs: typeof writeGridOutputs;
  readonly writeRunOutputs: typeof writeRunOutputs;
  readonly readStoredReaction: (runDir: string) => Promise<StoredReaction | null>;
  readonly findStoredReaction?: typeof findStoredReaction;
  // runs/{runId}/run.json for `--run-id`; null when absent.
  readonly readRunManifest: (runDir: string) => Promise<RunManifest | null>;
}

// `wsr report` (Spec §7.2); also used by `wsr backtest --venue a,b` for the
// comparison table. Injectable like the others.
export interface ReportCommands {
  readonly loadReportInputs: typeof loadReportInputs;
  // Writes runs/{runId}/report.md atomically; returns its path.
  readonly writeReport: (runDir: string, markdown: string) => Promise<string>;
  // runs/compare-{hash}/ (A-135); default writeComparison.
  readonly writeComparison?: typeof writeComparison;
}

// `wsr bench` (Spec §10).
export interface BenchCommands {
  readonly benchCoreLoop: typeof benchCoreLoop;
  readonly benchEndToEnd: typeof benchEndToEnd;
  readonly readBaseline: (path: string) => Promise<BenchBaseline>;
  readonly writeBaseline: (path: string, baseline: BenchBaseline) => Promise<void>;
}

export interface CliDeps {
  readonly commands: DataCommands;
  readonly reaction: ReactionCommands;
  readonly backtest: BacktestCommands;
  readonly grid: GridCommands;
  readonly report: ReportCommands;
  readonly bench: BenchCommands;
  // run.json provenance (Spec §7.1); injected so the e2e goldens are byte-identical.
  readonly gitCommit: () => string;
  readonly version: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now: () => Date;
  // Soft stop (first SIGINT) and hard abort (second SIGINT).
  readonly shouldStop: () => boolean;
  readonly signal?: AbortSignal;
  readonly logger?: (level: string) => PipelineLogger;
}

const defaultCommands: DataCommands = { fetchPartitions, mergeStored, rebuildHygiene, loadHygiene, verifyPartitions, fetchMeta };
const defaultReaction: ReactionCommands = { runReactionTest, writeRunOutputs };

async function readStoredReaction(runDir: string): Promise<StoredReaction | null> {
  try {
    return await readReaction(runDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readGridRun(runDir: string): Promise<{ manifest: RunManifest; grid: GridFile } | null> {
  const manifest = await readRunManifest(runDir);
  if (manifest === null) return null;
  try {
    return { manifest, grid: JSON.parse(await readFile(join(runDir, 'grid.json'), 'utf8')) as GridFile };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// The run's own reaction.json when it matches, else the first matching one under runsRoot (A-136).
async function storedReactionFor(
  cmds: { readonly readStoredReaction: (runDir: string) => Promise<StoredReaction | null>; readonly findStoredReaction?: typeof findStoredReaction },
  runsRoot: string, ownDir: string, input: ReplayInput, config: RunConfig, B: number,
): Promise<StoredReaction | null> {
  const key = reactionKeyFor(input, config);
  const own = await cmds.readStoredReaction(ownDir);
  if (storedReactionMatches(own, key, B)) return own;
  return (cmds.findStoredReaction ?? findStoredReaction)(runsRoot, key, B);
}

const defaultBacktest: BacktestCommands = { runBacktest, writeBacktestOutputs, readStoredReaction };

async function readRunManifest(runDir: string): Promise<RunManifest | null> {
  let text: string;
  try {
    text = await readFile(join(runDir, 'run.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return (JSON.parse(text) as { runManifest: RunManifest }).runManifest;
}

const defaultGrid: GridCommands = { runGrid, writeGridOutputs, writeRunOutputs, readStoredReaction, readRunManifest };

const defaultReport: ReportCommands = {
  loadReportInputs,
  writeReport: async (runDir, markdown) => {
    const path = join(runDir, 'report.md');
    await atomicWriteFile(path, Buffer.from(markdown));
    return path;
  },
};

const defaultBench: BenchCommands = {
  benchCoreLoop,
  benchEndToEnd,
  readBaseline: async (path) => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as BenchBaseline;
    } catch (error) {
      throw new UsageError(`cannot read baseline ${path}: ${(error as Error).message}`);
    }
  },
  writeBaseline: async (path, baseline) => {
    await atomicWriteFile(path, Buffer.from(`${JSON.stringify(baseline, null, 2)}\n`));
  },
};

function gitHead(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

const PACKAGE_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

interface GlobalOptions {
  readonly dataRoot: string;
  readonly config?: string;
  readonly logLevel: string;
  readonly json?: boolean;
}

interface SelectorOptions {
  readonly venue?: string;
  readonly symbol?: string;
  readonly from?: string;
  readonly to?: string;
}

function list(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : value.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
}

function utcToday(now: Date): UtcDay {
  return { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
}

function shiftDays(day: UtcDay, n: number): UtcDay {
  const date = new Date(dayStartMs(day) + n * 86_400_000);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

// Spec §2.7 defaults: --to = yesterday UTC; --from = run date − 12 months −
// WarmupDays − 7.
export function defaultRange(now: Date): { from: UtcDay; to: UtcDay } {
  const today = utcToday(now);
  const yearAgo = new Date(Date.UTC(today.y, today.m - 1 - 12, today.d));
  const from = shiftDays({ y: yearAgo.getUTCFullYear(), m: yearAgo.getUTCMonth() + 1, d: yearAgo.getUTCDate() }, -(WARMUP_DAYS + EXTRA_DAYS));
  return { from, to: shiftDays(today, -1) };
}

// `wsr reaction` default span: run date − 12 months … yesterday UTC (the
// replay adds WarmupDays before it).
export function defaultSpan(now: Date): { from: UtcDay; to: UtcDay } {
  const today = utcToday(now);
  const yearAgo = new Date(Date.UTC(today.y, today.m - 1 - 12, today.d));
  return { from: { y: yearAgo.getUTCFullYear(), m: yearAgo.getUTCMonth() + 1, d: yearAgo.getUTCDate() }, to: shiftDays(today, -1) };
}

function parseDayFlag(text: string | undefined, fallback: UtcDay, flag: string): UtcDay {
  if (text === undefined) {
    return fallback;
  }
  try {
    return parseDay(text);
  } catch (error) {
    throw new UsageError(`${flag}: ${(error as Error).message}`);
  }
}

function checkSymbol(symbol: string): void {
  if (!/^[A-Z0-9]+USDT$/.test(symbol)) {
    throw new UsageError(`symbol '${symbol}' is not canonical (<BASE>USDT, upper case)`);
  }
}

function checkVenues(venueNames: readonly string[]): VenueId[] {
  const unknown = venueNames.filter((v) => !isVenueId(v));
  if (unknown.length > 0) {
    throw new UsageError(`unknown venue(s): ${unknown.join(', ')} (known: ${VENUE_ORDER.join(', ')})`);
  }
  return venueNames as VenueId[];
}

function parseUint(text: string, flag: string, max: number, min = 0): number {
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new UsageError(`${flag} must be an integer in [${min}, ${max}], got '${text}'`);
  }
  return value;
}

async function loadConfig(path: string | undefined): Promise<RunConfig | undefined> {
  if (path === undefined) {
    return undefined;
  }
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read config ${path}: ${(error as Error).message}`);
  }
  try {
    return parseRunConfig(JSON.parse(text));
  } catch (error) {
    throw new UsageError(`invalid config ${path}: ${(error as Error).message}`);
  }
}

interface ResolvedSelection {
  readonly venues: VenueId[];
  readonly symbols: string[];
  readonly from: UtcDay;
  readonly to: UtcDay;
}

async function resolveSelection(options: SelectorOptions, globals: GlobalOptions, now: Date): Promise<ResolvedSelection> {
  const venues = checkVenues(list(options.venue) ?? [...VENUE_ORDER]);
  let symbols = list(options.symbol);
  if (symbols === undefined) {
    const config = await loadConfig(globals.config);
    if (config === undefined) {
      throw new UsageError('--symbol is required without --config (the default includes config.data.lowCapSymbol)');
    }
    symbols = [...DEFAULT_SYMBOLS, config.data.lowCapSymbol];
  } else if (globals.config !== undefined) {
    await loadConfig(globals.config); // still validate it
  }
  symbols.forEach(checkSymbol);
  const { from, to } = resolveSpan(options, defaultRange(now));
  return { venues, symbols, from, to };
}

function resolveSpan(options: SelectorOptions, defaults: { from: UtcDay; to: UtcDay }): { from: UtcDay; to: UtcDay } {
  const from = parseDayFlag(options.from, defaults.from, '--from');
  const to = parseDayFlag(options.to, defaults.to, '--to');
  if (dayStartMs(from) > dayStartMs(to)) {
    throw new UsageError(`--from ${formatDay(from)} is after --to ${formatDay(to)}`);
  }
  return { from, to };
}

function makeLogger(level: string): PipelineLogger {
  return pino({ level, base: { runId: `data-${process.pid}` } }, pino.destination(2));
}

function withSelectors(command: Command): Command {
  return command
    .option('--venue <ids>', `comma-separated venue ids (default: ${VENUE_ORDER.join(',')})`)
    .option('--symbol <symbols>', 'comma-separated canonical symbols (default: ETHUSDT,BTCUSDT,<config.data.lowCapSymbol>)')
    .option('--from <YYYY-MM-DD>', 'first UTC day (default: run date − 12 months − WarmupDays − 7)')
    .option('--to <YYYY-MM-DD>', 'last UTC day (default: yesterday UTC)');
}

export function buildProgram(deps: CliDeps, setExit: (code: ExitCodeValue) => void): Command {
  const program = new Command('wsr');
  program
    .description('Wick-sweep-reclaim backtest system')
    .option('--data-root <dir>', 'data directory', './data')
    .option('--config <file>', 'run config JSON (Spec §8)')
    .addOption(new Option('--log-level <level>', 'log level; silent writes no runs/{runId}/logs/*.jsonl and no progress').choices(['error', 'warn', 'info', 'debug', 'silent']).default('info'))
    .option('--json', 'machine-readable NDJSON on stdout')
    .exitOverride()
    .configureOutput({ writeOut: (s) => deps.stdout(s.trimEnd()), writeErr: (s) => deps.stderr(s.trimEnd()) });

  const data = program.command('data').description('venue data pipeline (Spec §2)').exitOverride();

  const context = (command: Command) => {
    const globals = command.optsWithGlobals<GlobalOptions & SelectorOptions>();
    const log = (deps.logger ?? makeLogger)(globals.logLevel);
    const emit = (result: PartitionResult): void => {
      deps.stdout(globals.json === true ? JSON.stringify({ type: 'partition', ...result }) : formatPartitionLine(result));
    };
    return { globals, log, emit };
  };

  const printCoverage = async (globals: GlobalOptions, selection: ResolvedSelection): Promise<void> => {
    const entries = await deps.commands.loadHygiene({ ...selection, dataRoot: globals.dataRoot });
    const rows = summarizeCoverage(entries);
    if (globals.json === true) {
      rows.forEach((row) => deps.stdout(JSON.stringify({ type: 'coverage', ...row })));
    } else {
      formatCoverageTable(rows).forEach((line) => deps.stdout(line));
    }
  };

  withSelectors(data.command('fetch').description('download, normalise, merge, write raw+merged+hygiene+.done'))
    .option('--concurrency <n>', 'parallel archive downloads per venue', '2')
    .option('--dry-run', 'plan via listAvailable only')
    .option('--keep-cache', 'keep downloaded archives under {data-root}/cache')
    .action(async (_options: unknown, command: Command) => {
      const { globals, log, emit } = context(command);
      const options = command.opts<{ concurrency: string; dryRun?: boolean; keepCache?: boolean }>();
      const concurrency = Number(options.concurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new UsageError(`--concurrency must be a positive integer, got '${options.concurrency}'`);
      }
      const selection = await resolveSelection(globals, globals, deps.now());
      const result = await deps.commands.fetchPartitions({
        ...selection,
        dataRoot: globals.dataRoot,
        concurrency,
        dryRun: options.dryRun === true,
        keepCache: options.keepCache === true,
        shouldStop: deps.shouldStop,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        log,
        onPartition: emit,
      });
      if (options.dryRun !== true) {
        await printCoverage(globals, selection);
      }
      const failed = result.partitions.filter((r) => r.status === 'failed' || r.status === 'checksumFailed');
      if (failed.length > 0 && globals.json !== true) {
        deps.stdout(`${failed.length} partition(s) failed:`);
        failed.forEach((r) => deps.stdout(`  ${formatPartitionLine(r)}`));
      }
      setExit(exitCodeFor(result.partitions, result.interrupted));
    });

  withSelectors(data.command('merge').description('re-run the Spec §2.4 merge from stored raw partitions'))
    .option('--force', 'rebuild partitions that already have a merged file')
    .action(async (_options: unknown, command: Command) => {
      const { globals, log, emit } = context(command);
      const selection = await resolveSelection(globals, globals, deps.now());
      const results = await deps.commands.mergeStored({ ...selection, dataRoot: globals.dataRoot, force: command.opts<{ force?: boolean }>().force === true, log, onPartition: emit });
      setExit(exitCodeFor(results));
    });

  withSelectors(data.command('hygiene').description('(re)compute hygiene reports'))
    .option('--summary', 'print the coverage table only (no recomputation)')
    .action(async (_options: unknown, command: Command) => {
      const { globals, log, emit } = context(command);
      const selection = await resolveSelection(globals, globals, deps.now());
      if (command.opts<{ summary?: boolean }>().summary === true) {
        await printCoverage(globals, selection);
        setExit(ExitCode.success);
        return;
      }
      const statuses: PartitionResult[] = [];
      await deps.commands.rebuildHygiene({
        ...selection,
        dataRoot: globals.dataRoot,
        log,
        onPartition: (result) => {
          statuses.push(result);
          emit(result);
        },
      });
      await printCoverage(globals, selection);
      setExit(exitCodeFor(statuses));
    });

  withSelectors(data.command('meta').description('fetch instrument meta, fee placeholders and funding history'))
    .action(async (_options: unknown, command: Command) => {
      const { globals, log } = context(command);
      const selection = await resolveSelection(globals, globals, deps.now());
      const results = await deps.commands.fetchMeta({
        venues: selection.venues,
        symbols: selection.symbols,
        dataRoot: globals.dataRoot,
        fundingFrom: dayStartMs(selection.from),
        fundingTo: dayEndMs(selection.to) - 1,
        log,
      });
      for (const result of results) {
        deps.stdout(
          globals.json === true
            ? JSON.stringify({ type: 'meta', ...result })
            : `${result.status.padEnd(15)} ${result.venue.padEnd(8)} ${result.symbol.padEnd(12)} ${result.status === 'done' ? `funding=${result.fundingRecords} ${result.instrumentHistoryPath}` : `— ${result.error}`}`,
        );
        // [VERIFY] placeholders written into instrument_history.json (Spec §2.7, A-102).
        if (globals.json !== true) {
          (result.verify ?? []).forEach((note) => deps.stdout(`  ${note}`));
        }
      }
      setExit(results.some((r) => r.status === 'failed') ? ExitCode.partialFailure : ExitCode.success);
    });

  withSelectors(data.command('verify').description('recompute sha256 of every partition and compare with .done'))
    .action(async (_options: unknown, command: Command) => {
      const { globals, emit } = context(command);
      const selection = await resolveSelection(globals, globals, deps.now());
      const results = await deps.commands.verifyPartitions({ ...selection, dataRoot: globals.dataRoot, onPartition: emit });
      const bad = results.filter((r) => r.status === 'integrityFailed');
      if (globals.json !== true) {
        deps.stdout(`verified ${results.length} partition(s), ${bad.length} mismatch(es)`);
      }
      setExit(exitCodeFor(results));
    });

  // Spec §10 "Logging" / "Progress" (A-140): every run command writes pino JSON lines
  // to runs/{runId}/logs/{command}.jsonl (runId, venue, symbol on every line)
  // and an NDJSON progress sample every 5 s with eventsProcessed /
  // eventsPerSec, counted over the decoded replay batches. `stopOnSignal`
  // makes the first SIGINT abort the replay itself (exit 130) instead of
  // waiting for the whole run. Both are off with an injected logger (tests)
  // and with --log-level silent, so no golden-compared file moves.
  interface RunSession {
    readonly log: PipelineLogger;
    readonly progress: (sample: object) => void;
    readonly close: () => Promise<void>;
  }
  const openSession = (
    command: string, globals: GlobalOptions, runsRoot: string, runId: string,
    base: { readonly venue: string; readonly symbol: string } & Readonly<Record<string, unknown>>,
    opts: { readonly stopOnSignal: boolean } = { stopOnSignal: false },
  ): RunSession => {
    const quiet = deps.logger !== undefined || globals.logLevel === 'silent';
    const runLog: RunLog = quiet ? NO_RUN_LOG : openRunLog(runsRoot, runId, command, globals.logLevel, base);
    const log = deps.logger === undefined ? runLog.log : deps.logger(globals.logLevel);
    const emit = (sample: object): void => {
      log.info(sample, 'progress');
      if (globals.json === true) deps.stdout(JSON.stringify(sample));
      else deps.stderr(JSON.stringify(sample));
    };
    const ticker = quiet ? null : new ProgressTicker(emit, { command, runId, venue: base.venue, symbol: base.symbol }, () => deps.now().getTime());
    const restore = installReplayHooks({
      ...(opts.stopOnSignal ? { shouldStop: deps.shouldStop } : {}),
      ...(ticker === null ? {} : { onProgress: (p) => ticker.add(p.batchEvents, p.day) }),
    });
    log.info({ command, ...base }, 'run start');
    return {
      log,
      progress: (sample) => { if (!quiet) emit(sample); },
      close: async () => {
        restore();
        ticker?.flush();
        log.info({ command, ...base }, 'run done');
        await runLog.close();
      },
    };
  };

  program
    .command('reaction')
    .description('reaction test + gate (Spec §6.1) → {runs-root}/{runId}/reaction.json; exit 3 when the gate fails')
    .requiredOption('--venue <id>', 'venue id; a comma list runs each venue independently (never mixed)')
    .requiredOption('--symbol <symbol>', 'canonical symbol')
    .option('--from <YYYY-MM-DD>', 'first span day (default: run date − 12 months; the replay adds WarmupDays before it)')
    .option('--to <YYYY-MM-DD>', 'last span day (default: yesterday UTC)')
    .option('--seed <n>', 'uint32 seed (default: config seed)')
    .option('--runs-root <dir>', 'output root', './runs')
    .addOption(new Option('--bootstrap <B>', 'bootstrap resamples (diagnostic)').default('2000').hideHelp())
    .exitOverride()
    .action(async (_options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOptions & SelectorOptions & { seed?: string; runsRoot: string; bootstrap: string }>();
      const loaded = await loadConfig(globals.config);
      if (loaded === undefined) {
        throw new UsageError('wsr reaction requires --config');
      }
      const venues = checkVenues(list(globals.venue) ?? []);
      checkSymbol(globals.symbol!);
      const { from, to } = resolveSpan(globals, defaultSpan(deps.now()));
      const seed = globals.seed === undefined ? loaded.seed : parseUint(globals.seed, '--seed', 0xffffffff);
      const B = parseUint(globals.bootstrap, '--bootstrap', 1_000_000, 1);
      const config: RunConfig = { ...loaded, seed };
      let code: ExitCodeValue = ExitCode.success;
      for (const venue of venues) {
        const input: ReplayInput = { dataRoot: globals.dataRoot, venue, symbol: globals.symbol!, from, to };
        const labels = spanLabels(input);
        const runId = runIdOf(venue, input.symbol, labels, computeConfigHash(config), seed);
        const session = openSession('reaction', globals, globals.runsRoot, runId, { venue, symbol: input.symbol, span: labels, seed }, { stopOnSignal: true });
        try {
          const run = await deps.reaction.runReactionTest(input, config, seed, { B });
          const manifest = buildManifest({
            venue, symbol: input.symbol, span: labels, seed, config, dataChecksums: run.plan.dataChecksums,
            feesVerifiedAt: run.plan.feesVerifiedAt, warnings: run.warnings,
            createdAt: deps.now().toISOString(), gitCommit: deps.gitCommit(), wsrVersion: deps.version,
          });
          const paths = await deps.reaction.writeRunOutputs(globals.runsRoot, manifest, run.result);
          session.log.info({ runId: manifest.runId, gate: run.result.gate.pass, warnings: run.warnings }, 'reaction test done');
          if (globals.json === true) {
            deps.stdout(JSON.stringify({ type: 'reaction', runId: manifest.runId, ...paths, warnings: run.warnings, result: reportValue(run.result) }));
          } else {
            formatReaction(manifest, run.result, run.warnings, paths.reactionJson).forEach((line) => deps.stdout(line));
          }
          if (!run.result.gate.pass) {
            code = ExitCode.reactionFailed;
          }
        } finally {
          await session.close();
        }
      }
      setExit(code);
    });

  // Spec §6.1.6 (A-136): the P&L backtest refuses without a reaction.json of the same
  // (venue, symbol, span, gate config) and B, unless --run-reaction / --force-pnl.
  const refuseWithoutReaction = (input: ReplayInput, runsRoot: string, B: number, json: boolean): void => {
    const reason = `no reaction.json of ${input.venue} ${input.symbol} ${formatDay(input.from)}…${formatDay(input.to)} with this gate config and B = ${B} under ${runsRoot} — run \`wsr reaction\` first, or pass --run-reaction`;
    if (json) deps.stdout(JSON.stringify({ type: 'refused', venue: input.venue, symbol: input.symbol, reason }));
    else [NO_REACTION_BANNER, `  - ${reason}`].forEach((line) => deps.stdout(line));
  };

  // `wsr backtest --synthetic driftless --trades N` (Spec §12.2, A-133): exit
  // 5 when HitRate(2,1) is outside 1/3 ± 3σ (an engine bias), else 3 when the
  // reaction gate fails (the expected outcome), else 0.
  const runSynthetic = (globals: GlobalOptions & { seed?: string; trades: string; bootstrap: string }): void => {
    const trades = parseUint(globals.trades, '--trades', 10_000_000, 1);
    const seed = globals.seed === undefined ? 1 : parseUint(globals.seed, '--seed', 0xffffffff);
    const B = parseUint(globals.bootstrap, '--bootstrap', 1_000_000, 1);
    const r = (deps.backtest.syntheticDriftless ?? syntheticDriftless)({ trades, seed, B });
    if (globals.json === true) deps.stdout(JSON.stringify({ type: 'synthetic', path: 'driftless', ...reportValue(r) as object }));
    else formatSynthetic(r).forEach((line) => deps.stdout(line));
    if (!r.within3Sigma) {
      deps.stderr('HitRate(2,1) outside 1/3 ± 3σ on a driftless walk — the engine is biased (Spec §11.3)');
      setExit(ExitCode.invariantViolated);
    } else {
      setExit(r.reaction.gate.pass ? ExitCode.success : ExitCode.reactionFailed);
    }
  };

  program
    .command('backtest')
    .description('reaction gate → walk-forward P&L backtest (Spec §6) → {runs-root}/{runId}/; exit 3 when the reaction test fails')
    .option('--venue <id>', 'venue id; a comma list runs each venue independently (never mixed); required without --synthetic')
    .option('--symbol <symbol>', 'canonical symbol; required without --synthetic')
    .option('--from <YYYY-MM-DD>', 'first span day (default: run date − 12 months; the replay adds WarmupDays before it)')
    .option('--to <YYYY-MM-DD>', 'last span day (default: yesterday UTC)')
    .option('--seed <n>', 'uint32 seed (default: config seed)')
    .option('--runs-root <dir>', 'output root', './runs')
    .addOption(new Option('--synthetic <path>', 'Spec §11.3 acceptance run instead of stored data: HitRate(2,1) vs 1/3 ± 3σ and the reaction gate').choices(['driftless']))
    .option('--trades <n>', 'with --synthetic: triggered trades to collect', '20000')
    .option('--force-pnl', 'run the P&L backtest despite a failed reaction test (diagnostics only; bannered)')
    .option('--run-reaction', 'no stored reaction.json of the same inputs: run the reaction test here and gate on it (Spec §6.1.6)')
    .option('--latency-sweep', 'latency curve: one extra replay per latency point {0, 50, 150, 500} ms (Spec §4.1)')
    .option('--slippage-sweep', 'slippage curve: one extra replay per SlipCoef ×2, ×4 (Spec §9.4)')
    .option('--variants <list>', 'scenario variants besides the baseline, one trading pass each: armMode,timeStop,counterTrendBlock,targetMode,ageClock')
    .option('--workers <n>', 'worker threads of the sweep / variant replays; 0 = in-process (default: available parallelism − 1)')
    .option('--from-grid <runId>', 'trade each fold with runs/{runId}/grid.json\'s chosen cell, fitted Stage B and target plateau; inputs from its run.json')
    .option('--fixture <dir>', 'Spec §11.4 end-to-end fixture: materialise its recorded day and generated days under {data-root}/fixtures/{name} and run its declared inputs')
    .addOption(new Option('--folds <train,test,step>', 'fold lengths in days; waives F ≥ 12 (diagnostic)').hideHelp())
    .addOption(new Option('--bootstrap <B>', 'bootstrap resamples (diagnostic)').default('2000').hideHelp())
    .exitOverride()
    .action(async (_options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOptions & SelectorOptions & {
        seed?: string; runsRoot: string; bootstrap: string; forcePnl?: boolean; folds?: string; latencySweep?: boolean; slippageSweep?: boolean;
        workers?: string; variants?: string; synthetic?: string; trades: string; fromGrid?: string; runReaction?: boolean; fixture?: string;
      }>();
      if (globals.synthetic !== undefined) {
        runSynthetic(globals);
        return;
      }
      // Spec §11.4 / A-150: the fixture carries its own config, data root, span,
      // seed and fold lengths; conflicting flags are a usage error.
      let fixture: E2eFixtureManifest | undefined;
      let dataRoot = globals.dataRoot;
      let configPath = globals.config;
      if (globals.fixture !== undefined) {
        if (globals.fromGrid !== undefined || globals.synthetic !== undefined) throw new UsageError('--fixture cannot be combined with --from-grid or --synthetic');
        const given = (['venue', 'symbol', 'from', 'to', 'seed', 'config', 'folds'] as const).filter((k) => globals[k] !== undefined);
        if (given.length > 0) throw new UsageError(`--fixture takes its inputs from the fixture: drop ${given.map((k) => `--${k}`).join(', ')}`);
        dataRoot = join(globals.dataRoot, 'fixtures', (await readE2eFixture(globals.fixture)).name);
        fixture = await materialiseFixtureRoot(globals.fixture, dataRoot);
        configPath = join(globals.fixture, 'config.json');
      }
      const loaded = await loadConfig(configPath);
      let config: RunConfig;
      let venues: VenueId[];
      let symbol: string;
      let span: { from: UtcDay; to: UtcDay };
      let seed: number;
      let fromGrid: FromGrid | undefined;
      let gridRunDir: string | undefined;
      if (fixture !== undefined) {
        if (loaded === undefined) throw new UsageError(`--fixture ${globals.fixture!}: no config.json`);
        venues = checkVenues([fixture.venue]);
        symbol = fixture.symbol;
        checkSymbol(symbol);
        span = fixtureSpan(fixture);
        seed = fixture.seed;
        config = { ...loaded, seed };
      } else if (globals.fromGrid !== undefined) {
        // Spec §6.3 / A-134: inputs default to the grid run's run.json; given flags must match it.
        gridRunDir = runDirOf(globals.runsRoot, globals.fromGrid);
        const stored = await (deps.backtest.readGridRun ?? readGridRun)(gridRunDir);
        if (stored === null) throw new UsageError(`--from-grid ${globals.fromGrid}: no run.json + grid.json under ${gridRunDir}`);
        const m = stored.manifest;
        const cfgIn: Record<string, unknown> = { ...m.config };
        delete cfgIn.MaxAge;                                       // derived (Spec §8.1)
        config = parseRunConfig(cfgIn);
        seed = m.seed;
        const conflicts: string[] = [];
        if (globals.venue !== undefined && globals.venue !== m.venue) conflicts.push(`--venue ${globals.venue} ≠ ${m.venue}`);
        if (globals.symbol !== undefined && globals.symbol !== m.symbol) conflicts.push(`--symbol ${globals.symbol} ≠ ${m.symbol}`);
        if (globals.from !== undefined && globals.from !== m.span.from) conflicts.push(`--from ${globals.from} ≠ ${m.span.from}`);
        if (globals.to !== undefined && globals.to !== m.span.to) conflicts.push(`--to ${globals.to} ≠ ${m.span.to}`);
        if (globals.seed !== undefined && parseUint(globals.seed, '--seed', 0xffffffff) !== m.seed) conflicts.push(`--seed ${globals.seed} ≠ ${m.seed}`);
        if (loaded !== undefined && computeConfigHash({ ...loaded, seed }) !== m.configHash) conflicts.push('--config differs from the grid run\'s config');
        if (conflicts.length > 0) throw new UsageError(`--from-grid ${globals.fromGrid}: ${conflicts.join('; ')}`);
        venues = [m.venue];
        symbol = m.symbol;
        span = { from: parseDay(m.span.from), to: parseDay(m.span.to) };
        fromGrid = fromGridOf(globals.fromGrid, stored.grid);
      } else {
        if (globals.venue === undefined || globals.symbol === undefined) throw new UsageError('wsr backtest requires --venue and --symbol (or --synthetic / --from-grid)');
        if (loaded === undefined) throw new UsageError('wsr backtest requires --config');
        venues = checkVenues(list(globals.venue) ?? []);
        symbol = globals.symbol;
        checkSymbol(symbol);
        span = resolveSpan(globals, defaultSpan(deps.now()));
        seed = globals.seed === undefined ? loaded.seed : parseUint(globals.seed, '--seed', 0xffffffff);
        config = { ...loaded, seed };
      }
      const { from, to } = span;
      const B = fixture === undefined ? parseUint(globals.bootstrap, '--bootstrap', 1_000_000, 1) : fixture.bootstrap;
      const foldsFlag = fixture === undefined ? globals.folds : fixture.folds;
      const folds = foldsFlag === undefined ? undefined : parseFoldDays(foldsFlag);
      const sweeps: Partial<BacktestOptions> = {
        ...(globals.latencySweep === true ? { latencySweep: true } : {}), ...(globals.slippageSweep === true ? { slippageSweep: true } : {}),
        ...(globals.workers === undefined ? {} : { workers: parseUint(globals.workers, '--workers', 1024) }),
        ...(globals.variants === undefined ? {} : { variants: parseVariants(globals.variants, config) }),
        ...(fromGrid === undefined ? {} : { fromGrid }),
      };
      let code: ExitCodeValue = ExitCode.success;
      const runDirs: string[] = [];
      for (const venue of venues) {
        const input: ReplayInput = { dataRoot, venue, symbol, from, to };
        const labels = spanLabels(input);
        const runId = runIdOf(venue, input.symbol, labels, computeConfigHash(config), seed);
        // A --from-grid run takes the gate from the grid run's reaction.json (same inputs, A-134).
        const storedReaction = await storedReactionFor(deps.backtest, globals.runsRoot, gridRunDir ?? runDirOf(globals.runsRoot, runId), input, config, B);
        if (storedReaction === null && globals.runReaction !== true && globals.forcePnl !== true) {
          refuseWithoutReaction(input, globals.runsRoot, B, globals.json === true);
          code = ExitCode.reactionFailed;
          continue;
        }
        const session = openSession('backtest', globals, globals.runsRoot, runId, { venue, symbol, span: labels, seed }, { stopOnSignal: true });
        try {
          const result = await deps.backtest.runBacktest(input, config, seed, {
            B, forcePnl: globals.forcePnl === true, storedReaction, ...(folds === undefined ? {} : { folds }), ...sweeps,
          });
          const plan = result.reaction.plan;
          const manifest = buildManifest({
            venue, symbol: input.symbol, span: labels, seed, config, dataChecksums: plan.dataChecksums, feesVerifiedAt: plan.feesVerifiedAt,
            warnings: result.warnings, createdAt: deps.now().toISOString(), gitCommit: deps.gitCommit(), wsrVersion: deps.version,
            ...(fromGrid === undefined ? {} : { fromGrid: fromGrid.runId }),
          });
          const paths = await deps.backtest.writeBacktestOutputs(globals.runsRoot, manifest, result, { dataRoot });
          session.log.info({ runId: manifest.runId, gate: result.gate, trades: result.records.length, warnings: result.warnings }, 'backtest done');
          runDirs.push(paths.runDir);
          if (globals.json === true) {
            deps.stdout(JSON.stringify({
              type: 'backtest', runId: manifest.runId, gate: result.gate, runDir: paths.runDir, files: paths.files, warnings: result.warnings,
              folds: reportValue(result.foldMetrics),
            }));
          } else {
            formatBacktest(manifest, result, paths.files).forEach((line) => deps.stdout(line));
          }
          if (result.gate === 'fail') {
            code = ExitCode.reactionFailed;
          }
        } finally {
          await session.close();
        }
      }
      // Spec §6.5: independent runs per venue plus a persisted comparison (open question 9, A-135).
      if (runDirs.length > 1) {
        await compareRuns(globals.runsRoot, runDirs, { dataRoot: globals.dataRoot }, globals.json === true);
      }
      setExit(code);
    });

  // Writes runs/compare-{hash}/comparison.{json,md}, re-renders each run's
  // report.md (its Q9 now reads the comparison) and prints the table.
  const compareRuns = async (runsRoot: string, runDirs: ReadonlyArray<string>, opts: { readonly dataRoot: string }, json: boolean): Promise<ReportInputs[]> => {
    const first = await Promise.all(runDirs.map((d) => deps.report.loadReportInputs(d, opts)));
    const c = comparisonOf(first);
    const paths = await (deps.report.writeComparison ?? writeComparison)(runsRoot, c);
    const runs: ReportInputs[] = [];
    for (const d of runDirs) {
      const inputs = await deps.report.loadReportInputs(d, opts);
      await deps.report.writeReport(d, renderReport(inputs));
      runs.push(inputs);
    }
    if (json) {
      deps.stdout(JSON.stringify({ type: 'comparison', compareId: c.compareId, json: paths.json, md: paths.md, verdict: c.verdict, lines: comparisonLines(c) }));
    } else {
      deps.stdout('');
      comparisonLines(c).forEach((line) => deps.stdout(line));
      deps.stdout('');
      deps.stdout(`comparison.json: ${paths.json}`);
      deps.stdout(`comparison.md: ${paths.md}`);
    }
    return runs;
  };

  program
    .command('grid')
    .description('parameter grid, plateau per fold, sensitivity, DSR, reality check (Spec §6.4) → {runs-root}/{runId}/; resumable')
    .option('--venue <id>', 'venue id (required without --run-id)')
    .option('--symbol <symbol>', 'canonical symbol (required without --run-id)')
    .option('--from <YYYY-MM-DD>', 'first span day (default: run date − 12 months; the replay adds WarmupDays before it)')
    .option('--to <YYYY-MM-DD>', 'last span day (default: yesterday UTC)')
    .option('--seed <n>', 'uint32 seed (default: config seed)')
    .option('--runs-root <dir>', 'output root', './runs')
    .option('--run-id <id>', 'resume runs/{id}: venue, symbol, span, seed and config from its run.json; completed cells are skipped')
    .option('--workers <n>', 'worker threads; 0 = in-process (default: available parallelism − 1)')
    .option('--variants <list>', 'scenario variants besides the baseline: armMode,timeStop,counterTrendBlock,targetMode,ageClock')
    .option('--force-pnl', 'run the grid despite a failed reaction test (diagnostics only; bannered)')
    .option('--run-reaction', 'no stored reaction.json of the same inputs: run the reaction test here and gate on it (Spec §6.1.6)')
    .addOption(new Option('--folds <train,test,step>', 'fold lengths in days; waives F ≥ 12 (diagnostic)').hideHelp())
    .addOption(new Option('--bootstrap <B>', 'bootstrap resamples of the reaction test and the reality check (diagnostic)').hideHelp())
    .addOption(new Option('--min-trades-train <n>', 'MinTradesTrain of the plateau selection (diagnostic)').default('100').hideHelp())
    .exitOverride()
    .action(async (_options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOptions & SelectorOptions & {
        seed?: string; runsRoot: string; runId?: string; workers?: string; variants?: string; forcePnl?: boolean; folds?: string;
        bootstrap?: string; minTradesTrain: string; runReaction?: boolean;
      }>();
      const loaded = await loadConfig(globals.config);
      let config: RunConfig;
      let input: ReplayInput;
      let seed: number;
      if (globals.runId !== undefined) {
        const manifest = await deps.grid.readRunManifest(runDirOf(globals.runsRoot, globals.runId));
        if (manifest === null) throw new UsageError(`--run-id ${globals.runId}: no run.json under ${runDirOf(globals.runsRoot, globals.runId)}`);
        const stored: Record<string, unknown> = { ...manifest.config };
        delete stored.MaxAge;                                       // derived (Spec §8.1)
        config = parseRunConfig(stored);
        seed = manifest.seed;
        input = { dataRoot: globals.dataRoot, venue: manifest.venue, symbol: manifest.symbol, from: parseDay(manifest.span.from), to: parseDay(manifest.span.to) };
        const conflicts: string[] = [];
        if (globals.venue !== undefined && globals.venue !== manifest.venue) conflicts.push(`--venue ${globals.venue} ≠ ${manifest.venue}`);
        if (globals.symbol !== undefined && globals.symbol !== manifest.symbol) conflicts.push(`--symbol ${globals.symbol} ≠ ${manifest.symbol}`);
        if (globals.from !== undefined && globals.from !== manifest.span.from) conflicts.push(`--from ${globals.from} ≠ ${manifest.span.from}`);
        if (globals.to !== undefined && globals.to !== manifest.span.to) conflicts.push(`--to ${globals.to} ≠ ${manifest.span.to}`);
        if (globals.seed !== undefined && parseUint(globals.seed, '--seed', 0xffffffff) !== manifest.seed) conflicts.push(`--seed ${globals.seed} ≠ ${manifest.seed}`);
        if (loaded !== undefined && computeConfigHash({ ...loaded, seed }) !== manifest.configHash) conflicts.push('--config differs from the run\'s config');
        if (conflicts.length > 0) throw new UsageError(`--run-id ${globals.runId}: ${conflicts.join('; ')}`);
        if (runIdOf(manifest.venue, manifest.symbol, manifest.span, computeConfigHash(config), seed) !== globals.runId) {
          throw new UsageError(`--run-id ${globals.runId}: run.json does not reproduce this runId (edited or other version)`);
        }
      } else {
        if (loaded === undefined) throw new UsageError('wsr grid requires --config (or --run-id)');
        if (globals.venue === undefined || globals.symbol === undefined) throw new UsageError('wsr grid requires --venue and --symbol (or --run-id)');
        const venues = checkVenues(list(globals.venue) ?? []);
        if (venues.length !== 1) throw new UsageError('wsr grid runs one venue at a time (Spec §6.5)');
        checkSymbol(globals.symbol);
        const { from, to } = resolveSpan(globals, defaultSpan(deps.now()));
        seed = globals.seed === undefined ? loaded.seed : parseUint(globals.seed, '--seed', 0xffffffff);
        config = { ...loaded, seed };
        input = { dataRoot: globals.dataRoot, venue: venues[0]!, symbol: globals.symbol, from, to };
      }
      const B = globals.bootstrap === undefined ? undefined : parseUint(globals.bootstrap, '--bootstrap', 1_000_000, 1);
      const workers = globals.workers === undefined ? defaultWorkerCount() : parseUint(globals.workers, '--workers', 1024);
      const minTradesTrain = parseUint(globals.minTradesTrain, '--min-trades-train', 1_000_000, 1);
      const folds = globals.folds === undefined ? undefined : parseFoldDays(globals.folds);
      const variants = parseVariants(globals.variants, config);
      const span = spanLabels(input);
      const runId = runIdOf(input.venue, input.symbol, span, computeConfigHash(config), seed);
      const runDir = runDirOf(globals.runsRoot, runId);
      const manifestOf = (warnings: readonly string[], plan: Pick<ReplayPlan, 'dataChecksums' | 'feesVerifiedAt'>): RunManifest => buildManifest({
        venue: input.venue, symbol: input.symbol, span, seed, config, dataChecksums: plan.dataChecksums, feesVerifiedAt: plan.feesVerifiedAt,
        warnings, createdAt: deps.now().toISOString(), gitCommit: deps.gitCommit(), wsrVersion: deps.version,
      });
      const storedReaction = await storedReactionFor(deps.grid, globals.runsRoot, runDir, input, config, B ?? 2000);
      if (storedReaction === null && globals.runReaction !== true && globals.forcePnl !== true) {
        refuseWithoutReaction(input, globals.runsRoot, B ?? 2000, globals.json === true);
        setExit(ExitCode.reactionFailed);
        return;
      }
      // The grid stops itself between tasks (resumable, Spec §10) — the replay
      // soft stop stays off here so a task in flight still lands in cells/.
      const session = openSession('grid', globals, globals.runsRoot, runId, { venue: input.venue, symbol: input.symbol, span, seed });
      let result: GridResult;
      try {
        result = await deps.grid.runGrid(input, config, seed, {
          runDir, forcePnl: globals.forcePnl === true, storedReaction, variants, workers, minTradesTrain, shouldStop: deps.shouldStop,
          ...(B === undefined ? {} : { B, realityCheckB: B }), ...(folds === undefined ? {} : { folds }),
          onStart: async (g) => {
            await deps.grid.writeRunOutputs(globals.runsRoot, manifestOf(g.warnings, g.reaction.plan), g.reaction.result);
          },
          onProgress: (p) => {
            session.log.info({ ...p }, 'task done');
            if (globals.json === true) deps.stdout(JSON.stringify({ type: 'progress', ...p }));
            else deps.stderr(`grid ${p.phase} ${p.done}/${p.pending} ${p.taskId}`);
          },
        });
        const manifest = manifestOf(result.warnings, result.reaction.plan);
        const files = result.status === 'interrupted' ? {} : (await deps.grid.writeGridOutputs(globals.runsRoot, manifest, result)).files;
        session.log.info({ runId, status: result.status, gate: result.gate, tasks: result.tasks, warnings: result.warnings }, 'grid done');
        if (globals.json === true) {
          deps.stdout(JSON.stringify({
            type: 'grid', runId, status: result.status, gate: result.gate, nConfigs: result.nConfigs, tasks: result.tasks, files, warnings: result.warnings,
            ...(result.status === 'complete' ? { walkForward: reportValue(result.report.walkForward), dsr: reportValue(result.report.dsr), realityCheck: reportValue(result.report.realityCheck) } : {}),
          }));
        } else {
          formatGrid(manifest, result, files).forEach((line) => deps.stdout(line));
        }
      } finally {
        await session.close();
      }
      setExit(result.status === 'refused' ? ExitCode.reactionFailed : result.status === 'interrupted' ? ExitCode.interrupted : ExitCode.success);
    });

  program
    .command('report')
    .description('assemble report.md (Spec §7.2, sections 0–12) from the artefacts of runs/{runId}/; with several ids also the persisted comparison')
    .option('--run-id <ids>', 'comma-separated run ids under --runs-root')
    .option('--compare <ids>', 'comma-separated run ids (≥ 2): runs/compare-{hash}/comparison.{json,md}, then every run\'s report.md (Q9)')
    .option('--runs-root <dir>', 'output root', './runs')
    .exitOverride()
    .action(async (_options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOptions & { runId?: string; compare?: string; runsRoot: string }>();
      if (globals.runId !== undefined && globals.compare !== undefined) throw new UsageError('--run-id and --compare are exclusive');
      const flag = globals.compare !== undefined ? '--compare' : '--run-id';
      const ids = list(globals.compare ?? globals.runId) ?? [];
      if (ids.length === 0) throw new UsageError(`${flag}: at least one run id`);
      if (globals.compare !== undefined && ids.length < 2) throw new UsageError('--compare: at least two run ids');
      const opts = { dataRoot: globals.dataRoot };
      let runs: ReportInputs[] = [];
      for (const id of ids) {
        const runDir = runDirOf(globals.runsRoot, id);
        const inputs = await deps.report.loadReportInputs(runDir, opts).catch((error: unknown) => {
          throw error instanceof ReplayInputError ? new UsageError(`${flag} ${id}: ${error.message}`) : error;
        });
        runs.push(inputs);
      }
      if (ids.length > 1) {
        // Several runs: the comparison is persisted first so each report's Q9 reads it (A-135).
        runs = await compareRuns(globals.runsRoot, ids.map((id) => runDirOf(globals.runsRoot, id)), opts, globals.json === true);
      }
      let code: ExitCodeValue = ExitCode.success;
      for (const [i, inputs] of runs.entries()) {
        const m = inputs.manifest;
        const session = openSession('report', globals, globals.runsRoot, ids[i]!, { venue: m.venue, symbol: m.symbol, span: m.span, seed: m.seed });
        const markdown = renderReport(inputs);
        const path = await deps.report.writeReport(runDirOf(globals.runsRoot, ids[i]!), markdown);
        const gate = reportGate(inputs);
        session.log.info({ runId: ids[i], gate, path }, 'report done');
        await session.close();
        if (globals.json === true) deps.stdout(JSON.stringify({ type: 'report', runId: ids[i], gate, path, sections: reportSections(markdown) }));
        else deps.stdout(`report.md: ${path}${gate === 'fail' ? '  (reaction test failed — P&L backtest not run)' : ''}`);
        if (gate === 'fail') code = ExitCode.reactionFailed;
      }
      setExit(code);
    });

  program
    .command('bench')
    .description('core-loop throughput, allocation rate, p99 per-print latency (Spec §10); exit 2 when throughput < 80 % of --baseline')
    .option('--synthetic', 'core loop on the synthetic path (default without --venue)')
    .option('--events <n>', 'timed events of the synthetic core loop', '5000000')
    .option('--seed <n>', 'uint32 seed of the synthetic path', '1')
    .option('--baseline <file>', 'baseline JSON to compare throughput against')
    .option('--update-baseline', 'write the result as the baseline (to --baseline, default benchmarks/baseline.json)')
    .option('--venue <id>', 'end-to-end: replay stored partitions of this venue (with --symbol, --from, --to, --config)')
    .option('--symbol <symbol>', 'end-to-end: canonical symbol')
    .option('--from <YYYY-MM-DD>', 'end-to-end: first span day')
    .option('--to <YYYY-MM-DD>', 'end-to-end: last span day')
    .exitOverride()
    .action(async (_options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOptions & SelectorOptions & {
        synthetic?: boolean; events: string; seed: string; baseline?: string; updateBaseline?: boolean;
      }>();
      const endToEnd = globals.venue !== undefined;
      if (endToEnd && globals.synthetic === true) throw new UsageError('wsr bench: --synthetic and --venue are exclusive');
      if (endToEnd) {
        const loaded = await loadConfig(globals.config);
        if (loaded === undefined) throw new UsageError('wsr bench --venue requires --config');
        if (globals.symbol === undefined || globals.from === undefined || globals.to === undefined) {
          throw new UsageError('wsr bench --venue requires --symbol, --from and --to');
        }
        const [venue, ...more] = checkVenues(list(globals.venue) ?? []);
        if (venue === undefined || more.length > 0) throw new UsageError('wsr bench --venue: exactly one venue');
        checkSymbol(globals.symbol);
        const { from, to } = resolveSpan(globals, defaultSpan(deps.now()));
        const r = await deps.bench.benchEndToEnd({ dataRoot: globals.dataRoot, venue, symbol: globals.symbol, from, to }, loaded);
        deps.stdout(globals.json === true ? JSON.stringify({ type: 'bench', ...reportValue(r) as object }) : formatBenchEndToEnd(r));
        setExit(ExitCode.success);
        return;
      }
      const events = parseUint(globals.events, '--events', 1_000_000_000, 1);
      const seed = parseUint(globals.seed, '--seed', 0xffffffff);
      const baselinePath = globals.baseline ?? (globals.updateBaseline === true ? 'benchmarks/baseline.json' : undefined);
      const baseline = globals.baseline === undefined || globals.updateBaseline === true ? null : await deps.bench.readBaseline(globals.baseline);
      const r = deps.bench.benchCoreLoop({ events, seed });
      const cmp = baseline === null ? null : compareBaseline(r, baseline);
      if (globals.json === true) {
        deps.stdout(JSON.stringify({ type: 'bench', ...reportValue(r) as object, ...(cmp === null ? {} : { baseline: reportValue(baseline), ratio: reportValue(cmp.ratio), ok: cmp.ok }) }));
      } else {
        formatBench(r, baseline === null ? null : { path: globals.baseline!, value: baseline }).forEach((line) => deps.stdout(line));
      }
      if (globals.updateBaseline === true) {
        await deps.bench.writeBaseline(baselinePath!, baselineOf(r, deps.now().toISOString()));
        if (globals.json !== true) deps.stdout(`baseline written: ${baselinePath}`);
      }
      setExit(cmp !== null && !cmp.ok ? ExitCode.partialFailure : ExitCode.success);
    });

  return program;
}

// Parses argv (without node + script), runs the command, returns the exit code.
export async function runCli(argv: readonly string[], partialDeps: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = {
    commands: defaultCommands,
    reaction: defaultReaction,
    backtest: defaultBacktest,
    grid: defaultGrid,
    report: defaultReport,
    bench: defaultBench,
    gitCommit: gitHead,
    version: PACKAGE_VERSION,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    now: () => new Date(),
    shouldStop: () => false,
    ...partialDeps,
  };
  let exitCode: ExitCodeValue = ExitCode.success;
  const program = buildProgram(deps, (code) => {
    exitCode = code;
  });
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? ExitCode.success : ExitCode.usage;
    }
    // First SIGINT during a replay (Spec §2.7.2 exit 130): nothing is written for the run in flight.
    if (error instanceof RunInterrupted) {
      deps.stderr(`interrupted: ${error.message}`);
      return ExitCode.interrupted;
    }
    if (error instanceof DataIntegrityError) {
      deps.stderr(`data integrity failure: ${error.message}`);
      return ExitCode.integrityFailure;
    }
    if (error instanceof InvariantViolation) {
      deps.stderr(`invariant violated (bug): ${error.message}`);
      return ExitCode.invariantViolated;
    }
    if (error instanceof UsageError || error instanceof ReplayInputError) {
      deps.stderr(`error: ${error.message}`);
      return ExitCode.usage;
    }
    deps.stderr(`error: ${(error as Error).stack ?? String(error)}`);
    return ExitCode.partialFailure;
  }
}
