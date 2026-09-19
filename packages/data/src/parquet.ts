import type { Side } from '@wsr/core';
import {
  Bool,
  Field,
  Float64,
  Int8,
  Int32,
  Int64,
  Schema as ArrowSchema,
  Table as ArrowTable,
  Utf8,
  makeData,
  makeVector,
  tableFromIPC,
  tableToIPC,
  vectorFromArray,
  type Dictionary,
  type Schema,
  type Vector,
} from 'apache-arrow';
import {
  Compression,
  Encoding,
  ParquetFile,
  type RecordBatch as WasmRecordBatch,
  Table as WasmTable,
  WriterPropertiesBuilder,
  readParquet,
  transformParquetStream,
  writeParquet,
} from 'parquet-wasm';
import { fromBigInt64, toBigInt64, type TradeColumns } from './columns.js';
import type { MergedColumns, MergedRecord } from './merge.js';
import { SCHEMA_VERSION, SCHEMA_VERSION_METADATA_KEY, buildFundingSchema, buildMergedSchema, buildRawSchema } from './schema.js';
import type { FundingRecord } from './venue.js';

// venue/symbol are plain strings here, not @wsr/core's VenueId: the storage
// layer is venue-agnostic (see merge.ts) and this lets tests use a
// placeholder id without tripping wsr/no-venue-literal.
export interface RawParquetRow {
  readonly venue: string;
  readonly symbol: string;
  readonly tradeId: string;
  readonly t: number;
  readonly tNsRemainder: number;
  readonly seq: number;
  readonly p: number;
  readonly q: number;
  readonly s: Side;
}

export interface MergedParquetRow extends MergedRecord {
  readonly venue: string;
  readonly symbol: string;
}

function buildWriterProperties() {
  // parquet-wasm 0.8.0's WriterPropertiesBuilder exposes setCompression /
  // setColumnEncoding / setColumnDictionaryEnabled but no ZSTD compression
  // *level* control (checked node/parquet_wasm.d.ts: no such method exists)
  // [VERIFY against a future parquet-wasm release] — the crate's default
  // ZSTD level is used instead of the spec's literal "level 3". Dictionary
  // encoding on venue/symbol and delta-binary-packing on t/seq/p (Spec §2.5)
  // are both controllable via this API and set explicitly below.
  //
  // writeParquet() consumes (frees) both the Table and these WriterProperties
  // it is given, so this must be called fresh for every write — never shared
  // across calls.
  return new WriterPropertiesBuilder()
    .setCreatedBy('wsr-data') // static string: Parquet metadata must carry no wall-clock content (Spec §2.5 determinism)
    .setCompression(Compression.ZSTD)
    .setMaxRowGroupSize(ROW_GROUP_ROWS)
    .setDictionaryEnabled(false)
    .setColumnDictionaryEnabled('venue', true)
    .setColumnDictionaryEnabled('symbol', true)
    .setColumnEncoding('t', Encoding.DELTA_BINARY_PACKED)
    .setColumnEncoding('seq', Encoding.DELTA_BINARY_PACKED)
    .setColumnEncoding('p', Encoding.DELTA_BINARY_PACKED)
    .build();
}

const ROW_GROUP_ROWS = 1_048_576;

function encode(table: ArrowTable): Uint8Array {
  const ipc = tableToIPC(table, 'stream');
  const wasmTable = WasmTable.fromIPCStream(ipc);
  return writeParquet(wasmTable, buildWriterProperties());
}

// Streams row-group-sized slices through the Parquet writer so wasm memory is
// bounded by one row group instead of the whole partition (a 5.8 M-row day
// otherwise peaks at ~4 GB RSS). `slice(start, end)` builds that range's table.
async function encodeChunked(schema: Schema, length: number, slice: (start: number, end: number) => ArrowTable): Promise<Uint8Array> {
  if (length === 0) {
    return encode(new ArrowTable(schema));
  }
  let start = 0;
  const batches = new ReadableStream({
    pull(controller) {
      if (start >= length) {
        controller.close();
        return;
      }
      const end = Math.min(length, start + ROW_GROUP_ROWS);
      const wasmTable = WasmTable.fromIPCStream(tableToIPC(slice(start, end), 'stream'));
      try {
        for (const batch of wasmTable.recordBatches()) {
          controller.enqueue(batch);
        }
      } finally {
        wasmTable.free();
      }
      start = end;
    },
  });
  const output = await transformParquetStream(batches, buildWriterProperties());
  const parts: Uint8Array[] = [];
  for await (const part of output as unknown as AsyncIterable<Uint8Array>) {
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function checkSchemaVersion(metadata: Map<string, string>): void {
  const version = metadata.get(SCHEMA_VERSION_METADATA_KEY);
  if (version !== String(SCHEMA_VERSION)) {
    throw new Error(`Parquet schemaVersion mismatch: expected ${SCHEMA_VERSION}, got ${version ?? 'undefined'}`);
  }
}

function decode(bytes: Uint8Array): ArrowTable {
  const wasmTable = readParquet(bytes);
  checkSchemaVersion(wasmTable.schema.metadata());
  return tableFromIPC(wasmTable.intoIPCStream());
}

export function writeRawParquet(rows: readonly RawParquetRow[]): Uint8Array {
  const schema = buildRawSchema();
  // venue/symbol get their own Dictionary DataType instance each (from the
  // field's own type, per schema.ts) — sharing one Dictionary object across
  // columns makes apache-arrow collide their dictionary ids.
  const table = new ArrowTable(schema, {
    venue: vectorFromArray(
      rows.map((r) => r.venue),
      schema.fields[0]!.type,
    ),
    symbol: vectorFromArray(
      rows.map((r) => r.symbol),
      schema.fields[1]!.type,
    ),
    tradeId: vectorFromArray(rows.map((r) => r.tradeId), new Utf8()),
    t: vectorFromArray(
      rows.map((r) => BigInt(r.t)),
      new Int64(),
    ),
    tNsRemainder: vectorFromArray(
      rows.map((r) => r.tNsRemainder),
      new Int32(),
    ),
    seq: vectorFromArray(
      rows.map((r) => BigInt(r.seq)),
      new Int64(),
    ),
    p: vectorFromArray(
      rows.map((r) => BigInt(r.p)),
      new Int64(),
    ),
    q: vectorFromArray(
      rows.map((r) => BigInt(r.q)),
      new Int64(),
    ),
    s: vectorFromArray(
      rows.map((r) => r.s),
      new Int8(),
    ),
  });
  return encode(table);
}

export function writeMergedParquet(rows: readonly MergedParquetRow[]): Uint8Array {
  const schema = buildMergedSchema();
  const table = new ArrowTable(schema, {
    venue: vectorFromArray(
      rows.map((r) => r.venue),
      schema.fields[0]!.type,
    ),
    symbol: vectorFromArray(
      rows.map((r) => r.symbol),
      schema.fields[1]!.type,
    ),
    t: vectorFromArray(
      rows.map((r) => BigInt(r.t)),
      new Int64(),
    ),
    seq: vectorFromArray(
      rows.map((r) => BigInt(r.seq)),
      new Int64(),
    ),
    p: vectorFromArray(
      rows.map((r) => BigInt(r.p)),
      new Int64(),
    ),
    q: vectorFromArray(
      rows.map((r) => BigInt(r.q)),
      new Int64(),
    ),
    s: vectorFromArray(
      rows.map((r) => r.s),
      new Int8(),
    ),
    n: vectorFromArray(
      rows.map((r) => r.n),
      new Int32(),
    ),
    pFirst: vectorFromArray(
      rows.map((r) => BigInt(r.pFirst)),
      new Int64(),
    ),
    rawSeqFirst: vectorFromArray(
      rows.map((r) => BigInt(r.rawSeqFirst)),
      new Int64(),
    ),
  });
  return encode(table);
}

export function readRawParquet(bytes: Uint8Array): RawParquetRow[] {
  const table = decode(bytes);
  const rows: RawParquetRow[] = [];
  for (const row of table) {
    if (row === null) {
      continue;
    }
    rows.push({
      venue: row.venue as string,
      symbol: row.symbol as string,
      tradeId: row.tradeId as string,
      t: Number(row.t as bigint),
      tNsRemainder: row.tNsRemainder as number,
      seq: Number(row.seq as bigint),
      p: Number(row.p as bigint),
      q: Number(row.q as bigint),
      s: row.s as Side,
    });
  }
  return rows;
}

export function readMergedParquet(bytes: Uint8Array): MergedParquetRow[] {
  const table = decode(bytes);
  const rows: MergedParquetRow[] = [];
  for (const row of table) {
    if (row === null) {
      continue;
    }
    rows.push({
      venue: row.venue as string,
      symbol: row.symbol as string,
      t: Number(row.t as bigint),
      seq: Number(row.seq as bigint),
      p: Number(row.p as bigint),
      q: Number(row.q as bigint),
      s: row.s as Side,
      n: row.n as number,
      pFirst: Number(row.pFirst as bigint),
      rawSeqFirst: Number(row.rawSeqFirst as bigint),
    });
  }
  return rows;
}

export function writeFundingParquet(rows: readonly FundingRecord[]): Uint8Array {
  const schema = buildFundingSchema();
  if (rows.length === 0) {
    // A zero-length column set yields a batch whose (nullable) fields differ
    // from the schema; a batch-less table encodes the schema alone.
    return encode(new ArrowTable(schema));
  }
  const table = new ArrowTable(schema, {
    t: makeVector(BigInt64Array.from(rows, (r) => BigInt(r.t))),
    rate: makeVector(Float64Array.from(rows, (r) => r.rate)),
  });
  return encode(table);
}

export function readFundingParquet(bytes: Uint8Array): FundingRecord[] {
  const table = decode(bytes);
  const rows: FundingRecord[] = [];
  for (const row of table) {
    if (row === null) {
      continue;
    }
    rows.push({ t: Number(row.t as bigint), rate: row.rate as number });
  }
  return rows;
}

// Single-value dictionary column (one partition = one venue/symbol) built
// from an all-zero index array instead of n string references.
function constantDictionary(type: Dictionary, value: string, length: number): Vector {
  const dictionary = vectorFromArray([value], new Utf8());
  return makeVector(makeData({ type, length, nullCount: 0, data: new Int32Array(length), dictionary }));
}

export function writeRawParquetColumns(venue: string, symbol: string, cols: TradeColumns): Promise<Uint8Array> {
  const schema = buildRawSchema();
  return encodeChunked(schema, cols.length, (start, end) => {
    const n = end - start;
    return new ArrowTable(schema, {
      venue: constantDictionary(schema.fields[0]!.type as Dictionary, venue, n),
      symbol: constantDictionary(schema.fields[1]!.type as Dictionary, symbol, n),
      tradeId: vectorFromArray(cols.tradeId.slice(start, end), new Utf8()),
      t: makeVector(toBigInt64(cols.t.subarray(start, end))),
      tNsRemainder: makeVector(cols.tNsRemainder.slice(start, end)),
      seq: makeVector(toBigInt64(cols.seq.subarray(start, end))),
      p: makeVector(toBigInt64(cols.p.subarray(start, end))),
      q: makeVector(toBigInt64(cols.q.subarray(start, end))),
      s: makeVector(cols.s.slice(start, end)),
    });
  });
}

export function writeMergedParquetColumns(venue: string, symbol: string, cols: MergedColumns): Promise<Uint8Array> {
  const schema = buildMergedSchema();
  return encodeChunked(schema, cols.length, (start, end) => {
    const n = end - start;
    const seq = new Float64Array(n);
    for (let k = 0; k < n; k += 1) {
      seq[k] = start + k;
    }
    return new ArrowTable(schema, {
      venue: constantDictionary(schema.fields[0]!.type as Dictionary, venue, n),
      symbol: constantDictionary(schema.fields[1]!.type as Dictionary, symbol, n),
      t: makeVector(toBigInt64(cols.t.subarray(start, end))),
      seq: makeVector(toBigInt64(seq)),
      p: makeVector(toBigInt64(cols.p.subarray(start, end))),
      q: makeVector(toBigInt64(cols.q.subarray(start, end))),
      s: makeVector(cols.s.slice(start, end)),
      n: makeVector(cols.n.slice(start, end)),
      pFirst: makeVector(toBigInt64(cols.pFirst.subarray(start, end))),
      rawSeqFirst: makeVector(toBigInt64(cols.rawSeqFirst.subarray(start, end))),
    });
  });
}

function int64Column(table: ArrowTable, name: string): Float64Array {
  return fromBigInt64(table.getChild(name)!.toArray() as BigInt64Array);
}

export function readRawParquetColumns(bytes: Uint8Array): TradeColumns {
  const table = decode(bytes);
  const tradeId: string[] = [];
  for (const value of table.getChild('tradeId')!) {
    tradeId.push(value as string);
  }
  return {
    length: table.numRows,
    tradeId,
    t: int64Column(table, 't'),
    tNsRemainder: Int32Array.from(table.getChild('tNsRemainder')!.toArray() as Int32Array),
    seq: int64Column(table, 'seq'),
    p: int64Column(table, 'p'),
    q: int64Column(table, 'q'),
    s: Int8Array.from(table.getChild('s')!.toArray() as Int8Array),
  };
}

// Stored merged day as read back: the writer's columns plus `seq` (index in
// the merged day, Spec §2.3.1).
export interface StoredMergedColumns extends MergedColumns {
  readonly seq: Float64Array;
}

function mergedColumns(table: ArrowTable): StoredMergedColumns {
  return {
    length: table.numRows,
    t: int64Column(table, 't'),
    seq: int64Column(table, 'seq'),
    p: int64Column(table, 'p'),
    q: int64Column(table, 'q'),
    s: Int8Array.from(table.getChild('s')!.toArray() as Int8Array),
    n: Int32Array.from(table.getChild('n')!.toArray() as Int32Array),
    pFirst: int64Column(table, 'pFirst'),
    rawSeqFirst: int64Column(table, 'rawSeqFirst'),
  };
}

export function readMergedParquetColumns(bytes: Uint8Array): StoredMergedColumns {
  return mergedColumns(decode(bytes));
}

// Spec §10 "Streaming replay": a merged partition is decoded as Arrow record
// batches of at most this many rows, never as one whole-day table (a 5.8 M-row
// day would otherwise hold ~370 MB of columns at once). It equals the writer's
// row-group size, so one batch is one row group.
export const MERGED_BATCH_ROWS = ROW_GROUP_ROWS;

// One merged partition opened for batch decoding. `rows` comes from the
// Parquet footer, so a row-count check runs before any row is decoded.
export interface MergedPartitionReader {
  readonly rows: number;
  batches(): AsyncIterableIterator<StoredMergedColumns>;
  close(): void;
}

export async function openMergedParquet(bytes: Uint8Array, batchRows: number = MERGED_BATCH_ROWS): Promise<MergedPartitionReader> {
  if (!Number.isInteger(batchRows) || batchRows < 1 || batchRows > MERGED_BATCH_ROWS) {
    throw new Error(`openMergedParquet: batchRows ${batchRows} is not in 1…${MERGED_BATCH_ROWS}`);
  }
  // parquet-wasm reads a Blob lazily: only the batch being decoded lives in
  // wasm memory. The Blob copies the file bytes (compressed), not the columns.
  const file = await ParquetFile.fromFile(new Blob([bytes as Uint8Array<ArrayBuffer>]));
  const schema = file.schema();
  try {
    checkSchemaVersion(schema.metadata());
  } finally {
    schema.free();
  }
  const metadata = file.metadata();
  const fileMetadata = metadata.fileMetadata();
  const rows = fileMetadata.numRows();
  fileMetadata.free();
  metadata.free();
  async function* batches(): AsyncIterableIterator<StoredMergedColumns> {
    const stream = (await file.stream({ batchSize: batchRows })) as ReadableStream<WasmRecordBatch>;
    const reader = stream.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done === true) break;
      // intoIPCStream consumes the wasm batch; the JS table is the only copy left.
      yield mergedColumns(tableFromIPC(next.value.intoIPCStream()));
    }
  }
  return { rows, batches, close: () => { file.free(); } };
}

// Generic output table (run outputs, Spec §7.1): one entry per column.
// Every column is nullable; a non-finite number in an int/float column is
// written as null ('float' keeps NaN out of the file too).
export type RecordColumnType = 'int' | 'float' | 'bool' | 'utf8';
export interface RecordColumn {
  readonly name: string;
  readonly type: RecordColumnType;
  readonly values: ReadonlyArray<number | boolean | string | null>;
}

function recordVector(c: RecordColumn): Vector {
  const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  switch (c.type) {
    case 'int':
      return vectorFromArray(c.values.map((v) => {
        const x = finite(v);
        if (x !== null && !Number.isInteger(x)) throw new Error(`writeRecordsParquet: column ${c.name} value ${x} is not an integer`);
        return x === null ? null : BigInt(x);
      }), new Int64());
    case 'float':
      return vectorFromArray(c.values.map(finite), new Float64());
    case 'bool':
      return vectorFromArray(c.values.map((v) => (typeof v === 'boolean' ? v : null)), new Bool());
    case 'utf8':
      return vectorFromArray(c.values.map((v) => (v === null ? null : String(v))), new Utf8());
  }
}

const RECORD_TYPES: Record<RecordColumnType, () => Int64 | Float64 | Bool | Utf8> = {
  int: () => new Int64(), float: () => new Float64(), bool: () => new Bool(), utf8: () => new Utf8(),
};

// Deterministic Parquet (no timestamps; fixed created-by, Spec §9.2) with
// the given key-value metadata (e.g. wsr.configHash, wsr.seed, wsr.runId, Spec §8.3).
export function writeRecordsParquet(columns: ReadonlyArray<RecordColumn>, kv: Readonly<Record<string, string>>): Uint8Array {
  const length = columns[0]?.values.length ?? 0;
  for (const c of columns) {
    if (c.values.length !== length) throw new Error(`writeRecordsParquet: column ${c.name} has ${c.values.length} values, expected ${length}`);
  }
  const metadata = new Map(Object.keys(kv).sort().map((k) => [k, kv[k]!]));
  const schema = new ArrowSchema(columns.map((c) => new Field(c.name, RECORD_TYPES[c.type](), true)), metadata);
  const table = length === 0
    ? new ArrowTable(schema)
    : new ArrowTable(schema, Object.fromEntries(columns.map((c) => [c.name, recordVector(c)])));
  const ipc = tableToIPC(table, 'stream');
  const props = new WriterPropertiesBuilder()
    .setCreatedBy('wsr-backtest')
    .setCompression(Compression.ZSTD)
    .setMaxRowGroupSize(ROW_GROUP_ROWS)
    .setDictionaryEnabled(false)
    .build();
  return writeParquet(WasmTable.fromIPCStream(ipc), props);
}

// Reads a writeRecordsParquet file back: key-value metadata and rows as plain objects (int64 → number).
export function readRecordsParquet(bytes: Uint8Array): { metadata: Map<string, string>; rows: Record<string, unknown>[] } {
  const wasmTable = readParquet(bytes);
  const metadata = wasmTable.schema.metadata();
  const table = tableFromIPC(wasmTable.intoIPCStream());
  const rows: Record<string, unknown>[] = [];
  for (const row of table) {
    if (row === null) continue;
    const obj: Record<string, unknown> = {};
    for (const f of table.schema.fields) {
      const v = (row as unknown as Record<string, unknown>)[f.name];
      obj[f.name] = typeof v === 'bigint' ? Number(v) : v;
    }
    rows.push(obj);
  }
  return { metadata, rows };
}
