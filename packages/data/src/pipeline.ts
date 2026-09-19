import { readFile, rm, stat } from 'node:fs/promises';
import type { Ms } from '@wsr/core';
import { VENUES, getVenueAdapter } from './venues/index.js';
import type { AdapterDeps, ArchiveVenueAdapter } from './adapter.js';
import { addDays, dayEndMs, dayStartMs, eachDay, formatDay } from './days.js';
import { formatDecimal, gcdDecimal, multiplyDecimal, parseDecimal, type Decimal } from './decimal.js';
import { DoneMarkerSchema, readDoneMarker, type DoneMarker } from './done-marker.js';
import { ArchiveUnavailableError, ChecksumMismatchError } from './fetch-day.js';
import { mergeFunding, readFunding, writeFunding } from './funding.js';
import { TradeColumnsBuilder, type TradeColumns } from './columns.js';
import { checksumFailedHygiene, computeHygiene, readHygiene, screenTrades, ticksToPrice, writeHygiene, type HygieneReport, type MergedSummary } from './hygiene.js';
import { createMetaHistory, readInstrumentHistory, verifyNotes, withMetaRecord, writeInstrumentHistory } from './instrument-meta.js';
import { isMidnightSplit, mergeColumns } from './merge.js';
import { readMergedParquetColumns, readRawParquetColumns, writeMergedParquetColumns } from './parquet.js';
import { donePath, partitionPath, venueUnusablePath } from './paths.js';
import { SCHEMA_VERSION } from './schema.js';
import { atomicWriteFile, mergedBoundaries, sha256Hex, writePartitionColumns } from './storage.js';
import { MissingAggressorField, type UnverifiedField, type FundingRecord, type InstrumentMeta, type InstrumentMetaHistory, type NormalisedTrade, type RawDayPayload, type UtcDay, type VenueId } from './venue.js';

// pino-compatible subset.
export interface PipelineLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

const silentLogger: PipelineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

export type PartitionStatus = 'done' | 'skipped' | 'planned' | 'unavailable' | 'failed' | 'checksumFailed' | 'integrityFailed';

export interface PartitionResult {
  readonly venue: VenueId;
  readonly symbol: string;
  readonly day: string;
  readonly status: PartitionStatus;
  readonly rowsRaw?: number;
  readonly rowsMerged?: number;
  readonly suspect?: boolean;
  readonly error?: string;
}

export interface Selection {
  readonly venues: readonly VenueId[];
  readonly symbols: readonly string[];
  readonly from: UtcDay;
  readonly to: UtcDay;
  readonly dataRoot: string;
  readonly log?: PipelineLogger;
  readonly onPartition?: (result: PartitionResult) => void;
}

export interface FetchPartitionsOptions extends Selection {
  // Parallel archive downloads per venue (Spec §2.7 --concurrency).
  readonly concurrency: number;
  readonly dryRun?: boolean;
  // Keep downloaded archives instead of deleting them once used.
  readonly keepCache?: boolean;
  // Hard abort: in-flight downloads are cancelled.
  readonly signal?: AbortSignal;
  // Soft stop (first SIGINT): finish the partition being written, start no more.
  readonly shouldStop?: () => boolean;
  // Test/tuning hooks.
  readonly adapterDeps?: Omit<AdapterDeps, 'dataRoot'>;
  readonly adapters?: Partial<Record<VenueId, ArchiveVenueAdapter>>;
  readonly fetchedAt?: () => string;
  // Observation time of an instrument-meta refresh (A-103).
  readonly now?: () => Ms;
}

export interface FetchPartitionsResult {
  readonly partitions: readonly PartitionResult[];
  readonly interrupted: boolean;
}

class Slots {
  private free: number;
  private readonly waiters: Array<() => void> = [];
  constructor(n: number) {
    this.free = Math.max(1, n);
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.free > 0) {
      this.free -= 1;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next === undefined) {
        this.free += 1;
      } else {
        next();
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function mergedDonePath(dataRoot: string, venue: VenueId, symbol: string, day: UtcDay): string {
  return donePath(partitionPath(dataRoot, 'merged', venue, symbol, day));
}

async function readMarker(dataRoot: string, venue: VenueId, symbol: string, day: UtcDay): Promise<DoneMarker | undefined> {
  try {
    return await readDoneMarker(mergedDonePath(dataRoot, venue, symbol, day));
  } catch {
    return undefined;
  }
}

// Spec §2.5 idempotency: complete when .done parses with the current
// schemaVersion and the adapter version matches, and (when the marker
// records it) the day's grid records are unchanged (A-103).
async function isComplete(dataRoot: string, venue: VenueId, symbol: string, day: UtcDay, adapterVersion: string, meta: InstrumentMetaHistory | undefined): Promise<boolean> {
  const marker = await readMarker(dataRoot, venue, symbol, day);
  if (marker === undefined || marker.schemaVersion !== SCHEMA_VERSION || marker.adapterVersion !== adapterVersion) {
    return false;
  }
  return marker.sha256Meta === undefined || meta === undefined || marker.sha256Meta === metaFingerprint(meta, day);
}

// Loads instrument_history.json, fetching the current record on first use
// and folding it in on later runs (a contract-size or grid change is
// recorded before new days are normalised, A-103). A failed refresh
// degrades to the stored history.
export async function ensureInstrumentHistory(adapter: ArchiveVenueAdapter, dataRoot: string, symbol: string, log: PipelineLogger, now: () => Ms = Date.now): Promise<InstrumentMetaHistory> {
  const existing = await readInstrumentHistory(dataRoot, adapter.id, symbol);
  if (existing === undefined) {
    const fetched = await adapter.fetchInstrumentMeta(symbol);
    const path = await writeInstrumentHistory(dataRoot, adapter.id, symbol, fetched);
    log.info({ venue: adapter.id, symbol, path }, 'instrument meta fetched');
    return fetched;
  }
  let current: InstrumentMeta;
  try {
    current = (await adapter.fetchInstrumentMeta(symbol)).records[0]!;
  } catch (error) {
    log.warn({ venue: adapter.id, symbol, err: errorMessage(error) }, 'instrument meta refresh failed; using stored history');
    return existing;
  }
  const { history, changed } = mergeCurrentMeta(existing, current, now());
  if (JSON.stringify(history.records) !== JSON.stringify(existing.records)) {
    const path = await writeInstrumentHistory(dataRoot, adapter.id, symbol, history);
    if (changed) {
      log.warn({ venue: adapter.id, symbol, path }, '[VERIFY] instrument grid/contract size changed; record appended at the observation time, set validFrom from the venue announcement');
    }
  }
  return history;
}

// Spec §2.3.1: p/q of a day depend on the grid records in force during it.
// Their sha256 goes into .done so a later edit of instrument_history.json
// (e.g. a verified contract-size change instant) makes the day incomplete
// and it is re-normalised (A-103).
export function metaFingerprint(meta: InstrumentMetaHistory, day: UtcDay): string {
  const start = dayStartMs(day);
  const end = dayEndMs(day);
  const inForce = [meta.at(start), ...meta.records.filter((r) => r.validFrom > start && r.validFrom < end)];
  const grid = inForce.map((r) => [Math.max(r.validFrom, start), r.TickDecimal, r.LotSizeDecimal, r.contractMultiplierDecimal]);
  return sha256Hex(Buffer.from(JSON.stringify(grid)));
}

// Funding history covering [from, to]; fetched and stored when the stored
// file does not reach both ends. Failures degrade to what is stored
// (fundingMissing then lists the gaps).
async function ensureFunding(adapter: ArchiveVenueAdapter, dataRoot: string, symbol: string, from: Ms, to: Ms, intervalHours: number, log: PipelineLogger): Promise<FundingRecord[]> {
  const stored = await readFunding(dataRoot, adapter.id, symbol);
  const slack = intervalHours * 3_600_000;
  const first = stored[0];
  const last = stored[stored.length - 1];
  if (first !== undefined && last !== undefined && first.t <= from + slack && last.t >= to - slack) {
    return stored;
  }
  try {
    const fetched = await adapter.fetchFunding(symbol, from, to);
    const merged = mergeFunding(stored, fetched);
    await writeFunding(dataRoot, adapter.id, symbol, merged);
    log.info({ venue: adapter.id, symbol, records: fetched.length }, 'funding fetched');
    return merged;
  } catch (error) {
    log.warn({ venue: adapter.id, symbol, err: errorMessage(error) }, 'funding fetch failed; using stored records');
    return stored;
  }
}

// Off-grid records kept for grid inference (a sample suffices for the gcd).
const OFF_GRID_SAMPLE = 200_000;

interface NormalisedDay {
  readonly cols: TradeColumns;
  readonly offGrid: readonly NormalisedTrade[];
  readonly firstT: Ms | undefined;
}

async function normaliseDay(adapter: ArchiveVenueAdapter, payload: RawDayPayload, meta: InstrumentMetaHistory): Promise<NormalisedDay> {
  const builder = new TradeColumnsBuilder();
  const offGrid: NormalisedTrade[] = [];
  let firstT: Ms | undefined;
  for await (const row of adapter.normalise(payload, meta)) {
    builder.push(row);
    if ((row.offTick || row.offLot) && offGrid.length < OFF_GRID_SAMPLE) {
      offGrid.push(row);
    }
    firstT = firstT === undefined ? row.t : Math.min(firstT, row.t);
  }
  return { cols: builder.build(), offGrid, firstT };
}

function gcdOf(values: Iterable<Decimal>, start: Decimal): Decimal {
  let acc = start;
  for (const value of values) {
    acc = gcdDecimal(acc, value);
  }
  return acc;
}

// Spec §2.3.2: prices (sizes) off the metadata grid ⇒ the day uses a finer
// Tick (LotSize). Infers the finest common grid of the off-grid records and
// the current one, valid from the day's first trade; undefined when on-grid.
export function inferGridChange(offGrid: readonly NormalisedTrade[], firstT: Ms | undefined, meta: InstrumentMetaHistory): InstrumentMeta | undefined {
  if (offGrid.length === 0 || firstT === undefined) {
    return undefined;
  }
  const base = meta.at(firstT);
  const multiplier = parseDecimal(base.contractMultiplierDecimal);
  const priceStep = gcdOf(
    offGrid.filter((row) => row.offTick && row.priceText !== undefined).map((row) => parseDecimal(row.priceText!)),
    parseDecimal(base.TickDecimal),
  );
  const lot = gcdOf(
    offGrid.filter((row) => row.offLot && row.sizeText !== undefined).map((row) => multiplyDecimal(parseDecimal(row.sizeText!), multiplier)),
    parseDecimal(base.LotSizeDecimal),
  );
  return {
    ...base,
    unverified: withUnverified(base.unverified, 'validFrom'),
    Tick: Number(formatDecimal(priceStep)),
    TickDecimal: formatDecimal(priceStep),
    LotSize: Number(formatDecimal(lot)),
    LotSizeDecimal: formatDecimal(lot),
    validFrom: firstT,
  };
}

function withUnverified(fields: InstrumentMeta['unverified'], field: UnverifiedField): UnverifiedField[] {
  return fields?.includes(field) === true ? [...fields] : [...(fields ?? []), field];
}

// The inferred-change record whose validFrom falls inside the day, if any.
function tickChangeOnDay(meta: InstrumentMetaHistory, day: UtcDay): { t: Ms; inferredTick: string } | undefined {
  const record = meta.records.find((r) => r.validFrom > 0 && r.validFrom >= dayStartMs(day) && r.validFrom < dayEndMs(day));
  return record === undefined ? undefined : { t: record.validFrom, inferredTick: record.TickDecimal };
}

interface SymbolContext {
  readonly adapter: ArchiveVenueAdapter;
  readonly symbol: string;
  readonly dataRoot: string;
  readonly log: PipelineLogger;
  meta: InstrumentMetaHistory;
  readonly funding: readonly FundingRecord[];
  readonly fetchedAt: () => string;
  // Called for every later partition whose .done a grid change removed, so
  // days of the current selection are rebuilt in this run (Spec §2.3.2).
  readonly requeue?: (day: UtcDay) => void;
}

// Normalise → (grid inference, once) → screen → write raw/merged/hygiene/.done.
async function buildPartition(ctx: SymbolContext, payload: RawDayPayload): Promise<PartitionResult> {
  const { adapter, symbol, dataRoot, log } = ctx;
  const day = payload.day;
  let normalised = await normaliseDay(adapter, payload, ctx.meta);
  const inferred = inferGridChange(normalised.offGrid, normalised.firstT, ctx.meta);
  if (inferred !== undefined) {
    const before = ctx.meta.at(inferred.validFrom);
    ctx.meta = withMetaRecord(ctx.meta, inferred);
    await writeInstrumentHistory(dataRoot, adapter.id, symbol, ctx.meta);
    log.warn(
      { venue: adapter.id, symbol, day: formatDay(day), Tick: `${before.TickDecimal}→${inferred.TickDecimal}`, lot: `${before.LotSizeDecimal}→${inferred.LotSizeDecimal}` },
      'tick/lot size change inferred; re-normalising',
    );
    await invalidateLaterPartitions(ctx, day);
    normalised = await normaliseDay(adapter, payload, ctx.meta);
  }

  const cols = normalised.cols;
  const screen = screenTrades(cols, day, (i) => ticksToPrice(cols.p[i]!, ctx.meta.at(cols.t[i]!).TickDecimal));
  const previous = await readMarker(dataRoot, adapter.id, symbol, addDays(day, -1));
  let report: HygieneReport | undefined;
  const written = await writePartitionColumns({
    dataRoot,
    venue: adapter.id,
    symbol,
    day,
    raw: cols,
    keep: screen.keep,
    source: 'archive',
    checksumVerified: payload.checksumVerified,
    adapterVersion: adapter.adapterVersion,
    fetchedAt: ctx.fetchedAt(),
    ...payloadHashes(payload),
    sha256Meta: metaFingerprint(ctx.meta, day),
    beforeMarker: async (merged) => {
      report = computeHygiene({
        venue: adapter.id,
        symbol,
        day,
        rowsRaw: cols.length,
        screen,
        merged,
        feedKind: adapter.feedKind,
        tickChange: tickChangeOnDay(ctx.meta, day),
        midnightSplit: midnightSplitAfter(previous, mergedBoundaries(merged).mergedFirst),
        funding: { records: ctx.funding, intervalHours: ctx.meta.at(dayStartMs(day)).fundingIntervalHours },
      });
      await writeHygiene(dataRoot, day, report);
    },
  });
  await refreshNextMidnightSplit(ctx, day, written.marker);
  return { venue: adapter.id, symbol, day: formatDay(day), status: 'done', rowsRaw: cols.length, rowsMerged: written.merged.length, suspect: report?.suspect ?? false };
}

// Every file hashed ⇒ the list goes into .done (Spec §2.5 "Checksums", A-100).
function payloadHashes(payload: RawDayPayload): { sha256Payload?: DoneMarker['sha256Payload'] } {
  if (payload.files.length === 0 || payload.files.some((f) => f.sha256 === undefined)) {
    return {};
  }
  return { sha256Payload: payload.files.map((f) => ({ url: f.url, sha256: f.sha256! })) };
}

function midnightSplitAfter(previous: DoneMarker | undefined, first: DoneMarker['mergedFirst']): boolean {
  return first !== undefined && isMidnightSplit(previous?.mergedLast, first);
}

// If day+1 was completed earlier (out-of-order run), its midnightSplit flag
// could not see this day; recompute it now.
async function refreshNextMidnightSplit(ctx: SymbolContext, day: UtcDay, marker: DoneMarker): Promise<void> {
  const next = addDays(day, 1);
  const nextMarker = await readMarker(ctx.dataRoot, ctx.adapter.id, ctx.symbol, next);
  const report = await readHygiene(ctx.dataRoot, ctx.adapter.id, ctx.symbol, next).catch(() => undefined);
  if (nextMarker?.mergedFirst === undefined || report === undefined) {
    return;
  }
  const midnightSplit = isMidnightSplit(marker.mergedLast, nextMarker.mergedFirst);
  if (midnightSplit !== report.midnightSplit) {
    await writeHygiene(ctx.dataRoot, next, { ...report, midnightSplit });
  }
}

// A grid change inferred on `day` changes Tick(t) for later days up to the
// next meta record; partitions already written there used the old grid and
// are marked incomplete (Spec §2.3.2, A-62); days inside the running
// selection are re-queued, the others are rebuilt by the next fetch.
async function invalidateLaterPartitions(ctx: SymbolContext, day: UtcDay): Promise<void> {
  const nextChange = ctx.meta.records.find((r) => r.validFrom >= dayEndMs(day));
  const limit = nextChange?.validFrom ?? Number.POSITIVE_INFINITY;
  // Bounded scan: partitions are daily, so walk forward until a gap of 400 days
  // without a marker (beyond any plausible span) or the next change.
  let misses = 0;
  for (let d = addDays(day, 1); dayStartMs(d) < limit && misses < 400; d = addDays(d, 1)) {
    const path = mergedDonePath(ctx.dataRoot, ctx.adapter.id, ctx.symbol, d);
    if (await exists(path)) {
      misses = 0;
      await rm(path, { force: true });
      ctx.log.warn({ venue: ctx.adapter.id, symbol: ctx.symbol, day: formatDay(d) }, 'partition invalidated by grid change; will be re-fetched');
      ctx.requeue?.(d);
    } else {
      misses += 1;
    }
  }
}

// Spec §2.1 invariant 1: MissingAggressorField marks the venue unusable
// (A-101). The marker is keyed by adapterVersion: a fixed adapter (new
// version) clears it; otherwise delete the file by hand.
interface VenueState {
  reason: string | undefined;
}

async function readVenueUnusable(dataRoot: string, adapter: ArchiveVenueAdapter): Promise<string | undefined> {
  try {
    const marker = JSON.parse(await readFile(venueUnusablePath(dataRoot, adapter.id), 'utf8')) as { adapterVersion?: unknown; reason?: unknown };
    return marker.adapterVersion === adapter.adapterVersion ? String(marker.reason) : undefined;
  } catch {
    return undefined;
  }
}

async function markVenueUnusable(dataRoot: string, adapter: ArchiveVenueAdapter, symbol: string, day: UtcDay, reason: string, markedAt: string): Promise<void> {
  const body = { adapterVersion: adapter.adapterVersion, reason, symbol, day: formatDay(day), markedAt };
  await atomicWriteFile(venueUnusablePath(dataRoot, adapter.id), Buffer.from(`${JSON.stringify(body, null, 2)}\n`));
}

type FetchOutcome = { readonly payload: RawDayPayload } | { readonly error: unknown };

// Spec §2.7 `wsr data fetch`. Per (venue, symbol) days run ascending: archive
// downloads overlap (`concurrency` per venue) while normalise/merge/write is
// one partition at a time process-wide (memory-bound), so day D−1 is always
// complete before day D (midnightSplit, tick-change inference).
export async function fetchPartitions(options: FetchPartitionsOptions): Promise<FetchPartitionsResult> {
  const log = options.log ?? silentLogger;
  const results: PartitionResult[] = [];
  const report = (result: PartitionResult): void => {
    results.push(result);
    options.onPartition?.(result);
  };
  const shouldStop = options.shouldStop ?? (() => options.signal?.aborted === true);
  const internal = new AbortController();
  const signal = options.signal === undefined ? internal.signal : AbortSignal.any([options.signal, internal.signal]);
  const processing = new Slots(1);
  const fetchedAt = options.fetchedAt ?? (() => new Date().toISOString());
  let interrupted = false;

  const runSymbol = async (adapter: ArchiveVenueAdapter, downloads: Slots, symbol: string, venueState: VenueState): Promise<void> => {
    const pending: UtcDay[] = [];
    const storedMeta = await readInstrumentHistory(options.dataRoot, adapter.id, symbol).catch(() => undefined);
    for (const day of eachDay(options.from, options.to)) {
      if (await isComplete(options.dataRoot, adapter.id, symbol, day, adapter.adapterVersion, storedMeta)) {
        report({ venue: adapter.id, symbol, day: formatDay(day), status: 'skipped' });
      } else {
        pending.push(day);
      }
    }
    if (pending.length === 0) {
      return;
    }
    const unusable = (day: UtcDay): PartitionResult => ({ venue: adapter.id, symbol, day: formatDay(day), status: 'failed', error: `venue unusable: ${venueState.reason}` });
    if (venueState.reason !== undefined) {
      pending.forEach((day) => report(unusable(day)));
      return;
    }
    const planned: UtcDay[] = [];
    for (const day of pending) {
      if (shouldStop()) {
        interrupted = true;
        return;
      }
      const [availability] = await adapter.listAvailable(symbol, day, day, { signal });
      if (availability?.source === 'unavailable') {
        report({ venue: adapter.id, symbol, day: formatDay(day), status: 'unavailable' });
      } else {
        planned.push(day);
      }
    }
    if (options.dryRun === true) {
      planned.forEach((day) => report({ venue: adapter.id, symbol, day: formatDay(day), status: 'planned' }));
      return;
    }
    if (planned.length === 0) {
      return;
    }

    const meta = await ensureInstrumentHistory(adapter, options.dataRoot, symbol, log, options.now);
    const funding = await ensureFunding(
      adapter,
      options.dataRoot,
      symbol,
      dayStartMs(planned[0]!),
      dayEndMs(planned[planned.length - 1]!),
      meta.records[meta.records.length - 1]!.fundingIntervalHours,
      log,
    );
    // Ascending work queue; a grid change re-queues later days of the
    // selection whose .done it removed (Spec §2.3.2).
    const queue: UtcDay[] = [...planned];
    const queued = new Set(queue.map(formatDay));
    // Cache refcounts: an archive is deleted once every queued day using it is processed.
    const refCounts = new Map<string, number>();
    const retain = (day: UtcDay): void => {
      for (const ref of adapter.archiveFiles(symbol, day)) {
        refCounts.set(ref.cacheKey, (refCounts.get(ref.cacheKey) ?? 0) + 1);
      }
    };
    queue.forEach(retain);
    const requeue = (day: UtcDay): void => {
      const key = formatDay(day);
      if (queued.has(key) || dayStartMs(day) < dayStartMs(options.from) || dayStartMs(day) > dayStartMs(options.to)) {
        return;
      }
      queued.add(key);
      retain(day);
      const at = queue.findIndex((d) => dayStartMs(d) > dayStartMs(day));
      queue.splice(at < 0 ? queue.length : at, 0, day);
    };
    const ctx: SymbolContext = { adapter, symbol, dataRoot: options.dataRoot, log, meta, funding, fetchedAt, requeue };
    const release = async (day: UtcDay): Promise<void> => {
      for (const ref of adapter.archiveFiles(symbol, day)) {
        const count = refCounts.get(ref.cacheKey);
        if (count === undefined) {
          continue;
        }
        refCounts.set(ref.cacheKey, count - 1);
        if (count === 1 && options.keepCache !== true) {
          await adapter.removeCached(ref.cacheKey).catch((error: unknown) => log.warn({ err: errorMessage(error) }, 'cache cleanup failed'));
        }
      }
    };

    const window = Math.max(1, options.concurrency);
    const fetches = new Map<string, Promise<FetchOutcome>>();
    const startFetch = (day: UtcDay): void => {
      const key = formatDay(day);
      if (fetches.has(key)) {
        return;
      }
      fetches.set(key, downloads.run(async () => {
        if (shouldStop()) {
          return { error: new Error('interrupted') };
        }
        try {
          return { payload: await adapter.fetch(symbol, day, { signal }) };
        } catch (error) {
          return { error };
        }
      }));
    };

    while (queue.length > 0) {
      if (shouldStop()) {
        interrupted = true;
        break;
      }
      if (venueState.reason !== undefined) {
        // Drain: no further downloads start; started ones settle before the
        // cache is released.
        for (const day of queue.splice(0)) {
          report(unusable(day));
          await fetches.get(formatDay(day));
          await release(day);
        }
        break;
      }
      queue.slice(0, window).forEach(startFetch);
      const day = queue.shift()!;
      const outcome = await fetches.get(formatDay(day))!;
      fetches.delete(formatDay(day));
      if (shouldStop()) {
        interrupted = true;
        break;
      }
      const base = { venue: adapter.id, symbol, day: formatDay(day) };
      if ('error' in outcome) {
        const error = outcome.error;
        if (error instanceof ChecksumMismatchError) {
          await writeHygiene(options.dataRoot, day, checksumFailedHygiene(adapter.id, symbol, day, adapter.feedKind));
          log.error({ ...base, err: error.message }, 'checksum mismatch');
          report({ ...base, status: 'checksumFailed', error: error.message });
        } else if (error instanceof ArchiveUnavailableError) {
          report({ ...base, status: 'unavailable', error: error.message });
        } else {
          log.error({ ...base, err: errorMessage(error) }, 'fetch failed');
          report({ ...base, status: 'failed', error: errorMessage(error) });
        }
      } else {
        try {
          report(await processing.run(() => buildPartition(ctx, outcome.payload)));
        } catch (error) {
          log.error({ ...base, err: errorMessage(error) }, 'partition failed');
          report({ ...base, status: 'failed', error: errorMessage(error) });
          if (error instanceof MissingAggressorField && venueState.reason === undefined) {
            venueState.reason = errorMessage(error);
            await markVenueUnusable(options.dataRoot, adapter, symbol, day, venueState.reason, fetchedAt());
            log.error({ venue: adapter.id, path: venueUnusablePath(options.dataRoot, adapter.id) }, 'venue marked unusable (Spec §2.1 invariant 1)');
          }
        }
      }
      await release(day);
    }
    // Cancel downloads that were prefetched but will not be processed.
    if (interrupted) {
      internal.abort(new Error('interrupted'));
      await Promise.allSettled(fetches.values());
    }
  };

  await Promise.all(
    options.venues.map(async (venue) => {
      const adapter = options.adapters?.[venue] ?? getVenueAdapter(venue, { ...options.adapterDeps, dataRoot: options.dataRoot });
      const downloads = new Slots(options.concurrency);
      const venueState: VenueState = { reason: await readVenueUnusable(options.dataRoot, adapter) };
      await Promise.all(
        options.symbols.map((symbol) =>
          runSymbol(adapter, downloads, symbol, venueState).catch((error: unknown) => {
            log.error({ venue, symbol, err: errorMessage(error) }, 'symbol failed');
            report({ venue, symbol, day: '*', status: 'failed', error: errorMessage(error) });
          }),
        ),
      );
    }),
  );
  return { partitions: results, interrupted: interrupted || shouldStop() };
}

async function readRawColumns(dataRoot: string, venue: VenueId, symbol: string, day: UtcDay): Promise<{ cols: TradeColumns; bytes: Uint8Array }> {
  const bytes = await readFile(partitionPath(dataRoot, 'raw', venue, symbol, day));
  return { cols: readRawParquetColumns(bytes), bytes };
}

function priceRenderer(cols: TradeColumns, meta: InstrumentMetaHistory | undefined): (i: number) => string {
  return (i) => (meta === undefined ? String(cols.p[i]) : ticksToPrice(cols.p[i]!, meta.at(cols.t[i]!).TickDecimal));
}

async function forEachPartition(selection: Selection, visit: (venue: VenueId, symbol: string, day: UtcDay) => Promise<void>): Promise<void> {
  for (const venue of selection.venues) {
    for (const symbol of selection.symbols) {
      for (const day of eachDay(selection.from, selection.to)) {
        await visit(venue, symbol, day);
      }
    }
  }
}

// Hygiene from stored partitions (`wsr data hygiene`, `wsr data merge`).
async function hygieneFromStored(dataRoot: string, venue: VenueId, symbol: string, day: UtcDay, raw: TradeColumns, merged: MergedSummary, midnightSplit: boolean): Promise<HygieneReport> {
  const meta = await readInstrumentHistory(dataRoot, venue, symbol);
  const funding = await readFunding(dataRoot, venue, symbol);
  const screen = screenTrades(raw, day, priceRenderer(raw, meta));
  return computeHygiene({
    venue,
    symbol,
    day,
    rowsRaw: raw.length,
    screen,
    merged,
    feedKind: VENUES[venue].feedKind,
    tickChange: meta === undefined ? undefined : tickChangeOnDay(meta, day),
    midnightSplit,
    funding: { records: funding, intervalHours: meta?.at(dayStartMs(day)).fundingIntervalHours ?? 8 },
  });
}

async function midnightSplitFor(dataRoot: string, venue: VenueId, symbol: string, day: UtcDay, first: DoneMarker['mergedFirst']): Promise<boolean> {
  return midnightSplitAfter(await readMarker(dataRoot, venue, symbol, addDays(day, -1)), first);
}

export interface MergeStoredOptions extends Selection {
  readonly force?: boolean;
}

// `wsr data merge`: re-run Spec §2.4 from stored raw partitions. Without
// --force only partitions lacking a valid merged file + .done are rebuilt.
export async function mergeStored(options: MergeStoredOptions): Promise<PartitionResult[]> {
  const results: PartitionResult[] = [];
  const log = options.log ?? silentLogger;
  await forEachPartition(options, async (venue, symbol, day) => {
    const base = { venue, symbol, day: formatDay(day) };
    const rawPath = partitionPath(options.dataRoot, 'raw', venue, symbol, day);
    if (!(await exists(rawPath))) {
      return;
    }
    const mergedPath = partitionPath(options.dataRoot, 'merged', venue, symbol, day);
    const marker = await readMarker(options.dataRoot, venue, symbol, day);
    let result: PartitionResult;
    if (options.force !== true && marker !== undefined && (await exists(mergedPath))) {
      result = { ...base, status: 'skipped' };
    } else {
      try {
        const { cols, bytes } = await readRawColumns(options.dataRoot, venue, symbol, day);
        const meta = await readInstrumentHistory(options.dataRoot, venue, symbol);
        const screen = screenTrades(cols, day, priceRenderer(cols, meta));
        const merged = mergeColumns(cols, screen.keep);
        const mergedBytes = await writeMergedParquetColumns(venue, symbol, merged);
        await atomicWriteFile(mergedPath, mergedBytes);
        const boundaries = mergedBoundaries(merged);
        const midnightSplit = await midnightSplitFor(options.dataRoot, venue, symbol, day, boundaries.mergedFirst);
        const report = await hygieneFromStored(options.dataRoot, venue, symbol, day, cols, merged, midnightSplit);
        await writeHygiene(options.dataRoot, day, report);
        const previousMarker = marker ?? { source: 'archive' as const, checksumVerified: false, fetchedAt: new Date().toISOString(), adapterVersion: 'unknown' };
        const next = DoneMarkerSchema.parse({
          source: previousMarker.source,
          checksumVerified: previousMarker.checksumVerified,
          fetchedAt: previousMarker.fetchedAt,
          adapterVersion: previousMarker.adapterVersion,
          schemaVersion: SCHEMA_VERSION,
          rowsRaw: cols.length,
          rowsMerged: merged.length,
          sha256Raw: sha256Hex(bytes),
          sha256Merged: sha256Hex(mergedBytes),
          ...boundaries,
          ...(marker?.sha256Payload === undefined ? {} : { sha256Payload: marker.sha256Payload }),
          ...(marker?.sha256Meta === undefined ? {} : { sha256Meta: marker.sha256Meta }),
        });
        await atomicWriteFile(donePath(mergedPath), Buffer.from(JSON.stringify(next)));
        result = { ...base, status: 'done', rowsRaw: cols.length, rowsMerged: merged.length, suspect: report.suspect };
      } catch (error) {
        log.error({ ...base, err: errorMessage(error) }, 'merge failed');
        result = { ...base, status: 'failed', error: errorMessage(error) };
      }
    }
    results.push(result);
    options.onPartition?.(result);
  });
  return results;
}

export interface HygieneEntry {
  readonly venue: VenueId;
  readonly symbol: string;
  readonly day: UtcDay;
  readonly report: HygieneReport | undefined;
}

// `wsr data hygiene`: recompute every complete partition's report.
export async function rebuildHygiene(options: Selection): Promise<HygieneEntry[]> {
  const entries: HygieneEntry[] = [];
  const log = options.log ?? silentLogger;
  await forEachPartition(options, async (venue, symbol, day) => {
    const marker = await readMarker(options.dataRoot, venue, symbol, day);
    if (marker === undefined) {
      // Keep a stored checksum-failure report; nothing else to recompute.
      entries.push({ venue, symbol, day, report: await readHygiene(options.dataRoot, venue, symbol, day).catch(() => undefined) });
      return;
    }
    try {
      const { cols } = await readRawColumns(options.dataRoot, venue, symbol, day);
      const merged = readMergedParquetColumns(await readFile(partitionPath(options.dataRoot, 'merged', venue, symbol, day)));
      const midnightSplit = await midnightSplitFor(options.dataRoot, venue, symbol, day, marker.mergedFirst);
      const report = await hygieneFromStored(options.dataRoot, venue, symbol, day, cols, merged, midnightSplit);
      await writeHygiene(options.dataRoot, day, report);
      entries.push({ venue, symbol, day, report });
      options.onPartition?.({ venue, symbol, day: formatDay(day), status: 'done', rowsRaw: report.rowsRaw, rowsMerged: report.rowsMerged, suspect: report.suspect });
    } catch (error) {
      log.error({ venue, symbol, day: formatDay(day), err: errorMessage(error) }, 'hygiene failed');
      entries.push({ venue, symbol, day, report: undefined });
      options.onPartition?.({ venue, symbol, day: formatDay(day), status: 'failed', error: errorMessage(error) });
    }
  });
  return entries;
}

// Stored hygiene reports for the selection (no recomputation).
export async function loadHygiene(options: Selection): Promise<HygieneEntry[]> {
  const entries: HygieneEntry[] = [];
  await forEachPartition(options, async (venue, symbol, day) => {
    entries.push({ venue, symbol, day, report: await readHygiene(options.dataRoot, venue, symbol, day).catch(() => undefined) });
  });
  return entries;
}

// `wsr data verify`: sha256 of every present partition vs its .done.
export async function verifyPartitions(options: Selection): Promise<PartitionResult[]> {
  const results: PartitionResult[] = [];
  await forEachPartition(options, async (venue, symbol, day) => {
    const base = { venue, symbol, day: formatDay(day) };
    const markerPath = mergedDonePath(options.dataRoot, venue, symbol, day);
    if (!(await exists(markerPath))) {
      return;
    }
    let result: PartitionResult;
    try {
      const marker = await readDoneMarker(markerPath);
      const raw = await readFile(partitionPath(options.dataRoot, 'raw', venue, symbol, day));
      const merged = await readFile(partitionPath(options.dataRoot, 'merged', venue, symbol, day));
      const problems: string[] = [];
      if (sha256Hex(raw) !== marker.sha256Raw) {
        problems.push('raw sha256 mismatch');
      }
      if (sha256Hex(merged) !== marker.sha256Merged) {
        problems.push('merged sha256 mismatch');
      }
      result = problems.length === 0 ? { ...base, status: 'done', rowsRaw: marker.rowsRaw, rowsMerged: marker.rowsMerged } : { ...base, status: 'integrityFailed', error: problems.join('; ') };
    } catch (error) {
      result = { ...base, status: 'integrityFailed', error: errorMessage(error) };
    }
    results.push(result);
    options.onPartition?.(result);
  });
  return results;
}

export interface FetchMetaOptions {
  readonly venues: readonly VenueId[];
  readonly symbols: readonly string[];
  readonly dataRoot: string;
  readonly fundingFrom: Ms;
  readonly fundingTo: Ms;
  readonly log?: PipelineLogger;
  readonly adapterDeps?: Omit<AdapterDeps, 'dataRoot'>;
  readonly adapters?: Partial<Record<VenueId, ArchiveVenueAdapter>>;
  readonly now?: () => Ms;
}

export interface MetaResult {
  readonly venue: VenueId;
  readonly symbol: string;
  readonly status: 'done' | 'failed';
  readonly instrumentHistoryPath?: string;
  readonly fundingPath?: string;
  readonly fundingRecords?: number;
  // Tick, lot, contract multiplier or funding interval differs from the
  // stored latest record (a record with validFrom = now was appended).
  readonly tickChanged?: boolean;
  // [VERIFY] placeholders left in instrument_history.json (A-102).
  readonly verify?: readonly string[];
  readonly error?: string;
}

function sameInstrument(a: InstrumentMeta, b: InstrumentMeta): boolean {
  return (
    a.TickDecimal === b.TickDecimal &&
    a.LotSizeDecimal === b.LotSizeDecimal &&
    a.contractMultiplierDecimal === b.contractMultiplierDecimal &&
    a.fundingIntervalHours === b.fundingIntervalHours
  );
}

// Folds the venue's current record into the stored history. Placeholder
// (unverified) fees are replaced by the definition's current schedule;
// hand-verified fees are kept. A tick, lot, contract-multiplier (Gate
// `quanto_multiplier`, Spec §2.2) or funding-interval change appends a
// record at `observedAt`: the venue gives current values only, so that
// instant is a [VERIFY] placeholder (A-102, A-103).
export function mergeCurrentMeta(stored: InstrumentMetaHistory | undefined, fetched: InstrumentMeta, observedAt: Ms): { history: InstrumentMetaHistory; changed: boolean } {
  if (stored === undefined) {
    return { history: createMetaHistory([fetched]), changed: false };
  }
  let history = stored;
  if (fetched.feesVerifiedAt !== null && history.records.some((r) => r.feesVerifiedAt === null)) {
    history = createMetaHistory(
      history.records.map((r) => (r.feesVerifiedAt === null ? { ...r, TakerFee: fetched.TakerFee, MakerFee: fetched.MakerFee, feesVerifiedAt: fetched.feesVerifiedAt } : r)),
    );
  }
  const latest = history.records[history.records.length - 1]!;
  if (!sameInstrument(latest, fetched)) {
    const record = { ...fetched, TakerFee: latest.TakerFee, MakerFee: latest.MakerFee, feesVerifiedAt: latest.feesVerifiedAt, validFrom: observedAt, unverified: withUnverified(fetched.unverified, 'validFrom') };
    return { history: withMetaRecord(history, record), changed: true };
  }
  if (latest.unverified?.includes('fundingIntervalHours') === true && fetched.unverified?.includes('fundingIntervalHours') !== true) {
    // The venue now reports the defaulted interval (and it matches).
    history = withMetaRecord(history, { ...latest, unverified: latest.unverified.filter((f) => f !== 'fundingIntervalHours') });
  }
  return { history, changed: false };
}

// `wsr data meta`: instrument meta (+ fee placeholders) and funding history.
// A current grid that differs from the stored latest record is appended with
// validFrom = now; stored verified fees are kept, placeholder ones updated.
export async function fetchMeta(options: FetchMetaOptions): Promise<MetaResult[]> {
  const log = options.log ?? silentLogger;
  const now = options.now ?? (() => Date.now());
  const results: MetaResult[] = [];
  for (const venue of options.venues) {
    const adapter = options.adapters?.[venue] ?? getVenueAdapter(venue, { ...options.adapterDeps, dataRoot: options.dataRoot });
    for (const symbol of options.symbols) {
      try {
        const fetched = (await adapter.fetchInstrumentMeta(symbol)).records[0]!;
        const { history, changed: tickChanged } = mergeCurrentMeta(await readInstrumentHistory(options.dataRoot, venue, symbol), fetched, now());
        const instrumentHistoryPath = await writeInstrumentHistory(options.dataRoot, venue, symbol, history);
        const funding = mergeFunding(await readFunding(options.dataRoot, venue, symbol), await adapter.fetchFunding(symbol, options.fundingFrom, options.fundingTo));
        const fundingPath = await writeFunding(options.dataRoot, venue, symbol, funding);
        log.info({ venue, symbol, fundingRecords: funding.length }, 'meta written');
        const verify = verifyNotes(history);
        verify.forEach((note) => log.warn({ venue, symbol }, note));
        results.push({ venue, symbol, status: 'done', instrumentHistoryPath, fundingPath, fundingRecords: funding.length, tickChanged, verify });
      } catch (error) {
        log.error({ venue, symbol, err: errorMessage(error) }, 'meta failed');
        results.push({ venue, symbol, status: 'failed', error: errorMessage(error) });
      }
    }
  }
  return results;
}
