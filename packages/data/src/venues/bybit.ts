// Bybit USDT linear perpetual — public trade archive.
// Docs: https://public.bybit.com/trading/ (directory listing),
//       https://bybit-exchange.github.io/docs/v5/market/instrument
// Checked 2026-09-19 (ETHUSDT 2025-01-09): archive
//   public.bybit.com/trading/{S}/{S}{YYYY-MM-DD}.csv.gz (no checksum published).
// CSV header timestamp,symbol,side,size,price,tickDirection,trdMatchID,
//   grossValue,homeNotional,foreignNotional ; UTC day ; timestamp = epoch
// seconds with a fractional part (sub-ms kept in tNsRemainder) ; size in base
// asset ; side = taker side (Buy/Sell) ; trdMatchID is a UUID (unordered).
// Early files may lack the header row (column order above assumed).
// Meta: GET /v5/market/instruments-info?category=linear (priceFilter.tickSize,
//   lotSizeFilter.qtyStep, fundingInterval minutes).
// Funding: GET /v5/market/funding/history (newest first, limit ≤ 200).
import type { Ms } from '@wsr/core';
import type { RawTradeRow, VenueDefinition } from '../adapter.js';
import { formatDay } from '../days.js';
import { parseEpochSeconds } from '../decimal.js';
import type { HttpClient } from '../http.js';
import { DEFAULT_RETRY_POLICY, type FundingRecord, type VenueId } from '../venue.js';
import { buildMeta, col, expectOk, field, rateLimit, resolveColumns, takerSide, type Columns } from './common.js';

const VENUE: VenueId = 'bybit';
const ARCHIVE = 'https://public.bybit.com/trading';
const API = 'https://api.bybit.com';
const COLUMNS = ['timestamp', 'symbol', 'side', 'size', 'price', 'tickDirection', 'trdMatchID', 'grossValue', 'homeNotional', 'foreignNotional'] as const;

interface BybitResponse<T> {
  readonly retCode: number;
  readonly result?: { readonly list?: readonly T[] };
}

interface Instrument {
  readonly symbol: string;
  readonly priceFilter: { readonly tickSize: string };
  readonly lotSizeFilter: { readonly qtyStep: string };
  readonly fundingInterval?: number;
}

interface FundingRow {
  readonly fundingRate: string;
  readonly fundingRateTimestamp: string;
}

async function* parseRows(rows: AsyncIterable<string[]>): AsyncGenerator<RawTradeRow> {
  let columns: Columns | undefined;
  let iTime = 0;
  let iSide = 0;
  let iSize = 0;
  let iPrice = 0;
  let iId = 0;
  for await (const fields of rows) {
    if (columns === undefined) {
      columns = resolveColumns(VENUE, fields, COLUMNS, ['timestamp', 'size', 'price', 'trdMatchID'], 'side');
      [iTime, iSide, iSize, iPrice, iId] = [col(columns, 'timestamp'), col(columns, 'side'), col(columns, 'size'), col(columns, 'price'), col(columns, 'trdMatchID')];
      if (columns.header) {
        continue;
      }
    }
    yield {
      tradeId: field(fields, iId),
      time: parseEpochSeconds(field(fields, iTime)),
      priceText: field(fields, iPrice),
      sizeText: field(fields, iSize),
      s: takerSide(VENUE, field(fields, iSide)),
    };
  }
}

export const bybit: VenueDefinition = {
  id: VENUE,
  adapterVersion: 'bybit-trading-1',
  rateLimit: rateLimit(2),
  retryPolicy: DEFAULT_RETRY_POLICY,
  timestampResolution: 's_fractional',
  feedKind: 'raw',
  tradeIdKind: 'uuid',
  toVenueSymbol: (symbol) => symbol,
  archiveFiles(symbol, day) {
    const name = `${symbol}${formatDay(day)}.csv.gz`;
    return [{ url: `${ARCHIVE}/${symbol}/${name}`, cacheKey: `${symbol}/${name}`, contentType: 'csv.gz' }];
  },
  parseRows,
  async fetchInstrumentMeta(symbol, http) {
    const body = await http.getJson<BybitResponse<Instrument>>(`${API}/v5/market/instruments-info?category=linear&symbol=${symbol}`);
    const entry = body.result?.list?.find((s) => s.symbol === symbol);
    expectOk(VENUE, body.retCode === 0 && entry !== undefined, body);
    return buildMeta({
      venue: VENUE,
      symbol,
      venueSymbol: symbol,
      tickText: entry!.priceFilter.tickSize,
      lotInArchiveUnits: entry!.lotSizeFilter.qtyStep,
      contractMultiplier: '1',
      takerFeeBps: 5.5,
      makerFeeBps: 2.0,
      fundingIntervalHours: entry!.fundingInterval === undefined ? undefined : entry!.fundingInterval / 60,
    });
  },
  async fetchFunding(symbol: string, from: Ms, to: Ms, http: HttpClient): Promise<FundingRecord[]> {
    const out: FundingRecord[] = [];
    let end = to;
    while (end >= from) {
      const body = await http.getJson<BybitResponse<FundingRow>>(`${API}/v5/market/funding/history?category=linear&symbol=${symbol}&startTime=${from}&endTime=${end}&limit=200`);
      expectOk(VENUE, body.retCode === 0, body);
      const page = body.result?.list ?? [];
      for (const row of page) {
        out.push({ t: Number(row.fundingRateTimestamp), rate: Number(row.fundingRate) });
      }
      if (page.length < 200) {
        break;
      }
      end = Math.min(...page.map((row) => Number(row.fundingRateTimestamp))) - 1;
    }
    return out.sort((a, b) => a.t - b.t);
  },
};
