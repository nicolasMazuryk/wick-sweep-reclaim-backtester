import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRunConfig, VENUE_IDS } from '@wsr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { macroReleasesPath } from './blacklist-load.js';
import { buildManifest, writeRunOutputs } from './output.js';
import { CONCLUSION_ONLY_EXTREMUM, readReaction, type ReactionRun, runReactionTest, spanLabels } from './reaction-run.js';
import type { ReplayInput } from './replay.js';
import { writeSyntheticDataRoot } from './synthetic-data-root.js';

const VENUE = VENUE_IDS[0];
const fees = Object.fromEntries(VENUE_IDS.map((v) => [v, { TakerFee: 0.0005, MakerFee: 0.0002, verifiedAt: '2026-09-19' }]));
const cfg = parseRunConfig({ fees, data: { lowCapSymbol: 'SOLUSDT' } });
const B = 100;

let dir: string;
let input: ReplayInput;
let run: ReactionRun;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wsr-reaction-'));
  // 8 warm-up days + 4 span days of seeded walk with planted spikes and breakouts.
  await writeSyntheticDataRoot({ dataRoot: dir, venue: VENUE, symbol: 'ETHUSDT', from: { y: 2025, m: 1, d: 1 }, days: 12, seed: 1 });
  input = { dataRoot: dir, venue: VENUE, symbol: 'ETHUSDT', from: { y: 2025, m: 1, d: 9 }, to: { y: 2025, m: 1, d: 12 } };
  run = await runReactionTest(input, cfg, 1, { B });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const spanStart = Date.UTC(2025, 0, 9);

describe('runReactionTest on a stored data root (Spec §6.1)', () => {
  it('returns the Spec §6.1.5 result: four sets, ten deciles, three contrasts, monotone, gate', () => {
    const r = run.result;
    expect(Object.keys(r.sets).sort()).toEqual(['placebo', 'random', 'slow', 'wick']);
    expect(r.wickByDecile.map((d) => d.decile)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(Object.keys(r.contrasts)).toEqual(['1-4', '1-2', '1-3']);
    expect(r.span).toEqual({ from: spanStart, to: Date.UTC(2025, 0, 13) });
    expect([r.venue, r.symbol, r.seed, r.B]).toEqual([VENUE, 'ETHUSDT', 1, B]);
    expect(r.sets.wick.complete).toBeGreaterThan(50);
    expect(r.gate.pass).toBe(r.gate.reasons.length === 0);
    expect(r.conclusion12 === null || r.conclusion12 === CONCLUSION_ONLY_EXTREMUM).toBe(true);
    expect(r.reactionKey).toMatch(/^[0-9a-f]{64}$/);
    expect(run.warnings).toEqual(['[VERIFY] fees unverified']);             // warm-up ended before the span
    expect(run.counters.tickChanges).toBe(0);
  });

  it('property: L9 reactionSetIncludesInvalidated — set 1 = every in-span WickLevel of the PivotStore, INVALIDATED ones included', () => {
    const rows = run.engine.store.snapshot().filter((row) => row.cls === 'WickLevel');
    const inSpan = rows.filter((row) => row.classifiedAt >= spanStart);
    const set1 = run.observations.filter((o) => o.level.setId === 'wick').map((o) => o.level.srcPivotId);
    expect(set1).toEqual(inSpan.map((row) => row.pivot.pivotId));
    expect(rows.length).toBeGreaterThan(inSpan.length);                       // warm-up-span levels excluded
    const invalidatedRows = inSpan.filter((row) => row.finalState === 'INVALIDATED');
    expect(invalidatedRows.length).toBeGreaterThan(0);
    for (const row of invalidatedRows) expect(set1).toContain(row.pivot.pivotId);
  });

  it('property: L12 randomLevelCausal — every random level is drawn at/after spanStart and at/before its source approach', () => {
    const approachOf = new Map(run.observations.filter((o) => o.level.setId === 'wick').map((o) => [o.level.srcPivotId, o.approachT]));
    const random = run.observations.filter((o) => o.level.setId === 'random');
    expect(random.length).toBe(run.result.sets.wick.approached);
    for (const o of random) {
      expect(o.level.availableAt).toBeGreaterThanOrEqual(spanStart);
      expect(o.level.availableAt).toBeLessThanOrEqual(approachOf.get(o.level.srcPivotId)!);
    }
  });

  it('a blacklist interval over a spike ⇒ its pivot is Unresolved(blacklist) and in no set', async () => {
    const victim = run.engine.store.snapshot().find((row) => row.cls === 'WickLevel' && row.classifiedAt >= spanStart + 86_400_000)!;
    await mkdir(join(dir, 'meta'), { recursive: true });
    await writeFile(macroReleasesPath(dir), JSON.stringify([victim.pivot.confirmed_at]));
    const blocked = await runReactionTest(input, { ...cfg, blacklistMacroReleases: true }, 1, { B });
    const row = blocked.engine.store.snapshot().find((r) => r.pivot.pivotId === victim.pivot.pivotId)!;
    expect([row.cls, row.note]).toEqual(['Unresolved', 'blacklist']);
    expect(blocked.observations.some((o) => o.level.srcPivotId === victim.pivot.pivotId)).toBe(false);
    expect(blocked.plan.blacklist.intervals.some((i) => i.reason === 'macroRelease')).toBe(true);
    expect(blocked.result.blacklistedBuckets).toBeGreaterThan(run.result.blacklistedBuckets);
    expect(blocked.result.reactionKey).not.toBe(run.result.reactionKey);  // the variant is part of the config
  });

  it('same inputs ⇒ identical reaction.json bytes; readReaction round-trips the gate', async () => {
    const runs = await mkdtemp(join(tmpdir(), 'wsr-runs-'));
    try {
      const write = async (r: ReactionRun) => {
        const manifest = buildManifest({
          venue: VENUE, symbol: 'ETHUSDT', span: spanLabels(input), seed: 1, config: cfg, dataChecksums: r.plan.dataChecksums,
          feesVerifiedAt: r.plan.feesVerifiedAt, warnings: r.warnings, createdAt: '2026-09-19T00:00:00.000Z', gitCommit: 'test', wsrVersion: 'test',
        });
        return writeRunOutputs(runs, manifest, r.result);
      };
      const a = await write(run);
      const text = await readFile(a.reactionJson, 'utf8');
      const b = await write(await runReactionTest(input, cfg, 1, { B }));
      expect(await readFile(b.reactionJson, 'utf8')).toBe(text);
      const stored = await readReaction(a.runDir);
      expect(stored.gate).toEqual(run.result.gate);
      expect(stored.reactionKey).toBe(run.result.reactionKey);
      expect(stored.runManifest.dataChecksums).toHaveLength(12);
    } finally {
      await rm(runs, { recursive: true, force: true });
    }
  });
});
