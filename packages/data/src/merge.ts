import type { Lots, MergedEvent, Ms, Side, Ticks } from '@wsr/core';
import { sortedIndices } from './columns.js';

// Venue-agnostic on purpose (Spec §2.4 operates on one already-scoped
// (venue, symbol, day) partition): venue/symbol never appear here.
export interface RawMergeInput {
  readonly t: Ms;
  readonly seq: number; // venue delivery order (Spec §2.1)
  readonly p: Ticks;
  readonly q: Lots;
  readonly s: Side;
}

// Spec §2.3.1 merged-schema columns beyond MergedEvent (hygiene-only fields).
export interface MergedRecord extends MergedEvent {
  readonly pFirst: Ticks;
  readonly rawSeqFirst: number;
}

export interface MergeOptions {
  // Last flushed group of the previous UTC day. Spec §2.4 says midnightSplit
  // is set "when the first record of the day has the same (t,s) as the last
  // of the previous day" — read literally that never holds (t is an absolute
  // ms timestamp and the two days' last/first prints differ by construction).
  // We take the substantively-equivalent test instead: would this day's
  // first record have continued the previous day's last monotone run had the
  // partition boundary not cut it (same side, price still monotone in that
  // side's direction)? That is the same startNew predicate used within a day,
  // applied across the boundary.
  readonly previousDayLast?: { readonly p: Ticks; readonly s: Side } | undefined;
}

export interface MergeResult {
  readonly records: readonly MergedRecord[];
  readonly midnightSplit: boolean;
}

function continuesRun(side: Side, fromPrice: Ticks, toPrice: Ticks): boolean {
  return side === 1 ? toPrice >= fromPrice : toPrice <= fromPrice;
}

// Struct-of-arrays merged day (seq = row index).
export interface MergedColumns {
  readonly length: number;
  readonly t: Float64Array;
  readonly p: Float64Array;
  readonly q: Float64Array;
  readonly s: Int8Array;
  readonly n: Int32Array;
  readonly pFirst: Float64Array;
  readonly rawSeqFirst: Float64Array;
}

export interface MergeColumnsInput {
  readonly length: number;
  readonly t: Float64Array;
  readonly seq: Float64Array;
  readonly p: Float64Array;
  readonly q: Float64Array;
  readonly s: Int8Array;
}

// Spec §2.4 exact algorithm on columns: stable sort by (t asc, seq asc), then
// scan and group monotone same-(t,s) runs into one merged event per group.
// `keep` (1 = include) excludes dropped records without copying.
export function mergeColumns(raw: MergeColumnsInput, keep?: Uint8Array): MergedColumns {
  const order = sortedIndices(raw, keep);
  const cap = order.length;
  const out = {
    t: new Float64Array(cap),
    p: new Float64Array(cap),
    q: new Float64Array(cap),
    s: new Int8Array(cap),
    n: new Int32Array(cap),
    pFirst: new Float64Array(cap),
    rawSeqFirst: new Float64Array(cap),
  };
  let k = -1;
  for (const i of order) {
    const t = raw.t[i]!;
    const side = raw.s[i]! as Side;
    const price = raw.p[i]!;
    if (k < 0 || t !== out.t[k] || side !== out.s[k] || !continuesRun(side, out.p[k]!, price)) {
      k += 1;
      out.t[k] = t;
      out.s[k] = side;
      out.pFirst[k] = price;
      out.p[k] = price;
      out.q[k] = raw.q[i]!;
      out.n[k] = 1;
      out.rawSeqFirst[k] = raw.seq[i]!;
    } else {
      out.q[k]! += raw.q[i]!;
      out.p[k] = price;
      out.n[k]! += 1;
    }
  }
  const length = k + 1;
  // slice (not subarray): release the raw-length buffers.
  return {
    length,
    t: out.t.slice(0, length),
    p: out.p.slice(0, length),
    q: out.q.slice(0, length),
    s: out.s.slice(0, length),
    n: out.n.slice(0, length),
    pFirst: out.pFirst.slice(0, length),
    rawSeqFirst: out.rawSeqFirst.slice(0, length),
  };
}

export function mergedColumnsToRecords(cols: MergedColumns): MergedRecord[] {
  const records: MergedRecord[] = [];
  for (let k = 0; k < cols.length; k += 1) {
    records.push({
      t: cols.t[k]!,
      seq: k,
      p: cols.p[k]!,
      q: cols.q[k]!,
      s: cols.s[k]! as Side,
      n: cols.n[k]!,
      pFirst: cols.pFirst[k]!,
      rawSeqFirst: cols.rawSeqFirst[k]!,
    });
  }
  return records;
}

// Record-array form of mergeColumns (same algorithm).
export function merge(raw: readonly RawMergeInput[], options: MergeOptions = {}): MergeResult {
  const n = raw.length;
  const cols: MergeColumnsInput = {
    length: n,
    t: Float64Array.from(raw, (r) => r.t),
    seq: Float64Array.from(raw, (r) => r.seq),
    p: Float64Array.from(raw, (r) => r.p),
    q: Float64Array.from(raw, (r) => r.q),
    s: Int8Array.from(raw, (r) => r.s),
  };
  const merged = mergeColumns(cols);
  const midnightSplit = merged.length > 0 && isMidnightSplit(options.previousDayLast, { p: merged.pFirst[0]!, s: merged.s[0]! as Side });
  return { records: mergedColumnsToRecords(merged), midnightSplit };
}

// Spec §2.4 midnightSplit predicate (see MergeOptions.previousDayLast): the
// day's first raw record would have continued the previous day's last run.
// `first.p` is that raw record's price (= the first merged event's pFirst).
export function isMidnightSplit(
  previousDayLast: { readonly p: Ticks; readonly s: Side } | undefined,
  first: { readonly p: Ticks; readonly s: Side },
): boolean {
  return previousDayLast !== undefined && previousDayLast.s === first.s && continuesRun(previousDayLast.s, previousDayLast.p, first.p);
}
