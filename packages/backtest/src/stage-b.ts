import { FEATURE_COUNT, sigmoid, type StageBModel, type StoredPivot } from '@wsr/core';
import { fitLogistic } from './logistic.js';
import { mean } from './numeric.js';
import type { ReactionObservation } from './reaction.js';
import type { Fold } from './walk-forward.js';

// Spec §3.7.4 / §6.3: IPW floor on P̂(approached | x).
export const IPW_FLOOR = 0.05;
export const CALIBRATION_BINS = 10;

// One IPW row: a WickLevel / SlowExtreme pivot with ranks, classified in the
// train window, whose approach status was decided before trainEnd.
export interface StageBRow {
  readonly pivotId: number;
  readonly z: Float64Array;                 // 2·rank − 1
  readonly approached: 0 | 1;
  readonly label: 0 | 1 | null;             // ReactionHit when approached and decided before trainEnd
}

export interface StageBFit {
  readonly model: StageBModel;
  readonly nIpw: number;                    // IPW population
  readonly nApproached: number;
  readonly nLabelled: number;
  readonly ipwConverged: boolean;
  readonly converged: boolean;
  readonly iterations: number;
  readonly warnings: readonly string[];
}

export function zOf(ranks: ArrayLike<number>): Float64Array {
  const z = new Float64Array(FEATURE_COUNT);
  for (let j = 0; j < FEATURE_COUNT; j++) z[j] = 2 * ranks[j]! - 1;
  return z;
}

// Observations of set (1)/(2) keyed by source pivot (a pivot is in one of them).
export function observationsByPivot(observations: ReadonlyArray<ReactionObservation>): Map<number, ReactionObservation> {
  const out = new Map<number, ReactionObservation>();
  for (const o of observations) {
    if (o.level.setId === 'wick' || o.level.setId === 'slow') out.set(o.level.srcPivotId, o);
  }
  return out;
}

// L10: only rows classified in [trainStart, trainEnd) and only fates known
// before trainEnd (decidedAt < trainEnd) are used; everything at or after
// trainEnd is invisible to the fit.
export function stageBRows(
  rows: ReadonlyArray<StoredPivot>, byPivot: ReadonlyMap<number, ReactionObservation>, fold: Pick<Fold, 'trainStart' | 'trainEnd'>,
): StageBRow[] {
  const out: StageBRow[] = [];
  for (const row of rows) {
    if (row.cls !== 'WickLevel' && row.cls !== 'SlowExtreme') continue;
    if (row.ranks === null || !(row.classifiedAt >= fold.trainStart && row.classifiedAt < fold.trainEnd)) continue;
    const o = byPivot.get(row.pivot.pivotId);
    if (o === undefined || o.status === 'pending' || !(o.decidedAt < fold.trainEnd)) {
      // Approached but the window not finished before trainEnd: the approach itself is known.
      if (o?.status !== 'approached' || !(o.approachT < fold.trainEnd)) continue;
      out.push({ pivotId: row.pivot.pivotId, z: zOf(row.ranks), approached: 1, label: null });
      continue;
    }
    const approached = o.status === 'approached' ? 1 : 0;
    out.push({ pivotId: row.pivot.pivotId, z: zOf(row.ranks), approached, label: approached === 1 && o.complete ? o.ReactionHit : null });
  }
  return out;
}

// w = 1 / max(P̂(approached | z), 0.05) (Spec §3.7.4).
export function ipwWeight(ipw: StageBModel['ipwModel'], z: ArrayLike<number>): number {
  return 1 / Math.max(sigmoid(ipw.gamma0 + dot(ipw.gamma, z)), IPW_FLOOR);
}

function logit(p: number): number {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return Math.log(q / (1 - q));
}

// Spec §3.7.4: unpenalised P(approached | z) on the IPW population, then the
// λ-penalised logistic regression of ReactionHit on z over the labelled rows
// weighted by 1/max(P̂, 0.05), then a 10-bin equal-count calibration table.
// A degenerate train set (no labels, or a single outcome) gives β = 0.
export function fitStageB(rows: ReadonlyArray<StageBRow>, foldId: number, lambda: number): StageBFit {
  const warnings: string[] = [];
  const nApproached = rows.filter((r) => r.approached === 1).length;
  let ipw: { beta0: number; beta: Float64Array; converged: boolean } = { beta0: logit(rows.length === 0 ? 1 : nApproached / rows.length), beta: new Float64Array(FEATURE_COUNT), converged: true };
  if (rows.length === 0) warnings.push(`fold ${foldId}: Stage B IPW population empty`);
  else if (nApproached === 0 || nApproached === rows.length) warnings.push(`fold ${foldId}: Stage B IPW degenerate (approached ${nApproached}/${rows.length}) — P̂ constant`);
  else ipw = fitLogistic(rows.map((r) => r.z), rows.map((r) => r.approached), rows.map(() => 1), 0);
  if (!ipw.converged) warnings.push(`fold ${foldId}: Stage B IPW fit did not converge`);

  const labelled = rows.filter((r) => r.label !== null);
  const y = labelled.map((r) => r.label!);
  const w = labelled.map((r) => ipwWeight({ gamma0: ipw.beta0, gamma: ipw.beta }, r.z));
  const hits = y.filter((v) => v === 1).length;
  let fit: { beta0: number; beta: Float64Array; converged: boolean; iterations: number } = { beta0: 0, beta: new Float64Array(FEATURE_COUNT), converged: true, iterations: 0 };
  if (labelled.length === 0 || hits === 0 || hits === labelled.length) {
    warnings.push(`fold ${foldId}: Stage B train set degenerate (${hits}/${labelled.length} ReactionHit) — β = 0`);
  } else {
    fit = fitLogistic(labelled.map((r) => r.z), y, w, lambda);
    if (!fit.converged) warnings.push(`fold ${foldId}: Stage B fit did not converge in ${fit.iterations} iterations`);
  }

  const scored = labelled.map((r, i) => ({ p: sigmoid(fit.beta0 + dot(fit.beta, r.z)), y: y[i]!, i }));
  scored.sort((a, b) => a.p - b.p || a.i - b.i);
  const calibration: { bin: number; meanP: number; meanY: number; n: number }[] = [];
  for (let b = 0; b < CALIBRATION_BINS; b++) {
    const from = Math.floor((b * scored.length) / CALIBRATION_BINS);
    const to = Math.floor(((b + 1) * scored.length) / CALIBRATION_BINS);
    const bin = scored.slice(from, to);
    calibration.push({
      bin: b + 1, n: bin.length,
      meanP: mean(bin.map((x) => x.p)),                                        // compensated, NaN when empty (Spec §9.2)
      meanY: mean(bin.map((x) => x.y)),
    });
  }
  const model: StageBModel = {
    foldId, beta0: fit.beta0, beta: fit.beta, lambda, ipwModel: { gamma0: ipw.beta0, gamma: ipw.beta }, minStrengthQuantile: NaN,
    calibration,
  };
  return {
    model, nIpw: rows.length, nApproached, nLabelled: labelled.length, ipwConverged: ipw.converged, converged: fit.converged,
    iterations: fit.iterations, warnings,
  };
}

function dot(beta: ArrayLike<number>, z: ArrayLike<number>): number {
  let s = 0;
  for (let j = 0; j < z.length; j++) s += beta[j]! * z[j]!;
  return s;
}
