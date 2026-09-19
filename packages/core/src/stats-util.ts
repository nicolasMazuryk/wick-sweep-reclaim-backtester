// Small numeric helpers shared by the bucket-close statistics (Spec §3.2.6).

function swap(arr: Float64Array, i: number, j: number): void {
  const tmp = arr[i]!;
  arr[i] = arr[j]!;
  arr[j] = tmp;
}

// In-place nth_element over arr[0, len): afterwards arr[kth] holds the value
// of rank kth (0-based) in sorted order, everything left of it is ≤ and
// everything right of it is ≥. Deterministic median-of-three pivot.
export function quickselect(arr: Float64Array, len: number, kth: number): number {
  if (kth < 0 || kth >= len) {
    throw new RangeError(`quickselect: kth ${kth} outside [0, ${len})`);
  }
  let lo = 0;
  let hi = len - 1;
  while (hi > lo) {
    const mid = lo + ((hi - lo) >> 1);
    if (arr[mid]! < arr[lo]!) swap(arr, mid, lo);
    if (arr[hi]! < arr[lo]!) swap(arr, hi, lo);
    if (arr[hi]! < arr[mid]!) swap(arr, hi, mid);
    const pivot = arr[mid]!;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (arr[i]! < pivot) i++;
      while (arr[j]! > pivot) j--;
      if (i <= j) {
        swap(arr, i, j);
        i++;
        j--;
      }
    }
    if (kth <= j) {
      hi = j;
    } else if (kth >= i) {
      lo = i;
    } else {
      break;
    }
  }
  return arr[kth]!;
}

// Median of arr[0, len), reordering arr. Even sample → mean of the two middles
// (A-49). Empty → NaN.
export function medianOf(arr: Float64Array, len: number): number {
  if (len === 0) {
    return NaN;
  }
  const upper = len >> 1;
  const upperValue = quickselect(arr, len, upper);
  if (len % 2 === 1) {
    return upperValue;
  }
  // After selection every value left of `upper` is ≤ upperValue; the lower
  // middle is the largest of them.
  let lowerValue = -Infinity;
  for (let i = 0; i < upper; i++) {
    if (arr[i]! > lowerValue) lowerValue = arr[i]!;
  }
  return (lowerValue + upperValue) / 2;
}

// Nearest-rank percentile ceil(pct·n) of arr[0, len), reordering arr (A-52). Empty → NaN.
export function percentileNearestRank(arr: Float64Array, len: number, pct: number): number {
  if (len === 0) {
    return NaN;
  }
  const rank = Math.min(len, Math.max(1, Math.ceil(pct * len - 1e-9)));
  return quickselect(arr, len, rank - 1);
}

// First position in sorted[0, len) whose value is ≥ x.
function lowerBound(sorted: Float64Array, len: number, x: number): number {
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < x) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// First position in sorted[0, len) whose value is > x.
function upperBound(sorted: Float64Array, len: number, x: number): number {
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= x) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// Rolling window over the last `capacity` pushed values: a ring for arrival
// order plus a sorted array maintained by binary insert/remove (O(N) memmove,
// N = 1440 in practice). Serves rolling medians and rank counts. NaN is not
// ordered and must not be pushed.
export class SortedWindow {
  private readonly arrival: Float64Array;
  private readonly sorted: Float64Array;
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.arrival = new Float64Array(capacity);
    this.sorted = new Float64Array(capacity);
  }

  get size(): number { return this.count; }

  push(x: number): void {
    if (this.count === this.capacity) {
      // Evict and insert with one memmove of the elements between the two
      // positions (the same array as remove-then-insert, both at lowerBound).
      const s = this.sorted;
      const out = lowerBound(s, this.count, this.arrival[this.head]!);
      const at = lowerBound(s, this.count, x);
      if (at <= out) {
        s.copyWithin(at + 1, at, out);
        s[at] = x;
      } else {
        s.copyWithin(out, out + 1, at);
        s[at - 1] = x;
      }
      this.arrival[this.head] = x;
      this.head = (this.head + 1) % this.capacity;
      return;
    }
    this.arrival[this.head] = x;
    this.head = (this.head + 1) % this.capacity;
    const at = lowerBound(this.sorted, this.count, x);
    this.sorted.copyWithin(at + 1, at, this.count);
    this.sorted[at] = x;
    this.count++;
  }

  // #{y ∈ window : y < x} and #{y ∈ window : y ≤ x}, O(log N).
  countLess(x: number): number { return lowerBound(this.sorted, this.count, x); }
  countLessOrEqual(x: number): number { return upperBound(this.sorted, this.count, x); }

  // Contents in arrival order, oldest first (for snapshots).
  toArray(): number[] {
    const out: number[] = [];
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) out.push(this.arrival[(start + i) % this.capacity]!);
    return out;
  }

  median(): number {
    if (this.count === 0) {
      return NaN;
    }
    const upper = this.count >> 1;
    return this.count % 2 === 1 ? this.sorted[upper]! : (this.sorted[upper - 1]! + this.sorted[upper]!) / 2;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
  }
}

// FIFO multiset with nearest-rank order statistics: values leave in arrival
// order, the distinct values are kept sorted with their counts. Push/shift
// cost O(log K) plus an O(K) memmove only when a value appears or vanishes;
// nearestRank walks the counts from the nearer end (K = distinct values, few
// for event sizes). Same rank rule as percentileNearestRank. NaN must not be pushed.
export class SlidingOrderStats {
  private fifo = new Float64Array(16);
  private head = 0;
  private count = 0;
  private keys = new Float64Array(16);
  private counts = new Float64Array(16);
  private distinct = 0;

  get size(): number { return this.count; }

  push(x: number): void {
    if (this.count === this.fifo.length) {
      const grown = new Float64Array(this.fifo.length * 2);
      for (let i = 0; i < this.count; i++) grown[i] = this.fifo[(this.head + i) % this.fifo.length]!;
      this.fifo = grown;
      this.head = 0;
    }
    this.fifo[(this.head + this.count) % this.fifo.length] = x;
    this.count++;
    const at = lowerBound(this.keys, this.distinct, x);
    if (at < this.distinct && this.keys[at] === x) {
      this.counts[at]!++;
      return;
    }
    if (this.distinct === this.keys.length) {
      const keys = new Float64Array(this.keys.length * 2);
      const counts = new Float64Array(this.keys.length * 2);
      keys.set(this.keys);
      counts.set(this.counts);
      this.keys = keys;
      this.counts = counts;
    }
    this.keys.copyWithin(at + 1, at, this.distinct);
    this.counts.copyWithin(at + 1, at, this.distinct);
    this.keys[at] = x;
    this.counts[at] = 1;
    this.distinct++;
  }

  // Removes and returns the oldest value.
  shift(): number {
    if (this.count === 0) {
      throw new RangeError('SlidingOrderStats.shift: empty');
    }
    const x = this.fifo[this.head]!;
    this.head = (this.head + 1) % this.fifo.length;
    this.count--;
    const at = lowerBound(this.keys, this.distinct, x);
    if (--this.counts[at]! === 0) {
      this.keys.copyWithin(at, at + 1, this.distinct);
      this.counts.copyWithin(at, at + 1, this.distinct);
      this.distinct--;
    }
    return x;
  }

  // Nearest-rank percentile ceil(pct·n) of the held values (A-52). Empty → NaN.
  nearestRank(pct: number): number {
    if (this.count === 0) {
      return NaN;
    }
    const rank = Math.min(this.count, Math.max(1, Math.ceil(pct * this.count - 1e-9)));
    if (2 * rank <= this.count) {
      let seen = 0;
      for (let j = 0; ; j++) {
        seen += this.counts[j]!;
        if (seen >= rank) return this.keys[j]!;
      }
    }
    // Walk down: `above` = #values ≥ keys[j]; stop once fewer than `rank` lie below.
    let above = 0;
    for (let j = this.distinct - 1; ; j--) {
      above += this.counts[j]!;
      if (this.count - above < rank) return this.keys[j]!;
    }
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.distinct = 0;
  }
}

// EWMA with α = 2/(N+1), seeded with the first observation (Spec §3.2.6 #3).
export class Ewma {
  readonly alpha: number;
  private current = NaN;

  constructor(readonly span: number) {
    this.alpha = 2 / (span + 1);
  }

  get value(): number { return this.current; }
  get seeded(): boolean { return !Number.isNaN(this.current); }

  update(x: number): number {
    this.current = Number.isNaN(this.current) ? x : this.current + this.alpha * (x - this.current);
    return this.current;
  }

  reset(): void {
    this.current = NaN;
  }
}
