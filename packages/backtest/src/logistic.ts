import { sigmoid } from '@wsr/core';

// Deterministic weighted L2 logistic regression (Spec §3.7.4, §1.4 "no ML
// library"): Newton / IRLS on the penalised log-likelihood
//   ℓ(b) = Σ w_i [y_i η_i − log(1 + e^{η_i})] − λ/2 ‖β‖²,  η_i = β0 + β·x_i,
// intercept unpenalised. Each Newton step solves the dense (p+1)² system by
// Cholesky (Gaussian elimination with partial pivoting as fallback) and is
// halved until ℓ does not decrease, so separable data (λ = 0) moves by
// bounded steps and stops at the iteration cap with finite coefficients.
// Sums are compensated and taken in row order (Spec §9.2).

export interface LogisticFit {
  readonly beta0: number;
  readonly beta: Float64Array;
  readonly iterations: number;
  readonly converged: boolean;
  readonly logLik: number;                  // penalised
}

export const LOGISTIC_MAX_ITER = 50;
export const LOGISTIC_TOL = 1e-8;
const MAX_HALVINGS = 30;
const SINGULAR_RIDGE = 1e-9;

// Compensated accumulator over a vector.
class KahanVector {
  readonly sum: Float64Array;
  private readonly c: Float64Array;
  constructor(n: number) {
    this.sum = new Float64Array(n);
    this.c = new Float64Array(n);
  }
  add(i: number, x: number): void {
    const s = this.sum[i]!;
    const t = s + x;
    this.c[i]! += Math.abs(s) >= Math.abs(x) ? s - t + x : x - t + s;
    this.sum[i] = t;
  }
  value(i: number): number { return this.sum[i]! + this.c[i]!; }
}

// log(1 + e^η) without overflow.
function log1pExp(eta: number): number {
  return eta > 0 ? eta + Math.log1p(Math.exp(-eta)) : Math.log1p(Math.exp(eta));
}

function eta(b: Float64Array, x: ArrayLike<number>): number {
  let z = b[0]!;
  for (let j = 0; j < x.length; j++) z += b[j + 1]! * x[j]!;
  return z;
}

function penalisedLogLik(b: Float64Array, X: ReadonlyArray<ArrayLike<number>>, y: ArrayLike<number>, w: ArrayLike<number>, lambda: number): number {
  const acc = new KahanVector(1);
  for (let i = 0; i < X.length; i++) {
    if (w[i] === 0) continue;
    const e = eta(b, X[i]!);
    acc.add(0, w[i]! * (y[i]! * e - log1pExp(e)));
  }
  let pen = 0;
  for (let j = 1; j < b.length; j++) pen += b[j]! * b[j]!;
  return acc.value(0) - 0.5 * lambda * pen;
}

// Solves A x = g for symmetric positive (semi-)definite A (row-major, n×n).
// Cholesky first; on a non-positive pivot, Gaussian elimination with partial
// pivoting; a singular system gets a tiny ridge on the diagonal. null if still singular.
export function solveSymmetric(A: Float64Array, g: Float64Array, n: number): Float64Array | null {
  const chol = cholesky(A, g, n);
  if (chol !== null) return chol;
  const gauss = gaussian(A, g, n);
  if (gauss !== null) return gauss;
  let trace = 0;
  for (let i = 0; i < n; i++) trace += Math.abs(A[i * n + i]!);
  const ridged = Float64Array.from(A);
  const r = SINGULAR_RIDGE * Math.max(trace / n, 1);
  for (let i = 0; i < n; i++) ridged[i * n + i]! += r;
  return cholesky(ridged, g, n) ?? gaussian(ridged, g, n);
}

function cholesky(A: Float64Array, g: Float64Array, n: number): Float64Array | null {
  const L = new Float64Array(n * n);
  let scale = 0;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(A[i * n + i]!));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j]!;
      for (let k = 0; k < j; k++) s -= L[i * n + k]! * L[j * n + k]!;
      if (i === j) {
        if (!(s > 1e-13 * Math.max(scale, 1e-300))) return null;
        L[i * n + i] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j]!;
      }
    }
  }
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = g[i]!;
    for (let k = 0; k < i; k++) s -= L[i * n + k]! * z[k]!;
    z[i] = s / L[i * n + i]!;
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i]!;
    for (let k = i + 1; k < n; k++) s -= L[k * n + i]! * x[k]!;
    x[i] = s / L[i * n + i]!;
  }
  return x;
}

function gaussian(A0: Float64Array, g0: Float64Array, n: number): Float64Array | null {
  const A = Float64Array.from(A0);
  const g = Float64Array.from(g0);
  let scale = 0;
  for (let i = 0; i < n * n; i++) scale = Math.max(scale, Math.abs(A[i]!));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]!) > Math.abs(A[piv * n + c]!)) piv = r;
    if (!(Math.abs(A[piv * n + c]!) > 1e-13 * Math.max(scale, 1e-300))) return null;
    if (piv !== c) {
      for (let k = 0; k < n; k++) {
        const tmp = A[c * n + k]!;
        A[c * n + k] = A[piv * n + k]!;
        A[piv * n + k] = tmp;
      }
      const tmp = g[c]!;
      g[c] = g[piv]!;
      g[piv] = tmp;
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c]! / A[c * n + c]!;
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k]! -= f * A[c * n + k]!;
      g[r]! -= f * g[c]!;
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = g[i]!;
    for (let k = i + 1; k < n; k++) s -= A[i * n + k]! * x[k]!;
    x[i] = s / A[i * n + i]!;
  }
  return x;
}

// X: one feature row per observation (length p, no intercept column);
// y ∈ {0, 1}; w ≥ 0 observation weights; λ ≥ 0 (β0 unpenalised).
export function fitLogistic(
  X: ReadonlyArray<ArrayLike<number>>, y: ArrayLike<number>, w: ArrayLike<number>, lambda: number,
  opts: { readonly maxIter?: number; readonly tol?: number } = {},
): LogisticFit {
  const n = X.length;
  if (y.length !== n || w.length !== n) throw new Error('fitLogistic: X, y, w length mismatch');
  if (!(lambda >= 0)) throw new Error(`fitLogistic: lambda ${lambda} must be ≥ 0`);
  const p = n === 0 ? 0 : X[0]!.length;
  const d = p + 1;
  const maxIter = opts.maxIter ?? LOGISTIC_MAX_ITER;
  const tol = opts.tol ?? LOGISTIC_TOL;
  let b = new Float64Array(d);
  let ll = penalisedLogLik(b, X, y, w, lambda);
  let converged = false;
  let iterations = 0;
  const xi = new Float64Array(d);
  while (iterations < maxIter) {
    iterations++;
    // Gradient of ℓ and the (negated) Hessian H = Σ w p(1−p) x xᵀ + λ·diag(0, 1, …, 1).
    const grad = new KahanVector(d);
    const hess = new KahanVector(d * d);
    for (let i = 0; i < n; i++) {
      const wi = w[i]!;
      if (wi === 0) continue;
      const row = X[i]!;
      xi[0] = 1;
      for (let j = 0; j < p; j++) xi[j + 1] = row[j]!;
      const mu = sigmoid(eta(b, row));
      const r = wi * (y[i]! - mu);
      const v = wi * mu * (1 - mu);
      for (let j = 0; j < d; j++) {
        grad.add(j, r * xi[j]!);
        const vj = v * xi[j]!;
        for (let k = 0; k <= j; k++) hess.add(j * d + k, vj * xi[k]!);
      }
    }
    const g = new Float64Array(d);
    const H = new Float64Array(d * d);
    for (let j = 0; j < d; j++) {
      g[j] = grad.value(j) - (j === 0 ? 0 : lambda * b[j]!);
      for (let k = 0; k <= j; k++) {
        const h = hess.value(j * d + k) + (j === k && j > 0 ? lambda : 0);
        H[j * d + k] = h;
        H[k * d + j] = h;
      }
    }
    const step = solveSymmetric(H, g, d);
    if (step === null || step.some((x) => !Number.isFinite(x))) break;
    let t = 1;
    let next = b;
    let llNext = ll;
    for (let h = 0; h <= MAX_HALVINGS; h++, t /= 2) {
      const cand = new Float64Array(d);
      for (let j = 0; j < d; j++) cand[j] = b[j]! + t * step[j]!;
      const llCand = penalisedLogLik(cand, X, y, w, lambda);
      if (Number.isFinite(llCand) && llCand >= ll) {
        next = cand;
        llNext = llCand;
        break;
      }
    }
    if (next === b) {                                       // no ascent along the Newton direction: at the optimum
      converged = true;
      break;
    }
    let maxStep = 0;
    for (let j = 0; j < d; j++) maxStep = Math.max(maxStep, Math.abs(next[j]! - b[j]!));
    const dll = llNext - ll;
    b = next;
    ll = llNext;
    if (maxStep < tol || dll < tol * (Math.abs(ll) + tol)) {
      converged = true;
      break;
    }
  }
  return { beta0: b[0]!, beta: b.slice(1), iterations, converged, logLik: ll };
}
