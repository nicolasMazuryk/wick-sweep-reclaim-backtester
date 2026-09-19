import type { Ms, Side } from '@wsr/core';
import { readArchiveRows } from './archive-read.js';
import { dayEndMs, dayStartMs } from './days.js';
import { multiplyDecimal, parseDecimal, quantize, type Decimal, type SubMsTimestamp } from './decimal.js';
import { ArchiveFetcher } from './fetch-day.js';
import { HttpClient, type Clock, type FetchFn } from './http.js';
import { createMetaHistory } from './instrument-meta.js';
import type {
  ArchiveFileRef,
  FundingRecord,
  InstrumentMeta,
  InstrumentMetaHistory,
  LocalFile,
  NormalisedTrade,
  RateLimit,
  RawDayPayload,
  RetryPolicy,
  UtcDay,
  VenueAdapter,
  VenueId,
} from './venue.js';

// One archive row after venue-specific parsing, before quantisation.
export interface RawTradeRow {
  readonly tradeId: string;
  readonly time: SubMsTimestamp;
  readonly priceText: string;
  // Absolute size in the archive's unit (contracts or base asset).
  readonly sizeText: string;
  readonly s: Side;
}

// Everything venue-specific; one per file under venues/ (Spec §2.1: adding a
// venue = one file there + one registry row). The generic machinery below
// turns it into a VenueAdapter.
export interface VenueDefinition {
  readonly id: VenueId;
  // Bump when parsing/normalisation changes (Spec §2.5 idempotency key).
  readonly adapterVersion: string;
  readonly rateLimit: RateLimit;
  readonly retryPolicy: RetryPolicy;
  readonly timestampResolution: VenueAdapter['timestampResolution'];
  readonly feedKind: VenueAdapter['feedKind'];
  readonly tradeIdKind: VenueAdapter['tradeIdKind'];
  // Archive rows are time-ascending, so a file can be abandoned once rows
  // are well past the day (Gate's monthly file).
  readonly timeSortedFiles?: boolean;
  toVenueSymbol(symbol: string): string;
  archiveFiles(symbol: string, day: UtcDay): ArchiveFileRef[];
  // Rows of one archive file in file order; throws MissingAggressorField when
  // the explicit taker-side field is absent (Spec §2.1 invariant 1).
  parseRows(rows: AsyncIterable<string[]>, file: LocalFile): AsyncIterable<RawTradeRow>;
  // Current instrument record (validFrom 0); fees are placeholders.
  fetchInstrumentMeta(symbol: string, http: HttpClient): Promise<InstrumentMeta>;
  fetchFunding(symbol: string, from: Ms, to: Ms, http: HttpClient): Promise<FundingRecord[]>;
}

export interface ArchiveVenueAdapter extends VenueAdapter {
  readonly definition: VenueDefinition;
  // Deletes a cached archive once no planned day needs it.
  removeCached(cacheKey: string): Promise<void>;
}

export interface AdapterDeps {
  // Root for the archive cache ({dataRoot}/cache/{venue}/…).
  readonly dataRoot: string;
  readonly fetchFn?: FetchFn;
  readonly clock?: Clock;
  readonly random?: () => number;
  readonly timeoutMs?: number;
  readonly onRetry?: ConstructorParameters<typeof HttpClient>[0]['onRetry'];
}

// Rows this far past the day end prove a time-sorted file has left the day.
const SORTED_EXIT_MARGIN_MS = 10 * 60_000;

interface ParsedMeta {
  readonly priceStep: Decimal;
  readonly lot: Decimal;
  readonly multiplier: Decimal;
}

// Spec §2.1 normalise: rows of the day's files in delivery order, filtered to
// the UTC day (archives cut on other boundaries, A-58), seq = 0,1,2,… in that
// order; p/q by exact decimal arithmetic (Spec §3.11).
export async function* normaliseArchiveDay(definition: VenueDefinition, raw: RawDayPayload, meta: InstrumentMetaHistory): AsyncGenerator<NormalisedTrade> {
  const start = dayStartMs(raw.day);
  const end = dayEndMs(raw.day);
  const parsedMeta = new Map<InstrumentMeta, ParsedMeta>();
  const parse = (record: InstrumentMeta): ParsedMeta => {
    let parsed = parsedMeta.get(record);
    if (parsed === undefined) {
      parsed = {
        priceStep: parseDecimal(record.TickDecimal),
        lot: parseDecimal(record.LotSizeDecimal),
        multiplier: parseDecimal(record.contractMultiplierDecimal),
      };
      parsedMeta.set(record, parsed);
    }
    return parsed;
  };
  let seq = 0;
  for (const file of raw.files) {
    for await (const row of definition.parseRows(readArchiveRows(file.path, file.contentType), file)) {
      const t = row.time.t;
      if (t < start) {
        continue;
      }
      if (t >= end) {
        if (definition.timeSortedFiles === true && t >= end + SORTED_EXIT_MARGIN_MS) {
          break;
        }
        continue;
      }
      const grid = parse(meta.at(t));
      const price = quantize(parseDecimal(row.priceText), grid.priceStep);
      const size = quantize(multiplyDecimal(parseDecimal(row.sizeText), grid.multiplier), grid.lot);
      const offTick = !price.exact;
      const offLot = !size.exact;
      const keepText = offTick || offLot || price.n <= 0 || size.n <= 0;
      yield {
        venue: definition.id,
        symbol: raw.symbol,
        tradeId: row.tradeId,
        t,
        tNsRemainder: row.time.tNsRemainder,
        seq,
        p: price.n,
        q: size.n,
        s: row.s,
        offTick,
        offLot,
        ...(keepText ? { priceText: row.priceText, sizeText: row.sizeText } : {}),
      };
      seq += 1;
    }
  }
}

export function createVenueAdapter(definition: VenueDefinition, deps: AdapterDeps): ArchiveVenueAdapter {
  const http = new HttpClient({
    rateLimit: definition.rateLimit,
    retryPolicy: definition.retryPolicy,
    ...(deps.fetchFn === undefined ? {} : { fetchFn: deps.fetchFn }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    ...(deps.random === undefined ? {} : { random: deps.random }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    ...(deps.onRetry === undefined ? {} : { onRetry: deps.onRetry }),
  });
  const fetcher = new ArchiveFetcher(definition.id, http, deps.dataRoot);
  return {
    definition,
    id: definition.id,
    adapterVersion: definition.adapterVersion,
    rateLimit: definition.rateLimit,
    retryPolicy: definition.retryPolicy,
    timestampResolution: definition.timestampResolution,
    feedKind: definition.feedKind,
    tradeIdKind: definition.tradeIdKind,
    toVenueSymbol: (symbol) => definition.toVenueSymbol(symbol),
    archiveFiles: (symbol, day) => definition.archiveFiles(symbol, day),
    listAvailable: (symbol, from, to, opts) => fetcher.listAvailable((day) => definition.archiveFiles(symbol, day), from, to, opts?.signal),
    fetch: (symbol, day, opts) => fetcher.fetchDay(symbol, day, definition.archiveFiles(symbol, day), opts.signal),
    normalise: (raw, meta) => normaliseArchiveDay(definition, raw, meta),
    fetchInstrumentMeta: async (symbol) => createMetaHistory([await definition.fetchInstrumentMeta(symbol, http)]),
    fetchFunding: (symbol, from, to) => definition.fetchFunding(symbol, from, to, http),
    removeCached: (cacheKey) => fetcher.remove(cacheKey),
  };
}
