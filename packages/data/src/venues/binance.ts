// Binance USDⓈ-M perpetual — raw `trades` archive (not aggTrades).
// Docs: https://github.com/binance/binance-public-data (futures/um/daily/trades),
//       https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api
// Checked 2026-09-19 (ETHUSDT 2025-01-09): archive
//   data.binance.vision/data/futures/um/daily/trades/{S}/{S}-trades-{YYYY-MM-DD}.zip
// + `.CHECKSUM` sidecar (sha256sum format). CSV header
//   id,price,qty,quote_qty,time,is_buyer_maker ; UTC day ; time in ms ; qty in
// base asset. is_buyer_maker=true ⇒ seller was the taker (s=−1).
// Meta: GET /fapi/v1/exchangeInfo (PRICE_FILTER.tickSize, LOT_SIZE.stepSize);
//   funding interval from GET /fapi/v1/fundingInfo (fundingIntervalHours; only
//   symbols with adjusted funding parameters are listed, the others settle on
//   the default 8 h — [VERIFY] against the docs).
// Funding: GET /fapi/v1/fundingRate (startTime/endTime, limit ≤ 1000).
import type { Ms } from '@wsr/core';
import type { RawTradeRow, VenueDefinition } from '../adapter.js';
import { formatDay } from '../days.js';
import { parseEpochMs } from '../decimal.js';
import type { HttpClient } from '../http.js';
import { DEFAULT_RETRY_POLICY, MissingAggressorField, type FundingRecord, type VenueId } from '../venue.js';
import { DEFAULT_FUNDING_INTERVAL_HOURS, buildMeta, col, expectOk, field, rateLimit, resolveColumns, type Columns } from './common.js';

const VENUE: VenueId = 'binance';
const ARCHIVE = 'https://data.binance.vision/data/futures/um/daily/trades';
const API = 'https://fapi.binance.com';
const COLUMNS = ['id', 'price', 'qty', 'quote_qty', 'time', 'is_buyer_maker'] as const;

interface ExchangeInfo {
  readonly symbols?: ReadonlyArray<{
    readonly symbol: string;
    readonly filters: ReadonlyArray<{ readonly filterType: string; readonly tickSize?: string; readonly stepSize?: string }>;
  }>;
}

interface FundingInfo {
  readonly symbol: string;
  readonly fundingIntervalHours?: number;
}

interface FundingRow {
  readonly fundingTime: number;
  readonly fundingRate: string;
}

async function* parseRows(rows: AsyncIterable<string[]>): AsyncGenerator<RawTradeRow> {
  let columns: Columns | undefined;
  let iId = 0;
  let iPrice = 0;
  let iQty = 0;
  let iTime = 0;
  let iMaker = 0;
  for await (const fields of rows) {
    if (columns === undefined) {
      columns = resolveColumns(VENUE, fields, COLUMNS, ['id', 'price', 'qty', 'time'], 'is_buyer_maker');
      [iId, iPrice, iQty, iTime, iMaker] = [col(columns, 'id'), col(columns, 'price'), col(columns, 'qty'), col(columns, 'time'), col(columns, 'is_buyer_maker')];
      if (columns.header) {
        continue;
      }
    }
    const maker = field(fields, iMaker).toLowerCase();
    if (maker !== 'true' && maker !== 'false') {
      throw new MissingAggressorField(VENUE, `is_buyer_maker='${maker}'`);
    }
    yield {
      tradeId: field(fields, iId),
      time: parseEpochMs(field(fields, iTime)),
      priceText: field(fields, iPrice),
      sizeText: field(fields, iQty),
      s: maker === 'true' ? -1 : 1,
    };
  }
}

export const binance: VenueDefinition = {
  id: VENUE,
  adapterVersion: 'binance-trades-1',
  rateLimit: rateLimit(5),
  retryPolicy: DEFAULT_RETRY_POLICY,
  timestampResolution: 'ms',
  feedKind: 'raw',
  tradeIdKind: 'monotonic_int',
  toVenueSymbol: (symbol) => symbol,
  archiveFiles(symbol, day) {
    const name = `${symbol}-trades-${formatDay(day)}.zip`;
    const url = `${ARCHIVE}/${symbol}/${name}`;
    return [{ url, cacheKey: `${symbol}/${name}`, contentType: 'zip', checksumUrl: `${url}.CHECKSUM` }];
  },
  parseRows,
  async fetchInstrumentMeta(symbol, http) {
    const info = await http.getJson<ExchangeInfo>(`${API}/fapi/v1/exchangeInfo`);
    const entry = info.symbols?.find((s) => s.symbol === symbol);
    expectOk(VENUE, entry !== undefined, { symbol });
    const tickSize = entry!.filters.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize;
    const step = entry!.filters.find((f) => f.filterType === 'LOT_SIZE')?.stepSize;
    expectOk(VENUE, tickSize !== undefined && step !== undefined, entry);
    const fundingInfo = await http.getJson<FundingInfo[]>(`${API}/fapi/v1/fundingInfo`);
    expectOk(VENUE, Array.isArray(fundingInfo), fundingInfo);
    return buildMeta({
      venue: VENUE,
      symbol,
      venueSymbol: symbol,
      tickText: tickSize!,
      lotInArchiveUnits: step!,
      contractMultiplier: '1',
      takerFeeBps: 5.0,
      makerFeeBps: 2.0,
      // Absent from fundingInfo ⇒ the venue default (8 h), a venue fact, not a placeholder.
      fundingIntervalHours: fundingInfo.find((f) => f.symbol === symbol)?.fundingIntervalHours ?? DEFAULT_FUNDING_INTERVAL_HOURS,
    });
  },
  async fetchFunding(symbol: string, from: Ms, to: Ms, http: HttpClient): Promise<FundingRecord[]> {
    const out: FundingRecord[] = [];
    let start = from;
    for (;;) {
      const page = await http.getJson<FundingRow[]>(`${API}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${start}&endTime=${to}&limit=1000`);
      expectOk(VENUE, Array.isArray(page), page);
      for (const row of page) {
        out.push({ t: row.fundingTime, rate: Number(row.fundingRate) });
      }
      if (page.length < 1000) {
        return out;
      }
      start = page[page.length - 1]!.fundingTime + 1;
    }
  },
};
