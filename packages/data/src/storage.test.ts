import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDoneMarker } from './done-marker.js';
import { readMergedParquet, readRawParquet, type RawParquetRow } from './parquet.js';
import { atomicWriteFile, sha256Hex, writePartition } from './storage.js';

const rawRows: RawParquetRow[] = [
  { venue: 'testvenue', symbol: 'ETHUSDT', tradeId: '1', t: 1000, tNsRemainder: 0, seq: 0, p: 100, q: 1, s: 1 },
  { venue: 'testvenue', symbol: 'ETHUSDT', tradeId: '2', t: 1000, tNsRemainder: 0, seq: 1, p: 101, q: 2, s: 1 },
  { venue: 'testvenue', symbol: 'ETHUSDT', tradeId: '3', t: 2000, tNsRemainder: 0, seq: 2, p: 50, q: 3, s: -1 },
];

describe('sha256Hex', () => {
  it('is deterministic for the same bytes', () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(sha256Hex(data)).toBe(sha256Hex(data));
  });

  it('differs for different bytes', () => {
    expect(sha256Hex(new Uint8Array([1]))).not.toBe(sha256Hex(new Uint8Array([2])));
  });
});

describe('atomicWriteFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wsr-storage-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates parent directories and writes the final file (no leftover tmp files)', async () => {
    const path = join(dir, 'a', 'b', 'c.bin');
    await atomicWriteFile(path, new Uint8Array([1, 2, 3]));
    expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3]));
  });
});

describe('writePartition', () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'wsr-partition-'));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('writes raw + merged parquet and a valid .done marker, end-to-end', async () => {
    const result = await writePartition({
      dataRoot,
      venue: 'testvenue',
      symbol: 'ETHUSDT',
      day: { y: 2025, m: 3, d: 1 },
      rawRows,
      source: 'archive',
      checksumVerified: true,
      adapterVersion: '1.0.0',
      fetchedAt: '2025-03-02T00:00:00.000Z',
    });

    const rawBytes = await readFile(result.rawPath);
    const mergedBytes = await readFile(result.mergedPath);
    expect(readRawParquet(rawBytes)).toEqual(rawRows);

    const mergedRows = readMergedParquet(mergedBytes);
    expect(mergedRows).toEqual([
      { venue: 'testvenue', symbol: 'ETHUSDT', t: 1000, seq: 0, p: 101, q: 3, s: 1, n: 2, pFirst: 100, rawSeqFirst: 0 },
      { venue: 'testvenue', symbol: 'ETHUSDT', t: 2000, seq: 1, p: 50, q: 3, s: -1, n: 1, pFirst: 50, rawSeqFirst: 2 },
    ]);

    const marker = await readDoneMarker(result.donePath);
    expect(marker).toEqual({
      schemaVersion: 1,
      rowsRaw: 3,
      rowsMerged: 2,
      sha256Raw: sha256Hex(rawBytes),
      sha256Merged: sha256Hex(mergedBytes),
      source: 'archive',
      checksumVerified: true,
      fetchedAt: '2025-03-02T00:00:00.000Z',
      adapterVersion: '1.0.0',
      mergedFirst: { p: 100, s: 1 },
      mergedLast: { p: 50, s: -1 },
    });
    expect(result.midnightSplit).toBe(false);
  });

  it('writes byte-identical merged Parquet for the same input across two independent runs', async () => {
    const write = () =>
      writePartition({
        dataRoot,
        venue: 'testvenue',
        symbol: 'ETHUSDT',
        day: { y: 2025, m: 3, d: 1 },
        rawRows,
        source: 'archive',
        checksumVerified: true,
        adapterVersion: '1.0.0',
        fetchedAt: '2025-03-02T00:00:00.000Z',
      });

    const first = await write();
    const firstBytes = await readFile(first.mergedPath);
    const second = await write();
    const secondBytes = await readFile(second.mergedPath);

    expect(Buffer.compare(firstBytes, secondBytes)).toBe(0);
  });
});
