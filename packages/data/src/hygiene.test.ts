import { describe, expect, it } from 'vitest';
import { tradeColumnsFromRows, type TradeRowLike } from './columns.js';
import { dayStartMs, parseDay } from './days.js';
import {
  BAD_PRINT_PAD_MS,
  GAP_PAD_MS,
  computeHygiene,
  expectedFundingTimes,
  mergeIntervals,
  screenTrades,
  summarizeCoverage,
  ticksToPrice,
  type HygieneReport,
} from './hygiene.js';
import { mergeColumns } from './merge.js';
import type { FundingRecord, VenueId } from './venue.js';

const VENUE = 'testvenue' as VenueId;
const DAY = parseDay('2025-03-01');
const T0 = dayStartMs(DAY);
const H = 3_600_000;

// One print per second all day, alternating sides around 100 000 ticks.
function day(opts: { gap?: [number, number]; badAt?: number; duplicateAt?: number; backwardsAt?: number[] } = {}): TradeRowLike[] {
  const rows: TradeRowLike[] = [];
  let seq = 0;
  for (let sec = 0; sec < 86_400; sec += 1) {
    const t = T0 + sec * 1000;
    if (opts.gap !== undefined && t > opts.gap[0] && t < opts.gap[1]) {
      continue;
    }
    const p = opts.badAt === t ? 150_000 : 100_000 + (sec % 7);
    rows.push({ tradeId: String(seq), t, tNsRemainder: 0, seq, p, q: 1, s: sec % 2 === 0 ? 1 : -1 });
    seq += 1;
  }
  if (opts.duplicateAt !== undefined) {
    const original = rows[opts.duplicateAt]!;
    rows.splice(opts.duplicateAt + 1, 0, { ...original, seq: original.seq + 0.5 });
  }
  for (const i of opts.backwardsAt ?? []) {
    const row = rows[i]!;
    rows[i] = { ...row, t: row.t - 5000 };
  }
  return rows;
}

function report(rows: TradeRowLike[], extra: { funding?: FundingRecord[]; intervalHours?: number; tickChange?: { t: number; inferredTick: string } } = {}): HygieneReport {
  const cols = tradeColumnsFromRows(rows);
  const screen = screenTrades(cols, DAY, (i) => ticksToPrice(cols.p[i]!, '0.01'));
  const merged = mergeColumns(cols, screen.keep);
  return computeHygiene({
    venue: VENUE,
    symbol: 'ETHUSDT',
    day: DAY,
    rowsRaw: cols.length,
    screen,
    merged,
    feedKind: 'raw',
    tickChange: extra.tickChange,
    midnightSplit: false,
    funding: { records: extra.funding ?? [0, 8, 16].map((h) => ({ t: T0 + h * H, rate: 0.0001 })), intervalHours: extra.intervalHours ?? 8 },
  });
}

describe('screenTrades + computeHygiene on a planted day (Spec §2.6.1)', () => {
  const gapStart = T0 + 10 * H;
  const gapEnd = gapStart + 5 * 60_000;
  const badAt = T0 + 15 * H;
  const rows = day({ gap: [gapStart, gapEnd], badAt, duplicateAt: 1000 });
  // seq ids: the gap removes the 299 whole seconds strictly inside it.
  const result = report(rows, { tickChange: { t: T0 + 20 * H, inferredTick: '0.005' } });

  it('drops duplicate tradeIds beyond the first and lists them', () => {
    expect(result.duplicateTradeIds).toEqual({ count: 1, sample: ['1000'] });
    expect(result.rowsRaw).toBe(rows.length);
  });

  it('finds the 5-minute gap and blacklists it padded by GapPadMs', () => {
    expect(result.gaps.filter((g) => g.reason === 'gap')).toEqual([{ tStart: gapStart, tEnd: gapEnd, reason: 'gap' }]);
    expect(result.blacklist).toContainEqual({ tStart: gapStart, tEnd: gapEnd + GAP_PAD_MS, reason: 'gap' });
  });

  it('drops the bad print (> 20 × median 60-s range from both neighbours) and blacklists t ± 1 s', () => {
    expect(result.badPrints).toEqual({ count: 1, sample: [{ tradeId: String(15 * 3600 - 299), t: badAt, price: '1500' }] });
    expect(result.blacklist).toContainEqual({ tStart: badAt - BAD_PRINT_PAD_MS, tEnd: badAt + BAD_PRINT_PAD_MS, reason: 'badPrint' });
  });

  it('records the tick-size change as a flagged blacklist boundary', () => {
    expect(result.tickSizeChange).toEqual({ detected: true, inferredTick: '0.005' });
    expect(result.blacklist).toContainEqual({ tStart: T0 + 20 * H, tEnd: T0 + 20 * H + GAP_PAD_MS, reason: 'tickChange' });
  });

  it('merge stats count clean records only; nothing else flagged', () => {
    expect(result.mergeStats.maxN).toBe(1);
    expect(result.rowsMerged).toBe(rows.length - 2);
    expect(result.nonMonotoneTimestamps).toBe(0);
    expect(result.suspect).toBe(false);
    expect(result.fundingMissing).toEqual([]);
    expect(result.gaps.some((g) => g.reason === 'dayBoundary')).toBe(false);
    expect(result.blacklist).toHaveLength(3);
  });
});

describe('other checks', () => {
  it('nonMonotoneTimestamps above 0.1 % marks the partition suspect', () => {
    const few = report(day({ backwardsAt: [100, 200] }));
    expect(few.nonMonotoneTimestamps).toBe(2);
    expect(few.suspect).toBe(false);
    const many = report(day({ backwardsAt: Array.from({ length: 100 }, (_, i) => 10 + i * 700) }));
    expect(many.nonMonotoneTimestamps).toBe(100);
    expect(many.suspect).toBe(true);
  });

  it('dayBoundaryGap: late first / early last print', () => {
    const rows = day().filter((r) => r.t >= T0 + H && r.t < T0 + 23 * H);
    const result = report(rows);
    expect(result.gaps.filter((g) => g.reason === 'dayBoundary')).toEqual([
      { tStart: T0, tEnd: T0 + H, reason: 'dayBoundary' },
      { tStart: T0 + 23 * H - 1000, tEnd: T0 + 24 * H, reason: 'dayBoundary' },
    ]);
  });

  it('an empty day is one whole-day interval', () => {
    const result = report([]);
    expect(result.blacklist).toEqual([{ tStart: T0, tEnd: T0 + 24 * H + GAP_PAD_MS, reason: 'dayBoundary' }]);
  });

  it('non-positive price or size is a bad print', () => {
    const rows = day();
    rows[500] = { ...rows[500]!, q: 0 };
    rows[600] = { ...rows[600]!, p: -1 };
    expect(report(rows).badPrints.count).toBe(2);
  });

  it('fundingMissing lists expected settlements without a record', () => {
    const result = report(day(), { funding: [{ t: T0, rate: 0 }, { t: T0 + 16 * H + 1, rate: 0 }] });
    expect(result.fundingMissing).toEqual([T0 + 8 * H]);
    expect(report(day(), { funding: [] }).fundingMissing).toEqual([T0, T0 + 8 * H, T0 + 16 * H]);
  });

  it('expectedFundingTimes follows the venue phase (04/12/20 UTC)', () => {
    expect(expectedFundingTimes(DAY, [{ t: T0 - 4 * H, rate: 0 }], 8)).toEqual([T0 + 4 * H, T0 + 12 * H, T0 + 20 * H]);
  });
});

describe('mergeIntervals', () => {
  it('merges overlapping intervals and joins reasons', () => {
    expect(
      mergeIntervals([
        { tStart: 50, tEnd: 60, reason: 'badPrint' },
        { tStart: 0, tEnd: 10, reason: 'gap' },
        { tStart: 5, tEnd: 20, reason: 'badPrint' },
        { tStart: 20, tEnd: 30, reason: 'gap' },
      ]),
    ).toEqual([
      { tStart: 0, tEnd: 30, reason: 'badPrint+gap' },
      { tStart: 50, tEnd: 60, reason: 'badPrint' },
    ]);
  });
});

describe('summarizeCoverage', () => {
  it('counts requested / present / suspect days and blacklisted minutes', () => {
    const good = report(day({ gap: [T0 + 10 * H, T0 + 10 * H + 5 * 60_000] }));
    const rows = summarizeCoverage([
      { venue: VENUE, symbol: 'ETHUSDT', day: DAY, report: good },
      { venue: VENUE, symbol: 'ETHUSDT', day: parseDay('2025-03-02'), report: undefined },
    ]);
    expect(rows).toEqual([{ venue: VENUE, symbol: 'ETHUSDT', daysRequested: 2, daysPresent: 1, daysSuspect: 0, blacklistedMinutes: 6 }]);
  });
});
