import { readFile } from 'node:fs/promises';
import { FUNDING_MATCH_TOLERANCE_MS, fundingPhaseMs, type Ms, type Ticks } from '@wsr/core';
import { z } from 'zod';
import { sortedIndices, type TradeColumns } from './columns.js';
import { dayEndMs, dayStartMs, formatDay } from './days.js';
import { formatDecimal, multiplyDecimal, parseDecimal } from './decimal.js';
import { hygienePath } from './paths.js';
import { atomicWriteFile } from './storage.js';
import type { FundingRecord, UtcDay, VenueId } from './venue.js';

// Spec §2.6.1 constants.
export const GAP_MIN_THRESHOLD_MS = 60_000;
export const GAP_MEDIAN_MULT = 20;
export const GAP_PAD_MS = 60_000;
export const BAD_PRINT_MULT = 20;
export const BAD_PRINT_PAD_MS = 1_000;
export const NON_MONOTONE_SUSPECT_FRACTION = 0.001;
export const SAMPLE_LIMIT = 100;

export type HygieneIntervalReason = 'gap' | 'dayBoundary' | 'badPrint' | 'tickChange' | 'checksum';

export interface HygieneInterval {
  readonly tStart: Ms;
  readonly tEnd: Ms;
  readonly reason: HygieneIntervalReason;
}

export interface BlacklistInterval {
  readonly tStart: Ms;
  readonly tEnd: Ms;
  readonly reason: string;
}

// Spec §2.6.2.
export interface HygieneReport {
  readonly schemaVersion: 1;
  readonly venue: VenueId;
  readonly symbol: string;
  readonly day: string;
  readonly rowsRaw: number;
  readonly rowsMerged: number;
  readonly duplicateTradeIds: { readonly count: number; readonly sample: readonly string[] };
  readonly nonMonotoneTimestamps: number;
  readonly gaps: readonly HygieneInterval[];
  readonly tickSizeChange: { readonly detected: boolean; readonly inferredTick?: string };
  readonly badPrints: { readonly count: number; readonly sample: ReadonlyArray<{ tradeId: string; t: Ms; price: string }> };
  readonly aggregatedFeed: boolean;
  readonly mergeStats: { readonly meanN: number; readonly maxN: number };
  readonly midnightSplit: boolean;
  readonly fundingMissing: readonly Ms[];
  readonly checksumFailed: boolean;
  readonly suspect: boolean;
  readonly blacklist: readonly BlacklistInterval[];
}

export interface ScreenResult {
  // 1 = record goes into the merge (Spec §2.4); duplicates and bad prints 0.
  readonly keep: Uint8Array;
  readonly duplicateTradeIds: HygieneReport['duplicateTradeIds'];
  readonly nonMonotoneTimestamps: number;
  readonly badPrints: HygieneReport['badPrints'];
  readonly badPrintTimes: readonly Ms[];
}

// Mean of the two middles for even n (A-49). Sorts in place.
function median(values: Float64Array | number[]): number {
  if (values.length === 0) {
    return 0;
  }
  if (Array.isArray(values)) {
    values.sort((a, b) => a - b);
  } else {
    values.sort();
  }
  const mid = values.length >> 1;
  return values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

// VolUnit_dayProxy (Spec §2.6.1): median over the day's non-empty 60-s
// windows of (max p − min p), in ticks. `order` is time-ascending.
function medianMinuteRange(cols: TradeColumns, order: Uint32Array, dayStart: Ms): number {
  const ranges: number[] = [];
  let minute = Number.NaN;
  let lo = 0;
  let hi = 0;
  for (const i of order) {
    const m = Math.floor((cols.t[i]! - dayStart) / 60_000);
    const price = cols.p[i]!;
    if (m !== minute) {
      if (!Number.isNaN(minute)) {
        ranges.push(hi - lo);
      }
      minute = m;
      lo = price;
      hi = price;
    } else {
      lo = Math.min(lo, price);
      hi = Math.max(hi, price);
    }
  }
  if (!Number.isNaN(minute)) {
    ranges.push(hi - lo);
  }
  return median(ranges);
}

// Spec §2.6.1 pre-merge checks on one partition's raw records (delivery
// order): duplicateTradeIds (dropped beyond the first), nonMonotoneTimestamps,
// badPrints (price ≤ 0, size ≤ 0, or > BadPrintMult × VolUnit_dayProxy from
// both time-ordered neighbours; dropped). `priceOf(i)` renders record i's
// price for samples.
export function screenTrades(cols: TradeColumns, day: UtcDay, priceOf: (i: number) => string): ScreenResult {
  const n = cols.length;
  let nonMonotone = 0;
  for (let i = 1; i < n; i += 1) {
    if (cols.t[i]! < cols.t[i - 1]!) {
      nonMonotone += 1;
    }
  }

  const keep = new Uint8Array(n);
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (let i = 0; i < n; i += 1) {
    const id = cols.tradeId[i]!;
    if (seen.has(id)) {
      duplicated.add(id);
    } else {
      seen.add(id);
      keep[i] = 1;
    }
  }
  seen.clear();

  const bad = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    if (keep[i] === 1 && (cols.p[i]! <= 0 || cols.q[i]! <= 0)) {
      bad[i] = 1;
      keep[i] = 0;
    }
  }
  const order = sortedIndices(cols, keep);
  const threshold = BAD_PRINT_MULT * Math.max(1, medianMinuteRange(cols, order, dayStartMs(day)));
  if (order.length > 1) {
    for (let k = 0; k < order.length; k += 1) {
      const i = order[k]!;
      const price = cols.p[i]!;
      const farFromPrev = k === 0 || Math.abs(price - cols.p[order[k - 1]!]!) > threshold;
      const farFromNext = k === order.length - 1 || Math.abs(price - cols.p[order[k + 1]!]!) > threshold;
      if (farFromPrev && farFromNext) {
        bad[i] = 1;
      }
    }
  }

  const sample: Array<{ tradeId: string; t: Ms; price: string }> = [];
  const badPrintTimes: Ms[] = [];
  for (let i = 0; i < n; i += 1) {
    if (bad[i] === 1) {
      keep[i] = 0;
      badPrintTimes.push(cols.t[i]!);
      if (sample.length < SAMPLE_LIMIT) {
        sample.push({ tradeId: cols.tradeId[i]!, t: cols.t[i]!, price: priceOf(i) });
      }
    }
  }
  const duplicatedIds = [...duplicated];
  return {
    keep,
    duplicateTradeIds: { count: duplicatedIds.length, sample: duplicatedIds.slice(0, SAMPLE_LIMIT) },
    nonMonotoneTimestamps: nonMonotone,
    badPrints: { count: badPrintTimes.length, sample },
    badPrintTimes,
  };
}

// Price of p ticks as a decimal string.
export function ticksToPrice(p: Ticks, tickDecimal: string): string {
  return formatDecimal(multiplyDecimal({ units: BigInt(p), scale: 0 }, parseDecimal(tickDecimal)));
}

// The merged-day columns the report reads (time-ascending).
export interface MergedSummary {
  readonly length: number;
  readonly t: Float64Array;
  readonly n: Int32Array;
}

export interface HygieneInput {
  readonly venue: VenueId;
  readonly symbol: string;
  readonly day: UtcDay;
  readonly rowsRaw: number;
  readonly screen: Omit<ScreenResult, 'keep'>;
  readonly merged: MergedSummary;
  readonly feedKind: 'raw' | 'aggregated';
  readonly tickChange?: { readonly t: Ms; readonly inferredTick: string } | undefined;
  readonly midnightSplit: boolean;
  readonly funding: { readonly records: readonly FundingRecord[]; readonly intervalHours: number };
  readonly checksumFailed?: boolean;
}

// Expected settlements of the day on the venue's funding grid; the grid phase
// comes from the funding record nearest the day (KuCoin settles at 04/12/20
// UTC), 00:00 UTC when there is none.
export function expectedFundingTimes(day: UtcDay, records: readonly FundingRecord[], intervalHours: number): Ms[] {
  const interval = intervalHours * 3_600_000;
  const start = dayStartMs(day);
  const phase = ((fundingPhaseMs(records, start, interval) - (start % interval)) % interval + interval) % interval;
  const times: Ms[] = [];
  for (let t = start + phase; t < dayEndMs(day); t += interval) {
    times.push(t);
  }
  return times;
}

function missingFunding(day: UtcDay, records: readonly FundingRecord[], intervalHours: number): Ms[] {
  const start = dayStartMs(day) - FUNDING_MATCH_TOLERANCE_MS;
  const end = dayEndMs(day) + FUNDING_MATCH_TOLERANCE_MS;
  const nearby = records.filter((r) => r.t >= start - intervalHours * 3_600_000 && r.t < end + intervalHours * 3_600_000);
  return expectedFundingTimes(day, nearby.length > 0 ? nearby : records, intervalHours).filter(
    (expected) => !nearby.some((r) => Math.abs(r.t - expected) <= FUNDING_MATCH_TOLERANCE_MS),
  );
}

// Sorted union of intervals; overlapping/touching ones merge and join reasons.
export function mergeIntervals(intervals: readonly BlacklistInterval[]): BlacklistInterval[] {
  const sorted = [...intervals].sort((a, b) => a.tStart - b.tStart || a.tEnd - b.tEnd);
  const out: Array<{ tStart: Ms; tEnd: Ms; reasons: Set<string> }> = [];
  for (const interval of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && interval.tStart <= last.tEnd) {
      last.tEnd = Math.max(last.tEnd, interval.tEnd);
      interval.reason.split('+').forEach((r) => last.reasons.add(r));
    } else {
      out.push({ tStart: interval.tStart, tEnd: interval.tEnd, reasons: new Set(interval.reason.split('+')) });
    }
  }
  return out.map((i) => ({ tStart: i.tStart, tEnd: i.tEnd, reason: [...i.reasons].sort().join('+') }));
}

function padded(interval: HygieneInterval): BlacklistInterval {
  switch (interval.reason) {
    case 'gap':
    case 'dayBoundary':
    case 'tickChange':
      return { tStart: interval.tStart, tEnd: interval.tEnd + GAP_PAD_MS, reason: interval.reason };
    default:
      return interval;
  }
}

// Spec §2.6.1/§2.6.2 report for one partition.
export function computeHygiene(input: HygieneInput): HygieneReport {
  const start = dayStartMs(input.day);
  const end = dayEndMs(input.day);
  const intervals: HygieneInterval[] = [];
  const times = input.merged.t;

  if (input.checksumFailed === true || times.length === 0) {
    intervals.push({ tStart: start, tEnd: end, reason: input.checksumFailed === true ? 'checksum' : 'dayBoundary' });
  } else {
    const diffs = new Float64Array(times.length - 1);
    for (let i = 1; i < times.length; i += 1) {
      diffs[i - 1] = times[i]! - times[i - 1]!;
    }
    const threshold = Math.max(GAP_MIN_THRESHOLD_MS, GAP_MEDIAN_MULT * median(diffs));
    for (let i = 1; i < times.length; i += 1) {
      if (times[i]! - times[i - 1]! > threshold) {
        intervals.push({ tStart: times[i - 1]!, tEnd: times[i]!, reason: 'gap' });
      }
    }
    if (times[0]! > start + threshold) {
      intervals.push({ tStart: start, tEnd: times[0]!, reason: 'dayBoundary' });
    }
    if (times[times.length - 1]! < end - threshold) {
      intervals.push({ tStart: times[times.length - 1]!, tEnd: end, reason: 'dayBoundary' });
    }
  }
  for (const t of input.screen.badPrintTimes) {
    intervals.push({ tStart: t - BAD_PRINT_PAD_MS, tEnd: t + BAD_PRINT_PAD_MS, reason: 'badPrint' });
  }
  if (input.tickChange !== undefined) {
    intervals.push({ tStart: input.tickChange.t, tEnd: input.tickChange.t, reason: 'tickChange' });
  }
  intervals.sort((a, b) => a.tStart - b.tStart || a.tEnd - b.tEnd);

  let sumN = 0;
  let maxN = 0;
  for (const n of input.merged.n) {
    sumN += n;
    maxN = Math.max(maxN, n);
  }
  const checksumFailed = input.checksumFailed === true;
  return {
    schemaVersion: 1,
    venue: input.venue,
    symbol: input.symbol,
    day: formatDay(input.day),
    rowsRaw: input.rowsRaw,
    rowsMerged: input.merged.length,
    duplicateTradeIds: input.screen.duplicateTradeIds,
    nonMonotoneTimestamps: input.screen.nonMonotoneTimestamps,
    gaps: intervals,
    tickSizeChange: input.tickChange === undefined ? { detected: false } : { detected: true, inferredTick: input.tickChange.inferredTick },
    badPrints: input.screen.badPrints,
    aggregatedFeed: input.feedKind === 'aggregated',
    mergeStats: { meanN: input.merged.length === 0 ? 0 : sumN / input.merged.length, maxN },
    midnightSplit: input.midnightSplit,
    fundingMissing: missingFunding(input.day, input.funding.records, input.funding.intervalHours),
    checksumFailed,
    suspect: checksumFailed || input.screen.nonMonotoneTimestamps > NON_MONOTONE_SUSPECT_FRACTION * input.rowsRaw,
    blacklist: mergeIntervals(intervals.map(padded)),
  };
}

const EMPTY_SCREEN: HygieneInput['screen'] = {
  duplicateTradeIds: { count: 0, sample: [] },
  nonMonotoneTimestamps: 0,
  badPrints: { count: 0, sample: [] },
  badPrintTimes: [],
};

// Report for a partition that failed checksum verification (Spec §2.5):
// excluded from replay by a whole-day blacklist interval.
export function checksumFailedHygiene(venue: VenueId, symbol: string, day: UtcDay, feedKind: 'raw' | 'aggregated'): HygieneReport {
  return computeHygiene({
    venue,
    symbol,
    day,
    rowsRaw: 0,
    screen: EMPTY_SCREEN,
    merged: { length: 0, t: new Float64Array(0), n: new Int32Array(0) },
    feedKind,
    midnightSplit: false,
    funding: { records: [], intervalHours: 24 },
    checksumFailed: true,
  });
}

const HygieneReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    venue: z.string(),
    symbol: z.string(),
    day: z.string(),
    rowsRaw: z.number(),
    rowsMerged: z.number(),
    duplicateTradeIds: z.object({ count: z.number(), sample: z.array(z.string()) }),
    nonMonotoneTimestamps: z.number(),
    gaps: z.array(z.object({ tStart: z.number(), tEnd: z.number(), reason: z.string() })),
    tickSizeChange: z.object({ detected: z.boolean(), inferredTick: z.string().optional() }),
    badPrints: z.object({ count: z.number(), sample: z.array(z.object({ tradeId: z.string(), t: z.number(), price: z.string() })) }),
    aggregatedFeed: z.boolean(),
    mergeStats: z.object({ meanN: z.number(), maxN: z.number() }),
    midnightSplit: z.boolean(),
    fundingMissing: z.array(z.number()),
    checksumFailed: z.boolean(),
    suspect: z.boolean(),
    blacklist: z.array(z.object({ tStart: z.number(), tEnd: z.number(), reason: z.string() })),
  })
  .strict();

export async function writeHygiene(dataRoot: string, day: UtcDay, report: HygieneReport): Promise<string> {
  const path = hygienePath(dataRoot, report.venue, report.symbol, day);
  await atomicWriteFile(path, Buffer.from(`${JSON.stringify(report, null, 2)}\n`));
  return path;
}

export async function readHygiene(dataRoot: string, venue: VenueId, symbol: string, day: UtcDay): Promise<HygieneReport | undefined> {
  try {
    const text = await readFile(hygienePath(dataRoot, venue, symbol, day), 'utf8');
    return HygieneReportSchema.parse(JSON.parse(text)) as HygieneReport;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export interface CoverageRow {
  readonly venue: VenueId;
  readonly symbol: string;
  readonly daysRequested: number;
  readonly daysPresent: number;
  readonly daysSuspect: number;
  readonly blacklistedMinutes: number;
}

// `wsr data hygiene --summary` table (Spec §2.7): days requested / present /
// suspect / blacklisted-minutes per (venue, symbol).
export function summarizeCoverage(requested: ReadonlyArray<{ readonly venue: VenueId; readonly symbol: string; readonly day: UtcDay; readonly report: HygieneReport | undefined }>): CoverageRow[] {
  const rows = new Map<string, { venue: VenueId; symbol: string; daysRequested: number; daysPresent: number; daysSuspect: number; blacklistedMs: number }>();
  for (const entry of requested) {
    const key = `${entry.venue}/${entry.symbol}`;
    let row = rows.get(key);
    if (row === undefined) {
      row = { venue: entry.venue, symbol: entry.symbol, daysRequested: 0, daysPresent: 0, daysSuspect: 0, blacklistedMs: 0 };
      rows.set(key, row);
    }
    row.daysRequested += 1;
    const report = entry.report;
    if (report === undefined || report.checksumFailed) {
      continue;
    }
    row.daysPresent += 1;
    row.daysSuspect += report.suspect ? 1 : 0;
    const start = dayStartMs(entry.day);
    const end = dayEndMs(entry.day);
    for (const interval of report.blacklist) {
      row.blacklistedMs += Math.max(0, Math.min(end, interval.tEnd) - Math.max(start, interval.tStart));
    }
  }
  return [...rows.values()].map(({ blacklistedMs, ...row }) => ({ ...row, blacklistedMinutes: Math.round(blacklistedMs / 60_000) }));
}
