import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NO_REACTION_BANNER, reactionKeyFor, type BacktestOptions, type BacktestResult, type BenchBaseline, type BenchResult, buildManifest, defaultWorkerCount, FORCED_BANNER, type GridFile, type GridOptions,
  type GridResult, reactionStats, REFUSED_BANNER, ReplayInputError, type ReportInputs, reportSections, rngStream, type ReactionTestResult,
  type ReplayInput, type RunManifest, type StoredReaction, type SyntheticDriftlessResult, writeRunOutputs, compareIdOf,
} from '@wsr/backtest';
import { InvariantViolation, parseRunConfig, type RunConfig } from '@wsr/core';
import { DataIntegrityError, VENUE_ORDER, type FetchPartitionsOptions, type PartitionResult, type PipelineLogger } from '@wsr/data';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExitCode, exitCodeFor } from './exit-codes.js';
import {
  type BacktestCommands, type BenchCommands, defaultRange, defaultSpan, type GridCommands, runCli, type DataCommands, type ReactionCommands,
  type ReportCommands,
} from './program.js';

const silent: PipelineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const V0 = VENUE_ORDER[0]!;

function partition(status: PartitionResult['status'], day = '2025-01-09'): PartitionResult {
  return { venue: V0, symbol: 'ETHUSDT', day, status };
}

interface Harness {
  readonly out: string[];
  readonly err: string[];
  readonly calls: Record<string, unknown[]>;
  run(argv: string[]): Promise<number>;
}

function harness(overrides: Partial<DataCommands> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, arg: unknown) => {
    (calls[name] ??= []).push(arg);
  };
  const commands: DataCommands = {
    fetchPartitions: async (options) => {
      record('fetch', options);
      options.onPartition?.(partition('done'));
      return { partitions: [partition('done')], interrupted: false };
    },
    mergeStored: async (options) => {
      record('merge', options);
      return [partition('done')];
    },
    rebuildHygiene: async (options) => {
      record('hygiene', options);
      return [];
    },
    loadHygiene: async (options) => {
      record('loadHygiene', options);
      return [];
    },
    verifyPartitions: async (options) => {
      record('verify', options);
      return [partition('done')];
    },
    fetchMeta: async (options) => {
      record('meta', options);
      return [];
    },
    ...overrides,
  };
  return {
    out,
    err,
    calls,
    run: (argv) =>
      runCli(argv, {
        commands,
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
        now: () => new Date(Date.UTC(2026, 8, 19, 12)),
        logger: () => silent,
      }),
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wsr-cli-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('wsr data fetch', () => {
  it('parses selectors and passes them to the pipeline', async () => {
    const h = harness();
    const code = await h.run(['--data-root', dir, 'data', 'fetch', '--venue', VENUE_ORDER.slice(0, 2).join(','), '--symbol', 'ETHUSDT,BTCUSDT', '--from', '2025-01-01', '--to', '2025-01-31', '--concurrency', '3']);
    expect(code).toBe(ExitCode.success);
    const options = h.calls.fetch![0] as FetchPartitionsOptions;
    expect(options).toMatchObject({
      venues: VENUE_ORDER.slice(0, 2),
      symbols: ['ETHUSDT', 'BTCUSDT'],
      from: { y: 2025, m: 1, d: 1 },
      to: { y: 2025, m: 1, d: 31 },
      dataRoot: dir,
      concurrency: 3,
      dryRun: false,
    });
    expect(h.out[0]).toMatch(/^done\s+\S+\s+ETHUSDT\s+2025-01-09/);
  });

  it('defaults: all six venues, run date − 12 months − 8 − 7 … yesterday, symbols from config', async () => {
    const config = join(dir, 'config.json');
    const fees = Object.fromEntries(VENUE_ORDER.map((v) => [v, { TakerFee: 0.0005, MakerFee: 0.0002, verifiedAt: '2026-09-19' }]));
    await writeFile(config, JSON.stringify({ fees, data: { lowCapSymbol: 'SOLUSDT' } }));
    const h = harness();
    expect(await h.run(['--config', config, 'data', 'fetch'])).toBe(ExitCode.success);
    const options = h.calls.fetch![0] as FetchPartitionsOptions;
    expect(options.venues).toEqual([...VENUE_ORDER]);
    expect(options.symbols).toEqual(['ETHUSDT', 'BTCUSDT', 'SOLUSDT']);
    expect(options.from).toEqual({ y: 2025, m: 9, d: 4 });
    expect(options.to).toEqual({ y: 2026, m: 9, d: 18 });
    expect(options.concurrency).toBe(2);
  });

  it('--json emits NDJSON partition lines and coverage rows', async () => {
    const h = harness({
      loadHygiene: async () => [{ venue: V0, symbol: 'ETHUSDT', day: { y: 2025, m: 1, d: 9 }, report: undefined }],
    });
    await h.run(['--json', 'data', 'fetch', '--symbol', 'ETHUSDT', '--from', '2025-01-09', '--to', '2025-01-09']);
    expect(h.out.map((line) => JSON.parse(line).type)).toEqual(['partition', 'coverage']);
  });

  it.each([
    [['data', 'fetch'], '--symbol is required'],
    [['data', 'fetch', '--symbol', 'ETHUSDT', '--venue', 'nowhere'], 'unknown venue'],
    [['data', 'fetch', '--symbol', 'eth-usdt'], 'not canonical'],
    [['data', 'fetch', '--symbol', 'ETHUSDT', '--from', '2025-02-30'], '--from'],
    [['data', 'fetch', '--symbol', 'ETHUSDT', '--from', '2025-02-02', '--to', '2025-02-01'], 'is after'],
    [['data', 'fetch', '--symbol', 'ETHUSDT', '--concurrency', '0'], '--concurrency'],
    [['data', 'fetch', '--symbol', 'ETHUSDT', '--config', '/nonexistent.json'], 'cannot read config'],
    [['data', 'bogus'], ''],
  ])('usage error %j → exit 1', async (argv, message) => {
    const h = harness();
    expect(await h.run(argv)).toBe(ExitCode.usage);
    expect(h.err.join('\n')).toContain(message);
    expect(h.calls.fetch).toBeUndefined();
  });

  it.each([
    [[partition('done'), partition('failed', '2025-01-10')], false, ExitCode.partialFailure],
    [[partition('done'), partition('checksumFailed', '2025-01-10')], false, ExitCode.integrityFailure],
    [[partition('done')], true, ExitCode.interrupted],
    [[partition('skipped'), partition('unavailable')], false, ExitCode.success],
  ] as const)('exit code from partition statuses %#', async (partitions, interrupted, expected) => {
    const h = harness({ fetchPartitions: async () => ({ partitions, interrupted }) });
    expect(await h.run(['data', 'fetch', '--symbol', 'ETHUSDT'])).toBe(expected);
  });
});

describe('other data commands', () => {
  it('verify → exit 4 on a mismatch', async () => {
    const h = harness({ verifyPartitions: async () => [partition('done'), { ...partition('integrityFailed'), error: 'raw sha256 mismatch' }] });
    expect(await h.run(['data', 'verify', '--symbol', 'ETHUSDT'])).toBe(ExitCode.integrityFailure);
    expect(h.out.at(-1)).toBe('verified 2 partition(s), 1 mismatch(es)');
  });

  it('merge passes --force', async () => {
    const h = harness();
    expect(await h.run(['data', 'merge', '--symbol', 'ETHUSDT', '--force'])).toBe(ExitCode.success);
    expect(h.calls.merge![0]).toMatchObject({ force: true });
  });

  it('hygiene --summary only reads stored reports', async () => {
    const h = harness();
    expect(await h.run(['data', 'hygiene', '--symbol', 'ETHUSDT', '--summary'])).toBe(ExitCode.success);
    expect(h.calls.hygiene).toBeUndefined();
    expect(h.calls.loadHygiene).toHaveLength(1);
    expect(h.out[0]).toMatch(/^venue\s+symbol\s+requested\s+present\s+suspect\s+blacklisted_min$/);
  });

  it('meta requests funding over the selected span', async () => {
    const h = harness();
    await h.run(['data', 'meta', '--venue', V0, '--symbol', 'ETHUSDT', '--from', '2025-01-01', '--to', '2025-01-31']);
    expect(h.calls.meta![0]).toMatchObject({ venues: [V0], fundingFrom: Date.UTC(2025, 0, 1), fundingTo: Date.UTC(2025, 1, 1) - 1 });
  });

  it('meta prints the [VERIFY] placeholders left in instrument_history.json', async () => {
    const note = '[VERIFY] record validFrom=0 (1970-01-01T00:00:00.000Z): fundingIntervalHours=8 is a default';
    const h = harness({ fetchMeta: async () => [{ venue: V0, symbol: 'ETHUSDT', status: 'done', fundingRecords: 3, instrumentHistoryPath: '/x.json', verify: [note] }] });
    await h.run(['data', 'meta', '--venue', V0, '--symbol', 'ETHUSDT', '--from', '2025-01-01', '--to', '2025-01-31']);
    expect(h.out).toEqual([expect.stringMatching(/^done\s/), `  ${note}`]);
  });
});

describe('helpers', () => {
  it('defaultRange', () => {
    expect(defaultRange(new Date(Date.UTC(2026, 2, 1, 5)))).toEqual({ from: { y: 2025, m: 2, d: 14 }, to: { y: 2026, m: 2, d: 28 } });
  });

  it('exitCodeFor precedence: integrity > interrupted > partial', () => {
    expect(exitCodeFor([partition('failed'), partition('integrityFailed')], true)).toBe(ExitCode.integrityFailure);
    expect(exitCodeFor([partition('failed')], true)).toBe(ExitCode.interrupted);
    expect(exitCodeFor([])).toBe(ExitCode.success);
  });
});

// ---------------------------------------------------------------- wsr reaction

function fakeResult(venue: ReplayInput['venue'], pass: boolean): ReactionTestResult {
  const stats = reactionStats([], { B: 1, rng: rngStream(1, 'bootstrap', 0) });
  return {
    ...stats, venue, symbol: 'ETHUSDT', span: { from: 0, to: 1 }, seed: 1, randomClipped: 0, blacklistedBuckets: 0, totalBuckets: 0,
    conclusion12: null, configHash: 'h', gateConfigHash: 'g', reactionKey: 'k', gate: pass ? { pass: true, reasons: [] } : { pass: false, reasons: ['(1)−(4): 95 % block-bootstrap CI contains 0'] },
  };
}

interface ReactionCall { input: ReplayInput; cfg: RunConfig; seed: number; B: number | undefined }

function reactionHarness(behaviour: (input: ReplayInput) => boolean | Error = () => true) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: ReactionCall[] = [];
  const written: { runsRoot: string; manifest: RunManifest; reaction: object }[] = [];
  const reaction: ReactionCommands = {
    runReactionTest: async (input, cfg, seed, opts) => {
      calls.push({ input, cfg, seed, B: opts.B });
      const outcome = behaviour(input);
      if (outcome instanceof Error) throw outcome;
      return { result: fakeResult(input.venue, outcome), warnings: ['[VERIFY] fees unverified'], plan: { dataChecksums: [], feesVerifiedAt: null } };
    },
    writeRunOutputs: async (runsRoot, manifest, result) => {
      written.push({ runsRoot, manifest, reaction: result });
      const runDir = join(runsRoot, manifest.runId);
      return { runDir, runJson: join(runDir, 'run.json'), reactionJson: join(runDir, 'reaction.json') };
    },
  };
  const run = (argv: string[]) => runCli(argv, {
    reaction, stdout: (line) => out.push(line), stderr: (line) => err.push(line), now: () => new Date(Date.UTC(2026, 8, 19, 12)),
    gitCommit: () => 'deadbeef', version: '9.9.9', logger: () => silent,
  });
  return { out, err, calls, written, run };
}

describe('wsr reaction', () => {
  let config: string;
  beforeEach(async () => {
    config = join(dir, 'config.json');
    const fees = Object.fromEntries(VENUE_ORDER.map((v) => [v, { TakerFee: 0.0005, MakerFee: 0.0002, verifiedAt: '2026-09-19' }]));
    await writeFile(config, JSON.stringify({ fees, data: { lowCapSymbol: 'SOLUSDT' }, seed: 5 }));
  });
  const args = (...extra: string[]) => ['--data-root', dir, '--config', config, 'reaction', '--venue', V0, '--symbol', 'ETHUSDT', ...extra];

  it('passes the span, seed and B; writes run outputs; gate pass ⇒ exit 0', async () => {
    const h = reactionHarness();
    const code = await h.run(args('--from', '2025-01-09', '--to', '2025-01-12', '--seed', '1', '--runs-root', join(dir, 'runs'), '--bootstrap', '300'));
    expect(code).toBe(ExitCode.success);
    expect(h.calls).toHaveLength(1);
    const c = h.calls[0]!;
    expect(c.input).toEqual({ dataRoot: dir, venue: V0, symbol: 'ETHUSDT', from: { y: 2025, m: 1, d: 9 }, to: { y: 2025, m: 1, d: 12 } });
    expect([c.seed, c.cfg.seed, c.B]).toEqual([1, 1, 300]);
    const m = h.written[0]!.manifest;
    expect(h.written[0]!.runsRoot).toBe(join(dir, 'runs'));
    expect([m.createdAt, m.gitCommit, m.wsrVersion, m.seed, m.span]).toEqual(['2026-09-19T12:00:00.000Z', 'deadbeef', '9.9.9', 1, { from: '2025-01-09', to: '2025-01-12' }]);
    expect(m.warnings).toEqual(['[VERIFY] fees unverified']);
    expect(h.out).toContain('GATE PASS');
    expect(h.out.at(-1)).toBe(`reaction.json: ${join(dir, 'runs', m.runId, 'reaction.json')}`);
  });

  it('gate fail ⇒ exit 3, reasons printed, reaction.json still written', async () => {
    const h = reactionHarness(() => false);
    expect(await h.run(args())).toBe(ExitCode.reactionFailed);
    expect(h.written).toHaveLength(1);
    expect(h.out).toContain('GATE FAIL');
    expect(h.out).toContain('  - (1)−(4): 95 % block-bootstrap CI contains 0');
  });

  it('defaults: seed from config, B = 2000, span run date − 12 months … yesterday, ./runs', async () => {
    const h = reactionHarness();
    await h.run(args());
    const c = h.calls[0]!;
    expect([c.seed, c.B, c.input.from, c.input.to]).toEqual([5, 2000, { y: 2025, m: 9, d: 19 }, { y: 2026, m: 9, d: 18 }]);
    expect(h.written[0]!.runsRoot).toBe('./runs');
    expect(defaultSpan(new Date(Date.UTC(2026, 2, 1)))).toEqual({ from: { y: 2025, m: 3, d: 1 }, to: { y: 2026, m: 2, d: 28 } });
  });

  it('a venue list runs each venue independently; any failed gate ⇒ exit 3', async () => {
    const h = reactionHarness((input) => input.venue === V0);
    const code = await h.run(['--config', config, 'reaction', '--venue', VENUE_ORDER.slice(0, 2).join(','), '--symbol', 'ETHUSDT']);
    expect(code).toBe(ExitCode.reactionFailed);
    expect(h.calls.map((c) => c.input.venue)).toEqual(VENUE_ORDER.slice(0, 2));
    expect(h.written.map((w) => w.manifest.venue)).toEqual(VENUE_ORDER.slice(0, 2));
    expect(new Set(h.written.map((w) => w.manifest.runId)).size).toBe(2);
  });

  it('--json emits one NDJSON reaction line per venue with finite numbers', async () => {
    const h = reactionHarness();
    await h.run(['--json', ...args()]);
    const line = JSON.parse(h.out[0]!);
    expect(line).toMatchObject({ type: 'reaction', result: { gate: { pass: true }, monotone: { slope: null, slopeDefined: false } } });
    expect(h.out).toHaveLength(1);
  });

  it.each([
    [['reaction', '--venue', V0, '--symbol', 'ETHUSDT'], 'requires --config'],
    [['--config', 'CFG', 'reaction', '--symbol', 'ETHUSDT'], '--venue'],
    [['--config', 'CFG', 'reaction', '--venue', V0], '--symbol'],
    [['--config', 'CFG', 'reaction', '--venue', 'nowhere', '--symbol', 'ETHUSDT'], 'unknown venue'],
    [['--config', 'CFG', 'reaction', '--venue', V0, '--symbol', 'ethusdt'], 'not canonical'],
    [['--config', 'CFG', 'reaction', '--venue', V0, '--symbol', 'ETHUSDT', '--seed', '-1'], '--seed'],
    [['--config', 'CFG', 'reaction', '--venue', V0, '--symbol', 'ETHUSDT', '--bootstrap', '0'], '--bootstrap'],
    [['--config', 'CFG', 'reaction', '--venue', V0, '--symbol', 'ETHUSDT', '--from', '2025-02-02', '--to', '2025-02-01'], 'is after'],
  ])('usage error %j → exit 1', async (argv, message) => {
    const h = reactionHarness();
    expect(await h.run(argv.map((a) => (a === 'CFG' ? config : a)))).toBe(ExitCode.usage);
    expect(h.err.join('\n')).toContain(message);
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    [new DataIntegrityError('sha256 mismatch'), ExitCode.integrityFailure, 'data integrity failure'],
    [new InvariantViolation('random level drawn after its approach (L12)'), ExitCode.invariantViolated, 'invariant violated'],
    [new ReplayInputError('blacklistMacroReleases is on but meta/macro_releases.json is missing'), ExitCode.usage, 'macro_releases'],
  ])('%s → exit %i', async (error, code, message) => {
    const h = reactionHarness(() => error);
    expect(await h.run(args())).toBe(code);
    expect(h.err.join('\n')).toContain(message);
    expect(h.written).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- wsr backtest

function backtestHarness(
  pass: boolean, stored: StoredReaction | null = null, gridRun: { manifest: RunManifest; grid: GridFile } | null = null, found: StoredReaction | null = null,
) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { input: ReplayInput; seed: number; opts: BacktestOptions }[] = [];
  const lookups: string[] = [];
  const written: { manifest: RunManifest; result: BacktestResult }[] = [];
  const reports: string[] = [];
  const backtest: BacktestCommands = {
    runBacktest: async (input, _cfg, seed, opts) => {
      calls.push({ input, seed, opts });
      const gate = pass ? 'pass' : opts.forcePnl === true ? 'forced' : 'fail';
      return {
        reaction: { result: fakeResult(input.venue, pass), plan: { dataChecksums: [], feesVerifiedAt: null } }, gate,
        gateReasons: pass ? [] : ['(1)−(4): 95 % block-bootstrap CI contains 0'], foldDays: { train: 56, test: 14, step: 14 }, folds: [],
        fits: [], schedule: [], engine: null, paths: [], records: [], targetGrid: null, foldMetrics: [], variants: [], stageB: [], transitions: [],
        nConfigs: { cells: 1, variants: 1, latencyPoints: opts.latencySweep === true ? 4 : 1, N: opts.latencySweep === true ? 4 : 1 },
        warnings: gate === 'forced' ? [FORCED_BANNER] : [],
      } as unknown as BacktestResult;
    },
    writeBacktestOutputs: async (runsRoot, manifest, result) => {
      written.push({ manifest, result });
      const runDir = join(runsRoot, manifest.runId);
      return { runDir, files: { 'run.json': join(runDir, 'run.json'), 'report.md': join(runDir, 'report.md') } };
    },
    readStoredReaction: async (runDir) => {
      lookups.push(runDir);
      return stored;
    },
    readGridRun: async () => gridRun,
    findStoredReaction: async () => found,
  };
  const report: ReportCommands = {
    loadReportInputs: async (runDir) => {
      const w = written.find((x) => join(dir, 'runs', x.manifest.runId) === runDir)!;
      return {
        manifest: w.manifest, reaction: w.result.reaction.result, folds: null, targetGrid: null, stageB: null, trades: null, transitions: null,
        levels: null, grid: null, sensitivity: null, hygiene: null,
      } satisfies ReportInputs;
    },
    writeReport: async (runDir) => {
      reports.push(runDir);
      return join(runDir, 'report.md');
    },
  };
  const run = (argv: string[]) => runCli(argv, {
    backtest, report, stdout: (line) => out.push(line), stderr: (line) => err.push(line), now: () => new Date(Date.UTC(2026, 8, 19, 12)),
    gitCommit: () => 'deadbeef', version: '9.9.9', logger: () => silent,
  });
  return { out, err, calls, lookups, written, reports, run };
}

describe('wsr backtest', () => {
  let config: string;
  beforeEach(async () => {
    config = join(dir, 'config.json');
    const fees = Object.fromEntries(VENUE_ORDER.map((v) => [v, { TakerFee: 0.0005, MakerFee: 0.0002, verifiedAt: '2026-09-19' }]));
    await writeFile(config, JSON.stringify({ fees, data: { lowCapSymbol: 'SOLUSDT' }, seed: 5 }));
  });
  const plainArgs = (...extra: string[]) => ['--data-root', dir, '--config', config, 'backtest', '--venue', V0, '--symbol', 'ETHUSDT',
    '--from', '2025-01-09', '--to', '2025-01-12', '--runs-root', join(dir, 'runs'), ...extra];
  const args = (...extra: string[]) => plainArgs('--run-reaction', ...extra);
  const keyOf = (B = 2000) => ({
    reactionKey: reactionKeyFor({ venue: V0, symbol: 'ETHUSDT', from: { y: 2025, m: 1, d: 9 }, to: { y: 2025, m: 1, d: 12 } },
      parseRunConfig({ fees: Object.fromEntries(VENUE_ORDER.map((v) => [v, { TakerFee: 0.0005, MakerFee: 0.0002, verifiedAt: '2026-09-19' }])), data: { lowCapSymbol: 'SOLUSDT' }, seed: 5 })),
    B,
  });

  it('gate fail ⇒ exit 3, the refusal banner first, outputs still written; the stored reaction.json of the runId is looked up', async () => {
    const stored = { ...keyOf(), gate: { pass: false, reasons: [] } } as unknown as StoredReaction;
    const h = backtestHarness(false, stored);
    expect(await h.run(plainArgs())).toBe(ExitCode.reactionFailed);
    expect(h.out[0]).toBe(REFUSED_BANNER);
    expect(h.out[1]).toBe('  - (1)−(4): 95 % block-bootstrap CI contains 0');
    expect(h.written).toHaveLength(1);
    expect(h.lookups).toEqual([join(dir, 'runs', h.written[0]!.manifest.runId)]);
    expect(h.calls[0]!.opts).toEqual({ B: 2000, forcePnl: false, storedReaction: stored });
  });

  it('Spec §6.1.6 (A-136): no matching reaction.json (other key or B) ⇒ exit 3 before any replay, nothing written; --run-reaction runs it', async () => {
    for (const stored of [null, { ...keyOf(100), gate: { pass: true, reasons: [] } }, { reactionKey: 'other', B: 2000, gate: { pass: true, reasons: [] } }]) {
      const h = backtestHarness(true, stored as StoredReaction | null);
      expect(await h.run(plainArgs())).toBe(ExitCode.reactionFailed);
      expect(h.out[0]).toBe(NO_REACTION_BANNER);
      expect(h.out[1]).toMatch(/^ {2}- no reaction\.json of .* ETHUSDT 2025-01-09…2025-01-12 with this gate config and B = 2000 under .* — run `wsr reaction` first, or pass --run-reaction$/);
      expect(h.calls).toHaveLength(0);
      expect(h.written).toHaveLength(0);
    }
    const found = { ...keyOf(), gate: { pass: true, reasons: [] } } as unknown as StoredReaction;
    const elsewhere = backtestHarness(true, null, null, found);
    expect(await elsewhere.run(plainArgs())).toBe(ExitCode.success);
    expect(elsewhere.calls[0]!.opts.storedReaction).toBe(found);
    const h = backtestHarness(true);
    expect(await h.run(plainArgs('--run-reaction'))).toBe(ExitCode.success);
    expect(h.calls[0]!.opts.storedReaction).toBeNull();
  });

  it('--force-pnl ⇒ exit 0 with the forced banner; hidden --folds and --bootstrap reach runBacktest', async () => {
    const h = backtestHarness(false);
    expect(await h.run(args('--force-pnl', '--folds', '4,2,2', '--bootstrap', '100', '--seed', '3'))).toBe(ExitCode.success);
    expect(h.out[0]).toBe(FORCED_BANNER);
    expect(h.calls[0]!.opts).toEqual({ B: 100, forcePnl: true, storedReaction: null, folds: { train: 4, test: 2, step: 2 } });
    expect(h.calls[0]!.seed).toBe(3);
    expect(h.written[0]!.manifest.warnings).toEqual([FORCED_BANNER]);
  });

  it('--latency-sweep / --slippage-sweep / --workers reach runBacktest; N_configs is printed', async () => {
    const h = backtestHarness(true);
    expect(await h.run(args('--latency-sweep', '--slippage-sweep', '--workers', '0'))).toBe(ExitCode.success);
    expect(h.calls[0]!.opts).toEqual({ B: 2000, forcePnl: false, storedReaction: null, latencySweep: true, slippageSweep: true, workers: 0 });
    expect(h.out).toContain('N_configs 1 cell × 1 variant(s) × 4 latency point(s) = 4');
    expect(await backtestHarness(true).run(args('--workers', 'x'))).toBe(ExitCode.usage);
  });

  it('--variants reaches runBacktest as [baseline, …expanded]; an unknown name is a usage error', async () => {
    const h = backtestHarness(true);
    expect(await h.run(args('--variants', 'armMode,targetMode'))).toBe(ExitCode.success);
    expect(h.calls[0]!.opts.variants!.map((v) => v.id)).toEqual(['baseline', 'armMode', 'targetMode.volUnit', 'targetMode.market', 'targetMode.twoStage']);
    const bad = backtestHarness(true);
    expect(await bad.run(args('--variants', 'nope'))).toBe(ExitCode.usage);
    expect(bad.err.join('\n')).toContain("unknown variant 'nope'");
    expect(bad.calls).toHaveLength(0);
  });

  it('gate pass ⇒ exit 0; a venue list runs each venue independently', async () => {
    const h = backtestHarness(true);
    const argv = args();
    argv[argv.indexOf(V0)] = VENUE_ORDER.slice(0, 2).join(',');
    expect(await h.run(argv)).toBe(ExitCode.success);
    expect(h.calls.map((c) => c.input.venue)).toEqual(VENUE_ORDER.slice(0, 2));
    expect(new Set(h.written.map((w) => w.manifest.runId)).size).toBe(2);
    expect(h.out).toContain('## Cross-venue / cross-symbol comparison (Appendix B Q9)');
    for (const v of VENUE_ORDER.slice(0, 2)) expect(h.out.some((l) => l.startsWith(`| ${v} | ETHUSDT |`))).toBe(true);
    // A-135: the comparison is persisted and both reports are re-rendered afterwards.
    const ids = h.written.map((w) => w.manifest.runId);
    const cmpDir = join(dir, 'runs', compareIdOf(ids));
    const cmp = JSON.parse(await readFile(join(cmpDir, 'comparison.json'), 'utf8'));
    expect(cmp.runIds).toEqual([...ids].sort());
    expect(cmp.verdict).toMatch(/^(yes|no|partly|inconclusive)/);
    expect(await readFile(join(cmpDir, 'comparison.md'), 'utf8')).toContain('Q9 verdict: ');
    expect(h.out).toContain(`comparison.json: ${join(cmpDir, 'comparison.json')}`);
    expect(h.reports).toEqual(ids.map((id) => join(dir, 'runs', id)));
  });

  it.each([
    [['--folds', '4,2'], '--folds expects'],
    [['--folds', '4,0,2'], '--folds expects'],
  ])('usage error %j → exit 1', async (extra, message) => {
    const h = backtestHarness(true);
    expect(await h.run(args(...extra))).toBe(ExitCode.usage);
    expect(h.err.join('\n')).toContain(message);
    expect(h.calls).toHaveLength(0);
  });

  it('F < 12 from runBacktest (ReplayInputError) ⇒ exit 1', async () => {
    const h = backtestHarness(true);
    const backtestFail = runCli(args(), {
      backtest: {
        runBacktest: async () => { throw new ReplayInputError('span of 4 day(s) gives 0 folds; Spec §6.3 requires F ≥ 12'); },
        writeBacktestOutputs: async () => { throw new Error('unreachable'); },
        readStoredReaction: async () => null, findStoredReaction: async () => null,
      },
      stdout: (l) => h.out.push(l), stderr: (l) => h.err.push(l), logger: () => silent,
    });
    expect(await backtestFail).toBe(ExitCode.usage);
    expect(h.err.join('\n')).toContain('F ≥ 12');
  });
});

describe('wsr backtest --synthetic driftless (Spec §11.3, §12.2, A-133)', () => {
  const fake = (within3Sigma: boolean, pass: boolean): SyntheticDriftlessResult => ({
    seed: 1, events: 1000, trades: 20_000, hits: 6_700, unresolved: 3, HitRate: 0.335, HitRate_0: 1 / 3, sigma: 0.0033, z: 0.5, within3Sigma,
    reactionEvents: 1_000_000,
    reaction: {
      ...reactionStats([], { B: 1, rng: rngStream(1, 'bootstrap', 0) }),
      gate: pass ? { pass: true, reasons: [] } : { pass: false, reasons: ['(1)−(4): 95 % block-bootstrap CI contains 0'] },
    },
  });
  const run = (r: SyntheticDriftlessResult, argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const calls: unknown[] = [];
    const backtest: BacktestCommands = {
      runBacktest: async () => { throw new Error('unreachable'); }, writeBacktestOutputs: async () => { throw new Error('unreachable'); },
      readStoredReaction: async () => null, syntheticDriftless: (o) => { calls.push(o); return r; },
    };
    return runCli(['backtest', '--synthetic', 'driftless', ...argv], { backtest, stdout: (l) => out.push(l), stderr: (l) => err.push(l), logger: () => silent })
      .then((code) => ({ code, out, err, calls }));
  };

  it('within 3σ and gate FAIL ⇒ exit 3; --trades / --seed / --bootstrap reach the run; no --venue / --config needed', async () => {
    const r = await run(fake(true, false), ['--trades', '500', '--seed', '7', '--bootstrap', '100']);
    expect(r.code).toBe(ExitCode.reactionFailed);
    expect(r.calls).toEqual([{ trades: 500, seed: 7, B: 100 }]);
    expect(r.out[1]).toBe('HitRate(2,1) 0.3350 vs HitRate_0 0.3333 ± 3σ 0.0099 (σ 0.0033, z 0.50): within 3σ — PASS');
    expect(r.out).toContain('GATE FAIL (expected on a driftless walk)');
  });

  it('outside 3σ ⇒ exit 5 (engine bias); gate PASS within 3σ ⇒ exit 0', async () => {
    const biased = await run(fake(false, false), []);
    expect(biased.code).toBe(ExitCode.invariantViolated);
    expect(biased.err.join('\n')).toContain('outside 1/3 ± 3σ');
    expect((await run(fake(true, true), [])).code).toBe(ExitCode.success);
  });

  it('unknown --synthetic path, bad --trades, or no --venue without --synthetic ⇒ usage error', async () => {
    expect((await run(fake(true, false), ['--trades', '0'])).code).toBe(ExitCode.usage);
    const out: string[] = [];
    expect(await runCli(['backtest', '--synthetic', 'trend'], { stdout: (l) => out.push(l), stderr: (l) => out.push(l) })).toBe(ExitCode.usage);
    expect(await runCli(['--config', 'x.json', 'backtest', '--symbol', 'ETHUSDT'], { stdout: (l) => out.push(l), stderr: (l) => out.push(l) }))
      .toBe(ExitCode.usage);
  });

  it('the real run on a short walk: exit 3, HitRate line printed', async () => {
    const out: string[] = [];
    const code = await runCli(['--json', 'backtest', '--synthetic', 'driftless', '--trades', '300', '--bootstrap', '50'],
      { stdout: (l) => out.push(l), stderr: (l) => out.push(l) });
    const r = JSON.parse(out[0]!);
    expect(r.type).toBe('synthetic');
    expect(r.trades).toBeGreaterThanOrEqual(300);
    expect(code).toBe(r.within3Sigma ? (r.reaction.gate.pass ? ExitCode.success : ExitCode.reactionFailed) : ExitCode.invariantViolated);
    expect(code).toBe(ExitCode.reactionFailed);
  }, 60_000);
});

describe('wsr backtest --from-grid (A-134)', () => {
  const fees = Object.fromEntries(VENUE_ORDER.map((v) => [v, { TakerFee: 0.0005, MakerFee: 0.0002, verifiedAt: '2026-09-19' }]));
  const config = parseRunConfig({ fees, data: { lowCapSymbol: 'SOLUSDT' }, seed: 5 });
  const gridManifest = buildManifest({
    venue: V0, symbol: 'ETHUSDT', span: { from: '2025-01-09', to: '2025-01-12' }, seed: 5, config, dataChecksums: [], feesVerifiedAt: null,
    warnings: [], createdAt: 'x', gitCommit: 'x', wsrVersion: 'x',
  });
  const grid = {
    folds: [{ foldId: 0, trainFrom: '2025-01-09', testFrom: '2025-01-11', testTo: '2025-01-11' }],
    walkForward: [{ variant: 'baseline', folds: [{ foldId: 0, chosen: { cellId: 'c0007', params: {} } }] }],
  } as unknown as GridFile;
  const args = (...extra: string[]) => ['--data-root', dir, 'backtest', '--from-grid', gridManifest.runId, '--runs-root', join(dir, 'runs'), '--run-reaction', ...extra];

  it('inputs from the grid run\'s run.json; the fold choice reaches runBacktest; own runId; gate looked up in the grid run', async () => {
    const h = backtestHarness(true, null, { manifest: gridManifest, grid });
    expect(await h.run(args())).toBe(ExitCode.success);
    const call = h.calls[0]!;
    expect(call.input).toMatchObject({ venue: V0, symbol: 'ETHUSDT', from: { y: 2025, m: 1, d: 9 }, to: { y: 2025, m: 1, d: 12 } });
    expect(call.seed).toBe(5);
    expect(call.opts.fromGrid).toEqual({ runId: gridManifest.runId, folds: grid.folds, chosen: [{ cellId: 'c0007', params: {} }] });
    expect(h.lookups).toEqual([join(dir, 'runs', gridManifest.runId)]);
    const m = h.written[0]!.manifest;
    expect(m.fromGrid).toBe(gridManifest.runId);
    expect(m.runId).not.toBe(gridManifest.runId);
    expect(m.configHash).toBe(gridManifest.configHash);
  });

  it('flags that contradict the grid run, or a missing grid run, are usage errors', async () => {
    const h = backtestHarness(true, null, { manifest: gridManifest, grid });
    expect(await h.run(args('--symbol', 'BTCUSDT', '--seed', '6'))).toBe(ExitCode.usage);
    expect(h.err.join('\n')).toContain('--symbol BTCUSDT ≠ ETHUSDT; --seed 6 ≠ 5');
    const none = backtestHarness(true);
    expect(await none.run(args())).toBe(ExitCode.usage);
    expect(none.err.join('\n')).toContain('no run.json + grid.json');
    expect(none.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- wsr grid

function gridHarness(status: GridResult['status'] | Error, manifests: Record<string, RunManifest> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { input: ReplayInput; cfg: RunConfig; seed: number; opts: GridOptions }[] = [];
  const written: { manifest: RunManifest; result: GridResult }[] = [];
  const grid: GridCommands = {
    runGrid: async (input, cfg, seed, opts) => {
      calls.push({ input, cfg, seed, opts });
      if (status instanceof Error) throw status;
      const nan = NaN;
      return {
        status, reaction: { result: fakeResult(input.venue, status !== 'refused'), plan: { dataChecksums: [], feesVerifiedAt: null } },
        gate: status === 'refused' ? 'fail' : 'pass', gateReasons: status === 'refused' ? ['(1)−(4): 95 % block-bootstrap CI contains 0'] : [],
        foldDays: { train: 56, test: 14, step: 14 }, folds: [], nConfigs: { cells: 1296, variants: 3, latencyPoints: 1, N: 3888 },
        warnings: [], tasks: { total: 1653, ran: 1653, skipped: 0 },
        report: {
          nConfigs: { cells: 1296, variants: 3, latencyPoints: 1, N: 3888 }, minTradesTrain: 100, walkForward: [], folds: [],
          dsr: { DSR: nan, SR: nan, SR0: nan, VSR: nan, nTrades: 0, skew: nan, kurt: nan, N: 3888, trials: 0 },
          realityCheck: { V: nan, p: nan, B: 1000, meanBlock: 1, n: 0, cells: 0, firstVolumeDay: -1 },
        },
        sensitivity: { centre: null, rows: [] },
      } as unknown as GridResult;
    },
    writeGridOutputs: async (runsRoot, manifest, result) => {
      written.push({ manifest, result });
      const runDir = join(runsRoot, manifest.runId);
      return { runDir, files: { 'run.json': join(runDir, 'run.json') } };
    },
    writeRunOutputs: async () => { throw new Error('unreachable (onStart is not called by the fake)'); },
    readStoredReaction: async () => null,
    findStoredReaction: async () => null,
    readRunManifest: async (runDir) => manifests[runDir] ?? null,
  };
  const run = (argv: string[]) => runCli(argv, {
    grid, stdout: (line) => out.push(line), stderr: (line) => err.push(line), now: () => new Date(Date.UTC(2026, 8, 19, 12)),
    gitCommit: () => 'deadbeef', version: '9.9.9', logger: () => silent,
  });
  return { out, err, calls, written, run };
}

describe('wsr grid', () => {
  let config: string;
  const fees = Object.fromEntries(VENUE_ORDER.map((v) => [v, { TakerFee: 0.0005, MakerFee: 0.0002, verifiedAt: '2026-09-19' }]));
  beforeEach(async () => {
    config = join(dir, 'config.json');
    await writeFile(config, JSON.stringify({ fees, data: { lowCapSymbol: 'SOLUSDT' }, seed: 5 }));
  });
  const runs = () => join(dir, 'runs');
  const args = (...extra: string[]) => ['--data-root', dir, '--config', config, 'grid', '--venue', V0, '--symbol', 'ETHUSDT',
    '--from', '2025-01-09', '--to', '2025-01-12', '--runs-root', runs(), '--run-reaction', ...extra];

  it('complete ⇒ exit 0 with the cell-count line; flags reach runGrid', async () => {
    const h = gridHarness('complete');
    expect(await h.run(args('--workers', '0', '--variants', 'armMode,timeStop', '--folds', '4,2,2', '--bootstrap', '100', '--min-trades-train', '5', '--force-pnl'))).toBe(ExitCode.success);
    expect(h.out).toContain('cells 1296 × variants 3 × latency 1 = N_configs 3888');
    expect(h.out).toContain('## 11. Parameter search (§9.3)');
    const { opts, seed, input } = h.calls[0]!;
    expect(seed).toBe(5);
    expect(input).toEqual({ dataRoot: dir, venue: V0, symbol: 'ETHUSDT', from: { y: 2025, m: 1, d: 9 }, to: { y: 2025, m: 1, d: 12 } });
    expect(opts.variants!.map((v) => v.id)).toEqual(['baseline', 'armMode', 'timeStop']);
    expect([opts.workers, opts.B, opts.realityCheckB, opts.minTradesTrain, opts.forcePnl]).toEqual([0, 100, 100, 5, true]);
    expect(opts.folds).toEqual({ train: 4, test: 2, step: 2 });
    expect(opts.runDir).toBe(join(runs(), h.written[0]!.manifest.runId));
    expect(h.written).toHaveLength(1);
  });

  it('defaults: availableParallelism − 1 workers, baseline only, MinTradesTrain 100, default bootstraps', async () => {
    const h = gridHarness('complete');
    expect(await h.run(args())).toBe(ExitCode.success);
    const { opts } = h.calls[0]!;
    expect([opts.workers, opts.minTradesTrain, opts.B, opts.realityCheckB, opts.forcePnl]).toEqual([defaultWorkerCount(), 100, undefined, undefined, false]);
    expect(opts.variants!.map((v) => v.id)).toEqual(['baseline']);
  });

  it('refused ⇒ exit 3 with the banner; interrupted ⇒ exit 130 and no grid outputs', async () => {
    const refused = gridHarness('refused');
    expect(await refused.run(args())).toBe(ExitCode.reactionFailed);
    expect(refused.out[0]).toBe(REFUSED_BANNER);
    expect(refused.written).toHaveLength(1);
    const stopped = gridHarness('interrupted');
    expect(await stopped.run(args())).toBe(ExitCode.interrupted);
    expect(stopped.written).toHaveLength(0);
    expect(stopped.out.some((l) => l.startsWith('interrupted: resume with `wsr grid --run-id '))).toBe(true);
  });

  it('Spec §6.1.6 (A-136): without a matching reaction.json nor --run-reaction / --force-pnl ⇒ exit 3, runGrid not called', async () => {
    const h = gridHarness('complete');
    const argv = args().filter((a) => a !== '--run-reaction');
    expect(await h.run(argv)).toBe(ExitCode.reactionFailed);
    expect(h.out[0]).toBe(NO_REACTION_BANNER);
    expect(h.calls).toHaveLength(0);
    expect(await h.run([...argv, '--force-pnl'])).toBe(ExitCode.success);
  });

  it('an invariant violation inside a grid task ⇒ exit 5', async () => {
    const h = gridHarness(new InvariantViolation('Engine: boom'));
    expect(await h.run(args())).toBe(ExitCode.invariantViolated);
    expect(h.err.join('\n')).toContain('Engine: boom');
  });

  it.each([
    [['--variants', 'nope'], "unknown variant 'nope'"],
    [['--workers', '-1'], '--workers must be an integer'],
    [['--workers', 'two'], '--workers must be an integer'],
    [['--min-trades-train', '0'], '--min-trades-train must be an integer'],
    [['--folds', '4,2'], '--folds expects'],
  ])('usage error %j → exit 1', async (extra, message) => {
    const h = gridHarness('complete');
    expect(await h.run(args(...extra))).toBe(ExitCode.usage);
    expect(h.err.join('\n')).toContain(message);
    expect(h.calls).toHaveLength(0);
  });

  it('without --run-id: --venue / --symbol / --config required, one venue only', async () => {
    const h = gridHarness('complete');
    expect(await h.run(['--data-root', dir, '--config', config, 'grid', '--symbol', 'ETHUSDT', '--runs-root', runs()])).toBe(ExitCode.usage);
    expect(await h.run(['--data-root', dir, 'grid', '--venue', V0, '--symbol', 'ETHUSDT', '--runs-root', runs()])).toBe(ExitCode.usage);
    const argv = args();
    argv[argv.indexOf(V0)] = VENUE_ORDER.slice(0, 2).join(',');
    expect(await h.run(argv)).toBe(ExitCode.usage);
    expect(h.err.join('\n')).toContain('one venue at a time');
    expect(h.calls).toHaveLength(0);
  });

  it('--run-id resumes from run.json (venue, symbol, span, seed, config); conflicting flags or no run.json ⇒ exit 1', async () => {
    const cfg = parseRunConfig({ fees, data: { lowCapSymbol: 'SOLUSDT' }, seed: 5, MinSweepMult: 0.3 });
    const manifest = buildManifest({
      venue: V0, symbol: 'ETHUSDT', span: { from: '2025-01-09', to: '2025-01-12' }, seed: 5, config: cfg, dataChecksums: [], feesVerifiedAt: null,
      warnings: [], createdAt: 'x', gitCommit: 'x', wsrVersion: 'x',
    });
    const stored = JSON.parse(JSON.stringify(manifest)) as RunManifest;
    const h = gridHarness('complete', { [join(runs(), manifest.runId)]: stored });
    const base = ['--data-root', dir, 'grid', '--runs-root', runs(), '--run-id', manifest.runId, '--workers', '0', '--run-reaction'];
    expect(await h.run(base)).toBe(ExitCode.success);
    expect(h.calls[0]!.input).toEqual({ dataRoot: dir, venue: V0, symbol: 'ETHUSDT', from: { y: 2025, m: 1, d: 9 }, to: { y: 2025, m: 1, d: 12 } });
    expect(h.calls[0]!.cfg.MinSweepMult).toBe(0.3);
    expect(h.calls[0]!.seed).toBe(5);
    expect(h.written[0]!.manifest.runId).toBe(manifest.runId);
    expect(await h.run([...base, '--symbol', 'ETHUSDT', '--seed', '5'])).toBe(ExitCode.success);          // agreeing flags are fine

    expect(await h.run([...base, '--symbol', 'BTCUSDT'])).toBe(ExitCode.usage);
    expect(h.err.join('\n')).toContain('--symbol BTCUSDT ≠ ETHUSDT');
    expect(await h.run([...base.slice(0, 1), dir, '--config', config, ...base.slice(2)])).toBe(ExitCode.usage);
    expect(h.err.join('\n')).toContain("--config differs from the run's config");
    expect(await h.run(['--data-root', dir, 'grid', '--runs-root', runs(), '--run-id', 'feedfacefeedface'])).toBe(ExitCode.usage);
    expect(h.err.join('\n')).toContain('no run.json');
    expect(h.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- wsr report

describe('wsr report', () => {
  const fees = Object.fromEntries(VENUE_ORDER.map((v) => [v, { TakerFee: 0.0005, MakerFee: 0.0002, verifiedAt: '2026-09-19' }]));
  const runs = () => join(dir, 'runs');

  async function reactionRun(venue: ReplayInput['venue'], pass: boolean): Promise<string> {
    const manifest = buildManifest({
      venue, symbol: 'ETHUSDT', span: { from: '2025-01-09', to: '2025-01-12' }, seed: 5, config: parseRunConfig({ fees, data: { lowCapSymbol: 'SOLUSDT' } }),
      dataChecksums: [], feesVerifiedAt: '2026-09-19', warnings: [], createdAt: 'x', gitCommit: 'x', wsrVersion: 'x',
    });
    await writeRunOutputs(runs(), manifest, fakeResult(venue, pass));
    return manifest.runId;
  }

  const cli = (argv: string[], out: string[], err: string[]) => runCli(['--data-root', dir, 'report', '--runs-root', runs(), ...argv], {
    stdout: (l) => out.push(l), stderr: (l) => err.push(l), logger: () => silent,
  });

  it('writes report.md with sections 0–12 from the run directory; a failed gate ⇒ exit 3 and the refusal banner', async () => {
    const pass = await reactionRun(VENUE_ORDER[0]!, true);
    const fail = await reactionRun(VENUE_ORDER[1]!, false);
    const out: string[] = [];
    const err: string[] = [];
    expect(await cli(['--run-id', pass], out, err)).toBe(ExitCode.success);
    const md = await readFile(join(runs(), pass, 'report.md'), 'utf8');
    expect(reportSections(md)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    expect(md).toContain('missing (run `wsr backtest`)');
    expect(out).toEqual([`report.md: ${join(runs(), pass, 'report.md')}`]);

    const out2: string[] = [];
    expect(await cli(['--run-id', `${pass},${fail}`, '--json'], out2, err)).toBe(ExitCode.reactionFailed);
    const lines = out2.map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['comparison', 'report', 'report']);
    expect(lines[2].gate).toBe('fail');
    expect(lines[1].sections).toHaveLength(13);
    expect(lines[0].lines.filter((l: string) => l.startsWith('| ') && !l.startsWith('| venue'))).toHaveLength(2);
    const refused = await readFile(join(runs(), fail, 'report.md'), 'utf8');
    expect(refused.split('\n')[0]).toBe(REFUSED_BANNER);
    expect(refused).toContain('P&L backtest not run (reaction test failed');
  });

  it('--compare persists runs/compare-{hash}/ and every report\'s Q9 reads it; the id set, not the order, names it (A-135)', async () => {
    const a = await reactionRun(VENUE_ORDER[0]!, true);
    const b = await reactionRun(VENUE_ORDER[2]!, true);
    const out: string[] = [];
    const err: string[] = [];
    expect(await cli(['--compare', `${b},${a}`], out, err)).toBe(ExitCode.success);
    const cmpDir = join(runs(), compareIdOf([a, b]));
    const json = await readFile(join(cmpDir, 'comparison.json'), 'utf8');
    const cmp = JSON.parse(json);
    expect(cmp.runIds).toEqual([a, b].sort());
    expect(cmp.rows.map((r: { venue: string }) => r.venue)).toEqual([VENUE_ORDER[0], VENUE_ORDER[2]]);
    expect(out).toContain(`comparison.md: ${join(cmpDir, 'comparison.md')}`);
    for (const id of [a, b]) {
      const md = await readFile(join(runs(), id, 'report.md'), 'utf8');
      expect(md).toContain(`${cmp.verdict} (${cmp.compareId}) |`);
    }
    expect(await cli(['--compare', `${a},${b}`], [], err)).toBe(ExitCode.success);
    expect(await readFile(join(cmpDir, 'comparison.json'), 'utf8')).toBe(json);
    expect(await cli(['--compare', a], [], err)).toBe(ExitCode.usage);
    expect(await cli(['--compare', a, '--run-id', b], [], err)).toBe(ExitCode.usage);
  });

  it('an unknown run id is a usage error (exit 1)', async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(await cli(['--run-id', 'feedfacefeedface'], out, err)).toBe(ExitCode.usage);
    expect(err.join('\n')).toContain('no run.json');
  });
});

// ---------------------------------------------------------------- wsr bench

describe('wsr bench', () => {
  const result: BenchResult = {
    kind: 'coreLoop', events: 1000, elapsedMs: 1, eventsPerSec: 1e6, allocBytes: 0, allocMBps: 0, gcCount: 0, p50Us: 0.5, p99Us: 2, latencySamples: 10,
    warmupEvents: 0, pivots: 1, levels: 1, trades: 1, node: 'v0', cpu: 'test',
  };
  const baseline = (eventsPerSec: number): BenchBaseline => ({ eventsPerSec, allocMBps: 0, p99Us: 1, events: 1000, node: 'v0', cpu: 'test', createdAt: 'x' });

  function benchHarness(base: BenchBaseline) {
    const out: string[] = [];
    const written: { path: string; baseline: BenchBaseline }[] = [];
    const bench: BenchCommands = {
      benchCoreLoop: () => result,
      benchEndToEnd: async () => { throw new Error('unreachable'); },
      readBaseline: async () => base,
      writeBaseline: async (path, b) => { written.push({ path, baseline: b }); },
    };
    const run = (argv: string[]) => runCli(['bench', ...argv], {
      bench, stdout: (l) => out.push(l), stderr: (l) => out.push(l), now: () => new Date(Date.UTC(2026, 8, 19)), logger: () => silent,
    });
    return { out, written, run };
  }

  it('--synthetic prints throughput, allocation and p99 latency lines (real core loop)', async () => {
    const out: string[] = [];
    expect(await runCli(['bench', '--synthetic', '--events', '200000'], { stdout: (l) => out.push(l), stderr: (l) => out.push(l) })).toBe(ExitCode.success);
    const text = out.join('\n');
    expect(text).toMatch(/throughput\s+\d+\.\d\d M events\/s/);
    expect(text).toMatch(/allocation\s+\d+\.\d\d MB\/s/);
    expect(text).toMatch(/p99 per-print latency\s+\d+\.\d\d µs/);
    expect(text).toMatch(/pivots [1-9]\d* {2}levels [1-9]\d* {2}trades \d+/);
  }, 60_000);

  it('throughput below 80 % of the baseline ⇒ exit 2; within ⇒ exit 0', async () => {
    const slow = benchHarness(baseline(10e6));
    expect(await slow.run(['--synthetic', '--baseline', 'b.json'])).toBe(ExitCode.partialFailure);
    expect(slow.out.join('\n')).toContain('REGRESSION');
    const ok = benchHarness(baseline(1.2e6));
    expect(await ok.run(['--synthetic', '--baseline', 'b.json'])).toBe(ExitCode.success);
    expect(ok.out.join('\n')).toContain('ratio 0.83 ≥ 0.8 OK');
  });

  it('--update-baseline writes the result; --synthetic with --venue is a usage error', async () => {
    const h = benchHarness(baseline(1));
    expect(await h.run(['--synthetic', '--update-baseline'])).toBe(ExitCode.success);
    expect(h.written).toEqual([{ path: 'benchmarks/baseline.json', baseline: { ...baseline(1e6), p99Us: 2, createdAt: '2026-09-19T00:00:00.000Z' } }]);
    expect(await h.run(['--synthetic', '--venue', VENUE_ORDER[0]!])).toBe(ExitCode.usage);
  });
});
