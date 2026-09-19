import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HygieneReport } from '@wsr/data';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBlacklist, macroReleasesPath, readMacroReleases, ReplayInputError, VARIANT_PAD_MS } from './blacklist-load.js';

const DAY0 = Date.UTC(2025, 0, 1);
const H = 3_600_000;
const OFF = { blacklistFunding: false, blacklistMacroReleases: false };

function report(blacklist: HygieneReport['blacklist']): HygieneReport {
  return { blacklist } as HygieneReport;
}

const base = { reports: [], excludedDays: [], funding: [], macroReleases: null, start: DAY0, end: DAY0 + 48 * H };

describe('buildBlacklist (Spec §2.6.3)', () => {
  it('closed hygiene intervals become half-open [tStart, tEnd + 1) and are merged across days (A-71)', () => {
    const { blacklist, intervals } = buildBlacklist({
      ...base,
      reports: [
        report([{ tStart: DAY0 + H, tEnd: DAY0 + 2 * H, reason: 'gap' }]),
        report([{ tStart: DAY0 + 2 * H + 1, tEnd: DAY0 + 3 * H, reason: 'badPrint' }, { tStart: DAY0 + 30 * H, tEnd: DAY0 + 30 * H, reason: 'tickChange' }]),
      ],
    }, OFF);
    expect(intervals).toEqual([
      { tStart: DAY0 + H, tEnd: DAY0 + 3 * H + 1, reason: 'badPrint+gap' },
      { tStart: DAY0 + 30 * H, tEnd: DAY0 + 30 * H + 1, reason: 'tickChange' },
    ]);
    expect(blacklist.intervals()).toEqual(intervals.map((i) => [i.tStart, i.tEnd]));
    expect(blacklist.overlaps(DAY0 + 2 * H, DAY0 + 2 * H)).toBe(true);        // the closed end is inside
    expect(blacklist.overlaps(DAY0 + 30 * H, DAY0 + 30 * H)).toBe(true);      // a point interval survives
    expect(blacklist.overlaps(DAY0 + 3 * H + 1, DAY0 + 3 * H + 1)).toBe(false);
  });

  it('a missing / checksum-failed day is one whole-day interval (A-70)', () => {
    const { intervals } = buildBlacklist({ ...base, excludedDays: [{ day: { y: 2025, m: 1, d: 2 }, reason: 'missingPartition' }] }, OFF);
    expect(intervals).toEqual([{ tStart: DAY0 + 24 * H, tEnd: DAY0 + 48 * H, reason: 'missingPartition' }]);
  });

  it('blacklistFunding adds ±2 min around each funding timestamp in the span (§8.7)', () => {
    const funding = [-8, 0, 8, 16, 56].map((h) => ({ t: DAY0 + h * H, rate: 0.0001 }));
    expect(buildBlacklist({ ...base, funding }, OFF).intervals).toEqual([]);
    const { intervals } = buildBlacklist({ ...base, funding }, { ...OFF, blacklistFunding: true });
    expect(intervals).toEqual([0, 8, 16].map((h) => ({ tStart: DAY0 + h * H - VARIANT_PAD_MS, tEnd: DAY0 + h * H + VARIANT_PAD_MS + 1, reason: 'funding' })));
  });

  it('blacklistMacroReleases adds ±2 min around each release; the file is required when the flag is on', () => {
    const t = DAY0 + 13.5 * H;
    const { intervals } = buildBlacklist({ ...base, macroReleases: [t] }, { ...OFF, blacklistMacroReleases: true });
    expect(intervals).toEqual([{ tStart: t - VARIANT_PAD_MS, tEnd: t + VARIANT_PAD_MS + 1, reason: 'macroRelease' }]);
    expect(() => buildBlacklist(base, { ...OFF, blacklistMacroReleases: true })).toThrow(ReplayInputError);
  });
});

describe('readMacroReleases', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wsr-macro-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('absent → null; epoch ms and ISO instants with offset, sorted', async () => {
    expect(await readMacroReleases(dir)).toBeNull();
    await mkdir(join(dir, 'meta'), { recursive: true });
    await writeFile(macroReleasesPath(dir), JSON.stringify(['2025-01-01T13:30:00Z', DAY0 + H, '2025-01-01T08:30:00-05:00']));
    expect(await readMacroReleases(dir)).toEqual([DAY0 + H, DAY0 + 13.5 * H, DAY0 + 13.5 * H]);
  });

  it.each([['{}'], ['["2025-01-01T13:30:00"]'], ['[1.5]'], ['not json']])('rejects %s', async (text) => {
    await mkdir(join(dir, 'meta'), { recursive: true });
    await writeFile(macroReleasesPath(dir), text);
    await expect(readMacroReleases(dir)).rejects.toThrow(ReplayInputError);
  });
});
