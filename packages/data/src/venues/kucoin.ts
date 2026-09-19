// KuCoin USDT-margined perpetual — historical trade archive.
// Docs: https://historical-data.kucoin.com/ ,
//       https://www.kucoin.com/docs-new/rest/futures-trading/market-data/get-symbol
// Checked 2026-09-19 (ETHUSDTM 2025-01-09): archive
//   historical-data.kucoin.com/data/futures/daily/trades/{VS}/{VS}-trades-{YYYY-MM-DD}.zip
// with VS = <BASE>USDTM (BTC is BTCUSDTM in the archive). CSV header
// trade_id,trade_time,price,size,side ; UTC day ; trade_time in ms ; prices
// zero-padded ('3327.32000000000000000000') ; size in CONTRACTS (× multiplier,
// 0.01 ETH) ; side = taker side.
// Meta: GET /api/v1/contracts/{VS} (tickSize, multiplier, lotSize contracts,
//   fundingRateGranularity ms — funding settles at 04/12/20 UTC).
// Funding: GET /api/v1/contract/funding-rates (from/to ms).
import type { Ms } from '@wsr/core';
import type { RawTradeRow, VenueDefinition } from '../adapter.js';
import { formatDay } from '../days.js';
import { parseEpochMs } from '../decimal.js';
import type { HttpClient } from '../http.js';
import { DEFAULT_RETRY_POLICY, type FundingRecord, type VenueId } from '../venue.js';
import { baseAsset, buildMeta, col, decimalText, expectOk, field, rateLimit, resolveColumns, takerSide, type Columns } from './common.js';

const VENUE: VenueId = 'kucoin';
const ARCHIVE = 'https://historical-data.kucoin.com/data/futures/daily/trades';
const API = 'https://api-futures.kucoin.com';
const FUNDING_WINDOW_MS = 30 * 86_400_000;

interface KucoinResponse<T> {
  readonly code: string;
  readonly data?: T;
}

interface Contract {
  readonly symbol: string;
  readonly tickSize: number | string;
  readonly multiplier: number | string;
  readonly lotSize: number | string;
  readonly fundingRateGranularity?: number;
}

interface FundingRow {
  readonly timepoint: number;
  readonly fundingRate: number;
}

function toVenueSymbol(symbol: string): string {
  return `${baseAsset(symbol)}USDTM`;
}

async function* parseRows(rows: AsyncIterable<string[]>): AsyncGenerator<RawTradeRow> {
  let columns: Columns | undefined;
  let iId = 0;
  let iTime = 0;
  let iPrice = 0;
  let iSize = 0;
  let iSide = 0;
  for await (const fields of rows) {
    if (columns === undefined) {
      columns = resolveColumns(VENUE, fields, undefined, ['trade_id', 'trade_time', 'price', 'size'], 'side');
      [iId, iTime, iPrice, iSize, iSide] = [col(columns, 'trade_id'), col(columns, 'trade_time'), col(columns, 'price'), col(columns, 'size'), col(columns, 'side')];
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

export const kucoin: VenueDefinition = {
  id: VENUE,
  adapterVersion: 'kucoin-futures-trades-1',
  rateLimit: rateLimit(5),
  retryPolicy: DEFAULT_RETRY_POLICY,
  timestampResolution: 'ms',
  feedKind: 'raw',
  tradeIdKind: 'opaque',
  toVenueSymbol,
  archiveFiles(symbol, day) {
    const venueSymbol = toVenueSymbol(symbol);
    const name = `${venueSymbol}-trades-${formatDay(day)}.zip`;
    return [{ url: `${ARCHIVE}/${venueSymbol}/${name}`, cacheKey: `${venueSymbol}/${name}`, contentType: 'zip' }];
  },
  parseRows,
  async fetchInstrumentMeta(symbol, http) {
    const venueSymbol = toVenueSymbol(symbol);
    const body = await http.getJson<KucoinResponse<Contract>>(`${API}/api/v1/contracts/${venueSymbol}`);
    expectOk(VENUE, body.code === '200000' && body.data?.symbol === venueSymbol, body);
    const entry = body.data!;
    return buildMeta({
      venue: VENUE,
      symbol,
      venueSymbol,
      tickText: decimalText(entry.tickSize),
      lotInArchiveUnits: decimalText(entry.lotSize),
      contractMultiplier: decimalText(entry.multiplier),
      takerFeeBps: 6.0,
      makerFeeBps: 2.0,
      fundingIntervalHours: entry.fundingRateGranularity === undefined ? undefined : entry.fundingRateGranularity / 3_600_000,
    });
  },
  async fetchFunding(symbol: string, from: Ms, to: Ms, http: HttpClient): Promise<FundingRecord[]> {
    const venueSymbol = toVenueSymbol(symbol);
    const byTime = new Map<number, FundingRecord>();
    for (let start = from; start <= to; start += FUNDING_WINDOW_MS) {
      const end = Math.min(to, start + FUNDING_WINDOW_MS - 1);
      const body = await http.getJson<KucoinResponse<FundingRow[]>>(`${API}/api/v1/contract/funding-rates?symbol=${venueSymbol}&from=${start}&to=${end}`);
      expectOk(VENUE, body.code === '200000' && Array.isArray(body.data), body);
      for (const row of body.data!) {
        byTime.set(row.timepoint, { t: row.timepoint, rate: row.fundingRate });
      }
    }
    return [...byTime.values()].sort((a, b) => a.t - b.t);
  },
};
