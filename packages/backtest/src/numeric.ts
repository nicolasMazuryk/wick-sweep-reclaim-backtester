// Numeric helpers for the harness statistics (no numeric library, Spec §1.4).
// Sums over trades/observations are compensated and taken in a fixed order (Spec §9.2).

// Kahan–Babuška (Neumaier) compensated sum.
export class KahanSum {
  private sum = 0;
  private c = 0;

  add(x: number): this {
    const s = this.sum + x;
    if (Math.abs(this.sum) >= Math.abs(x)) this.c += this.sum - s + x;
    else this.c += x - s + this.sum;
    this.sum = s;
    return this;
  }

  get value(): number {
    return this.sum + this.c;
  }
}

export function sum(xs: ArrayLike<number>): number {
  const k = new KahanSum();
  for (let i = 0; i < xs.length; i++) k.add(xs[i]!);
  return k.value;
}

// NaN for an empty sample.
export function mean(xs: ArrayLike<number>): number {
  return xs.length === 0 ? NaN : sum(xs) / xs.length;
}

// Sample variance (n − 1), two-pass; NaN below 2 observations.
export function variance(xs: ArrayLike<number>): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  const k = new KahanSum();
  for (let i = 0; i < n; i++) k.add((xs[i]! - m) ** 2);
  return k.value / (n - 1);
}

// Linear-interpolation percentile (type 7) of an unsorted sample, pct ∈ [0, 1]; NaN when empty.
export function percentile(xs: ArrayLike<number>, pct: number): number {
  if (!(pct >= 0 && pct <= 1)) throw new Error(`percentile: pct ${pct} outside [0, 1]`);
  const n = xs.length;
  if (n === 0) return NaN;
  const sorted = Float64Array.from(xs).sort();
  const h = (n - 1) * pct;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

// OLS slope of y on x; NaN when x has no spread or fewer than 2 points.
export function olsSlope(x: ArrayLike<number>, y: ArrayLike<number>): number {
  if (x.length !== y.length) throw new Error('olsSlope: length mismatch');
  const n = x.length;
  if (n < 2) return NaN;
  const mx = mean(x);
  const my = mean(y);
  const sxy = new KahanSum();
  const sxx = new KahanSum();
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    sxy.add(dx * (y[i]! - my));
    sxx.add(dx * dx);
  }
  return sxx.value > 0 ? sxy.value / sxx.value : NaN;
}

// 1-based ranks, ties get the average rank.
export function averageRanks(xs: ArrayLike<number>): Float64Array {
  const n = xs.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => xs[a]! - xs[b]! || a - b);
  const ranks = new Float64Array(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && xs[order[j + 1]!] === xs[order[i]!]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]!] = r;
    i = j + 1;
  }
  return ranks;
}

// Pearson correlation; NaN when either side has no spread.
export function pearson(x: ArrayLike<number>, y: ArrayLike<number>): number {
  if (x.length !== y.length) throw new Error('pearson: length mismatch');
  const n = x.length;
  if (n < 2) return NaN;
  const mx = mean(x);
  const my = mean(y);
  const sxy = new KahanSum();
  const sxx = new KahanSum();
  const syy = new KahanSum();
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy.add(dx * dy);
    sxx.add(dx * dx);
    syy.add(dy * dy);
  }
  const d = Math.sqrt(sxx.value * syy.value);
  return d > 0 ? sxy.value / d : NaN;
}

// Spearman ρ = Pearson correlation of average ranks.
export function spearman(x: ArrayLike<number>, y: ArrayLike<number>): number {
  return pearson(averageRanks(x), averageRanks(y));
}
