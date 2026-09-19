import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Blacklist, type Ms, type RunConfig } from '@wsr/core';
import {
  dayEndMs, dayStartMs, mergeIntervals, type BlacklistInterval, type FundingRecord, type HygieneReport, type UtcDay,
} from '@wsr/data';

// §8.7 robustness variant: ±2 min around funding / macro-release timestamps.
export const VARIANT_PAD_MS = 120_000;

// Invalid run input that is the user's to fix (CLI exit code 1).
export class ReplayInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayInputError';
  }
}

export interface BlacklistSource {
  // Hygiene reports of the replayed days (Spec §2.6.2); closed [tStart, tEnd].
  readonly reports: ReadonlyArray<HygieneReport>;
  // Days not fed to the engine (missing partition, checksum failure): whole-day intervals (A-70).
  readonly excludedDays: ReadonlyArray<{ readonly day: UtcDay; readonly reason: string }>;
  readonly funding: ReadonlyArray<FundingRecord>;
  readonly macroReleases: ReadonlyArray<Ms> | null;
  // Replay span [start, end): variant intervals are kept only where they touch it.
  readonly start: Ms;
  readonly end: Ms;
}

export interface LoadedBlacklist {
  readonly blacklist: Blacklist;
  // Merged, sorted, half-open [tStart, tEnd) with joined reasons (report).
  readonly intervals: ReadonlyArray<BlacklistInterval>;
}

// Spec §2.6.3: union of every hygiene blacklist interval over the replay days,
// the whole-day intervals of excluded days and the optional §8.7 variants.
// Hygiene intervals are closed; the engine's are half-open, so tEnd + 1 ms (A-71).
export function buildBlacklist(src: BlacklistSource, cfg: Pick<RunConfig, 'blacklistFunding' | 'blacklistMacroReleases'>): LoadedBlacklist {
  const intervals: BlacklistInterval[] = [];
  for (const report of src.reports) {
    for (const i of report.blacklist) intervals.push({ tStart: i.tStart, tEnd: i.tEnd + 1, reason: i.reason });
  }
  for (const { day, reason } of src.excludedDays) intervals.push({ tStart: dayStartMs(day), tEnd: dayEndMs(day), reason });
  const around = (times: ReadonlyArray<Ms>, reason: string): void => {
    for (const t of times) {
      if (t + VARIANT_PAD_MS < src.start || t - VARIANT_PAD_MS >= src.end) continue;
      intervals.push({ tStart: t - VARIANT_PAD_MS, tEnd: t + VARIANT_PAD_MS + 1, reason });
    }
  };
  if (cfg.blacklistFunding) around(src.funding.map((r) => r.t), 'funding');
  if (cfg.blacklistMacroReleases) {
    if (src.macroReleases === null) throw new ReplayInputError('blacklistMacroReleases is on but meta/macro_releases.json is missing');
    around(src.macroReleases, 'macroRelease');
  }
  const merged = mergeIntervals(intervals);
  return { blacklist: new Blacklist(merged.flatMap((i) => [i.tStart, i.tEnd])), intervals: merged };
}

// {dataRoot}/meta/macro_releases.json (user-supplied, Spec §2.6.3): a JSON
// array of release instants, each epoch ms or an ISO-8601 string with an
// explicit offset. null when the file is absent.
export function macroReleasesPath(dataRoot: string): string {
  return join(dataRoot, 'meta', 'macro_releases.json');
}

export async function readMacroReleases(dataRoot: string): Promise<Ms[] | null> {
  const path = macroReleasesPath(dataRoot);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ReplayInputError(`${path}: ${(error as Error).message}`);
  }
  if (!Array.isArray(json)) throw new ReplayInputError(`${path}: expected a JSON array of timestamps`);
  return json.map((v: unknown) => {
    const t = typeof v === 'number' ? v : typeof v === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(v) ? Date.parse(v) : NaN;
    if (!Number.isInteger(t)) throw new ReplayInputError(`${path}: '${String(v)}' is not epoch ms or an ISO-8601 instant with offset`);
    return t;
  }).sort((a, b) => a - b);
}

