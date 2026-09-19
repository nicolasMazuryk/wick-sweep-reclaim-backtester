import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSyntheticDataRoot } from '@wsr/backtest';
import { parseDay, VENUE_ORDER } from '@wsr/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExitCode } from './exit-codes.js';
import { runCli } from './program.js';

// Spec §11.4 end-to-end fixture, reaction part (build step 11): a synthetic
// data root generated at test time from fixtures/e2e/synthetic-reaction/
// fixture.json; `wsr reaction` must reproduce the checked-in reaction.json and
// run.json byte for byte, twice. `pnpm goldens:update` (UPDATE_GOLDENS=1)
// rewrites the goldens — only with a commit citing the Appendix A change.
const FIXTURE = fileURLToPath(new URL('../../../fixtures/e2e/synthetic-reaction/', import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === '1';

interface Fixture {
  venueIndex: number; symbol: string; seed: number; firstDay: string; days: number; span: { from: string; to: string };
  gaps: { start: string; end: string }[]; createdAt: string; gitCommit: string; wsrVersion: string;
}

let dir: string;
let f: Fixture;
beforeAll(async () => {
  f = JSON.parse(await readFile(join(FIXTURE, 'fixture.json'), 'utf8')) as Fixture;
  dir = await mkdtemp(join(tmpdir(), 'wsr-e2e-'));
  await writeSyntheticDataRoot({
    dataRoot: join(dir, 'data'), venue: VENUE_ORDER[f.venueIndex]!, symbol: f.symbol, from: parseDay(f.firstDay), days: f.days, seed: f.seed,
    gaps: f.gaps.map((g) => ({ start: Date.parse(g.start), end: Date.parse(g.end) })),
  });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function reaction(runsRoot: string): Promise<{ code: number; files: Record<string, string>; out: string[] }> {
  const out: string[] = [];
  const code = await runCli(
    ['--data-root', join(dir, 'data'), '--log-level', 'silent', '--config', join(FIXTURE, 'config.json'), 'reaction', '--venue', VENUE_ORDER[f.venueIndex]!,
      '--symbol', f.symbol, '--from', f.span.from, '--to', f.span.to, '--seed', String(f.seed), '--runs-root', runsRoot],
    { now: () => new Date(f.createdAt), gitCommit: () => f.gitCommit, version: f.wsrVersion, stdout: (l) => out.push(l), stderr: (l) => out.push(l) },
  );
  const [runId, ...rest] = await readdir(runsRoot);
  expect(rest).toEqual([]);
  const files: Record<string, string> = {};
  for (const name of ['reaction.json', 'run.json']) files[name] = await readFile(join(runsRoot, runId!, name), 'utf8');
  return { code, files, out };
}

describe('e2e: wsr reaction on the synthetic fixture (Spec §11.4, §9.2)', () => {
  it('reproduces the goldens byte for byte, twice; exit code follows the gate', async () => {
    const a = await reaction(join(dir, 'runs-a'));
    const b = await reaction(join(dir, 'runs-b'));
    expect(b.files).toEqual(a.files);
    if (UPDATE) {
      for (const [name, text] of Object.entries(a.files)) await writeFile(join(FIXTURE, name), text);
    }
    for (const [name, text] of Object.entries(a.files)) expect(text).toBe(await readFile(join(FIXTURE, name), 'utf8'));
    const stored = JSON.parse(a.files['reaction.json']!);
    expect(a.code).toBe(stored.gate.pass ? ExitCode.success : ExitCode.reactionFailed);
    expect(Object.keys(stored)[0]).toBe('runManifest');
    expect(Object.keys(stored.sets).sort()).toEqual(['placebo', 'random', 'slow', 'wick']);
    expect(stored.wickByDecile).toHaveLength(10);
    expect(Object.keys(stored.contrasts)).toEqual(['1-2', '1-3', '1-4']);
    expect(stored.runManifest.dataChecksums).toHaveLength(f.days);
    expect(stored.blacklistedBuckets).toBeGreaterThan(0);                       // the planted outage
    expect(a.out.some((l) => /^GATE (PASS|FAIL)$/.test(l))).toBe(true);
  }, 60_000);
});
