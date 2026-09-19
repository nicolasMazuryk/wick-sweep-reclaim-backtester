// @wsr/core owns the canonical six-id VenueId tuple (Spec §1.4: @wsr/data may
// import @wsr/core, not duplicate it). Re-exported here so venue-facing code
// in this package has one place to import it from.
export type { VenueId } from '@wsr/core';

import type { Lots, Ms, Side, Ticks, VenueId } from '@wsr/core';

// Spec §2.1: UTC calendar day, used as the partition key granularity.
export interface UtcDay {
  readonly y: number;
  readonly m: number;
  readonly d: number;
}

// Spec §2.1 canonical trade.
export interface CanonicalTrade {
  readonly venue: VenueId;
  readonly symbol: string;
  readonly tradeId: string;
  readonly t: Ms;
  // Sub-ms venue precision kept in the raw partition (Spec §2.3.1, A-32).
  readonly tNsRemainder: number;
  readonly seq: number;
  readonly p: Ticks;
  readonly q: Lots;
  readonly s: Side;
}

// What `normalise` actually yields: a CanonicalTrade plus the exactness of
// its p/q quantisation, which the pipeline needs for the tick-size-change
// check and lot-size inference (Spec §2.3.1, §2.3.2, §2.6.1).
export interface NormalisedTrade extends CanonicalTrade {
  // price / Tick(t) was not an integer; p is rounded.
  readonly offTick: boolean;
  // size × contractMultiplier / LotSize(t) was not an integer; q is rounded.
  readonly offLot: boolean;
  // Venue price / size strings, retained only for off-grid or non-positive
  // records (bad-print samples and tick inference); undefined otherwise.
  readonly priceText?: string;
  readonly sizeText?: string;
}

export interface RateLimit {
  readonly requestsPerSecond: number; // token-bucket refill rate
  readonly burstSize: number; // token-bucket capacity (Spec §2.1 `burst`)
  readonly concurrent: number; // max in-flight requests
}

export type RetryableCondition = number | 'ECONNRESET' | 'ETIMEDOUT' | 'checksum';

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number; // full jitter
  readonly retryOn: ReadonlyArray<RetryableCondition>;
}

// Spec §2.1 defaults.
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 6,
  baseDelayMs: 500,
  maxDelayMs: 60_000,
  multiplier: 2,
  retryOn: [429, 500, 502, 503, 504, 'ECONNRESET', 'ETIMEDOUT', 'checksum'],
};

// All six venues are served from bulk archives (A-57): no REST trade
// fallback, no WebSocket recorder.
export type DaySource = 'archive';

export interface DayAvailability {
  readonly day: UtcDay;
  readonly source: DaySource | 'unavailable';
  readonly expectedChecksum?: { readonly algo: 'sha256'; readonly value: string };
}

export type ArchiveContentType = 'zip' | 'csv.gz';

export interface ArchivePartRef {
  readonly url: string;
  readonly cacheKey: string;
}

// One archive file (or a probed series of numbered parts) needed to build a
// UTC day (A-58: OKX/Bitget need two UTC+8 files per UTC day; Gate one
// monthly file for many days).
export interface ArchiveFileRef {
  readonly url: string;
  // Path relative to {dataRoot}/cache/{venue}/; also the refcount key.
  readonly cacheKey: string;
  readonly contentType: ArchiveContentType;
  // sha256 sidecar in `sha256sum` format (Binance `.CHECKSUM`).
  readonly checksumUrl?: string;
  // Unpublished number of parts: probe part 1, 2, … until 403/404 (Bitget).
  // `url` is then part 1's URL; files land under `cacheKey/`.
  readonly probeParts?: { readonly maxParts: number; readonly part: (n: number) => ArchivePartRef };
}

export interface LocalFile {
  readonly path: string;
  readonly contentType: ArchiveContentType;
  readonly url: string;
  // sha256 (hex) of the downloaded bytes, recorded in .done (Spec §2.5
  // "Checksums", A-100); absent only for hand-built payloads.
  readonly sha256?: string;
}

export interface RawDayPayload {
  readonly symbol: string; // canonical
  readonly day: UtcDay;
  readonly source: DaySource;
  // Local copies of the archive files, in delivery order.
  readonly files: ReadonlyArray<LocalFile>;
  // Cache keys of the refs these files came from (for cache refcounting).
  readonly cacheKeys: ReadonlyArray<string>;
  // true only if every file with a venue-published checksum matched.
  readonly checksumVerified: boolean;
}

export interface InstrumentMeta {
  readonly venue: VenueId;
  readonly symbol: string;
  readonly venueSymbol: string;
  // Price tick; TickDecimal is the exact decimal string, Tick its number.
  readonly Tick: number;
  readonly TickDecimal: string;
  // Base-asset units per lot (after contract multiplier).
  readonly LotSize: number;
  readonly LotSizeDecimal: string;
  // Base units per contract (1 if the archive quotes base units directly).
  readonly contractMultiplier: number;
  readonly contractMultiplierDecimal: string;
  readonly TakerFee: number;
  readonly MakerFee: number;
  // null until the engineer has checked the venue's current VIP-0 schedule.
  readonly feesVerifiedAt: string | null;
  readonly fundingIntervalHours: number;
  readonly validFrom: Ms;
  // Fields holding a placeholder the engineer must check (written as
  // [VERIFY] lines in instrument_history.json, Spec §2.7 `wsr data meta`,
  // A-102). Fees use feesVerifiedAt = null instead.
  readonly unverified?: readonly UnverifiedField[];
}

// fundingIntervalHours: the venue response had no interval (default 8 h);
// validFrom: change instant inferred from the archive (Spec §2.3.2) or
// observed at a meta refresh, not taken from a venue announcement.
export type UnverifiedField = 'fundingIntervalHours' | 'validFrom';

export interface FundingRecord {
  readonly t: Ms;
  readonly rate: number;
}

export interface InstrumentMetaHistory {
  readonly records: ReadonlyArray<InstrumentMeta>; // sorted by validFrom ascending
  at(t: Ms): InstrumentMeta; // last record with validFrom ≤ t
}

export interface VenueAdapter {
  readonly id: VenueId;
  readonly adapterVersion: string;
  readonly rateLimit: RateLimit;
  readonly retryPolicy: RetryPolicy;
  readonly timestampResolution: 'ms' | 'us' | 'ns' | 's' | 's_fractional';
  readonly feedKind: 'raw' | 'aggregated';
  readonly tradeIdKind: 'monotonic_int' | 'uuid' | 'opaque';

  toVenueSymbol(symbol: string): string;

  // Archive files needed for one UTC day, in delivery order. Pure.
  archiveFiles(symbol: string, day: UtcDay): ReadonlyArray<ArchiveFileRef>;

  // HEAD probes only; never downloads trade data.
  listAvailable(symbol: string, from: UtcDay, to: UtcDay, opts?: { readonly signal?: AbortSignal }): Promise<ReadonlyArray<DayAvailability>>;

  fetch(symbol: string, day: UtcDay, opts: { readonly signal: AbortSignal }): Promise<RawDayPayload>;

  normalise(raw: RawDayPayload, meta: InstrumentMetaHistory): AsyncIterable<NormalisedTrade>;

  fetchInstrumentMeta(symbol: string): Promise<InstrumentMetaHistory>;

  fetchFunding(symbol: string, from: Ms, to: Ms): Promise<ReadonlyArray<FundingRecord>>;
}

// Spec §2.1 invariant 1: the venue payload has no explicit taker-side field.
export class MissingAggressorField extends Error {
  constructor(venue: string, detail: string) {
    super(`${venue}: missing aggressor (taker side) field: ${detail}`);
    this.name = 'MissingAggressorField';
  }
}
