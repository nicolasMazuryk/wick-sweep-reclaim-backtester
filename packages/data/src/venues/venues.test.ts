import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVenueAdapter, normaliseArchiveDay, type VenueDefinition } from '../adapter.js';
import { readArchiveLines } from '../archive-read.js';
import { dayEndMs, dayStartMs, parseDay } from '../days.js';
import { ChecksumMismatchError } from '../fetch-day.js';
import { createMetaHistory } from '../instrument-meta.js';
import { HttpClient } from '../http.js';
import { fakeFetch, fileRoute, InstantClock, jsonRoute, textRoute, venueFixture, type Route } from '../testing/fixtures.js';
import { MissingAggressorField, type ArchiveContentType, type CanonicalTrade, type InstrumentMeta, type RawDayPayload, type VenueId } from '../venue.js';
import { VENUES } from './index.js';

interface Manifest {
  readonly day: string;
  readonly files: ReadonlyArray<[string, ArchiveContentType]>;
}

const manifest = JSON.parse(await readFile(venueFixture('', 'files.json'), 'utf8')) as Record<VenueId, Manifest>;
const DAY = parseDay('2025-01-09');

async function metaOf(venue: VenueId): Promise<InstrumentMeta> {
  return JSON.parse(await readFile(venueFixture(venue, 'meta.json'), 'utf8')) as InstrumentMeta;
}

function payloadOf(venue: VenueId, files?: ReadonlyArray<[string, ArchiveContentType]>): RawDayPayload {
  return {
    symbol: 'ETHUSDT',
    day: DAY,
    source: 'archive',
    files: (files ?? manifest[venue].files).map(([name, contentType]) => ({ path: venueFixture(venue, name), contentType, url: name })),
    cacheKeys: [],
    checksumVerified: false,
  };
}

async function normalise(venue: VenueId, payload = payloadOf(venue)): Promise<CanonicalTrade[]> {
  const meta = createMetaHistory([await metaOf(venue)]);
  const out: CanonicalTrade[] = [];
  for await (const trade of normaliseArchiveDay(VENUES[venue], payload, meta)) {
    expect(trade.offTick).toBe(false);
    expect(trade.offLot).toBe(false);
    const { venue: v, symbol, tradeId, t, tNsRemainder, seq, p, q, s } = trade;
    out.push({ venue: v, symbol, tradeId, t, tNsRemainder, seq, p, q, s });
  }
  return out;
}

async function csvLines(venue: VenueId, index = 0): Promise<string[]> {
  const [name, contentType] = manifest[venue].files[index]!;
  const lines: string[] = [];
  for await (const line of readArchiveLines(venueFixture(venue, name), contentType)) {
    lines.push(line);
  }
  return lines;
}

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'wsr-venues-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// Writes `lines` as an archive of the given type (zip via the system `zip`).
async function writeArchive(name: string, contentType: ArchiveContentType, lines: readonly string[]): Promise<string> {
  const body = `${lines.join('\n')}\n`;
  const path = join(tmp, name);
  if (contentType === 'csv.gz') {
    await writeFile(path, gzipSync(body));
  } else {
    const csv = join(tmp, 'member.csv');
    await writeFile(csv, body);
    execFileSync('zip', ['-q', '-j', path, csv]);
  }
  return path;
}

const ALL: readonly VenueId[] = ['binance', 'bybit', 'okx', 'gate', 'bitget', 'kucoin'];

describe.each(ALL)('%s adapter (recorded fixture)', (venue) => {
  it('normalise matches the golden CanonicalTrades', async () => {
    const golden = JSON.parse(await readFile(venueFixture(venue, 'expected.json'), 'utf8')) as CanonicalTrade[];
    expect(await normalise(venue)).toEqual(golden);
  });

  it('assigns seq 0,1,2,… in delivery order, t inside the UTC day, s ∈ {±1}', async () => {
    const trades = await normalise(venue);
    expect(trades.length).toBeGreaterThan(200);
    trades.forEach((trade, i) => {
      expect(trade.seq).toBe(i);
      expect(trade.t).toBeGreaterThanOrEqual(dayStartMs(DAY));
      expect(trade.t).toBeLessThan(dayEndMs(DAY));
      expect([1, -1]).toContain(trade.s);
      expect(Number.isInteger(trade.p) && trade.p > 0).toBe(true);
      expect(Number.isInteger(trade.q) && trade.q > 0).toBe(true);
    });
  });

  it('throws MissingAggressorField when the side column is removed', async () => {
    const [name, contentType] = manifest[venue].files[0]!;
    const lines = await csvLines(venue);
    let stripped: string[];
    if (venue === 'gate') {
      // Headerless timestamp,id,price,size(signed): without size there is no side.
      stripped = lines.map((line) => line.split(',').slice(0, 3).join(','));
    } else {
      const header = lines[0]!.split(',');
      const sideIndex = header.findIndex((h) => h === 'side' || h === 'is_buyer_maker');
      stripped = lines.map((line) => line.split(',').filter((_, i) => i !== sideIndex).join(','));
    }
    const path = await writeArchive(name, contentType, stripped);
    const payload = { ...payloadOf(venue), files: [{ path, contentType, url: name }] };
    await expect(normalise(venue, payload)).rejects.toBeInstanceOf(MissingAggressorField);
  });
});

describe('exact p/q from the archive strings (Spec §3.11)', () => {
  it('binance: is_buyer_maker=true ⇒ s=−1; qty in base', async () => {
    // id,price,qty,quote_qty,time,is_buyer_maker = 4968713147,3325.38,0.007,23.27766,1736380805115,true
    const [first] = await normalise('binance');
    expect(first).toEqual({ venue: 'binance', symbol: 'ETHUSDT', tradeId: '4968713147', t: 1736380805115, tNsRemainder: 0, seq: 0, p: 332538, q: 7, s: -1 });
  });

  it('bybit: fractional-second timestamp keeps the sub-ms remainder; Buy ⇒ +1', async () => {
    // 1736380800.1104,ETHUSDT,Buy,0.03,3325.76,…,45040a82-d818-5052-841d-22c7a302bb5d
    const [first] = await normalise('bybit');
    expect(first).toMatchObject({ tradeId: '45040a82-d818-5052-841d-22c7a302bb5d', t: 1736380800110, tNsRemainder: 400_000, p: 332576, q: 3, s: 1 });
  });

  it('okx: size in contracts × ctVal 0.1 (lot 0.001 ETH)', async () => {
    const lines = await csvLines('okx');
    const trades = await normalise('okx');
    const first = trades[0]!;
    const row = lines.find((line) => line.split(',')[1] === first.tradeId)!.split(',');
    // size (contracts) × 0.1 / 0.001 = size × 100
    expect(first.q).toBe(Math.round(Number(row[4]) * 100));
    expect(first.p).toBe(Math.round(Number(row[3]) * 100));
  });

  it('kucoin: zero-padded prices; size in contracts × multiplier 0.01 (lot = 1 contract)', async () => {
    // trade_id,trade_time,price,size,side = 1755167962195,1736380800072,3327.32000000000000000000,26,sell
    const [first] = await normalise('kucoin');
    expect(first).toMatchObject({ tradeId: '1755167962195', t: 1736380800072, p: 332732, q: 26, s: -1 });
  });

  it('gate: signed size gives the taker side; contracts × quanto_multiplier; µs remainder', async () => {
    const trades = await normalise('gate');
    expect(trades[0]).toMatchObject({ tradeId: '381130382', t: 1736380800634, tNsRemainder: 207_000, p: 332555, q: 1, s: 1 });
    expect(trades[1]).toMatchObject({ tradeId: '381130383', s: -1 });
  });
});

describe('archive-boundary handling (A-58)', () => {
  it('okx: UTC day = tail of file D (UTC+8) + head of file D+1, filtered to the UTC day', async () => {
    const d = await normalise('okx', payloadOf('okx', [manifest.okx.files[0]!]));
    const d1 = await normalise('okx', payloadOf('okx', [manifest.okx.files[1]!]));
    expect(d.length).toBeGreaterThan(0);
    expect(d1.length).toBeGreaterThan(0);
    const both = await normalise('okx');
    expect(both.length).toBe(d.length + d1.length);
    // File D holds rows before UTC midnight that must be dropped.
    const fileD = (await csvLines('okx', 0)).slice(1);
    expect(fileD.length).toBeGreaterThan(d.length);
  });

  it('bitget: part sets of D and D+1, whole-second timestamps, filtered to the UTC day', async () => {
    const trades = await normalise('bitget');
    expect(trades.every((t) => t.t % 1000 === 0)).toBe(true);
    const p1 = await normalise('bitget', payloadOf('bitget', [manifest.bitget.files[0]!]));
    expect(p1).toHaveLength(0); // part 001 of D is before UTC midnight
    const next = await normalise('bitget', payloadOf('bitget', [manifest.bitget.files[2]!]));
    expect(next.length).toBeGreaterThan(0);
    expect(next.length).toBeLessThan((await csvLines('bitget', 2)).length - 1);
  });

  it('gate: the monthly file is split into the requested UTC day only', async () => {
    const trades = await normalise('gate');
    const all = (await csvLines('gate')).map((line) => line.split(','));
    const inDay = all.filter((f) => f[0]! >= '1736380800' && f[0]! < '1736467200');
    expect(trades.map((t) => t.tradeId)).toEqual(inDay.map((f) => f[1]));
    // …and a different day of the same month from the same file.
    const day10 = await normalise('gate', { ...payloadOf('gate'), day: parseDay('2025-01-10') });
    expect(day10.length).toBeGreaterThan(0);
    expect(day10.every((t) => t.t >= Date.UTC(2025, 0, 10) && t.t < Date.UTC(2025, 0, 11))).toBe(true);
  });
});

describe('archive URLs and symbols (verified 2026-09-19)', () => {
  it.each([
    ['binance', 'ETHUSDT', ['https://data.binance.vision/data/futures/um/daily/trades/ETHUSDT/ETHUSDT-trades-2025-01-09.zip']],
    ['bybit', 'ETHUSDT', ['https://public.bybit.com/trading/ETHUSDT/ETHUSDT2025-01-09.csv.gz']],
    [
      'okx',
      'ETH-USDT-SWAP',
      [
        'https://static.okx.com/cdn/okex/traderecords/trades/daily/20250109/ETH-USDT-SWAP-trades-2025-01-09.zip',
        'https://static.okx.com/cdn/okex/traderecords/trades/daily/20250110/ETH-USDT-SWAP-trades-2025-01-10.zip',
      ],
    ],
    ['gate', 'ETH_USDT', ['https://download.gatedata.org/futures_usdt/trades/202501/ETH_USDT-202501.csv.gz']],
    ['bitget', 'ETHUSDT', ['https://img.bitgetimg.com/online/trades/UMCBL/ETHUSDT/20250109_001.zip', 'https://img.bitgetimg.com/online/trades/UMCBL/ETHUSDT/20250110_001.zip']],
    ['kucoin', 'ETHUSDTM', ['https://historical-data.kucoin.com/data/futures/daily/trades/ETHUSDTM/ETHUSDTM-trades-2025-01-09.zip']],
  ] as const)('%s → %s', (venue, venueSymbol, urls) => {
    const definition: VenueDefinition = VENUES[venue];
    expect(definition.toVenueSymbol('ETHUSDT')).toBe(venueSymbol);
    expect(definition.archiveFiles('ETHUSDT', DAY).map((ref) => ref.url)).toEqual(urls);
  });

  it('kucoin maps BTC to BTCUSDTM (not XBT)', () => {
    expect(VENUES.kucoin.toVenueSymbol('BTCUSDT')).toBe('BTCUSDTM');
  });
});

describe('fetch through the archive cache (fake network)', () => {
  it('bitget: probes parts until the CDN answers 403, D and D+1', async () => {
    const definition = VENUES.bitget;
    const refs = definition.archiveFiles('ETHUSDT', DAY);
    const routes = new Map<string, Route>([
      [refs[0]!.probeParts!.part(1).url, fileRoute(venueFixture('bitget', '20250109_001.zip'))],
      [refs[0]!.probeParts!.part(2).url, fileRoute(venueFixture('bitget', '20250109_002.zip'))],
      [refs[1]!.probeParts!.part(1).url, fileRoute(venueFixture('bitget', '20250110_001.zip'))],
    ]);
    const network = fakeFetch(routes, 403);
    const adapter = createVenueAdapter(definition, { dataRoot: tmp, fetchFn: network.fetchFn });
    const payload = await adapter.fetch('ETHUSDT', DAY, { signal: new AbortController().signal });
    expect(payload.files.map((f) => f.url)).toEqual([refs[0]!.probeParts!.part(1).url, refs[0]!.probeParts!.part(2).url, refs[1]!.probeParts!.part(1).url]);
    expect(network.calls).toEqual([
      `GET ${refs[0]!.probeParts!.part(1).url}`,
      `GET ${refs[0]!.probeParts!.part(2).url}`,
      `GET ${refs[0]!.probeParts!.part(3).url}`,
      `GET ${refs[1]!.probeParts!.part(1).url}`,
      `GET ${refs[1]!.probeParts!.part(2).url}`,
    ]);
    const golden = JSON.parse(await readFile(venueFixture('bitget', 'expected.json'), 'utf8')) as CanonicalTrade[];
    expect(await normalise('bitget', payload)).toEqual(golden);

    // Second fetch is served from the cache manifest: no network.
    network.calls.length = 0;
    const again = createVenueAdapter(definition, { dataRoot: tmp, fetchFn: network.fetchFn });
    await again.fetch('ETHUSDT', DAY, { signal: new AbortController().signal });
    expect(network.calls).toEqual([]);
  });

  it('listAvailable sends HEAD probes only and reports 403/404 as unavailable', async () => {
    const definition = VENUES.kucoin;
    const [ref] = definition.archiveFiles('ETHUSDT', DAY);
    const network = fakeFetch(new Map([[ref!.url, fileRoute(venueFixture('kucoin', 'ETHUSDTM-trades-2025-01-09.zip'))]]));
    const adapter = createVenueAdapter(definition, { dataRoot: tmp, fetchFn: network.fetchFn });
    const availability = await adapter.listAvailable('ETHUSDT', DAY, parseDay('2025-01-10'));
    expect(availability.map((a) => a.source)).toEqual(['archive', 'unavailable']);
    expect(network.calls.every((call) => call.startsWith('HEAD '))).toBe(true);
  });

  describe('binance .CHECKSUM verification', () => {
    const definition = VENUES.binance;
    const [ref] = definition.archiveFiles('ETHUSDT', DAY);
    const zip = venueFixture('binance', 'ETHUSDT-trades-2025-01-09.zip');

    it('passes with the published sha256 and marks checksumVerified', async () => {
      const checksum = await readFile(venueFixture('binance', 'ETHUSDT-trades-2025-01-09.zip.CHECKSUM'), 'utf8');
      const network = fakeFetch(new Map([[ref!.url, fileRoute(zip)], [ref!.checksumUrl!, textRoute(checksum)]]));
      const adapter = createVenueAdapter(definition, { dataRoot: tmp, fetchFn: network.fetchFn });
      const payload = await adapter.fetch('ETHUSDT', DAY, { signal: new AbortController().signal });
      expect(payload.checksumVerified).toBe(true);
    });

    it('fails after 2 extra download attempts on a mismatch, backing off per retryPolicy', async () => {
      const checksum = await readFile(venueFixture('binance', 'ETHUSDT-trades-2025-01-09.zip.CHECKSUM.bad'), 'utf8');
      const network = fakeFetch(new Map([[ref!.url, fileRoute(zip)], [ref!.checksumUrl!, textRoute(checksum)]]));
      const clock = new InstantClock();
      const retries: string[] = [];
      const adapter = createVenueAdapter(definition, { dataRoot: tmp, fetchFn: network.fetchFn, clock, random: () => 1, onRetry: (info) => retries.push(info.reason) });
      await expect(adapter.fetch('ETHUSDT', DAY, { signal: new AbortController().signal })).rejects.toBeInstanceOf(ChecksumMismatchError);
      expect(network.calls.filter((call) => call === `GET ${ref!.url}`)).toHaveLength(3);
      // Full jitter with random()=1: base 500 ms × 2^(attempt−1).
      expect(clock.sleeps).toEqual([500, 1000]);
      expect(retries).toEqual(['checksum', 'checksum']);
    });

    it('does not retry a mismatch when the retryPolicy omits checksum', async () => {
      const checksum = await readFile(venueFixture('binance', 'ETHUSDT-trades-2025-01-09.zip.CHECKSUM.bad'), 'utf8');
      const network = fakeFetch(new Map([[ref!.url, fileRoute(zip)], [ref!.checksumUrl!, textRoute(checksum)]]));
      const noChecksumRetry = { ...definition, retryPolicy: { ...definition.retryPolicy, retryOn: definition.retryPolicy.retryOn.filter((c) => c !== 'checksum') } };
      const adapter = createVenueAdapter(noChecksumRetry, { dataRoot: tmp, fetchFn: network.fetchFn, clock: new InstantClock() });
      await expect(adapter.fetch('ETHUSDT', DAY, { signal: new AbortController().signal })).rejects.toBeInstanceOf(ChecksumMismatchError);
      expect(network.calls.filter((call) => call === `GET ${ref!.url}`)).toHaveLength(1);
    });
  });
});

describe('instrument meta and funding endpoints (fake network)', () => {
  const client = (venue: VenueId, routes: Map<string, Route>) => {
    const network = fakeFetch(routes);
    const http = new HttpClient({ rateLimit: VENUES[venue].rateLimit, retryPolicy: VENUES[venue].retryPolicy, fetchFn: network.fetchFn, clock: new InstantClock() });
    return { http, calls: network.calls };
  };
  const binanceInfo = jsonRoute({
    symbols: [{ symbol: 'ETHUSDT', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'LOT_SIZE', stepSize: '0.001' }] }],
  });

  it('binance: funding interval from /fapi/v1/fundingInfo; unlisted symbols settle every 8 h', async () => {
    const listed = client(
      'binance',
      new Map([
        ['https://fapi.binance.com/fapi/v1/exchangeInfo', binanceInfo],
        ['https://fapi.binance.com/fapi/v1/fundingInfo', jsonRoute([{ symbol: 'ETHUSDT', fundingIntervalHours: 4 }])],
      ]),
    );
    expect((await VENUES.binance.fetchInstrumentMeta('ETHUSDT', listed.http)).fundingIntervalHours).toBe(4);
    const unlisted = client(
      'binance',
      new Map([
        ['https://fapi.binance.com/fapi/v1/exchangeInfo', binanceInfo],
        ['https://fapi.binance.com/fapi/v1/fundingInfo', jsonRoute([{ symbol: 'BTCUSDT', fundingIntervalHours: 4 }])],
      ]),
    );
    expect((await VENUES.binance.fetchInstrumentMeta('ETHUSDT', unlisted.http)).fundingIntervalHours).toBe(8);
  });

  it('okx: funding interval = nextFundingTime − fundingTime', async () => {
    const t0 = Date.UTC(2025, 0, 9, 8);
    const { http } = client(
      'okx',
      new Map([
        ['https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=ETH-USDT-SWAP', jsonRoute({ code: '0', data: [{ instId: 'ETH-USDT-SWAP', tickSz: '0.01', lotSz: '0.01', ctVal: '0.1' }] })],
        ['https://www.okx.com/api/v5/public/funding-rate?instId=ETH-USDT-SWAP', jsonRoute({ code: '0', data: [{ instId: 'ETH-USDT-SWAP', fundingTime: String(t0), nextFundingTime: String(t0 + 4 * 3_600_000) }] })],
      ]),
    );
    expect(await VENUES.okx.fetchInstrumentMeta('ETHUSDT', http)).toMatchObject({ fundingIntervalHours: 4, LotSizeDecimal: '0.001', contractMultiplierDecimal: '0.1' });
  });

  it('gate: a contract without funding_interval gets the 8 h default marked unverified (A-102)', async () => {
    const contract = { name: 'ETH_USDT', order_price_round: '0.01', quanto_multiplier: '0.01' };
    const { http } = client('gate', new Map([['https://api.gateio.ws/api/v4/futures/usdt/contracts/ETH_USDT', jsonRoute(contract)]]));
    expect(await VENUES.gate.fetchInstrumentMeta('ETHUSDT', http)).toMatchObject({ fundingIntervalHours: 8, unverified: ['fundingIntervalHours'], contractMultiplierDecimal: '0.01' });
    const reported = client('gate', new Map([['https://api.gateio.ws/api/v4/futures/usdt/contracts/ETH_USDT', jsonRoute({ ...contract, funding_interval: 14_400 })]]));
    const meta = await VENUES.gate.fetchInstrumentMeta('ETHUSDT', reported.http);
    expect(meta.fundingIntervalHours).toBe(4);
    expect(meta.unverified).toBeUndefined();
  });

  it('gate: funding requests exactly the requested span, however old (no wall-clock clamp)', async () => {
    const from = Date.UTC(2020, 0, 1);
    const to = Date.UTC(2020, 0, 2) - 1;
    const url = `https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract=ETH_USDT&from=${from / 1000}&to=${Math.floor(to / 1000)}&limit=1000`;
    const rows = [
      { t: from / 1000 + 57_600, r: '0.0002' },
      { t: from / 1000, r: '0.0001' },
      { t: from / 1000 - 28_800, r: '0.5' },
    ];
    const { http, calls } = client('gate', new Map([[url, jsonRoute(rows)]]));
    const records = await VENUES.gate.fetchFunding('ETHUSDT', from, to, http);
    expect(calls).toEqual([`GET ${url}`]);
    expect(records).toEqual([
      { t: from, rate: 0.0001 },
      { t: from + 57_600_000, rate: 0.0002 },
    ]);
  });
});
