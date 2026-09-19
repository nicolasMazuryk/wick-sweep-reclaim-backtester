import { Field, Int64, Schema, Table as ArrowTable, tableFromIPC, tableToIPC, vectorFromArray } from 'apache-arrow';
import { Table as WasmTable, readParquet, writeParquet } from 'parquet-wasm';
import { describe, expect, it } from 'vitest';
import type { MergedParquetRow, RawParquetRow, RecordColumn } from './parquet.js';
import {
  MERGED_BATCH_ROWS, openMergedParquet, readMergedParquet, readMergedParquetColumns, readRawParquet, readRecordsParquet,
  writeMergedParquet, writeMergedParquetColumns, writeRawParquet, writeRecordsParquet,
} from './parquet.js';

const rawRows: RawParquetRow[] = [
  { venue: 'testvenue', symbol: 'ETHUSDT', tradeId: '1', t: 1_700_000_000_000, tNsRemainder: 0, seq: 0, p: 100, q: 5, s: 1 },
  { venue: 'testvenue', symbol: 'ETHUSDT', tradeId: '2', t: 1_700_000_000_500, tNsRemainder: 250, seq: 1, p: 101, q: 6, s: -1 },
  { venue: 'testvenue', symbol: 'BTCUSDT', tradeId: '3', t: 1_700_000_001_000, tNsRemainder: 0, seq: 2, p: 99, q: 7, s: 1 },
];

const mergedRows: MergedParquetRow[] = [
  { venue: 'testvenue', symbol: 'ETHUSDT', t: 1_700_000_000_000, seq: 0, p: 103, q: 6, s: 1, n: 3, pFirst: 100, rawSeqFirst: 0 },
  { venue: 'testvenue', symbol: 'ETHUSDT', t: 1_700_000_000_500, seq: 1, p: 90, q: 4, s: -1, n: 2, pFirst: 95, rawSeqFirst: 3 },
];

describe('raw parquet', () => {
  it('round-trips rows exactly', () => {
    const bytes = writeRawParquet(rawRows);
    expect(readRawParquet(bytes)).toEqual(rawRows);
  });

  it('produces byte-identical output for identical input (determinism)', () => {
    const b1 = Buffer.from(writeRawParquet(rawRows));
    const b2 = Buffer.from(writeRawParquet(rawRows));
    expect(Buffer.compare(b1, b2)).toBe(0);
  });

  it('embeds no timestamp-shaped metadata values', () => {
    const bytes = writeRawParquet(rawRows);
    const metadata = readParquet(bytes).schema.metadata();
    for (const value of metadata.values()) {
      expect(value).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('preserves dictionary encoding on venue and symbol', () => {
    const bytes = writeRawParquet(rawRows);
    const arrowTable = tableFromIPC(readParquet(bytes).intoIPCStream());
    const venueField = arrowTable.schema.fields.find((f) => f.name === 'venue');
    const symbolField = arrowTable.schema.fields.find((f) => f.name === 'symbol');
    expect(venueField?.type.toString()).toMatch(/^Dictionary/);
    expect(symbolField?.type.toString()).toMatch(/^Dictionary/);
  });
});

describe('merged parquet', () => {
  it('round-trips rows exactly', () => {
    const bytes = writeMergedParquet(mergedRows);
    expect(readMergedParquet(bytes)).toEqual(mergedRows);
  });

  it('produces byte-identical output for identical input (determinism)', () => {
    const b1 = Buffer.from(writeMergedParquet(mergedRows));
    const b2 = Buffer.from(writeMergedParquet(mergedRows));
    expect(Buffer.compare(b1, b2)).toBe(0);
  });

  it('rejects a schemaVersion mismatch on read', () => {
    const wrongVersionSchema = new Schema(
      [new Field('t', new Int64(), false)],
      new Map([['wsr.schemaVersion', '999']]),
    );
    const table = new ArrowTable(wrongVersionSchema, { t: vectorFromArray([1n], new Int64()) });
    const wasmTable = WasmTable.fromIPCStream(tableToIPC(table, 'stream'));
    const bytes = writeParquet(wasmTable);
    expect(() => readMergedParquet(bytes)).toThrow(/schemaVersion mismatch/);
  });
});

// Spec §10 "Streaming replay": merged partitions are decoded as ≤ 1 M-row
// record batches, never as one whole-day table.
describe('openMergedParquet (batch decode, Spec §10)', () => {
  const N = 2_500;
  const cols = {
    length: N,
    t: Float64Array.from({ length: N }, (_, i) => 1_700_000_000_000 + i),
    p: Float64Array.from({ length: N }, (_, i) => i - 1_000),
    q: Float64Array.from({ length: N }, (_, i) => 1 + (i % 7)),
    s: Int8Array.from({ length: N }, (_, i) => (i % 2 === 0 ? 1 : -1)),
    n: Int32Array.from({ length: N }, (_, i) => 1 + (i % 3)),
    pFirst: Float64Array.from({ length: N }, (_, i) => i - 1_001),
    rawSeqFirst: Float64Array.from({ length: N }, (_, i) => 2 * i),
  };
  const partition = async (): Promise<Uint8Array> => writeMergedParquetColumns('testvenue', 'ETHUSDT', cols);

  it('yields the whole partition in batches of at most batchRows, identical to the one-shot read', async () => {
    const bytes = await partition();
    const whole = readMergedParquetColumns(bytes);
    const reader = await openMergedParquet(bytes, 1_000);
    expect(reader.rows).toBe(N);                 // footer row count, before any decode
    const sizes: number[] = [];
    let at = 0;
    for await (const batch of reader.batches()) {
      sizes.push(batch.length);
      expect(batch.length).toBeLessThanOrEqual(1_000);
      for (let i = 0; i < batch.length; i++) {
        expect([batch.t[i], batch.seq[i], batch.p[i], batch.q[i], batch.s[i], batch.n[i], batch.pFirst[i], batch.rawSeqFirst[i]])
          .toEqual([whole.t[at], whole.seq[at], whole.p[at], whole.q[at], whole.s[at], whole.n[at], whole.pFirst[at], whole.rawSeqFirst[at]]);
        at++;
      }
    }
    reader.close();
    expect(at).toBe(N);
    expect(sizes).toEqual([1_000, 1_000, 500]);
  });

  it('defaults to one 1 M-row batch per row group and refuses a larger cap', async () => {
    expect(MERGED_BATCH_ROWS).toBe(1_048_576);
    const bytes = await partition();
    const reader = await openMergedParquet(bytes);
    const sizes: number[] = [];
    for await (const batch of reader.batches()) sizes.push(batch.length);
    reader.close();
    expect(sizes).toEqual([N]);
    await expect(openMergedParquet(bytes, MERGED_BATCH_ROWS + 1)).rejects.toThrow(/batchRows/);
    await expect(openMergedParquet(bytes, 0)).rejects.toThrow(/batchRows/);
  });

  it('rejects a schemaVersion mismatch before any batch is decoded', async () => {
    const wrongVersionSchema = new Schema([new Field('t', new Int64(), false)], new Map([['wsr.schemaVersion', '999']]));
    const table = new ArrowTable(wrongVersionSchema, { t: vectorFromArray([1n], new Int64()) });
    const bytes = writeParquet(WasmTable.fromIPCStream(tableToIPC(table, 'stream')));
    await expect(openMergedParquet(bytes)).rejects.toThrow(/schemaVersion mismatch/);
  });
});

describe('writeRecordsParquet (run outputs, Spec §7.1, §8.3)', () => {
  const columns: RecordColumn[] = [
    { name: 'id', type: 'int', values: [1, 2, null] },
    { name: 'x', type: 'float', values: [1.5, NaN, -0] },
    { name: 'ok', type: 'bool', values: [true, false, null] },
    { name: 'kind', type: 'utf8', values: ['stop', null, 'target'] },
  ];

  it('round-trips typed nullable columns and the key-value metadata; deterministic bytes regardless of kv key order', () => {
    const a = writeRecordsParquet(columns, { 'wsr.runId': 'r', 'wsr.seed': '1', 'wsr.configHash': 'h' });
    const b = writeRecordsParquet(columns, { 'wsr.configHash': 'h', 'wsr.seed': '1', 'wsr.runId': 'r' });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const back = readRecordsParquet(a);
    expect(Object.fromEntries(back.metadata)).toEqual({ 'wsr.configHash': 'h', 'wsr.runId': 'r', 'wsr.seed': '1' });
    expect(back.rows).toEqual([
      { id: 1, x: 1.5, ok: true, kind: 'stop' },
      { id: 2, x: null, ok: false, kind: null },
      { id: null, x: -0, ok: null, kind: 'target' },
    ]);
  });

  it('an empty table keeps its schema; ragged or non-integer int columns throw', () => {
    const empty = writeRecordsParquet(columns.map((c) => ({ ...c, values: [] })), { k: 'v' });
    expect(readRecordsParquet(empty).rows).toEqual([]);
    expect(() => writeRecordsParquet([{ name: 'a', type: 'int', values: [1] }, { name: 'b', type: 'int', values: [] }], {})).toThrow('expected 1');
    expect(() => writeRecordsParquet([{ name: 'a', type: 'int', values: [1.5] }], {})).toThrow('not an integer');
  });
});
