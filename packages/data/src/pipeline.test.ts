import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVenueAdapter, type VenueDefinition } from './adapter.js';
import { formatDay, parseDay } from './days.js';
import { readDoneMarker } from './done-marker.js';
import { readHygiene } from './hygiene.js';
import { createMetaHistory, readInstrumentHistory, writeInstrumentHistory } from './instrument-meta.js';
import { readFunding } from './funding.js';
import { readMergedParquetColumns, readRawParquetColumns } from './parquet.js';
import { donePath, instrumentHistoryPath, partitionPath, venueUnusablePath } from './paths.js';
import { fetchMeta, fetchPartitions, mergeStored, rebuildHygiene, verifyPartitions, type PartitionResult } from './pipeline.js';
import { fakeFetch, fileRoute, InstantClock, jsonRoute, textRoute, venueFixture, type Route } from './testing/fixtures.js';
import type { InstrumentMeta, VenueId } from './venue.js';
import { VENUES, VENUE_ORDER } from './venues/index.js';

// The first registry venue (the archive + .CHECKSUM one); referenced through
// the registry so this file stays free of venue literals.
const VENUE: VenueId = VENUE_ORDER[0]!;
const DAY = parseDay('2025-01-09');
const NEXT = parseDay('2025-01-10');
const FIXTURE_ZIP = venueFixture(VENUE, 'ETHUSDT-trades-2025-01-09.zip');

let dataRoot: string;
beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'wsr-pipeline-'));
});
afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

async function fixtureMeta(): Promise<InstrumentMeta> {
  return JSON.parse(await readFile(venueFixture(VENUE, 'meta.json'), 'utf8')) as InstrumentMeta;
}

// The real definition with meta/funding answered locally (no exchange API).
async function definition(overrides: Partial<VenueDefinition> = {}): Promise<VenueDefinition> {
  const meta = await fixtureMeta();
  return {
    ...VENUES[VENUE],
    fetchInstrumentMeta: async () => meta,
    fetchFunding: async (_symbol, from) => [0, 8, 16].map((h) => ({ t: from + h * 3_600_000, rate: 0.0001 })),
    ...overrides,
  };
}

function binanceRoutes(checksumName = 'ETHUSDT-trades-2025-01-09.zip.CHECKSUM'): Map<string, Route> {
  const [ref] = VENUES[VENUE].archiveFiles('ETHUSDT', DAY);
  return new Map<string, Route>([
    [ref!.url, fileRoute(FIXTURE_ZIP)],
    [ref!.checksumUrl!, async () => new Response(await readFile(venueFixture(VENUE, checksumName)))],
  ]);
}

async function run(def: VenueDefinition, routes: Map<string, Route>, extra: { from?: string; to?: string; dryRun?: boolean } = {}) {
  const network = fakeFetch(routes);
  // InstantClock: checksum-retry backoff (Spec §2.5) must not sleep for real.
  const adapter = createVenueAdapter(def, { dataRoot, fetchFn: network.fetchFn, clock: new InstantClock() });
  const seen: PartitionResult[] = [];
  const result = await fetchPartitions({
    venues: [VENUE],
    symbols: ['ETHUSDT'],
    from: parseDay(extra.from ?? '2025-01-09'),
    to: parseDay(extra.to ?? '2025-01-09'),
    dataRoot,
    concurrency: 2,
    dryRun: extra.dryRun ?? false,
    adapters: { [VENUE]: adapter },
    fetchedAt: () => '2026-09-19T00:00:00.000Z',
    onPartition: (r) => seen.push(r),
  });
  return { result, seen, calls: network.calls };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe('fetchPartitions', () => {
  it('writes raw + merged + hygiene + .done, reports unavailable days, cleans the cache', async () => {
    const { result } = await run(await definition(), binanceRoutes(), { to: '2025-01-10' });
    expect(result.partitions.map((p) => [p.day, p.status])).toEqual([
      ['2025-01-10', 'unavailable'],
      ['2025-01-09', 'done'],
    ]);
    const done = result.partitions.find((p) => p.status === 'done')!;
    expect(done).toMatchObject({ rowsRaw: 1500, suspect: false });

    const mergedPath = partitionPath(dataRoot, 'merged', VENUE, 'ETHUSDT', DAY);
    const marker = await readDoneMarker(donePath(mergedPath));
    expect(marker).toMatchObject({ rowsRaw: 1500, rowsMerged: done.rowsMerged, source: 'archive', checksumVerified: true, adapterVersion: VENUES[VENUE].adapterVersion });
    const published = (await readFile(venueFixture(VENUE, 'ETHUSDT-trades-2025-01-09.zip.CHECKSUM'), 'utf8')).split(/\s+/)[0];
    expect(marker.sha256Payload).toEqual([{ url: VENUES[VENUE].archiveFiles('ETHUSDT', DAY)[0]!.url, sha256: published }]);
    expect(await exists(partitionPath(dataRoot, 'raw', VENUE, 'ETHUSDT', DAY))).toBe(true);

    const hygiene = await readHygiene(dataRoot, VENUE, 'ETHUSDT', DAY);
    expect(hygiene).toMatchObject({ day: '2025-01-09', rowsRaw: 1500, checksumFailed: false, fundingMissing: [] });
    // The 1 500-row extract covers minutes, not the day: a dayBoundary interval.
    expect(hygiene!.gaps.some((g) => g.reason === 'dayBoundary')).toBe(true);

    expect(await readInstrumentHistory(dataRoot, VENUE, 'ETHUSDT')).toBeDefined();
    expect((await readFunding(dataRoot, VENUE, 'ETHUSDT')).length).toBeGreaterThan(0);
    expect(await readdir(join(dataRoot, 'cache', VENUE, 'ETHUSDT'))).toEqual([]);
  });

  it('is idempotent: a second run makes 0 network requests', async () => {
    const def = await definition();
    await run(def, binanceRoutes());
    const second = await run(def, binanceRoutes());
    expect(second.calls).toEqual([]);
    expect(second.result.partitions.map((p) => p.status)).toEqual(['skipped']);
  });

  it('dry run plans via HEAD only', async () => {
    const { result, calls } = await run(await definition(), binanceRoutes(), { dryRun: true });
    expect(result.partitions.map((p) => p.status)).toEqual(['planned']);
    expect(calls.every((call) => call.startsWith('HEAD '))).toBe(true);
    expect(await exists(partitionPath(dataRoot, 'merged', VENUE, 'ETHUSDT', DAY))).toBe(false);
  });

  it('checksum mismatch → checksumFailed hygiene, no .done', async () => {
    const { result } = await run(await definition(), binanceRoutes('ETHUSDT-trades-2025-01-09.zip.CHECKSUM.bad'));
    expect(result.partitions.map((p) => p.status)).toEqual(['checksumFailed']);
    expect(await readHygiene(dataRoot, VENUE, 'ETHUSDT', DAY)).toMatchObject({ checksumFailed: true, suspect: true });
    expect(await exists(donePath(partitionPath(dataRoot, 'merged', VENUE, 'ETHUSDT', DAY)))).toBe(false);
  });

  describe('synthetic archive (tick change, midnight split)', () => {
    const url = (day: string) => `https://fixture.test/${day}.csv.gz`;
    const header = 'id,price,qty,quote_qty,time,is_buyer_maker';
    const at = (day: string, sec: number) => Date.parse(`${day}T00:00:00Z`) + sec * 1000;

    async function syntheticDefinition(): Promise<VenueDefinition> {
      return definition({
        adapterVersion: 'synthetic-1',
        archiveFiles: (symbol, day) => [{ url: url(formatDay(day)), cacheKey: `${symbol}/${formatDay(day)}.csv.gz`, contentType: 'csv.gz' }],
      });
    }

    function csv(rows: Array<[number, string, string, number, boolean]>): Route {
      const body = [header, ...rows.map(([id, price, qty, t, maker]) => `${id},${price},${qty},0,${t},${maker}`)].join('\n');
      return () => new Response(gzipSync(body));
    }

    it('infers a finer tick from off-grid prices, records it, re-normalises', async () => {
      const day = '2025-01-09';
      const rows: Array<[number, string, string, number, boolean]> = Array.from({ length: 50 }, (_, i) => [i, i % 2 === 0 ? '3300.01' : '3300.015', '0.001', at(day, 3600 + i), false]);
      const { result } = await run(await syntheticDefinition(), new Map([[url(day), csv(rows)]]));
      expect(result.partitions.map((p) => p.status)).toEqual(['done']);
      const history = await readInstrumentHistory(dataRoot, VENUE, 'ETHUSDT');
      expect(history!.records.map((r) => [r.validFrom, r.TickDecimal, r.unverified])).toEqual([
        [0, '0.01', undefined],
        [at(day, 3600), '0.005', ['validFrom']],
      ]);
      expect(await readHygiene(dataRoot, VENUE, 'ETHUSDT', DAY)).toMatchObject({ tickSizeChange: { detected: true, inferredTick: '0.005' } });
      // No published checksum: our own sha256 of the payload is kept in .done (Spec §2.5).
      const marker = await readDoneMarker(donePath(partitionPath(dataRoot, 'merged', VENUE, 'ETHUSDT', DAY)));
      expect(marker.checksumVerified).toBe(false);
      const gz = Buffer.from(await (await csv(rows)(undefined)).arrayBuffer());
      expect(marker.sha256Payload).toEqual([{ url: url(day), sha256: createHash('sha256').update(gz).digest('hex') }]);
      const merged = await readFile(partitionPath(dataRoot, 'merged', VENUE, 'ETHUSDT', DAY));
      expect(merged.length).toBeGreaterThan(0);
    });

    it('re-queues a later partition of the selection that a tick change invalidated (Spec §2.3.2)', async () => {
      const def = await syntheticDefinition();
      const onGrid = (day: string, id: number) => csv([[id, '3300.01', '0.001', at(day, 3600), false]]);
      await run(def, new Map([[url('2025-01-10'), onGrid('2025-01-10', 100)]]), { from: '2025-01-10', to: '2025-01-10' });
      const rows: Array<[number, string, string, number, boolean]> = Array.from({ length: 10 }, (_, i) => [i, i % 2 === 0 ? '3300.01' : '3300.015', '0.001', at('2025-01-09', 3600 + i), false]);
      const routes = new Map([
        [url('2025-01-09'), csv(rows)],
        [url('2025-01-10'), onGrid('2025-01-10', 100)],
      ]);
      const { result } = await run(def, routes, { to: '2025-01-10' });
      expect(result.partitions.map((p) => [p.day, p.status])).toEqual([
        ['2025-01-10', 'skipped'],
        ['2025-01-09', 'done'],
        ['2025-01-10', 'done'],
      ]);
      expect(await exists(donePath(partitionPath(dataRoot, 'merged', VENUE, 'ETHUSDT', NEXT)))).toBe(true);
      // Rebuilt on the finer grid: 3300.01 / 0.005.
      const merged = readMergedParquetColumns(await readFile(partitionPath(dataRoot, 'merged', VENUE, 'ETHUSDT', NEXT)));
      expect(Number(merged.p[0])).toBe(660_002);
    });

    it('MissingAggressorField marks the venue unusable: later days fail, reruns refuse until the adapter changes (Spec §2.1)', async () => {
      const noSide = (day: string): Route => () => new Response(gzipSync(['id,price,qty,quote_qty,time', `1,3300.01,0.001,0,${at(day, 60)}`].join('\n')));
      const routes = new Map([
        [url('2025-01-09'), noSide('2025-01-09')],
        [url('2025-01-10'), noSide('2025-01-10')],
      ]);
      const def = await syntheticDefinition();
      const first = await run(def, routes, { to: '2025-01-10' });
      expect(first.result.partitions.map((p) => [p.day, p.status])).toEqual([
        ['2025-01-09', 'failed'],
        ['2025-01-10', 'failed'],
      ]);
      expect(first.result.partitions[0]!.error).toMatch(/aggressor/);
      expect(first.result.partitions[1]!.error).toMatch(/^venue unusable: /);
      const marker = JSON.parse(await readFile(venueUnusablePath(dataRoot, VENUE), 'utf8')) as { adapterVersion: string; day: string };
      expect(marker).toMatchObject({ adapterVersion: 'synthetic-1', day: '2025-01-09' });

      const rerun = await run(def, routes, { to: '2025-01-10' });
      expect(rerun.calls).toEqual([]);
      expect(rerun.result.partitions.every((p) => p.status === 'failed' && p.error!.startsWith('venue unusable: '))).toBe(true);

      // A new adapterVersion (fixed parser) is not blocked by the old marker.
      const fixed = await run({ ...def, adapterVersion: 'synthetic-2' }, new Map([[url('2025-01-09'), csv([[1, '3300.01', '0.001', at('2025-01-09', 60), false]])]]));
      expect(fixed.result.partitions.map((p) => p.status)).toEqual(['done']);
    });

    describe('contract-size history (Spec §2.2 Gate quanto_multiplier, A-103)', () => {
      const rows: Array<[number, string, string, number, boolean]> = [
        [1, '3300.01', '0.001', at('2025-01-09', 3600), false],
        [2, '3300.01', '0.001', at('2025-01-09', 3 * 3600), false],
      ];
      const routes = () => new Map([[url('2025-01-09'), csv(rows)]]);
      const addMultiplierChange = async () => {
        const history = (await readInstrumentHistory(dataRoot, VENUE, 'ETHUSDT'))!;
        const change = { ...history.records[0]!, contractMultiplier: 10, contractMultiplierDecimal: '10', validFrom: at('2025-01-09', 2 * 3600) };
        await writeInstrumentHistory(dataRoot, VENUE, 'ETHUSDT', createMetaHistory([...history.records, change]));
      };
      const rawQ = async () => [...readRawParquetColumns(await readFile(partitionPath(dataRoot, 'raw', VENUE, 'ETHUSDT', DAY))).q].map(Number);

      it('an edited change instant makes written days incomplete; they are re-normalised with the multiplier in force', async () => {
        const def = await syntheticDefinition();
        await run(def, routes());
        expect(await rawQ()).toEqual([1, 1]);
        await addMultiplierChange();
        const { result } = await run(def, routes());
        expect(result.partitions.map((p) => p.status)).toEqual(['done']);
        expect(await rawQ()).toEqual([1, 10]);
        // …and the rebuilt marker matches the history: the next run skips.
        expect((await run(def, routes())).result.partitions.map((p) => p.status)).toEqual(['skipped']);
      });

      it('markers written before A-103 (no sha256Meta) stay complete', async () => {
        const def = await syntheticDefinition();
        await run(def, routes());
        const markerPath = donePath(partitionPath(dataRoot, 'merged', VENUE, 'ETHUSDT', DAY));
        const { sha256Meta, ...legacy } = await readDoneMarker(markerPath);
        expect(sha256Meta).toMatch(/^[0-9a-f]{64}$/);
        await writeFile(markerPath, JSON.stringify(legacy));
        await addMultiplierChange();
        expect((await run(def, routes())).result.partitions.map((p) => p.status)).toEqual(['skipped']);
      });

      it('fetch refreshes the current record: a changed multiplier is appended at the observation time, marked [VERIFY]', async () => {
        const def = await syntheticDefinition();
        await run(def, routes());
        const changed = { ...(await fixtureMeta()), contractMultiplier: 10, contractMultiplierDecimal: '10' };
        const observed = Date.UTC(2026, 8, 19);
        const network = fakeFetch(new Map([[url('2025-01-10'), csv([[3, '3300.01', '0.001', at('2025-01-10', 60), false]])]]));
        const adapter = createVenueAdapter({ ...def, fetchInstrumentMeta: async () => changed }, { dataRoot, fetchFn: network.fetchFn, clock: new InstantClock() });
        await fetchPartitions({ venues: [VENUE], symbols: ['ETHUSDT'], from: NEXT, to: NEXT, dataRoot, concurrency: 1, adapters: { [VENUE]: adapter }, now: () => observed });
        const history = await readInstrumentHistory(dataRoot, VENUE, 'ETHUSDT');
        expect(history!.records.map((r) => [r.validFrom, r.contractMultiplierDecimal, r.unverified])).toEqual([
          [0, '1', undefined],
          [observed, '10', ['validFrom']],
        ]);
      });
    });

    it('sets midnightSplit when day 2 opens by continuing day 1’s last run', async () => {
      const routes = new Map([
        [url('2025-01-09'), csv([[1, '3300.00', '0.001', at('2025-01-09', 86_399), false]])],
        [url('2025-01-10'), csv([[2, '3300.01', '0.001', at('2025-01-10', 0), false]])],
      ]);
      const { result } = await run(await syntheticDefinition(), routes, { to: '2025-01-10' });
      expect(result.partitions.map((p) => p.status)).toEqual(['done', 'done']);
      expect((await readHygiene(dataRoot, VENUE, 'ETHUSDT', DAY))!.midnightSplit).toBe(false);
      expect((await readHygiene(dataRoot, VENUE, 'ETHUSDT', NEXT))!.midnightSplit).toBe(true);
    });
  });
});

describe('stored-partition maintenance', () => {
  beforeEach(async () => {
    await run(await definition(), binanceRoutes());
  });
  const selection = () => ({ venues: [VENUE], symbols: ['ETHUSDT'], from: DAY, to: DAY, dataRoot });

  it('verify passes, then detects a tampered byte', async () => {
    expect((await verifyPartitions(selection())).map((r) => r.status)).toEqual(['done']);
    const rawPath = partitionPath(dataRoot, 'raw', VENUE, 'ETHUSDT', DAY);
    const bytes = await readFile(rawPath);
    bytes[100] = bytes[100]! ^ 0xff;
    await writeFile(rawPath, bytes);
    const results = await verifyPartitions(selection());
    expect(results).toMatchObject([{ status: 'integrityFailed', error: 'raw sha256 mismatch' }]);
  });

  it('merge --force rebuilds byte-identical merged Parquet from raw', async () => {
    const mergedPath = partitionPath(dataRoot, 'merged', VENUE, 'ETHUSDT', DAY);
    const before = await readFile(mergedPath);
    expect((await mergeStored(selection())).map((r) => r.status)).toEqual(['skipped']);
    expect((await mergeStored({ ...selection(), force: true })).map((r) => r.status)).toEqual(['done']);
    expect(Buffer.compare(await readFile(mergedPath), before)).toBe(0);
    expect((await readDoneMarker(donePath(mergedPath))).sha256Payload).toHaveLength(1);
    expect((await verifyPartitions(selection())).map((r) => r.status)).toEqual(['done']);
  });

  it('hygiene rebuild reproduces the fetch-time report', async () => {
    const original = await readHygiene(dataRoot, VENUE, 'ETHUSDT', DAY);
    const [entry] = await rebuildHygiene(selection());
    expect(entry!.report).toEqual(original);
  });
});

describe('fetchMeta', () => {
  it('replaces stored placeholder fees with the verified schedule', async () => {
    const def = await definition();
    const stale = { ...(await fixtureMeta()), TakerFee: 0.001, MakerFee: 0.001, feesVerifiedAt: null };
    await writeInstrumentHistory(dataRoot, VENUE, 'ETHUSDT', createMetaHistory([stale]));
    const adapter = createVenueAdapter(def, { dataRoot, fetchFn: fakeFetch(new Map()).fetchFn });
    await fetchMeta({ venues: [VENUE], symbols: ['ETHUSDT'], dataRoot, fundingFrom: Date.UTC(2025, 0, 9), fundingTo: Date.UTC(2025, 0, 10), adapters: { [VENUE]: adapter } });
    const history = await readInstrumentHistory(dataRoot, VENUE, 'ETHUSDT');
    expect(history!.records).toHaveLength(1);
    expect(history!.records[0]).toMatchObject({ TakerFee: 0.0005, MakerFee: 0.0002, feesVerifiedAt: '2026-09-19' });
  });

  const metaWith = async (fetched: Partial<InstrumentMeta>, now = Date.UTC(2026, 8, 19)) => {
    const def = await definition({ fetchInstrumentMeta: async () => ({ ...(await fixtureMeta()), ...fetched }) });
    const adapter = createVenueAdapter(def, { dataRoot, fetchFn: fakeFetch(new Map()).fetchFn });
    const [result] = await fetchMeta({ venues: [VENUE], symbols: ['ETHUSDT'], dataRoot, fundingFrom: Date.UTC(2025, 0, 9), fundingTo: Date.UTC(2025, 0, 10), adapters: { [VENUE]: adapter }, now: () => now });
    const file = JSON.parse(await readFile(instrumentHistoryPath(dataRoot, VENUE, 'ETHUSDT'), 'utf8')) as { verify?: string[] };
    return { result: result!, file };
  };

  it('writes [VERIFY] placeholders: defaulted funding interval, unverified fees (Spec §2.7, A-102)', async () => {
    const { result, file } = await metaWith({ unverified: ['fundingIntervalHours'], feesVerifiedAt: null });
    expect(file.verify).toHaveLength(2);
    expect(file.verify!.every((line) => line.startsWith('[VERIFY] record validFrom=0 '))).toBe(true);
    expect(file.verify!.join('\n')).toMatch(/TakerFee\/MakerFee are placeholders[^]*fundingIntervalHours=8 is a default/);
    expect(result.verify).toEqual(file.verify);
    // The venue later reports the interval: the placeholder is cleared.
    const again = await metaWith({});
    expect(again.file.verify).toBeUndefined();
    expect((await readInstrumentHistory(dataRoot, VENUE, 'ETHUSDT'))!.records).toHaveLength(1);
  });

  it('a changed contract multiplier appends a record at the observation time with validFrom marked [VERIFY]', async () => {
    await metaWith({});
    const now = Date.UTC(2026, 8, 20);
    const { result, file } = await metaWith({ contractMultiplier: 10, contractMultiplierDecimal: '10' }, now);
    expect(result.tickChanged).toBe(true);
    const history = await readInstrumentHistory(dataRoot, VENUE, 'ETHUSDT');
    expect(history!.records.map((r) => [r.validFrom, r.contractMultiplierDecimal, r.unverified])).toEqual([
      [0, '1', undefined],
      [now, '10', ['validFrom']],
    ]);
    expect(file.verify).toEqual([expect.stringMatching(/^\[VERIFY\] record validFrom=\d+ \(2026-09-20T00:00:00.000Z\): change instant/)]);
  });

  it('reads a pre-A-102 file carrying the single fee note', async () => {
    const legacy = { schemaVersion: 1, note: '[VERIFY] fees', records: [await fixtureMeta()] };
    await mkdir(join(dataRoot, 'meta', VENUE, 'ETHUSDT'), { recursive: true });
    await writeFile(instrumentHistoryPath(dataRoot, VENUE, 'ETHUSDT'), JSON.stringify(legacy));
    expect((await readInstrumentHistory(dataRoot, VENUE, 'ETHUSDT'))!.records).toHaveLength(1);
  });

  it('writes instrument_history.json and funding.parquet', async () => {
    const adapter = createVenueAdapter(await definition(), { dataRoot, fetchFn: fakeFetch(new Map([['x', textRoute('')], ['y', jsonRoute({})]])).fetchFn });
    const [result] = await fetchMeta({ venues: [VENUE], symbols: ['ETHUSDT'], dataRoot, fundingFrom: Date.UTC(2025, 0, 9), fundingTo: Date.UTC(2025, 0, 10), adapters: { [VENUE]: adapter } });
    expect(result).toMatchObject({ status: 'done', fundingRecords: 3, tickChanged: false });
    const history = await readInstrumentHistory(dataRoot, VENUE, 'ETHUSDT');
    expect(history!.records[0]).toMatchObject({ TickDecimal: '0.01', TakerFee: 0.0005, MakerFee: 0.0002, feesVerifiedAt: '2026-09-19' });
  });
});
