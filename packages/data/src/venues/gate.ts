// Gate USDT-margined perpetual — monthly trade archive.
// Docs: https://www.gate.io/developer/historical_quotes ,
//       https://www.gate.io/docs/developers/apiv4/#futures
// Checked 2026-09-19 (ETH_USDT 2025-01): archive
//   download.gatedata.org/futures_usdt/trades/{YYYYMM}/{VS}-{YYYYMM}.csv.gz
// (~140 MB gz per month; published after the month ends). No header; columns
// timestamp,id,price,size ; timestamp = epoch seconds with µs fraction (sub-ms
// kept in tNsRemainder) ; size in CONTRACTS (× quanto_multiplier, 0.01 ETH),
// SIGNED: > 0 taker buy, < 0 taker sell (A-60, [VERIFY] against Gate's docs:
// the REST `size` is documented the same way). UTC month; rows time-ascending.
// Meta: GET /api/v4/futures/usdt/contracts/{VS} (order_price_round,
//   quanto_multiplier, funding_interval seconds; lot = 1 contract).
// Funding: GET /api/v4/futures/usdt/funding_rate (from/to seconds, newest
//   first, limit ≤ 1000; only the last 180 days are served — older requested
//   settlements come back empty and are listed in fundingMissing).
import type { Ms } from '@wsr/core';
import type { RawTradeRow, VenueDefinition } from '../adapter.js';
import { formatMonthCompact } from '../days.js';
import { parseEpochSeconds } from '../decimal.js';
import type { HttpClient } from '../http.js';
import { DEFAULT_RETRY_POLICY, MissingAggressorField, type FundingRecord, type VenueId } from '../venue.js';
import { baseAsset, buildMeta, expectOk, field, rateLimit } from './common.js';

const VENUE: VenueId = 'gate';
const ARCHIVE = 'https://download.gatedata.org/futures_usdt/trades';
const API = 'https://api.gateio.ws/api/v4';
const FUNDING_PAGE = 1000;

interface Contract {
  readonly name: string;
  readonly order_price_round: string;
  readonly quanto_multiplier: string;
  readonly funding_interval?: number;
}

interface FundingRow {
  readonly t: number;
  readonly r: string;
}

function toVenueSymbol(symbol: string): string {
  return `${baseAsset(symbol)}_USDT`;
}

async function* parseRows(rows: AsyncIterable<string[]>): AsyncGenerator<RawTradeRow> {
  let checked = false;
  for await (const fields of rows) {
    if (!checked) {
      checked = true;
      if (fields.length < 4) {
        throw new MissingAggressorField(VENUE, `expected timestamp,id,price,size(signed); got ${fields.length} fields`);
      }
      if (!/^[0-9]/.test(field(fields, 0))) {
        continue; // tolerate a header row
      }
    }
    const size = field(fields, 3);
    const negative = size.startsWith('-');
    yield {
      tradeId: field(fields, 1),
      time: parseEpochSeconds(field(fields, 0)),
      priceText: field(fields, 2),
      sizeText: negative || size.startsWith('+') ? size.slice(1) : size,
      s: negative ? -1 : 1,
    };
  }
}

export const gate: VenueDefinition = {
  id: VENUE,
  adapterVersion: 'gate-futures-usdt-1',
  rateLimit: rateLimit(5, 2),
  retryPolicy: DEFAULT_RETRY_POLICY,
  timestampResolution: 's_fractional',
  feedKind: 'raw',
  tradeIdKind: 'monotonic_int',
  timeSortedFiles: true,
  toVenueSymbol,
  archiveFiles(symbol, day) {
    const venueSymbol = toVenueSymbol(symbol);
    const month = formatMonthCompact(day);
    const name = `${venueSymbol}-${month}.csv.gz`;
    return [{ url: `${ARCHIVE}/${month}/${name}`, cacheKey: `${venueSymbol}/${name}`, contentType: 'csv.gz' }];
  },
  parseRows,
  async fetchInstrumentMeta(symbol, http) {
    const venueSymbol = toVenueSymbol(symbol);
    const entry = await http.getJson<Contract>(`${API}/futures/usdt/contracts/${venueSymbol}`);
    expectOk(VENUE, entry.name === venueSymbol, entry);
    return buildMeta({
      venue: VENUE,
      symbol,
      venueSymbol,
      tickText: entry.order_price_round,
      lotInArchiveUnits: '1',
      contractMultiplier: entry.quanto_multiplier,
      takerFeeBps: 5.0,
      makerFeeBps: 2.0,
      fundingIntervalHours: entry.funding_interval === undefined ? undefined : entry.funding_interval / 3600,
    });
  },
  // The requested span only (no wall-clock look-back clamp): the output
  // depends on (from, to) and the venue's answer, nothing else.
  async fetchFunding(symbol: string, from: Ms, to: Ms, http: HttpClient): Promise<FundingRecord[]> {
    const out: FundingRecord[] = [];
    const fromSec = Math.ceil(from / 1000);
    let toSec = Math.floor(to / 1000);
    while (toSec >= fromSec) {
      const page = await http.getJson<FundingRow[]>(`${API}/futures/usdt/funding_rate?contract=${toVenueSymbol(symbol)}&from=${fromSec}&to=${toSec}&limit=${FUNDING_PAGE}`);
      expectOk(VENUE, Array.isArray(page), page);
      for (const row of page) {
        if (row.t >= fromSec && row.t <= toSec) {
          out.push({ t: row.t * 1000, rate: Number(row.r) });
        }
      }
      if (page.length < FUNDING_PAGE) {
        break;
      }
      toSec = Math.min(...page.map((row) => row.t)) - 1;
    }
    return out.sort((a, b) => a.t - b.t);
  },
};
