import { canonicalDecimal, decimalToNumber, multiplyDecimal, parseDecimal, formatDecimal } from '../decimal.js';
import { isHeaderLine } from '../archive-read.js';
import type { InstrumentMeta, RateLimit, VenueId } from '../venue.js';
import { MissingAggressorField } from '../venue.js';

// Shared helpers for the venue definitions in this directory.

export interface Columns {
  // The first row was a header (and must be skipped).
  readonly header: boolean;
  readonly index: ReadonlyMap<string, number>;
}

// Resolves column positions from the first CSV row. Venues whose archives
// may lack a header row (Binance, early Bybit, Gate) pass `defaults`; a
// headerless row with fewer fields cannot identify its side column.
export function resolveColumns(venue: VenueId, firstRow: readonly string[], defaults: readonly string[] | undefined, required: readonly string[], sideColumn: string): Columns {
  const header = isHeaderLine(firstRow);
  let names: readonly string[];
  if (header) {
    names = firstRow.map((name) => name.trim());
  } else if (defaults !== undefined && firstRow.length >= defaults.length) {
    names = defaults;
  } else {
    throw new MissingAggressorField(venue, `headerless row with ${firstRow.length} fields, expected ${defaults?.length ?? 'a header'}`);
  }
  const index = new Map(names.map((name, i) => [name, i] as const));
  if (!index.has(sideColumn)) {
    throw new MissingAggressorField(venue, `no '${sideColumn}' column in [${names.join(',')}]`);
  }
  for (const name of required) {
    if (!index.has(name)) {
      throw new Error(`${venue}: archive has no '${name}' column in [${names.join(',')}]`);
    }
  }
  return { header, index };
}

export function col(columns: Columns, name: string): number {
  return columns.index.get(name)!;
}

export function field(fields: readonly string[], i: number): string {
  return fields[i]?.trim() ?? '';
}

// 'buy'/'Buy' → +1, 'sell'/'Sell' → −1 (taker side, Spec §2.2).
export function takerSide(venue: VenueId, text: string): 1 | -1 {
  const lower = text.toLowerCase();
  if (lower === 'buy') {
    return 1;
  }
  if (lower === 'sell') {
    return -1;
  }
  throw new MissingAggressorField(venue, `unrecognised side '${text}'`);
}

export function bps(value: number): number {
  return value / 10_000;
}

// Base-tier (VIP 0 / regular) USDT-perpetual fees, as supplied by the user
// on this date from each venue's fee schedule.
export const FEES_VERIFIED_AT = '2026-09-19';

export interface MetaInput {
  readonly venue: VenueId;
  readonly symbol: string;
  readonly venueSymbol: string;
  readonly tickText: string;
  // Lot in archive units (contracts or base asset).
  readonly lotInArchiveUnits: string;
  // Base units per archive unit.
  readonly contractMultiplier: string;
  readonly takerFeeBps: number;
  readonly makerFeeBps: number;
  // undefined: the venue did not report it → 8 h placeholder [VERIFY].
  readonly fundingIntervalHours: number | undefined;
}

export const DEFAULT_FUNDING_INTERVAL_HOURS = 8;

export function buildMeta(input: MetaInput): InstrumentMeta {
  const priceStep = parseDecimal(input.tickText);
  const multiplier = parseDecimal(input.contractMultiplier);
  const lot = multiplyDecimal(parseDecimal(input.lotInArchiveUnits), multiplier);
  return {
    venue: input.venue,
    symbol: input.symbol,
    venueSymbol: input.venueSymbol,
    Tick: decimalToNumber(priceStep),
    TickDecimal: formatDecimal(priceStep),
    LotSize: decimalToNumber(lot),
    LotSizeDecimal: formatDecimal(lot),
    contractMultiplier: decimalToNumber(multiplier),
    contractMultiplierDecimal: formatDecimal(multiplier),
    TakerFee: bps(input.takerFeeBps),
    MakerFee: bps(input.makerFeeBps),
    feesVerifiedAt: FEES_VERIFIED_AT,
    fundingIntervalHours: input.fundingIntervalHours ?? DEFAULT_FUNDING_INTERVAL_HOURS,
    validFrom: 0,
    ...(input.fundingIntervalHours === undefined ? { unverified: ['fundingIntervalHours' as const] } : {}),
  };
}

// JSON numbers (KuCoin) → canonical decimal string.
export function decimalText(value: string | number): string {
  return canonicalDecimal(typeof value === 'number' ? String(value) : value);
}

export function baseAsset(symbol: string): string {
  if (!symbol.endsWith('USDT') || symbol.length <= 4) {
    throw new Error(`canonical symbol must be <BASE>USDT, got '${symbol}'`);
  }
  return symbol.slice(0, -4);
}

export function rateLimit(requestsPerSecond: number, concurrent = 4): RateLimit {
  return { requestsPerSecond, burstSize: Math.max(1, Math.ceil(requestsPerSecond)), concurrent };
}

export function expectOk(venue: VenueId, ok: boolean, body: unknown): void {
  if (!ok) {
    throw new Error(`${venue}: unexpected API response: ${JSON.stringify(body).slice(0, 300)}`);
  }
}
