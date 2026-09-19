import { join } from 'node:path';
import { formatDay } from './days.js';
import type { UtcDay } from './venue.js';

// venue/symbol are plain strings, not VenueId (see merge.ts) — this layer is
// venue-agnostic and path-only.
export type PartitionKind = 'raw' | 'merged';

// Spec §2.5 layout: {dataRoot}/{kind}/{venue}/{symbol}/{YYYY}/{YYYY-MM-DD}.parquet
export function partitionPath(dataRoot: string, kind: PartitionKind, venue: string, symbol: string, day: UtcDay): string {
  return join(dataRoot, kind, venue, symbol, String(day.y).padStart(4, '0'), `${formatDay(day)}.parquet`);
}

// Spec §2.5 completion marker: colocated with the partition it describes.
export function donePath(parquetPath: string): string {
  return `${parquetPath}.done`;
}

// Spec §2.5: {dataRoot}/hygiene/{venue}/{symbol}/{YYYY-MM-DD}.json
export function hygienePath(dataRoot: string, venue: string, symbol: string, day: UtcDay): string {
  return join(dataRoot, 'hygiene', venue, symbol, `${formatDay(day)}.json`);
}

// Spec §2.5: {dataRoot}/meta/{venue}/{symbol}/
export function metaDir(dataRoot: string, venue: string, symbol: string): string {
  return join(dataRoot, 'meta', venue, symbol);
}

// Spec §2.1 invariant 1: a venue whose archive lacks the explicit taker-side
// field is marked unusable (A-101): {dataRoot}/meta/{venue}/unusable.json
export function venueUnusablePath(dataRoot: string, venue: string): string {
  return join(dataRoot, 'meta', venue, 'unusable.json');
}

export function instrumentHistoryPath(dataRoot: string, venue: string, symbol: string): string {
  return join(metaDir(dataRoot, venue, symbol), 'instrument_history.json');
}

export function fundingPath(dataRoot: string, venue: string, symbol: string): string {
  return join(metaDir(dataRoot, venue, symbol), 'funding.parquet');
}

// Downloaded venue archives (transient; removed once every planned day using
// them is done): {dataRoot}/cache/{venue}/{cacheKey}
export function cachePath(dataRoot: string, venue: string, cacheKey: string): string {
  return join(dataRoot, 'cache', venue, cacheKey);
}
