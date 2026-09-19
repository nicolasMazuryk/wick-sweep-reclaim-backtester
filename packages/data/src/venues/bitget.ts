// Bitget USDT-M perpetual (UMCBL) — public trade archive.
// Docs: https://www.bitget.com/data-download ,
//       https://www.bitget.com/api-doc/contract/market/Get-All-Symbols-Contracts
// Checked 2026-09-19 (ETHUSDT 2025-01-09): archive parts
//   img.bitgetimg.com/online/trades/UMCBL/{S}/{YYYYMMDD}_{NNN}.zip, NNN = 001,
// 002, … — the part count is unpublished; the first missing part answers 403.
// CSV header trade_id,timestamp,price,side,volume(quote),size(base) ;
// timestamp in ms but WHOLE SECONDS (A-59) ; side = taker side ; size in base.
// Files are cut on the UTC+8 day (the day-D set starts at D−1 16:00Z), so one
// UTC day needs the part sets of D and D+1 (A-58).
// Meta: GET /api/v2/mix/market/contracts?productType=USDT-FUTURES
//   (Tick = priceEndStep·10^−pricePlace, sizeMultiplier, fundInterval hours).
// Funding: GET /api/v2/mix/market/history-fund-rate (pageNo/pageSize ≤ 100,
//   newest first).
import type { Ms } from '@wsr/core';
import type { RawTradeRow, VenueDefinition } from '../adapter.js';
import { addDays, formatDayCompact } from '../days.js';
import { formatDecimal, parseDecimal, parseEpochMs } from '../decimal.js';
import type { HttpClient } from '../http.js';
import { DEFAULT_RETRY_POLICY, type ArchiveFileRef, type FundingRecord, type UtcDay, type VenueId } from '../venue.js';
import { buildMeta, col, expectOk, field, rateLimit, resolveColumns, takerSide, type Columns } from './common.js';

const VENUE: VenueId = 'bitget';
const ARCHIVE = 'https://img.bitgetimg.com/online/trades/UMCBL';
const API = 'https://api.bitget.com';
// Safety cap so a CDN glitch cannot turn probing into an endless scan.
const MAX_PARTS = 200;
const FUNDING_PAGE = 100;
const MAX_FUNDING_PAGES = 500;

interface BitgetResponse<T> {
  readonly code: string;
  readonly data?: readonly T[];
}

interface Contract {
  readonly symbol: string;
  readonly pricePlace: string;
  readonly priceEndStep: string;
  readonly sizeMultiplier: string;
  readonly fundInterval?: string;
}

interface FundingRow {
  readonly fundingRate: string;
  readonly fundingTime: string;
}

function partSet(symbol: string, fileDay: UtcDay): ArchiveFileRef {
  const stem = formatDayCompact(fileDay);
  const part = (n: number) => {
    const name = `${stem}_${String(n).padStart(3, '0')}.zip`;
    return { url: `${ARCHIVE}/${symbol}/${name}`, cacheKey: `${symbol}/${stem}/${name}` };
  };
  return { url: part(1).url, cacheKey: `${symbol}/${stem}`, contentType: 'zip', probeParts: { maxParts: MAX_PARTS, part } };
}

async function* parseRows(rows: AsyncIterable<string[]>): AsyncGenerator<RawTradeRow> {
  let columns: Columns | undefined;
  let iId = 0;
  let iTime = 0;
  let iPrice = 0;
  let iSide = 0;
  let iSize = 0;
  for await (const fields of rows) {
    if (columns === undefined) {
      columns = resolveColumns(VENUE, fields, undefined, ['trade_id', 'timestamp', 'price', 'size(base)'], 'side');
      [iId, iTime, iPrice, iSide, iSize] = [col(columns, 'trade_id'), col(columns, 'timestamp'), col(columns, 'price'), col(columns, 'side'), col(columns, 'size(base)')];
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

export const bitget: VenueDefinition = {
  id: VENUE,
  adapterVersion: 'bitget-umcbl-1',
  rateLimit: rateLimit(10),
  retryPolicy: DEFAULT_RETRY_POLICY,
  timestampResolution: 's',
  feedKind: 'raw',
  tradeIdKind: 'monotonic_int',
  toVenueSymbol: (symbol) => symbol,
  archiveFiles: (symbol, day) => [partSet(symbol, day), partSet(symbol, addDays(day, 1))],
  parseRows,
  async fetchInstrumentMeta(symbol, http) {
    const body = await http.getJson<BitgetResponse<Contract>>(`${API}/api/v2/mix/market/contracts?productType=USDT-FUTURES&symbol=${symbol}`);
    const entry = body.data?.find((s) => s.symbol === symbol);
    expectOk(VENUE, body.code === '00000' && entry !== undefined, body);
    const step = parseDecimal(entry!.priceEndStep);
    const tickSize = formatDecimal({ units: step.units, scale: step.scale + Number(entry!.pricePlace) });
    return buildMeta({
      venue: VENUE,
      symbol,
      venueSymbol: symbol,
      tickText: tickSize,
      lotInArchiveUnits: entry!.sizeMultiplier,
      contractMultiplier: '1',
      takerFeeBps: 6.0,
      makerFeeBps: 2.0,
      fundingIntervalHours: entry!.fundInterval === undefined ? undefined : Number(entry!.fundInterval),
    });
  },
  async fetchFunding(symbol: string, from: Ms, to: Ms, http: HttpClient): Promise<FundingRecord[]> {
    const out: FundingRecord[] = [];
    for (let pageNo = 1; pageNo <= MAX_FUNDING_PAGES; pageNo += 1) {
      const body = await http.getJson<BitgetResponse<FundingRow>>(
        `${API}/api/v2/mix/market/history-fund-rate?productType=USDT-FUTURES&symbol=${symbol}&pageSize=${FUNDING_PAGE}&pageNo=${pageNo}`,
      );
      expectOk(VENUE, body.code === '00000', body);
      const page = body.data ?? [];
      for (const row of page) {
        const t = Number(row.fundingTime);
        if (t >= from && t <= to) {
          out.push({ t, rate: Number(row.fundingRate) });
        }
      }
      if (page.length < FUNDING_PAGE || Math.min(...page.map((row) => Number(row.fundingTime))) < from) {
        break;
      }
    }
    return out.sort((a, b) => a.t - b.t);
  },
};
