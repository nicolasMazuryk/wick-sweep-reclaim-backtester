import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DoneMarkerSchema, type DoneMarker } from './done-marker.js';
import type { TradeColumns } from './columns.js';
import { merge, mergeColumns, type MergedColumns, type MergedRecord, type MergeOptions, type RawMergeInput } from './merge.js';
import { donePath, partitionPath } from './paths.js';
import {
  writeMergedParquet,
  writeMergedParquetColumns,
  writeRawParquet,
  writeRawParquetColumns,
  type MergedParquetRow,
  type RawParquetRow,
} from './parquet.js';
import { SCHEMA_VERSION } from './schema.js';
import type { UtcDay } from './venue.js';

// Spec §2.5 append-only rule: write to a sibling tmp path, then atomically
// rename into place, so a crash mid-write never leaves a partial partition
// file at the final path.
export async function atomicWriteFile(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(tmpPath, data);
  await rename(tmpPath, path);
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface WritePartitionInput {
  readonly dataRoot: string;
  readonly venue: string;
  readonly symbol: string;
  readonly day: UtcDay;
  readonly rawRows: readonly RawParquetRow[];
  readonly mergeOptions?: MergeOptions;
  readonly source: DoneMarker['source'];
  readonly checksumVerified: boolean;
  readonly adapterVersion: string;
  // Caller override for the .done marker's timestamp; defaults to now.
  // Nothing else written by this function may depend on wall-clock time.
  readonly fetchedAt?: string;
}

export interface WritePartitionResult {
  readonly rawPath: string;
  readonly mergedPath: string;
  readonly donePath: string;
  readonly midnightSplit: boolean;
  readonly marker: DoneMarker;
}

export async function writePartition(input: WritePartitionInput): Promise<WritePartitionResult> {
  const mergeInput: RawMergeInput[] = input.rawRows.map((row) => ({
    t: row.t,
    seq: row.seq,
    p: row.p,
    q: row.q,
    s: row.s,
  }));
  const { records, midnightSplit } = merge(mergeInput, input.mergeOptions);
  const mergedRows: MergedParquetRow[] = records.map((record) => ({
    ...record,
    venue: input.venue,
    symbol: input.symbol,
  }));

  const rawBytes = writeRawParquet(input.rawRows);
  const mergedBytes = writeMergedParquet(mergedRows);

  const rawPath = partitionPath(input.dataRoot, 'raw', input.venue, input.symbol, input.day);
  const mergedPath = partitionPath(input.dataRoot, 'merged', input.venue, input.symbol, input.day);
  const markerPath = donePath(mergedPath);

  await atomicWriteFile(rawPath, rawBytes);
  await atomicWriteFile(mergedPath, mergedBytes);

  const marker = DoneMarkerSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    rowsRaw: input.rawRows.length,
    rowsMerged: mergedRows.length,
    sha256Raw: sha256Hex(rawBytes),
    sha256Merged: sha256Hex(mergedBytes),
    source: input.source,
    checksumVerified: input.checksumVerified,
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    adapterVersion: input.adapterVersion,
    ...boundaryRecords(records.length === 0 ? undefined : { first: records[0]!, last: records[records.length - 1]! }),
  });
  await atomicWriteFile(markerPath, Buffer.from(JSON.stringify(marker)));

  return { rawPath, mergedPath, donePath: markerPath, midnightSplit, marker };
}

type Boundary = Pick<MergedRecord, 'p' | 'pFirst' | 's'>;

export function boundaryRecords(bounds: { readonly first: Boundary; readonly last: Boundary } | undefined): Pick<DoneMarker, 'mergedFirst' | 'mergedLast'> {
  if (bounds === undefined) {
    return {};
  }
  return { mergedFirst: { p: bounds.first.pFirst, s: bounds.first.s }, mergedLast: { p: bounds.last.p, s: bounds.last.s } };
}

export function mergedBoundaries(merged: MergedColumns): Pick<DoneMarker, 'mergedFirst' | 'mergedLast'> {
  const last = merged.length - 1;
  if (last < 0) {
    return {};
  }
  const at = (k: number): Boundary => ({ p: merged.p[k]!, pFirst: merged.pFirst[k]!, s: merged.s[k]! as 1 | -1 });
  return boundaryRecords({ first: at(0), last: at(last) });
}

export interface WritePartitionColumnsInput {
  readonly dataRoot: string;
  readonly venue: string;
  readonly symbol: string;
  readonly day: UtcDay;
  // Every normalised record, in delivery order (the raw partition keeps all).
  readonly raw: TradeColumns;
  // 1 = enters the merge. The fetch pipeline clears dropped duplicates and
  // bad prints (Spec §2.6.1); default: all records.
  readonly keep?: Uint8Array;
  readonly source: DoneMarker['source'];
  readonly checksumVerified: boolean;
  readonly adapterVersion: string;
  readonly fetchedAt?: string;
  // Archive-file sha256s of the payload (Spec §2.5 "Checksums", A-100).
  readonly sha256Payload?: DoneMarker['sha256Payload'];
  // Fingerprint of the instrument-meta grid the day was normalised with (A-103).
  readonly sha256Meta?: string;
  // Runs after both Parquet files are in place and before the .done marker,
  // so side outputs (the hygiene report) exist whenever .done does.
  readonly beforeMarker?: (merged: MergedColumns) => Promise<void>;
}

export interface WritePartitionColumnsResult {
  readonly rawPath: string;
  readonly mergedPath: string;
  readonly donePath: string;
  readonly marker: DoneMarker;
  readonly merged: MergedColumns;
}

// Columnar writePartition (Spec §2.5): raw + merged Parquet, then .done.
export async function writePartitionColumns(input: WritePartitionColumnsInput): Promise<WritePartitionColumnsResult> {
  const merged = mergeColumns(input.raw, input.keep);
  const rawBytes = await writeRawParquetColumns(input.venue, input.symbol, input.raw);
  const mergedBytes = await writeMergedParquetColumns(input.venue, input.symbol, merged);

  const rawPath = partitionPath(input.dataRoot, 'raw', input.venue, input.symbol, input.day);
  const mergedPath = partitionPath(input.dataRoot, 'merged', input.venue, input.symbol, input.day);
  const markerPath = donePath(mergedPath);

  await atomicWriteFile(rawPath, rawBytes);
  await atomicWriteFile(mergedPath, mergedBytes);
  await input.beforeMarker?.(merged);

  const marker = DoneMarkerSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    rowsRaw: input.raw.length,
    rowsMerged: merged.length,
    sha256Raw: sha256Hex(rawBytes),
    sha256Merged: sha256Hex(mergedBytes),
    source: input.source,
    checksumVerified: input.checksumVerified,
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    adapterVersion: input.adapterVersion,
    ...mergedBoundaries(merged),
    ...(input.sha256Payload === undefined ? {} : { sha256Payload: input.sha256Payload }),
    ...(input.sha256Meta === undefined ? {} : { sha256Meta: input.sha256Meta }),
  });
  await atomicWriteFile(markerPath, Buffer.from(JSON.stringify(marker)));
  return { rawPath, mergedPath, donePath: markerPath, marker, merged };
}
