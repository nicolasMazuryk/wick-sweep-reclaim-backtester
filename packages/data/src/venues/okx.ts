// OKX USDT-margined perpetual swap — historical trade archive.
// Docs: https://www.okx.com/en-us/historical-data ,
//       https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments
// Checked 2026-09-19 (ETH-USDT-SWAP 2025-01-09): archive
//   static.okx.com/cdn/okex/traderecords/trades/daily/{YYYYMMDD}/{VS}-trades-{YYYY-MM-DD}.zip
// CSV header instrument_name,trade_id,side,price,size,created_time ; created_time
// in ms ; side = taker side (buy/sell) ; size in CONTRACTS (× ctVal, 0.1 ETH).
// The file named D is cut on the UTC+8 day: it starts at D−1 16:00Z. One UTC
// day therefore needs files D and D+1, filtered to the UTC day (A-58).
// Meta: GET /api/v5/public/instruments?instType=SWAP (tickSz, lotSz, ctVal);
//   funding interval = nextFundingTime − fundingTime of
//   GET /api/v5/public/funding-rate?instId={VS} (ms).
// Funding: GET /api/v5/public/funding-rate-history (after = older-than cursor,
//   limit ≤ 400; ~3 months of look-back only).
import type { Ms } from '@wsr/core';
import type { RawTradeRow, VenueDefinition } from '../adapter.js';
import { addDays, formatDay, formatDayCompact } from '../days.js';
import { parseEpochMs } from '../decimal.js';
import type { HttpClient } from '../http.js';
import { DEFAULT_RETRY_POLICY, type ArchiveFileRef, type FundingRecord, type UtcDay, type VenueId } from '../venue.js';
import { baseAsset, buildMeta, col, expectOk, field, rateLimit, resolveColumns, takerSide, type Columns } from './common.js';

const VENUE: VenueId = 'okx';
const ARCHIVE = 'https://static.okx.com/cdn/okex/traderecords/trades/daily';
const API = 'https://www.okx.com';

interface OkxResponse<T> {
  readonly code: string;
  readonly data?: readonly T[];
}

interface Instrument {
  readonly instId: string;
  readonly tickSz: string;
  readonly lotSz: string;
  readonly ctVal: string;
}

interface CurrentFunding {
  readonly instId: string;
  readonly fundingTime: string;
  readonly nextFundingTime: string;
}

interface FundingRow {
  readonly fundingTime: string;
  readonly fundingRate: string;
}

function toVenueSymbol(symbol: string): string {
  return `${baseAsset(symbol)}-USDT-SWAP`;
}

function fileRef(venueSymbol: string, fileDay: UtcDay): ArchiveFileRef {
  const name = `${venueSymbol}-trades-${formatDay(fileDay)}.zip`;
  return { url: `${ARCHIVE}/${formatDayCompact(fileDay)}/${name}`, cacheKey: `${venueSymbol}/${name}`, contentType: 'zip' };
}

async function* parseRows(rows: AsyncIterable<string[]>): AsyncGenerator<RawTradeRow> {
  let columns: Columns | undefined;
  let iId = 0;
  let iSide = 0;
  let iPrice = 0;
  let iSize = 0;
  let iTime = 0;
  for await (const fields of rows) {
    if (columns === undefined) {
      columns = resolveColumns(VENUE, fields, undefined, ['trade_id', 'price', 'size', 'created_time'], 'side');
      [iId, iSide, iPrice, iSize, iTime] = [col(columns, 'trade_id'), col(columns, 'side'), col(columns, 'price'), col(columns, 'size'), col(columns, 'created_time')];
      continue;
    }
    yield {
      tradeId: field(fields, iId),
      time: parseEpochMs(field(fields, iTime)),
      priceText: field(fields, iPrice),
      sizeText: field(fields, iSize),
      s: takerSide(VENUE, field(fields, iSide)),
    };
  }
}

export const okx: VenueDefinition = {
  id: VENUE,
  adapterVersion: 'okx-trades-1',
  rateLimit: rateLimit(10),
  retryPolicy: DEFAULT_RETRY_POLICY,
  timestampResolution: 'ms',
  feedKind: 'raw',
  tradeIdKind: 'monotonic_int',
  toVenueSymbol,
  archiveFiles(symbol, day) {
    const venueSymbol = toVenueSymbol(symbol);
    return [fileRef(venueSymbol, day), fileRef(venueSymbol, addDays(day, 1))];
  },
  parseRows,
  async fetchInstrumentMeta(symbol, http) {
    const venueSymbol = toVenueSymbol(symbol);
    const body = await http.getJson<OkxResponse<Instrument>>(`${API}/api/v5/public/instruments?instType=SWAP&instId=${venueSymbol}`);
    const entry = body.data?.find((s) => s.instId === venueSymbol);
    expectOk(VENUE, body.code === '0' && entry !== undefined, body);
    const funding = await http.getJson<OkxResponse<CurrentFunding>>(`${API}/api/v5/public/funding-rate?instId=${venueSymbol}`);
    const current = funding.data?.find((row) => row.instId === venueSymbol);
    const intervalMs = Number(current?.nextFundingTime) - Number(current?.fundingTime);
    expectOk(VENUE, funding.code === '0', funding);
    return buildMeta({
      venue: VENUE,
      symbol,
      venueSymbol,
      tickText: entry!.tickSz,
      lotInArchiveUnits: entry!.lotSz,
      contractMultiplier: entry!.ctVal,
      takerFeeBps: 5.0,
      makerFeeBps: 2.0,
      fundingIntervalHours: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs / 3_600_000 : undefined,
    });
  },
  async fetchFunding(symbol: string, from: Ms, to: Ms, http: HttpClient): Promise<FundingRecord[]> {
    const venueSymbol = toVenueSymbol(symbol);
    const out: FundingRecord[] = [];
    let after = to + 1;
    for (;;) {
      const body = await http.getJson<OkxResponse<FundingRow>>(`${API}/api/v5/public/funding-rate-history?instId=${venueSymbol}&after=${after}&limit=400`);
      expectOk(VENUE, body.code === '0', body);
      const page = body.data ?? [];
      for (const row of page) {
        const t = Number(row.fundingTime);
        if (t >= from && t <= to) {
          out.push({ t, rate: Number(row.fundingRate) });
        }
      }
      const oldest = Math.min(...page.map((row) => Number(row.fundingTime)));
      if (page.length === 0 || oldest < from) {
        break;
      }
      after = oldest;
    }
    return out.sort((a, b) => a.t - b.t);
  },
};
