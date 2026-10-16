import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORCED_BANNER, NO_REACTION_BANNER, REFUSED_BANNER, reportSections, writeSyntheticDataRoot } from '@wsr/backtest';
import { parseDay, readRecordsParquet, VENUE_ORDER } from '@wsr/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExitCode } from './exit-codes.js';
import { runCli } from './program.js';
import { expectGolden, expectParquetGolden } from './golden-compare.js';

// Spec §11.4 end-to-end fixture, backtest part (build step 12): 8 warm-up +
// 14 span days of the synthetic data root, hidden `--folds 4,2,2` (5 folds,
// F ≥ 12 waived) and strengthModel stageB so Stage B is on the trading path.
// `wsr backtest` without --force-pnl must refuse (exit 3, banner) when the
// gate fails; with it, two runs must be byte-identical (Parquet included)
// and match the checked-in goldens. `pnpm goldens:update` rewrites them.
const FIXTURE = fileURLToPath(new URL('../../../fixtures/e2e/synthetic-backtest/', import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === '1';
const GOLDENS = ['run.json', 'reaction.json', 'folds.json', 'target_grid.json', 'stageB.json', 'trades.jsonl', 'report.md'];
// Spec §11.4 compares the Parquet artefacts byte for byte too; they are binary,
// so they are read and written as bytes, not decoded as UTF-8 text.
const PARQUET_GOLDENS = ['trades.parquet', 'transitions.parquet'];
const PNL_FILES = [
  'folds.json', 'levels.parquet', 'pivots.parquet', 'reaction.json', 'report.md', 'run.json', 'stageB.json', 'target_grid.json', 'trades.jsonl',
  'trades.parquet', 'transitions.parquet',
];
const SECTIONS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

interface Fixture {
  venueIndex: number; symbol: string; seed: number; firstDay: string; days: number; span: { from: string; to: string }; folds: string;
  bootstrap: number; gaps: { start: string; end: string }[]; createdAt: string; gitCommit: string; wsrVersion: string;
}

let dir: string;
let f: Fixture;
beforeAll(async () => {
  f = JSON.parse(await readFile(join(FIXTURE, 'fixture.json'), 'utf8')) as Fixture;
  dir = await mkdtemp(join(tmpdir(), 'wsr-e2e-bt-'));
  await writeSyntheticDataRoot({
    dataRoot: join(dir, 'data'), venue: VENUE_ORDER[f.venueIndex]!, symbol: f.symbol, from: parseDay(f.firstDay), days: f.days, seed: f.seed,
    gaps: f.gaps.map((g) => ({ start: Date.parse(g.start), end: Date.parse(g.end) })),
  });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readRun(runsRoot: string): Promise<{ runId: string; files: Record<string, Buffer> }> {
  const [runId, ...rest] = await readdir(runsRoot);
  expect(rest).toEqual([]);
  const files: Record<string, Buffer> = {};
  for (const name of (await readdir(join(runsRoot, runId!))).sort()) files[name] = await readFile(join(runsRoot, runId!, name));
  return { runId: runId!, files };
}

async function backtest(runsRoot: string, extra: string[]): Promise<{ code: number; files: Record<string, Buffer>; out: string[] }> {
  const out: string[] = [];
  const code = await runCli(
    ['--data-root', join(dir, 'data'), '--log-level', 'silent', '--config', join(FIXTURE, 'config.json'), 'backtest', '--venue', VENUE_ORDER[f.venueIndex]!,
      '--symbol', f.symbol, '--from', f.span.from, '--to', f.span.to, '--seed', String(f.seed), '--runs-root', runsRoot,
      '--folds', f.folds, '--bootstrap', String(f.bootstrap), ...extra],
    { now: () => new Date(f.createdAt), gitCommit: () => f.gitCommit, version: f.wsrVersion, stdout: (l) => out.push(l), stderr: (l) => out.push(l) },
  );
  return { code, out, ...(await readRun(runsRoot)) };
}

async function report(runsRoot: string, runId: string): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const code = await runCli(['--data-root', join(dir, 'data'), '--log-level', 'silent', 'report', '--run-id', runId, '--runs-root', runsRoot],
    { stdout: (l) => out.push(l), stderr: (l) => out.push(l) });
  return { code, out };
}

describe('e2e: wsr backtest on the synthetic fixture (Spec §11.4, §6)', () => {
  it('refuses with exit 3 and the banner when the gate fails; --force-pnl runs are byte-identical and match the goldens', async () => {
    // Spec §6.1.6 (A-136): no reaction.json of these inputs ⇒ exit 3 before any replay, nothing written.
    const noneOut: string[] = [];
    const none = await runCli(
      ['--data-root', join(dir, 'data'), '--log-level', 'silent', '--config', join(FIXTURE, 'config.json'), 'backtest', '--venue', VENUE_ORDER[f.venueIndex]!,
        '--symbol', f.symbol, '--from', f.span.from, '--to', f.span.to, '--seed', String(f.seed), '--runs-root', join(dir, 'runs-none'),
        '--folds', f.folds, '--bootstrap', String(f.bootstrap)],
      { now: () => new Date(f.createdAt), stdout: (l) => noneOut.push(l), stderr: (l) => noneOut.push(l) },
    );
    expect(none).toBe(ExitCode.reactionFailed);
    expect(noneOut[0]).toBe(NO_REACTION_BANNER);
    await expect(readdir(join(dir, 'runs-none'))).rejects.toThrow(/ENOENT/);
    // `wsr reaction` first: the backtest then gates on the stored reaction.json.
    const reactionOut: string[] = [];
    await runCli(
      ['--data-root', join(dir, 'data'), '--log-level', 'silent', '--config', join(FIXTURE, 'config.json'), 'reaction', '--venue', VENUE_ORDER[f.venueIndex]!,
        '--symbol', f.symbol, '--from', f.span.from, '--to', f.span.to, '--seed', String(f.seed), '--runs-root', join(dir, 'runs-refused'),
        '--bootstrap', String(f.bootstrap)],
      { now: () => new Date(f.createdAt), gitCommit: () => f.gitCommit, version: f.wsrVersion, stdout: (l) => reactionOut.push(l), stderr: (l) => reactionOut.push(l) },
    );
    const refused = await backtest(join(dir, 'runs-refused'), []);
    const reaction = JSON.parse(refused.files['reaction.json']!.toString('utf8'));
    const gatePass = reaction.gate.pass as boolean;
    if (!gatePass) {
      expect(refused.code).toBe(ExitCode.reactionFailed);
      expect(Object.keys(refused.files)).toEqual(['reaction.json', 'report.md', 'run.json']);
      const md = refused.files['report.md']!.toString('utf8');
      expect(md.split('\n')[0]).toBe(REFUSED_BANNER);
      expect(reportSections(md)).toEqual(SECTIONS);
      expect(md).toContain('## 11. Parameter search (§9.3)\n\n_P&L backtest not run');
      expect(refused.out[0]).toBe(REFUSED_BANNER);
    }

    const a = await backtest(join(dir, 'runs-a'), ['--force-pnl']);
    const b = await backtest(join(dir, 'runs-b'), ['--force-pnl']);
    expect(a.code).toBe(ExitCode.success);
    expect(Object.keys(a.files)).toEqual(PNL_FILES);
    for (const name of PNL_FILES) expect(b.files[name]!.equals(a.files[name]!), name).toBe(true);
    const body = (x: Buffer): unknown => ({ ...JSON.parse(x.toString('utf8')), runManifest: undefined });
    expect(body(a.files['reaction.json']!)).toEqual(body(refused.files['reaction.json']!));    // manifests differ by the forced banner

    if (UPDATE) {
      for (const name of [...GOLDENS, ...PARQUET_GOLDENS]) await writeFile(join(FIXTURE, name), a.files[name]!);
    }
    for (const name of GOLDENS) expectGolden(name, a.files[name]!.toString('utf8'), await readFile(join(FIXTURE, name), 'utf8'));
    for (const name of PARQUET_GOLDENS) expectParquetGolden(name, a.files[name]!, await readFile(join(FIXTURE, name)));

    const md = a.files['report.md']!.toString('utf8');
    if (!gatePass) expect(md.split('\n')[0]).toBe(FORCED_BANNER);
    expect(reportSections(md)).toEqual(SECTIONS);
    expect(md).not.toContain('_Not available — folds.json');
    expect(md).toMatch(/^\| 9 \| Transfer across venues and symbols\? \|/m);

    // `wsr report` on the same run directory re-renders report.md byte-identically.
    const runsA = join(dir, 'runs-a');
    const { runId } = await readRun(runsA);
    await writeFile(join(runsA, runId, 'report.md'), 'stale\n');
    const r = await report(runsA, runId);
    expect(r.code).toBe(ExitCode.success);
    expect(r.out).toEqual([`report.md: ${join(runsA, runId, 'report.md')}`]);
    expect((await readFile(join(runsA, runId, 'report.md'))).equals(a.files['report.md']!)).toBe(true);
    const run = JSON.parse(a.files['run.json']!.toString('utf8'));
    expect(run.runManifest.warnings.some((w: string) => w.startsWith(`--folds ${f.folds}`))).toBe(true);
    const folds = JSON.parse(a.files['folds.json']!.toString('utf8'));
    expect(folds.folds.map((m: { foldId: number | string; window: string }) => `${m.foldId}/${m.window}`)).toEqual([
      '0/train', '0/test', '1/train', '1/test', '2/train', '2/test', '3/train', '3/test', '4/train', '4/test', 'pooled/test',
    ]);
    const stageB = JSON.parse(a.files['stageB.json']!.toString('utf8'));
    expect(stageB.folds).toHaveLength(5);
    for (const fold of stageB.folds) expect(fold.model.beta).toHaveLength(13);

    const trades = readRecordsParquet(a.files['trades.parquet']!);
    const jsonl = a.files['trades.jsonl']!.toString('utf8').trimEnd().split('\n');
    expect(JSON.parse(jsonl[0]!).runManifest.runId).toBe(run.runManifest.runId);
    expect(trades.rows.map((r) => r.tradeId)).toEqual(jsonl.slice(1).map((l) => JSON.parse(l).tradeId));
    expect(trades.rows.length).toBeGreaterThan(20);
    expect(Object.fromEntries(trades.metadata)).toEqual({
      'wsr.configHash': run.runManifest.configHash, 'wsr.runId': run.runManifest.runId, 'wsr.seed': String(f.seed),
    });
    const transitions = readRecordsParquet(a.files['transitions.parquet']!);
    expect(transitions.rows.length).toBeGreaterThan(0);
    expect(Object.keys(transitions.rows[0]!)).toEqual(['t', 'seq', 'levelId', 'from', 'to', 'reason']);
    const levels = readRecordsParquet(a.files['levels.parquet']!);
    const pivots = readRecordsParquet(a.files['pivots.parquet']!);
    expect(levels.rows.length).toBeGreaterThan(0);
    expect(pivots.rows.length).toBeGreaterThan(levels.rows.length);
    expect(levels.rows.map((l) => l.levelId)).toEqual(levels.rows.map((_, i) => i));
    expect(new Set(levels.rows.map((l) => l.State)).has('INVALIDATED')).toBe(true);
    expect(Object.fromEntries(levels.metadata)).toEqual(Object.fromEntries(trades.metadata));
    expect(Object.fromEntries(pivots.metadata)).toEqual(Object.fromEntries(trades.metadata));
  }, 60_000);

  it('--latency-sweep --slippage-sweep --variants armMode on 2 workers: curves and one variant set, trades unchanged (A-130, A-132)', async () => {
    const r = await backtest(join(dir, 'runs-sweep'), ['--force-pnl', '--latency-sweep', '--slippage-sweep', '--variants', 'armMode', '--workers', '2']);
    expect(r.code).toBe(ExitCode.success);
    const folds = JSON.parse(r.files['folds.json']!.toString('utf8'));
    expect(folds.nConfigs).toEqual({ cells: 1, variants: 2, latencyPoints: 4, N: 8 });
    expect(folds.variants.map((v: { variant: string }) => v.variant)).toEqual(['armMode']);
    expect(folds.variants[0].folds).toHaveLength(folds.folds.length);
    for (const m of folds.folds) {
      expect(m.latencyCurve.map((c: { latencyMs: number }) => c.latencyMs)).toEqual([0, 50, 150, 500]);
      expect(m.slippageCurve.map((c: { slipCoefMult: number }) => c.slipCoefMult)).toEqual([1, 2, 4]);
    }
    expect(r.files['trades.jsonl']!.toString('utf8')).toBe(await readFile(join(FIXTURE, 'trades.jsonl'), 'utf8'));
    const md = r.files['report.md']!.toString('utf8');
    expect(md).not.toContain('Latency sweep not run');
    expect(md).toContain('N_configs (§6.4) = 1 cell × 2 variant(s) × 4 latency point(s) = 8.');
    expect(md).toMatch(/^\| armMode \| ArmMode=ArmOnApproach \| ArmOnApproach \|/m);
    expect(r.out.some((l) => l.startsWith('latency curve (pooled test, expectancy bps): 0 ms '))).toBe(true);
  }, 120_000);

  // Spec §10 logging / progress / exit 130 (Spec §2.7.2).
  it('logs to runs/{runId}/logs/reaction.jsonl with the real runId and progress; the first SIGINT aborts the run', async () => {
    const runsRoot = join(dir, 'runs-log');
    const out: string[] = [];
    const err: string[] = [];
    const argv = (root: string, ...globals: string[]): string[] => ['--data-root', join(dir, 'data'), ...globals, '--config', join(FIXTURE, 'config.json'), 'reaction',
      '--venue', VENUE_ORDER[f.venueIndex]!, '--symbol', f.symbol, '--from', f.span.from, '--to', f.span.to, '--seed', String(f.seed),
      '--runs-root', root, '--bootstrap', String(f.bootstrap)];
    const code = await runCli(argv(runsRoot), { gitCommit: () => f.gitCommit, version: f.wsrVersion, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
    expect(code === ExitCode.success || code === ExitCode.reactionFailed).toBe(true);
    const [runId, ...rest] = await readdir(runsRoot);
    expect(rest).toEqual([]);
    expect((await readdir(join(runsRoot, runId!))).sort()).toEqual(['logs', 'reaction.json', 'run.json']);
    const lines = (await readFile(join(runsRoot, runId!, 'logs', 'reaction.jsonl'), 'utf8')).trim().split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.every((l) => l.runId === runId && l.venue === VENUE_ORDER[f.venueIndex]! && l.symbol === f.symbol)).toBe(true);
    expect(lines.map((l) => l.msg)).toEqual(['run start', 'reaction test done', 'progress', 'run done']);   // the last sample is flushed at close
    const progress = lines.find((l) => l.msg === 'progress')!;
    expect(progress.eventsProcessed as number).toBeGreaterThan(0);
    expect(progress.eventsPerSec as number).toBeGreaterThanOrEqual(0);
    // The same sample as NDJSON on stderr; stdout keeps the human-readable summary.
    expect(err.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(['progress']);
    expect(out[0]).toMatch(/^reaction test /);

    // First SIGINT: the replay itself stops, exit 130, nothing written.
    const stopped = await runCli(argv(join(dir, 'runs-stop'), '--log-level', 'silent'), { shouldStop: () => true, stdout: () => {}, stderr: () => {} });
    expect(stopped).toBe(ExitCode.interrupted);
    await expect(readdir(join(dir, 'runs-stop'))).rejects.toThrow(/ENOENT/);
  }, 60_000);

  it('without --folds the 14-day span gives F < 12: usage error (exit 1)', async () => {
    const out: string[] = [];
    const code = await runCli(
      ['--data-root', join(dir, 'data'), '--log-level', 'silent', '--config', join(FIXTURE, 'config.json'), 'backtest', '--venue', VENUE_ORDER[f.venueIndex]!,
        '--symbol', f.symbol, '--from', f.span.from, '--to', f.span.to, '--runs-root', join(dir, 'runs-usage'), '--run-reaction'],
      { now: () => new Date(f.createdAt), stdout: (l) => out.push(l), stderr: (l) => out.push(l) },
    );
    expect(code).toBe(ExitCode.usage);
    expect(out.join('\n')).toMatch(/requires F ≥ 12/);
  });
});
