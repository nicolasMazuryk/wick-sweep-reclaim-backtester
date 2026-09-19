import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NO_RUN_LOG, openRunLog, PROGRESS_INTERVAL_MS, ProgressTicker, type ProgressSample } from './run-log.js';

const dirs: string[] = [];
async function root(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'wsr-runlog-'));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const base = { command: 'backtest', runId: 'abc123', venue: 'testvenue', symbol: 'ETHUSDT' };

describe('runs/{runId}/logs/*.jsonl (Spec §10 "Logging")', () => {
  it('writes one JSON line per record, each carrying runId, venue and symbol', async () => {
    const runs = await root();
    const runLog = openRunLog(runs, base.runId, 'backtest', 'info', { venue: base.venue, symbol: base.symbol });
    runLog.log.info({ trades: 7 }, 'backtest done');
    runLog.log.debug({ ignored: true }, 'below the level');
    runLog.log.warn({ reason: 'fees unverified' }, 'warning');
    await runLog.close();
    expect(runLog.path).toBe(join(runs, base.runId, 'logs', 'backtest.jsonl'));
    const lines = (await readFile(runLog.path!, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.msg)).toEqual(['backtest done', 'warning']);      // debug is below `info`
    for (const l of lines) expect([l.runId, l.venue, l.symbol]).toEqual([base.runId, base.venue, base.symbol]);
    expect(lines[0]!.trades).toBe(7);
  });

  it('level silent writes nothing at all (the run directory stays the Spec §7.1 artefact set)', async () => {
    const runs = await root();
    const runLog = openRunLog(runs, base.runId, 'backtest', 'silent', { venue: base.venue, symbol: base.symbol });
    runLog.log.error({}, 'dropped');
    await runLog.close();
    expect(runLog.path).toBeNull();
    await expect(readFile(join(runs, base.runId, 'logs', 'backtest.jsonl'), 'utf8')).rejects.toThrow(/ENOENT/);
    expect(NO_RUN_LOG.path).toBeNull();
  });
});

describe('progress every 5 s (Spec §10 "Progress")', () => {
  it('emits at most one sample per interval with eventsProcessed / eventsPerSec, and a final one', () => {
    const samples: ProgressSample[] = [];
    let t = 1_000;
    const ticker = new ProgressTicker((s) => samples.push(s), base, () => t, PROGRESS_INTERVAL_MS);
    ticker.add(1_000_000, '2025-01-01');
    t += 1_000;
    ticker.add(1_000_000, '2025-01-02');                      // 1 s in: no sample yet
    expect(samples).toEqual([]);
    t += 4_000;
    ticker.add(2_000_000, '2025-01-02');                      // 5 s in: 4 M events
    expect(samples.length).toBe(1);
    expect(samples[0]).toMatchObject({ type: 'progress', ...base, eventsProcessed: 4_000_000, eventsPerSec: 800_000, days: 2, elapsedMs: 5_000 });
    t += 1_000;
    ticker.add(1_000_000, '2025-01-02');
    ticker.flush();                                           // already sampled ⇒ no duplicate
    expect(samples.length).toBe(1);
  });

  it('a short run still reports once; a run that fed nothing reports not at all', () => {
    const samples: ProgressSample[] = [];
    let t = 0;
    const ticker = new ProgressTicker((s) => samples.push(s), base, () => t, PROGRESS_INTERVAL_MS);
    ticker.add(1_234, '2025-01-01');
    t += 2_000;
    ticker.flush();
    expect(samples.map((s) => [s.eventsProcessed, s.eventsPerSec])).toEqual([[1_234, 617]]);
    const empty: ProgressSample[] = [];
    new ProgressTicker((s) => empty.push(s), base, () => 0).flush();
    expect(empty).toEqual([]);
  });
});
