import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, type MergedEvent, parseRunConfig, VENUE_IDS } from '@wsr/core';
import { DataIntegrityError, dayStartMs, donePath, partitionPath } from '@wsr/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initialInstrument, installReplayHooks, planReplay, replay, RunInterrupted, type ReplayInput, type ReplayProgress } from './replay.js';
import { writeSyntheticDataRoot } from './synthetic-data-root.js';

const VENUE = VENUE_IDS[0];
const SYMBOL = 'ETHUSDT';
const FROM = { y: 2025, m: 1, d: 1 };
const fees = Object.fromEntries(VENUE_IDS.map((v) => [v, { TakerFee: 0.0005, MakerFee: 0.0002, verifiedAt: '2026-09-19' }]));
const cfg = parseRunConfig({ fees, data: { lowCapSymbol: 'SOLUSDT' } });

// Records what `replay` feeds an engine.
function recorder() {
  const events: MergedEvent[] = [];
  const resets: { atEvent: number; Tick: number }[] = [];
  let finished = 0;
  const engine = {
    onPrint: (e: MergedEvent) => { events.push({ ...e }); },           // replay reuses one event object
    resetOnTickChange: (i: { Tick: number }) => { resets.push({ atEvent: events.length, Tick: i.Tick }); },
    finish: () => { finished++; },
  } as unknown as Engine;
  return { engine, events, resets, finished: () => finished };
}

const roots: string[] = [];
async function dataRoot(opts: Partial<Parameters<typeof writeSyntheticDataRoot>[0]> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wsr-replay-'));
  roots.push(dir);
  await writeSyntheticDataRoot({ dataRoot: dir, venue: VENUE, symbol: SYMBOL, from: FROM, days: 3, seed: 3, ...opts });
  return dir;
}
const input = (dir: string): ReplayInput => ({ dataRoot: dir, venue: VENUE, symbol: SYMBOL, from: { y: 2025, m: 1, d: 2 }, to: { y: 2025, m: 1, d: 3 }, warmupDays: 1 });

afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('replay driver (Spec §6, §10)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await dataRoot();
  });

  it('plans warm-up + span days with checksums, funding and fee status', async () => {
    const plan = await planReplay(input(dir), cfg);
    expect(plan.days.map((d) => [d.label, d.status, d.warmup])).toEqual([
      ['2025-01-01', 'ok', true], ['2025-01-02', 'ok', false], ['2025-01-03', 'ok', false],
    ]);
    expect(plan.spanStart).toBe(Date.UTC(2025, 0, 2));
    expect(plan.spanEnd).toBe(Date.UTC(2025, 0, 4));
    expect(plan.dataChecksums.map((c) => c.day)).toEqual(['2025-01-01', '2025-01-02', '2025-01-03']);
    expect(plan.funding!.intervalMs).toBe(8 * 3_600_000);
    expect(plan.feesVerifiedAt).toBeNull();
    expect(plan.warnings).toEqual(['[VERIFY] fees unverified']);
    expect(initialInstrument(plan)).toEqual({ Tick: 0.01, LotSize: 0.001 });
  });

  it('feeds every stored row in (t, seq) order with seq global across days (A-69), then finish()', async () => {
    const plan = await planReplay(input(dir), cfg);
    const r = recorder();
    const days: string[] = [];
    await replay(plan, r.engine, { onDay: (d) => days.push(d.label) });
    expect(days).toEqual(['2025-01-01', '2025-01-02', '2025-01-03']);
    expect(r.events.length).toBe(plan.days.reduce((n, d) => n + d.rows, 0));
    r.events.forEach((e, i) => expect(e.seq).toBe(i));
    for (let i = 1; i < r.events.length; i++) expect(r.events[i]!.t).toBeGreaterThan(r.events[i - 1]!.t);
    expect(r.resets).toEqual([]);
    expect(r.finished()).toBe(1);
  });

  it('two replays through Engine.fromConfig are byte-identical (Spec §9.2)', async () => {
    const hash = async (): Promise<string> => {
      const plan = await planReplay(input(dir), cfg);
      const engine = Engine.fromConfig(cfg, VENUE, initialInstrument(plan), { blacklist: plan.blacklist.blacklist, funding: plan.funding });
      await replay(plan, engine);
      return engine.snapshotHash();
    };
    expect(await hash()).toBe(await hash());
  });

  it('a missing day is not fed, blacklisted whole-day and warned (A-70)', async () => {
    const d = await dataRoot({ skipDays: [{ y: 2025, m: 1, d: 2 }] });
    const plan = await planReplay(input(d), cfg);
    expect(plan.days.map((x) => x.status)).toEqual(['ok', 'missing', 'ok']);
    expect(plan.warnings).toContain('2025-01-02: merged partition missing or incomplete (no .done) — day not replayed, blacklisted');
    expect(plan.blacklist.intervals).toContainEqual({ tStart: Date.UTC(2025, 0, 2), tEnd: Date.UTC(2025, 0, 3), reason: 'missingPartition' });
    expect(plan.dataChecksums.map((c) => c.day)).toEqual(['2025-01-01', '2025-01-03']);
    const r = recorder();
    await replay(plan, r.engine);
    expect(r.events.some((e) => e.t >= Date.UTC(2025, 0, 2) && e.t < Date.UTC(2025, 0, 3))).toBe(false);
  });

  it('tick-size change: engine re-based before the first print on the new grid', async () => {
    const validFrom = dayStartMs({ y: 2025, m: 1, d: 3 });
    const d = await dataRoot({ tickChange: { validFrom, Tick: 0.02, TickDecimal: '0.02' } });
    const plan = await planReplay(input(d), cfg);
    expect(plan.warnings).toContain('tick/lot size change at 2025-01-03T00:00:00.000Z — engine re-based, warm-up restarted');
    const r = recorder();
    await replay(plan, r.engine);
    const first = r.events.findIndex((e) => e.t >= validFrom);
    expect(r.resets).toEqual([{ atEvent: first, Tick: 0.02 }]);

    const engine = Engine.fromConfig(cfg, VENUE, initialInstrument(plan), { blacklist: plan.blacklist.blacklist });
    await replay(await planReplay(input(d), cfg), engine);
    expect(engine.counters.tickChanges).toBe(1);
  });

  it('schema-version mismatch in .done ⇒ DataIntegrityError', async () => {
    const d = await dataRoot();
    const marker = donePath(partitionPath(d, 'merged', VENUE, SYMBOL, { y: 2025, m: 1, d: 3 }));
    await writeFile(marker, JSON.stringify({ ...JSON.parse(await readFile(marker, 'utf8')), schemaVersion: 2 }));
    await expect(planReplay(input(d), cfg)).rejects.toThrow(DataIntegrityError);
  });

  it('partition bytes that do not match the .done sha256 ⇒ DataIntegrityError', async () => {
    const d = await dataRoot();
    const plan = await planReplay(input(d), cfg);
    await appendFile(partitionPath(d, 'merged', VENUE, SYMBOL, { y: 2025, m: 1, d: 2 }), Buffer.from([0]));
    await expect(replay(plan, recorder().engine)).rejects.toThrow(DataIntegrityError);
  });

  it('a .done row count that the partition footer contradicts ⇒ DataIntegrityError, nothing fed (Spec §10)', async () => {
    const d = await dataRoot();
    const plan = await planReplay(input(d), cfg);
    const marker = donePath(partitionPath(d, 'merged', VENUE, SYMBOL, { y: 2025, m: 1, d: 1 }));
    await writeFile(marker, JSON.stringify({ ...JSON.parse(await readFile(marker, 'utf8')), rowsMerged: 7 }));
    const tampered = await planReplay(input(d), cfg);
    const r = recorder();
    await expect(replay(tampered, r.engine)).rejects.toThrow(/rows, \.done says 7/);
    expect(r.events.length).toBe(0);
    expect(plan.days[0]!.rows).toBeGreaterThan(7);
  });

  it('Σq ≥ 2^52 over the span ⇒ DataIntegrityError before the day is fed (Spec §3.11)', async () => {
    const big = await dataRoot({ qScale: 2 ** 40 });
    const plan = await planReplay(input(big), cfg);
    const r = recorder();
    await expect(replay(plan, r.engine)).rejects.toThrow(/2\^52/);
    await expect(replay(plan, r.engine)).rejects.toBeInstanceOf(DataIntegrityError);
  });

  it('hooks report per-batch progress and abort the replay on the first SIGINT (Spec §10, exit 130)', async () => {
    const plan = await planReplay(input(dir), cfg);
    const seen: ReplayProgress[] = [];
    let restore = installReplayHooks({ onProgress: (p) => seen.push(p) });
    const r = recorder();
    await replay(plan, r.engine);
    restore();
    expect(seen.map((p) => p.day)).toEqual(['2025-01-01', '2025-01-02', '2025-01-03']);   // one ≤ 1 M-row batch per day here
    expect(seen.at(-1)!.events).toBe(r.events.length);
    expect(seen.reduce((n, p) => n + p.batchEvents, 0)).toBe(r.events.length);

    const stopped = recorder();
    restore = installReplayHooks({ shouldStop: () => stopped.events.length > 0 });        // stop once the first batch is in
    await expect(replay(plan, stopped.engine)).rejects.toBeInstanceOf(RunInterrupted);
    restore();
    expect(stopped.events.length).toBe(plan.days[0]!.rows);
    expect(stopped.finished()).toBe(0);

    const after = recorder();                                                              // hooks restored: no stop, no progress
    await replay(plan, after.engine);
    expect(after.events.length).toBe(r.events.length);
  });

  it('no instrument history ⇒ DataIntegrityError; an empty span is refused', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'wsr-replay-'));
    roots.push(empty);
    await expect(planReplay(input(empty), cfg)).rejects.toThrow(DataIntegrityError);
    await expect(planReplay({ ...input(dir), from: { y: 2025, m: 1, d: 3 }, to: { y: 2025, m: 1, d: 2 } }, cfg)).rejects.toThrow(/empty/);
  });
});
