import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFUSED_BANNER, reportSections, writeSyntheticDataRoot } from '@wsr/backtest';
import { parseDay, VENUE_ORDER } from '@wsr/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExitCode } from './exit-codes.js';
import { runCli } from './program.js';

// Spec §11.4 end-to-end fixture, grid part (build step 13): the synthetic
// data root of the backtest fixture, a config whose `search.grid` shrinks the
// grid to 8 cells (MinSweepMult × minStrengthPassRate), `--variants timeStop`
// (N_configs = 8 × 2), hidden `--folds 4,2,2 --min-trades-train 1`.
// Verifies the cell-count report, plateau per fold, sensitivity, DSR / RC,
// and resumability: a run stopped after k tasks leaves k `.done` files and
// an in-process `--run-id` rerun skips them and ends byte-identical to an
// uninterrupted run on 2 worker threads.
const FIXTURE = fileURLToPath(new URL('../../../fixtures/e2e/synthetic-grid/', import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === '1';
const GOLDENS = ['grid.json', 'sensitivity.json'];
const OUTPUTS = ['grid.json', 'reaction.json', 'run.json', 'sensitivity.json'];

interface Fixture {
  venueIndex: number; symbol: string; seed: number; firstDay: string; days: number; span: { from: string; to: string }; folds: string;
  bootstrap: number; variants: string; minTradesTrain: number; gaps: { start: string; end: string }[]; createdAt: string; gitCommit: string;
  wsrVersion: string;
}

let dir: string;
let f: Fixture;
beforeAll(async () => {
  f = JSON.parse(await readFile(join(FIXTURE, 'fixture.json'), 'utf8')) as Fixture;
  dir = await mkdtemp(join(tmpdir(), 'wsr-e2e-grid-'));
  await writeSyntheticDataRoot({
    dataRoot: join(dir, 'data'), venue: VENUE_ORDER[f.venueIndex]!, symbol: f.symbol, from: parseDay(f.firstDay), days: f.days, seed: f.seed,
    gaps: f.gaps.map((g) => ({ start: Date.parse(g.start), end: Date.parse(g.end) })),
  });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Run { code: number; out: string[]; err: string[]; runId: string; files: Record<string, Buffer>; cells: string[] }

async function grid(runsRoot: string, args: string[], shouldStop: (err: string[]) => boolean = () => false): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(['--data-root', join(dir, 'data'), '--log-level', 'silent', '--config', join(FIXTURE, 'config.json'), 'grid', '--runs-root', runsRoot, ...args], {
    now: () => new Date(f.createdAt), gitCommit: () => f.gitCommit, version: f.wsrVersion, stdout: (l) => out.push(l), stderr: (l) => err.push(l),
    shouldStop: () => shouldStop(err),
  });
  const [runId, ...rest] = await readdir(runsRoot);
  expect(rest).toEqual([]);
  const files: Record<string, Buffer> = {};
  let cells: string[] = [];
  for (const name of (await readdir(join(runsRoot, runId!))).sort()) {
    if (name === 'cells') cells = (await readdir(join(runsRoot, runId!, 'cells'))).sort();
    else files[name] = await readFile(join(runsRoot, runId!, name));
  }
  return { code, out, err, runId: runId!, files, cells };
}

const selection = (): string[] => ['--venue', VENUE_ORDER[f.venueIndex]!, '--symbol', f.symbol, '--from', f.span.from, '--to', f.span.to, '--seed', String(f.seed)];
const options = (): string[] => ['--folds', f.folds, '--bootstrap', String(f.bootstrap), '--min-trades-train', String(f.minTradesTrain), '--variants', f.variants];
const progress = (err: string[]): string[] => err.filter((l) => l.startsWith('grid '));

describe('e2e: wsr grid on the synthetic fixture (Spec §11.4, §6.4)', () => {
  it('with --run-reaction and without --force-pnl a failed gate refuses (exit 3): run.json + reaction.json, no task', async () => {
    const r = await grid(join(dir, 'runs-refused'), [...selection(), ...options(), '--workers', '0', '--run-reaction']);
    const reaction = JSON.parse(r.files['reaction.json']!.toString('utf8'));
    if (reaction.gate.pass as boolean) return;           // the fixture's gate verdict decides (as in e2e-backtest)
    expect(r.code).toBe(ExitCode.reactionFailed);
    expect(r.out[0]).toBe(REFUSED_BANNER);
    expect(Object.keys(r.files)).toEqual(['reaction.json', 'run.json']);
    expect(r.cells).toEqual([]);
  }, 60_000);

  it('cell-count report, plateau per fold, sensitivity, DSR / RC; resume after a stop is byte-identical; goldens', async () => {
    const a = await grid(join(dir, 'runs-a'), [...selection(), ...options(), '--force-pnl', '--workers', '2']);
    expect(a.code, a.err.join('\n')).toBe(ExitCode.success);
    expect(a.out).toContain('cells 8 × variants 2 × latency 1 = N_configs 16');
    const nTasks = 2 * 2 + 2 * 8 + 21;                   // fits (variant × fit group) + cells + sensitivity
    expect(a.out).toContain(`tasks ${nTasks}: ran ${nTasks}, skipped 0 (completed earlier)`);
    expect(a.out).toContain('## 11. Parameter search (§9.3)');
    expect(Object.keys(a.files)).toEqual(OUTPUTS);
    expect(a.cells).toHaveLength(2 * nTasks);
    const g = JSON.parse(a.files['grid.json']!.toString('utf8'));
    expect(g.nConfigs).toEqual({ cells: 8, variants: 2, latencyPoints: 1, N: 16 });
    expect(g.cells).toHaveLength(16);
    expect(g.walkForward.map((w: { variant: string }) => w.variant)).toEqual(['baseline', 'timeStop']);
    for (const w of g.walkForward) {
      expect(w.folds.map((x: { foldId: number }) => x.foldId)).toEqual([0, 1, 2, 3, 4]);
      for (const x of w.folds) expect(x.chosen?.cellId).toMatch(/^c000[0-7]$/);
      expect(w.pooled.trades).toBeGreaterThan(0);
    }
    expect(g.dsr.N).toBe(16);
    expect(g.dsr.trials).toBe(16);
    expect(g.dsr.DSR).toBeGreaterThanOrEqual(0);
    expect(g.realityCheck.p).toBeGreaterThanOrEqual(0);
    expect(g.realityCheck.B).toBe(f.bootstrap);
    const s = JSON.parse(a.files['sensitivity.json']!.toString('utf8'));
    expect(s.rows).toHaveLength(22);
    expect(s.rows[0].param).toBe('base');
    expect(s.centre.cellId).toMatch(/^c000[0-7]$/);
    const run = JSON.parse(a.files['run.json']!.toString('utf8'));
    expect(run.runManifest.warnings).toContain('--min-trades-train 1: non-default MinTradesTrain (Spec §6.4: 100)');

    if (UPDATE) {
      for (const name of GOLDENS) await writeFile(join(FIXTURE, name), a.files[name]!);
    }
    for (const name of GOLDENS) expect(a.files[name]!.toString('utf8'), name).toBe(await readFile(join(FIXTURE, name), 'utf8'));

    // Stop after k tasks on 2 workers (in-flight tasks finish): exit 130, one .json/.done pair per finished task.
    const k = 10;
    const runsB = join(dir, 'runs-b');
    const b1 = await grid(runsB, [...selection(), ...options(), '--force-pnl', '--workers', '2'], (err) => progress(err).length >= k);
    expect(b1.code).toBe(ExitCode.interrupted);
    const finished = progress(b1.err).length;
    expect(finished).toBeGreaterThanOrEqual(k);
    expect(finished).toBeLessThan(k + 2);
    expect(b1.cells.filter((c) => c.endsWith('.done'))).toHaveLength(finished);
    expect(Object.keys(b1.files)).toEqual(['reaction.json', 'run.json']);
    expect(b1.out.some((l) => l.includes(`--run-id ${b1.runId}`))).toBe(true);
    expect(b1.runId).toBe(a.runId);

    // A conflicting selection flag is a usage error.
    const conflict = await grid(runsB, ['--run-id', b1.runId, '--symbol', 'BTCUSDT', ...options()]);
    expect(conflict.code).toBe(ExitCode.usage);

    const b2 = await grid(runsB, ['--run-id', b1.runId, ...options(), '--force-pnl', '--workers', '0']);
    expect(b2.code, b2.err.join('\n')).toBe(ExitCode.success);
    expect(b2.out).toContain(`tasks ${nTasks}: ran ${nTasks - finished}, skipped ${finished} (completed earlier)`);
    expect(progress(b2.err)).toHaveLength(nTasks - finished);
    for (const name of OUTPUTS) expect(b2.files[name]!.equals(a.files[name]!), name).toBe(true);
    expect(b2.cells).toEqual(a.cells);

    // A-82: `wsr report` assembles report.md for the grid run; its §11 is the section printed by `wsr grid`.
    const out: string[] = [];
    const code = await runCli(['--data-root', join(dir, 'data'), '--log-level', 'silent', 'report', '--run-id', a.runId, '--runs-root', join(dir, 'runs-a')],
      { stdout: (l) => out.push(l), stderr: (l) => out.push(l) });
    expect(code, out.join('\n')).toBe(ExitCode.success);
    const md = await readFile(join(dir, 'runs-a', a.runId, 'report.md'), 'utf8');
    expect(reportSections(md)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    const start = a.out.indexOf('## 11. Parameter search (§9.3)');
    const end = a.out.findIndex((l, i) => i > start && (l === 'warnings:' || /^[a-z]+\.json: /.test(l)));
    const section = a.out.slice(start, end).join('\n').trimEnd();
    expect(md).toContain(`${section}\n\n## 12. Open questions`);
    expect(md).toContain('_Not available — folds.json missing (run `wsr backtest`)._ The grid walk-forward is in §11.');

    // A-134: `wsr backtest --from-grid` trades each fold with the grid's chosen cell (inputs from the grid's run.json).
    const fgOut: string[] = [];
    const fgCode = await runCli(['--data-root', join(dir, 'data'), '--log-level', 'silent', 'backtest', '--from-grid', a.runId, '--runs-root', join(dir, 'runs-a'),
      '--folds', f.folds, '--bootstrap', String(f.bootstrap), '--force-pnl', '--workers', '0'],
    { now: () => new Date(f.createdAt), gitCommit: () => f.gitCommit, version: f.wsrVersion, stdout: (l) => fgOut.push(l), stderr: (l) => fgOut.push(l) });
    expect(fgCode, fgOut.join('\n')).toBe(ExitCode.success);
    const fgDirs = (await readdir(join(dir, 'runs-a'))).filter((d) => d !== a.runId);
    expect(fgDirs).toHaveLength(1);
    const fgRun = JSON.parse(await readFile(join(dir, 'runs-a', fgDirs[0]!, 'run.json'), 'utf8'));
    expect(fgRun.runManifest.fromGrid).toBe(a.runId);
    const fgFolds = JSON.parse(await readFile(join(dir, 'runs-a', fgDirs[0]!, 'folds.json'), 'utf8'));
    expect(fgFolds.schedule.map((x: { cellId: string }) => x.cellId)).toEqual(g.walkForward[0].folds.map((x: { chosen: { cellId: string } }) => x.chosen.cellId));
    const fgMd = await readFile(join(dir, 'runs-a', fgDirs[0]!, 'report.md'), 'utf8');
    expect(fgMd).toContain(`each fold's chosen cell of grid run ${a.runId}`);
  }, 300_000);
});
