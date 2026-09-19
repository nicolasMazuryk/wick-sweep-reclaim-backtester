import { invariantFailed } from './invariant.js';
import type { Ms } from './types.js';

// Spec §2.6.3: data-hygiene blacklist intervals, half-open `[start, end)` in
// ms. Built from flat `[start0, end0, start1, end1, …]` pairs in any order;
// overlapping or touching intervals are merged. `contains` is the per-print
// query (Spec §3.10 step 1, non-decreasing t: monotone cursor, O(1)
// amortised); `overlaps` answers arbitrary spans (binary search).
export class Blacklist {
  private readonly bounds: Float64Array;    // merged, sorted: start_i < end_i < start_{i+1}
  private cursor = 0;                       // first interval with end > last contains() query
  private lastT: Ms = -Infinity;

  constructor(pairs: ArrayLike<Ms>) {
    if (pairs.length % 2 !== 0) invariantFailed(`Blacklist: ${pairs.length} values is not a list of [start, end) pairs`);
    const intervals: [Ms, Ms][] = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const start = pairs[i]!;
      const end = pairs[i + 1]!;
      if (!(Number.isFinite(start) && Number.isFinite(end))) invariantFailed(`Blacklist: interval [${start}, ${end}) is not finite`);
      if (end > start) intervals.push([start, end]);
    }
    intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Ms[] = [];
    for (const [start, end] of intervals) {
      const n = merged.length;
      if (n > 0 && start <= merged[n - 1]!) merged[n - 1] = Math.max(merged[n - 1]!, end);
      else merged.push(start, end);
    }
    this.bounds = Float64Array.from(merged);
  }

  static empty(): Blacklist { return new Blacklist([]); }

  get size(): number { return this.bounds.length / 2; }

  // Merged intervals as [start, end) pairs (reports, snapshots).
  intervals(): [Ms, Ms][] {
    const out: [Ms, Ms][] = [];
    for (let i = 0; i < this.bounds.length; i += 2) out.push([this.bounds[i]!, this.bounds[i + 1]!]);
    return out;
  }

  // Is t inside an interval? Monotone cursor; a query earlier than the
  // previous one falls back to a binary search.
  contains(t: Ms): boolean {
    if (t < this.lastT) this.cursor = this.firstEndAfter(t);
    this.lastT = t;
    const b = this.bounds;
    while (this.cursor < this.size && b[2 * this.cursor + 1]! <= t) this.cursor++;
    return this.cursor < this.size && b[2 * this.cursor]! <= t;
  }

  // Does the closed span [a, b] intersect an interval? (A point: a = b.)
  overlaps(a: Ms, b: Ms): boolean {
    const i = this.firstEndAfter(a);
    return i < this.size && this.bounds[2 * i]! <= b;
  }

  // First interval index with end > t.
  private firstEndAfter(t: Ms): number {
    let lo = 0;
    let hi = this.size;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.bounds[2 * mid + 1]! <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
