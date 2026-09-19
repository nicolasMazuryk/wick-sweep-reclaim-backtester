import { KahanSum, mean, variance } from './numeric.js';

// Spec §6.4 deflated Sharpe ratio (Bailey–López de Prado) and the normal
// distribution helpers it needs (no numeric library, Spec §1.4).

const SQRT_PI = Math.sqrt(Math.PI);
export const EULER_GAMMA = 0.5772;          // γ_E as written in Spec §6.4

// erfc for x ≥ 0: positive-term series of erf below 2.5, Lentz continued
// fraction above; ≈ 1e-15 relative accuracy.
function erfcNonNeg(x: number): number {
  if (x < 2.5) {
    // erf(x) = 2/√π · e^{−x²} · Σ 2^n x^{2n+1} / (1·3·…·(2n+1))
    let term = x;
    let s = x;
    for (let n = 1; n < 200; n++) {
      term *= (2 * x * x) / (2 * n + 1);
      s += term;
      if (term < 1e-17 * s) break;
    }
    return 1 - (2 / SQRT_PI) * Math.exp(-x * x) * s;
  }
  // erfc(x) = e^{−x²}/√π · 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + …))))
  const tiny = 1e-300;
  let f = x;
  let c = x;
  let d = 0;
  for (let n = 1; n < 500; n++) {
    const a = n / 2;
    d = x + a * d;
    d = d === 0 ? tiny : 1 / d;
    c = x + a / c;
    if (c === 0) c = tiny;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-x * x) / SQRT_PI / f;
}

export function erfc(x: number): number {
  if (Number.isNaN(x)) return NaN;
  return x >= 0 ? erfcNonNeg(x) : 2 - erfcNonNeg(-x);
}

// Φ(z), standard normal CDF.
export function normCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

// Acklam's rational approximation, refined by one Halley step on normCdf.
const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const P_LOW = 0.02425;

// Φ⁻¹(p) for p ∈ (0, 1); ±∞ at 0 and 1, NaN outside.
export function normInv(p: number): number {
  if (!(p >= 0 && p <= 1)) return NaN;
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  let x: number;
  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) / ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  } else if (p <= 1 - P_LOW) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((A[0]! * r + A[1]!) * r + A[2]!) * r + A[3]!) * r + A[4]!) * r + A[5]!) * q)
      / (((((B[0]! * r + B[1]!) * r + B[2]!) * r + B[3]!) * r + B[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) / ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  }
  // Halley step: e = Φ(x) − p, u = e·√(2π)·e^{x²/2}. The upper tail is refined through 1 − p.
  const e = p > 0.5 ? -(0.5 * erfc(x / Math.SQRT2) - (1 - p)) : normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

// Sample skewness (population moments, m3 / m2^1.5); NaN below 3 values or without spread.
export function skewness(xs: ReadonlyArray<number>): number {
  if (xs.length < 3) return NaN;
  const m = mean(xs);
  const k2 = new KahanSum();
  const k3 = new KahanSum();
  for (const x of xs) {
    const d = x - m;
    k2.add(d * d);
    k3.add(d * d * d);
  }
  const m2 = k2.value / xs.length;
  return m2 > 0 ? k3.value / xs.length / m2 ** 1.5 : NaN;
}

// Raw (non-excess) kurtosis m4 / m2² (normal = 3); NaN below 4 values or without spread.
export function kurtosis(xs: ReadonlyArray<number>): number {
  if (xs.length < 4) return NaN;
  const m = mean(xs);
  const k2 = new KahanSum();
  const k4 = new KahanSum();
  for (const x of xs) {
    const d2 = (x - m) ** 2;
    k2.add(d2);
    k4.add(d2 * d2);
  }
  const m2 = k2.value / xs.length;
  return m2 > 0 ? k4.value / xs.length / (m2 * m2) : NaN;
}

export interface DsrInput {
  readonly SR: number;                      // per-trade Sharpe of the chosen configuration (OOS)
  readonly nTrades: number;                 // its trade count (T)
  readonly skew: number;                    // γ₃
  readonly kurt: number;                    // γ₄, raw
  readonly trialSharpes: ReadonlyArray<number>;   // one per evaluated cell (non-finite ignored)
  readonly N: number;                       // N_configs
}

export interface DsrResult {
  readonly DSR: number;
  readonly SR: number;
  readonly SR0: number;
  readonly VSR: number;                     // variance of the trial Sharpes
  readonly nTrades: number;
  readonly skew: number;
  readonly kurt: number;
  readonly N: number;
  readonly trials: number;                  // finite trial Sharpes
}

// Expected maximum Sharpe of N unskilled trials:
// SR₀ = √V[SR] · ((1 − γ_E)·Φ⁻¹(1 − 1/N) + γ_E·Φ⁻¹(1 − 1/(N·e))); N ≤ 1 ⇒ 0.
export function expectedMaxSharpe(VSR: number, N: number): number {
  if (!(N > 1)) return 0;
  return Math.sqrt(VSR) * ((1 - EULER_GAMMA) * normInv(1 - 1 / N) + EULER_GAMMA * normInv(1 - 1 / (N * Math.E)));
}

// DSR = Φ((SR̂ − SR₀)·√(T − 1) / √(1 − γ₃·SR̂ + (γ₄ − 1)/4·SR̂²)), T = nTrades;
// NaN when undefined (T < 2, SR̂ not finite, a non-positive variance term).
export function deflatedSharpe(input: DsrInput): DsrResult {
  const trials = input.trialSharpes.filter(Number.isFinite);
  const VSR = trials.length >= 2 ? variance(trials) : input.N > 1 ? NaN : 0;
  const SR0 = expectedMaxSharpe(VSR, input.N);
  const { SR, nTrades, skew, kurt } = input;
  const denom = 1 - skew * SR + ((kurt - 1) / 4) * SR * SR;
  const DSR = nTrades >= 2 && Number.isFinite(SR) && Number.isFinite(SR0) && denom > 0
    ? normCdf(((SR - SR0) * Math.sqrt(nTrades - 1)) / Math.sqrt(denom)) : NaN;
  return { DSR, SR, SR0, VSR, nTrades, skew, kurt, N: input.N, trials: trials.length };
}
