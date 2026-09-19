import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDoneMarker, readDoneMarker, type DoneMarker } from './done-marker.js';
import { atomicWriteFile } from './storage.js';

const validMarker: DoneMarker = {
  schemaVersion: 1,
  rowsRaw: 100,
  rowsMerged: 80,
  sha256Raw: 'a'.repeat(64),
  sha256Merged: 'b'.repeat(64),
  source: 'archive',
  checksumVerified: true,
  fetchedAt: '2025-03-01T00:00:00.000Z',
  adapterVersion: '1.0.0',
};

describe('parseDoneMarker', () => {
  it('round-trips a valid marker', () => {
    expect(parseDoneMarker(validMarker)).toEqual(validMarker);
  });

  it('accepts the payload sha256 list and still accepts markers without it (A-100)', () => {
    const withPayload = { ...validMarker, sha256Payload: [{ url: 'https://x/a.zip', sha256: 'c'.repeat(64) }] };
    expect(parseDoneMarker(withPayload)).toEqual(withPayload);
    expect(() => parseDoneMarker({ ...validMarker, sha256Payload: [{ url: 'https://x/a.zip', sha256: 'nope' }] })).toThrow();
  });

  it('rejects an unknown top-level key (strict schema)', () => {
    expect(() => parseDoneMarker({ ...validMarker, extra: true })).toThrow();
  });

  it('rejects a schemaVersion other than the current one', () => {
    expect(() => parseDoneMarker({ ...validMarker, schemaVersion: 2 })).toThrow();
  });

  it('rejects a malformed sha256 value', () => {
    expect(() => parseDoneMarker({ ...validMarker, sha256Raw: 'not-hex' })).toThrow();
  });

  it('rejects a missing required field', () => {
    const rest: Partial<DoneMarker> = { ...validMarker };
    delete rest.adapterVersion;
    expect(() => parseDoneMarker(rest)).toThrow();
  });
});

describe('readDoneMarker', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wsr-done-marker-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects a missing file', async () => {
    await expect(readDoneMarker(join(dir, 'nope.done'))).rejects.toThrow();
  });

  it('rejects malformed JSON', async () => {
    const path = join(dir, 'bad.done');
    await atomicWriteFile(path, Buffer.from('not json'));
    await expect(readDoneMarker(path)).rejects.toThrow();
  });

  it('round-trips through an atomic write', async () => {
    const path = join(dir, 'partition.done');
    await atomicWriteFile(path, Buffer.from(JSON.stringify(validMarker)));
    await expect(readDoneMarker(path)).resolves.toEqual(validMarker);
  });
});
