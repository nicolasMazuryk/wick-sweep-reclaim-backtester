import { KahanSum } from './numeric.js';
import type { Xoshiro128ss } from './rng.js';

// Spec §6.4 White's reality check with the Politis–Romano stationary bootstrap.

// One resample of 0..n−1: each position starts a new block with
// probability 1/meanBlock (uniform start), else continues the previous
// block (wrapping around). meanBlock = 1 ⇒ an iid resample.
export function stationaryBootstrapIndices(n: number, meanBlock: number, rng: Xoshiro128ss, out = new Int32Array(n)): Int32Array {
  if (!(meanBlock >= 1)) throw new Error(`stationaryBootstrapIndices: meanBlock ${meanBlock} < 1`);
  const q = 1 / meanBlock;
  for (let t = 0; t < n; t++) {
    out[t] = t === 0 || rng.nextFloat() < q ? rng.nextInt(n) : (out[t - 1]! + 1) % n;
  }
  return out;
}

export interface RealityCheckOptions {
  readonly B: number;
  readonly meanBlock: number;
  readonly rng: Xoshiro128ss;
}

export interface RealityCheckResult {
  readonly V: number;                       // √n · mean of the chosen series
  readonly p: number;                       // share of resamples with V*_b ≥ V
  readonly B: number;
  readonly meanBlock: number;
  readonly n: number;                       // series length (volume-days)
  readonly cells: number;
}

// `cells[k][t]`: OOS return of cell k on day t (all of length n); `chosen[t]`
// the chosen configuration's. Benchmark = no trade (0). Statistic V = √n·f̄
// of the chosen series; the null distribution is the bootstrap of
// V*_b = max_k √n·(f̄*_{k,b} − f̄_k) (recentred, White 2000); p = #{V*_b ≥ V}/B.
// NaN without days or cells.
export function realityCheck(
  cells: ReadonlyArray<ArrayLike<number>>, chosen: ArrayLike<number>, opts: RealityCheckOptions,
): RealityCheckResult {
  const n = chosen.length;
  const K = cells.length;
  const base = { B: opts.B, meanBlock: opts.meanBlock, n, cells: K };
  if (n === 0 || K === 0) return { ...base, V: NaN, p: NaN };
  const sqrtN = Math.sqrt(n);
  const meanOf = (xs: ArrayLike<number>): number => {
    const k = new KahanSum();
    for (let t = 0; t < n; t++) k.add(xs[t]!);
    return k.value / n;
  };
  const V = sqrtN * meanOf(chosen);
  const means = cells.map((c) => {
    if (c.length !== n) throw new Error(`realityCheck: series length ${c.length} ≠ ${n}`);
    return meanOf(c);
  });
  const idx = new Int32Array(n);
  let exceed = 0;
  for (let b = 0; b < opts.B; b++) {
    stationaryBootstrapIndices(n, opts.meanBlock, opts.rng, idx);
    let vmax = -Infinity;
    for (let k = 0; k < K; k++) {
      const c = cells[k]!;
      // Inline Neumaier sum (hot loop: B × cells × days).
      let s = 0;
      let comp = 0;
      for (let t = 0; t < n; t++) {
        const x = c[idx[t]!]!;
        const u = s + x;
        comp += Math.abs(s) >= Math.abs(x) ? s - u + x : x - u + s;
        s = u;
      }
      const v = sqrtN * ((s + comp) / n - means[k]!);
      if (v > vmax) vmax = v;
    }
    if (vmax >= V) exceed++;
  }
  return { ...base, V, p: opts.B === 0 ? NaN : exceed / opts.B };
}
