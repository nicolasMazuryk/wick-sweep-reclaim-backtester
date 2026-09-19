import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORCED_BANNER, readE2eFixture, reportSections, type E2eFixtureManifest } from '@wsr/backtest';
import { donePath, partitionPath, readDoneMarker, readRecordsParquet, VENUE_ORDER } from '@wsr/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExitCode } from './exit-codes.js';
import { runCli } from './program.js';

// Spec §11.4 end-to-end fixture on recorded data (A-150): one recorded
// Binance ETHUSDT venue-day (2025-03-01, 4 872 005 archive trades merged to
// 1 050 997 events) checked in under fixtures/e2e/binance-ETHUSDT-2025-03-01/
// recorded/, plus the nine days the replay needs in front of it, generated at
// test time from that day's own statistics. `wsr backtest --fixture` must
// produce trades.parquet, transitions.parquet, folds.json and report.md
// byte-identically twice and equal to the checked-in goldens; the single fold
// trains on the last generated day and tests on the recorded one, so every
// golden trade comes from recorded prints. `pnpm goldens:update` rewrites them.
const FIXTURE = fileURLToPath(new URL('../../../fixtures/e2e/binance-ETHUSDT-2025-03-01/', import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === '1';
const GOLDENS = ['run.json', 'reaction.json', 'folds.json', 'target_grid.json', 'stageB.json', 'trades.jsonl', 'report.md'];
const PARQUET_GOLDENS = ['trades.parquet', 'transitions.parquet'];
const RUN_FILES = [
  'folds.json', 'levels.parquet', 'pivots.parquet', 'reaction.json', 'report.md', 'run.json', 'stageB.json', 'target_grid.json', 'trades.jsonl',
  'trades.parquet', 'transitions.parquet',
];

let dir: string;
let f: E2eFixtureManifest;
beforeAll(async () => {
  f = await readE2eFixture(FIXTURE);
  dir = await mkdtemp(join(tmpdir(), 'wsr-e2e-fx-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function backtest(dataRoot: string, runsRoot: string): Promise<{ code: number; files: Record<string, Buffer>; out: string[] }> {
  const out: string[] = [];
  const code = await runCli(
    ['--data-root', dataRoot, '--log-level', 'silent', 'backtest', '--fixture', FIXTURE, '--runs-root', runsRoot, '--run-reaction', '--force-pnl'],
    { now: () => new Date(f.createdAt), gitCommit: () => f.gitCommit, version: f.wsrVersion, stdout: (l) => out.push(l), stderr: (l) => out.push(l) },
  );
  const [runId, ...rest] = await readdir(runsRoot);
  expect(rest).toEqual([]);
  const files: Record<string, Buffer> = {};
  for (const name of (await readdir(join(runsRoot, runId!))).sort()) files[name] = await readFile(join(runsRoot, runId!, name));
  return { code, out, files };
}

describe('e2e: wsr backtest --fixture on the recorded Binance day (Spec §11.4, A-150)', () => {
  it('materialises the recorded day plus generated days and reproduces the goldens byte for byte, twice', async () => {
    const a = await backtest(join(dir, 'data-a'), join(dir, 'runs-a'));
    const b = await backtest(join(dir, 'data-b'), join(dir, 'runs-b'));
    expect(a.code).toBe(ExitCode.success);
    expect(Object.keys(a.files)).toEqual(RUN_FILES);
    for (const name of RUN_FILES) expect(b.files[name]!.equals(a.files[name]!), name).toBe(true);

    if (UPDATE) {
      for (const name of [...GOLDENS, ...PARQUET_GOLDENS]) await writeFile(join(FIXTURE, name), a.files[name]!);
    }
    for (const name of GOLDENS) expect(a.files[name]!.toString('utf8'), name).toBe(await readFile(join(FIXTURE, name), 'utf8'));
    for (const name of PARQUET_GOLDENS) expect(a.files[name]!.equals(await readFile(join(FIXTURE, name))), name).toBe(true);

    // The recorded day is the replayed input, not a re-derivation of it: the
    // run manifest carries the checked-in partition's own sha256.
    const recorded = await readDoneMarker(
      donePath(partitionPath(join(FIXTURE, 'recorded'), 'merged', f.venue, f.symbol, { y: 2025, m: 3, d: 1 })),
    );
    const run = JSON.parse(a.files['run.json']!.toString('utf8'));
    expect(run.runManifest.span).toEqual(f.span);
    expect(run.runManifest.dataChecksums.some((c: { day: string; sha256Merged: string }) => c.day === '2025-03-01' && c.sha256Merged === recorded.sha256Merged)).toBe(true);
    expect(recorded.checksumVerified).toBe(true);
    expect(recorded.rowsMerged).toBeGreaterThan(1_000_000);

    // One fold: train on the last generated day, test on the recorded day.
    const folds = JSON.parse(a.files['folds.json']!.toString('utf8'));
    expect(folds.schedule).toHaveLength(1);
    expect(folds.folds.map((m: { foldId: number | string; window: string }) => `${m.foldId}/${m.window}`)).toEqual(['0/train', '0/test', 'pooled/test']);
    const pooled = folds.folds.find((m: { foldId: number | string }) => m.foldId === 'pooled');
    expect(pooled.trades).toBeGreaterThan(0);

    // Every OOS trade (foldId 0 = the test window) triggers inside the recorded day.
    const trades = readRecordsParquet(a.files['trades.parquet']!);
    const day = Date.UTC(2025, 2, 1);
    const oos = trades.rows.filter((r) => r.foldId === 0);
    expect(oos.length).toBe(pooled.trades);
    expect(oos.every((r) => (r.TriggerTime as number) >= day && (r.TriggerTime as number) < day + 86_400_000)).toBe(true);
    expect(readRecordsParquet(a.files['transitions.parquet']!).rows.length).toBeGreaterThan(0);

    const md = a.files['report.md']!.toString('utf8');
    expect(md.split('\n')[0]).toBe(FORCED_BANNER);                       // a one-day OOS window does not pass the §9.2 gate
    expect(reportSections(md)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
  }, 180_000);

  it('refuses the flags the fixture already carries', async () => {
    const out: string[] = [];
    const code = await runCli(
      ['--data-root', join(dir, 'data-usage'), '--log-level', 'silent', 'backtest', '--fixture', FIXTURE, '--runs-root', join(dir, 'runs-usage'), '--venue', VENUE_ORDER[1]!],
      { stdout: (l) => out.push(l), stderr: (l) => out.push(l) },
    );
    expect(code).toBe(ExitCode.usage);
    expect(out.join('\n')).toContain('--fixture takes its inputs from the fixture: drop --venue');
  });
});
