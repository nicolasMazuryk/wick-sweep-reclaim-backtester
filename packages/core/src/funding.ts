import { invariantFailed } from './invariant.js';
import type { Ms, Side } from './types.js';

// One funding settlement (`funding.parquet`, Spec §2.5). Declared locally:
// @wsr/core must not import @wsr/data (Spec §1.4).
export interface FundingRecord {
  readonly t: Ms;                           // settlement timestamp, UTC epoch ms
  readonly rate: number;                    // fraction per interval; > 0 ⇒ longs pay shorts
}

// A-38: 1 bp of notional per missing settlement, charged against the position.
export const FALLBACK_FUNDING_RATE = 0.0001;

export interface FundingAccrual {
  readonly cost: number;                    // quote currency; > 0 = paid, < 0 = received
  readonly missing: number;                 // settlements inside the trade without a record
}

// A-66: a stored record within this distance of an expected settlement counts.
export const FUNDING_MATCH_TOLERANCE_MS = 60_000;

// Default settlement interval when neither a schedule nor venue metadata is
// available (A-38 charges 1 bp per 8 h).
export const DEFAULT_FUNDING_INTERVAL_MS = 8 * 3_600_000;

// A-66: phase of the venue's funding grid in [0, intervalMs), taken from the
// stored record nearest `anchorT` rounded to the minute (venue timestamps
// jitter by a few ms; KuCoin settles at 04/12/20 UTC); 0 (UTC-epoch anchored)
// when there is no record. `records` need not be sorted.
export function fundingPhaseMs(records: ReadonlyArray<FundingRecord>, anchorT: Ms, intervalMs: Ms): Ms {
  let nearest: FundingRecord | undefined;
  for (const record of records) {
    if (nearest === undefined || Math.abs(record.t - anchorT) < Math.abs(nearest.t - anchorT)) nearest = record;
  }
  if (nearest === undefined) return 0;
  const rounded = intervalMs > 60_000 ? Math.round(nearest.t / 60_000) * 60_000 : nearest.t;
  return ((rounded % intervalMs) + intervalMs) % intervalMs;
}

// Spec §4.5: settlements on the venue grid `tf = phase + k·intervalMs` (A-66)
// with entryT < tf ≤ exitT. Position direction is −Side (Side=+1 ⇒ short), so
// cost = −Side·rate·notional: a short receives when rate > 0 and pays when
// rate < 0, a long the opposite [VERIFY] against each venue's documentation.
// `records` must be sorted by t; a settlement is matched by the nearest record
// within ±FUNDING_MATCH_TOLERANCE_MS, otherwise charged per A-38 and counted.
export function fundingAccrued(
  side: Side, notional: number, entryT: Ms, exitT: Ms, records: ReadonlyArray<FundingRecord>, intervalMs: Ms,
): FundingAccrual {
  if (!(intervalMs > 0)) invariantFailed(`fundingAccrued: intervalMs ${intervalMs} must be positive`);
  const phase = fundingPhaseMs(nearbyRecords(records, entryT), entryT, intervalMs);
  const tol = Math.min(FUNDING_MATCH_TOLERANCE_MS, Math.floor((intervalMs - 1) / 2));   // one record per settlement
  let cost = 0;
  let missing = 0;
  for (let tf = (Math.floor((entryT - phase) / intervalMs) + 1) * intervalMs + phase; tf <= exitT; tf += intervalMs) {
    const rec = nearestWithin(records, tf, tol);
    if (rec !== undefined) cost += -side * rec.rate * notional;
    else {
      cost += FALLBACK_FUNDING_RATE * notional;
      missing++;
    }
  }
  return { cost: cost + 0, missing };
}

// The (at most two) records bracketing `t` — enough to find the nearest one
// without scanning the whole sorted history.
function nearbyRecords(records: ReadonlyArray<FundingRecord>, t: Ms): FundingRecord[] {
  const i = lowerBound(records, t);
  const out: FundingRecord[] = [];
  if (i > 0) out.push(records[i - 1]!);
  if (i < records.length) out.push(records[i]!);
  return out;
}

function nearestWithin(records: ReadonlyArray<FundingRecord>, t: Ms, tol: Ms): FundingRecord | undefined {
  let best: FundingRecord | undefined;
  for (const r of nearbyRecords(records, t)) {
    if (Math.abs(r.t - t) <= tol && (best === undefined || Math.abs(r.t - t) < Math.abs(best.t - t))) best = r;
  }
  return best;
}

// First index with records[i].t ≥ t.
function lowerBound(records: ReadonlyArray<FundingRecord>, t: Ms): number {
  let lo = 0;
  let hi = records.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (records[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
