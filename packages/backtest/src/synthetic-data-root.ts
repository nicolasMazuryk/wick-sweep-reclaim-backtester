import type { Side, VenueId } from '@wsr/core';
import {
  addDays, computeHygiene, createMetaHistory, dayEndMs, dayStartMs, eachDay, type FundingRecord, type TradeColumns, type UtcDay,
  writeFunding, writeHygiene, writeInstrumentHistory, writePartitionColumns,
} from '@wsr/data';
import { rngStream } from './rng.js';

export interface SyntheticDataRootOptions {
  readonly dataRoot: string;
  readonly venue: VenueId;
  readonly symbol: string;
  readonly from: UtcDay;                    // first day written
  readonly days: number;
  readonly seed: number;
  // Prints removed over [start, end) (a hygiene gap), e.g. one span-day outage.
  readonly gaps?: ReadonlyArray<{ readonly start: number; readonly end: number }>;
  // Days written without partition (missing-day handling).
  readonly skipDays?: ReadonlyArray<UtcDay>;
  // Tick size (quote units) from `validFrom` on; prices are rescaled at that instant.
  readonly tickChange?: { readonly validFrom: number; readonly Tick: number; readonly TickDecimal: string };
  // Every stored size multiplied by this (numeric-domain tests); default 1.
  readonly qScale?: number;
  // Walk origin in ticks; default P0. The e2e recorded-day fixture derives it
  // from the recorded day's own first merged price (A-150).
  readonly origin?: number;
  // Baseline wall-clock distance between prints; default DT_MS.
  readonly printIntervalMs?: number;
  // Leave instrument history and funding alone (they are already written, e.g.
  // the recorded meta of the A-150 fixture); default false.
  readonly keepMeta?: boolean;
  // Funding settlements the hygiene reports are checked against; default the
  // generated 8-hourly grid. With `keepMeta` these are the stored records.
  readonly funding?: ReadonlyArray<FundingRecord>;
}

const DT_MS = 5_000;                        // baseline: one print per 5 s
const SPIKE_DT_MS = 500;
const P0 = 300_000;                         // 3000.00 at Tick 0.01
const SPIKE_PROB = 1 / 300;                 // ≈ every 25 min
const SPIKE_STEPS = 4;
const SPIKE_STEP_TICKS = 5;
const REJECT_STEP_TICKS = 4;               // 80 % retrace
const BREAKOUT_PROB = 0.35;
const BREAKOUT_DELAY = 60;                  // prints after the spike
const FUNDING_INTERVAL_HOURS = 8;
const FIXED_FETCHED_AT = '2025-01-01T00:00:00.000Z';

interface Print { t: number; p: number; q: number; s: Side }

// Seeded trade path: a ±1-tick walk whose aggressor side follows the move
// with probability 0.7, plus planted fast spikes (SPIKE_STEPS prints of
// SPIKE_STEP_TICKS against Side, then an 80 % rejection by the opposite
// aggressor) — a share of them broken out BREAKOUT_DELAY prints later.
function* syntheticPath(seed: number, start: number, end: number, origin: number, dt: number): Generator<Print> {
  const rng = rngStream(seed, 'syntheticDataRoot');
  let p = origin;
  let t = start + dt;
  const pending: Print[] = [];              // scripted prints ahead of the walk
  let breakoutAt = -1;
  let breakoutLevel = 0;
  let breakoutSide: Side = 1;
  let i = 0;
  const size = (): number => 1 + Math.floor(rng.nextFloat() * 20);
  while (t < end) {
    const scripted = pending.shift();
    if (scripted !== undefined) {
      p = scripted.p;
      yield { ...scripted, t };
      t += Math.min(SPIKE_DT_MS, dt);
      continue;
    }
    i++;
    if (i === breakoutAt) {
      // Walk through the spike extreme by 20 ticks in 5 fast prints.
      const step = Math.ceil((breakoutSide * (breakoutLevel - p) + 20) / 5);
      for (let k = 1; k <= 5; k++) pending.push({ t: 0, p: p + breakoutSide * step * k, q: 20, s: breakoutSide });
      breakoutAt = -1;
      continue;
    }
    if (breakoutAt < 0 && rng.nextFloat() < SPIKE_PROB) {
      const side: Side = rng.nextFloat() < 0.5 ? 1 : -1;
      const top = p + side * SPIKE_STEPS * SPIKE_STEP_TICKS;
      for (let k = 1; k <= SPIKE_STEPS; k++) pending.push({ t: 0, p: p + side * SPIKE_STEP_TICKS * k, q: 30, s: side });
      for (let k = 1; k <= SPIKE_STEPS; k++) pending.push({ t: 0, p: top - side * REJECT_STEP_TICKS * k, q: 30, s: (-side) as Side });
      if (rng.nextFloat() < BREAKOUT_PROB) {
        breakoutAt = i + BREAKOUT_DELAY;
        breakoutLevel = top;
        breakoutSide = side;
      }
      continue;
    }
    const up = rng.nextFloat() < 0.5;
    p += up ? 1 : -1;
    const s: Side = (rng.nextFloat() < 0.7) === up ? 1 : -1;
    yield { t, p, q: size(), s };
    t += dt;
  }
}

// Writes a complete Spec §2.5 data root for one (venue, symbol): merged + raw
// partitions with `.done`, hygiene reports, instrument history (fees
// unverified) and 8-hourly funding. Deterministic in `seed`.
export async function writeSyntheticDataRoot(o: SyntheticDataRootOptions): Promise<void> {
  const days = eachDay(o.from, addDays(o.from, o.days - 1));
  const start = dayStartMs(o.from);
  const end = dayEndMs(days[days.length - 1]!);
  const base = {
    venue: o.venue, symbol: o.symbol, venueSymbol: o.symbol, Tick: 0.01, TickDecimal: '0.01', LotSize: 0.001, LotSizeDecimal: '0.001',
    contractMultiplier: 1, contractMultiplierDecimal: '1', TakerFee: 0.0005, MakerFee: 0.0002, feesVerifiedAt: null,
    fundingIntervalHours: FUNDING_INTERVAL_HOURS, validFrom: start,
  };
  const records = [base];
  if (o.tickChange !== undefined) records.push({ ...base, Tick: o.tickChange.Tick, TickDecimal: o.tickChange.TickDecimal, validFrom: o.tickChange.validFrom });
  const generated: FundingRecord[] = [];
  for (let t = start; t < end; t += FUNDING_INTERVAL_HOURS * 3_600_000) generated.push({ t, rate: 0.0001 });
  const funding = o.funding ?? generated;
  if (o.keepMeta !== true) {
    await writeInstrumentHistory(o.dataRoot, o.venue, o.symbol, createMetaHistory(records));
    await writeFunding(o.dataRoot, o.venue, o.symbol, generated);
  }

  const scale = o.tickChange === undefined ? 1 : Math.round(o.tickChange.Tick / base.Tick);
  const byDay = new Map<number, Print[]>(days.map((d) => [dayStartMs(d), []]));
  for (const pr of syntheticPath(o.seed, start, end, o.origin ?? P0, o.printIntervalMs ?? DT_MS)) {
    if (o.gaps?.some((g) => pr.t >= g.start && pr.t < g.end)) continue;
    const coarse = o.tickChange !== undefined && pr.t >= o.tickChange.validFrom;
    byDay.get(pr.t - (pr.t % 86_400_000))!.push(coarse ? { ...pr, p: Math.round(pr.p / scale) } : pr);
  }
  const skip = new Set((o.skipDays ?? []).map(dayStartMs));
  for (const day of days) {
    if (skip.has(dayStartMs(day))) continue;
    const prints = byDay.get(dayStartMs(day))!;
    const n = prints.length;
    const raw: TradeColumns = {
      length: n,
      tradeId: prints.map((_, k) => `${dayStartMs(day) / 1000}-${k}`),
      t: Float64Array.from(prints, (x) => x.t),
      tNsRemainder: new Int32Array(n),
      seq: Float64Array.from(prints, (_, k) => k),
      p: Float64Array.from(prints, (x) => x.p),
      q: Float64Array.from(prints, (x) => x.q * (o.qScale ?? 1)),
      s: Int8Array.from(prints, (x) => x.s),
    };
    await writePartitionColumns({
      dataRoot: o.dataRoot, venue: o.venue, symbol: o.symbol, day, raw, source: 'archive', checksumVerified: false,
      adapterVersion: 'synthetic-1', fetchedAt: FIXED_FETCHED_AT,
      beforeMarker: async (merged) => {
        const report = computeHygiene({
          venue: o.venue, symbol: o.symbol, day, rowsRaw: n,
          screen: { duplicateTradeIds: { count: 0, sample: [] }, nonMonotoneTimestamps: 0, badPrints: { count: 0, sample: [] }, badPrintTimes: [] },
          merged, feedKind: 'raw', midnightSplit: false, funding: { records: [...funding], intervalHours: FUNDING_INTERVAL_HOURS },
        });
        await writeHygiene(o.dataRoot, day, report);
      },
    });
  }
}
