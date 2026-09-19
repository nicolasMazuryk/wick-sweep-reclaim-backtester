import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, FEATURE_COUNT, parseRunConfig, sigmoid, type StoredPivot, VENUE_IDS } from '@wsr/core';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fitFolds, toFoldSchedule } from './fold-fit.js';
import { fitLogistic } from './logistic.js';
import type { ReactionObservation } from './reaction.js';
import { type ReactionRun, runReactionTest } from './reaction-run.js';
import { rngStream } from './rng.js';
import { fitStageB, IPW_FLOOR, ipwWeight, observationsByPivot, type StageBRow, stageBRows, zOf } from './stage-b.js';
import { writeSyntheticDataRoot } from './synthetic-data-root.js';
import { type Fold, foldSchedule } from './walk-forward.js';

const DAY = 86_400_000;
const RUNS = Number(process.env.WSR_PROPERTY_RUNS ?? 40);

// Minimal StoredPivot / ReactionObservation for the row filter.
function row(pivotId: number, classifiedAt: number, cls: StoredPivot['cls'] = 'WickLevel', ranks: number[] | null = Array(FEATURE_COUNT).fill(0.5)): StoredPivot {
  return { pivot: { pivotId }, cls, classifiedAt, ranks, WickStrength_0: 0.5 } as unknown as StoredPivot;
}
function obs(pivotId: number, o: Partial<ReactionObservation>, setId: 'wick' | 'slow' = 'wick'): ReactionObservation {
  return {
    level: { setId, srcPivotId: pivotId }, status: 'approached', approachT: 0, complete: true, ReactionHit: 1, decidedAt: 0, ...o,
  } as unknown as ReactionObservation;
}

describe('Stage B rows (Spec §3.7.4, §6.3, L10)', () => {
  const fold = { trainStart: 100, trainEnd: 200 };
  it('IPW population = WickLevel/SlowExtreme rows with ranks classified in the train window whose approach status is known before trainEnd', () => {
    const rows = [
      row(1, 150), row(2, 150), row(3, 150), row(4, 150), row(5, 150, 'SlowExtreme'), row(6, 99), row(7, 200), row(8, 150, 'BurstPivot'),
      row(9, 150, 'WickLevel', null), row(10, 150), row(11, 150),
    ];
    const byPivot = observationsByPivot([
      obs(1, { decidedAt: 180, ReactionHit: 1 }),                                  // labelled
      obs(2, { approachT: 190, decidedAt: 210, complete: true }),                  // approached before trainEnd, outcome after: no label
      obs(3, { status: 'notApproached', decidedAt: 170 }),                          // not approached, known
      obs(4, { status: 'notApproached', decidedAt: 230 }),                          // expiry after trainEnd: excluded
      obs(5, { decidedAt: 160, ReactionHit: 0 }, 'slow'),
      obs(6, { decidedAt: 120 }), obs(7, { decidedAt: 250 }), obs(8, { decidedAt: 150 }), obs(9, { decidedAt: 150 }),
      obs(10, { status: 'pending', approachT: -1, decidedAt: NaN }),                // unknown fate
      obs(11, { approachT: 205, decidedAt: 260 }),                                  // approached after trainEnd
    ]);
    const out = stageBRows(rows, byPivot, fold);
    expect(out.map((r) => [r.pivotId, r.approached, r.label])).toEqual([[1, 1, 1], [2, 1, null], [3, 0, null], [5, 1, 0]]);
    expect(Array.from(out[0]!.z)).toEqual(Array(FEATURE_COUNT).fill(0));
  });

  it('IPW weights are 1/max(P̂(approached | z), 0.05)', () => {
    const gamma = new Float64Array(FEATURE_COUNT);
    gamma[0] = 1;
    const z = new Float64Array(FEATURE_COUNT);
    z[0] = 0.5;
    expect(ipwWeight({ gamma0: 0.2, gamma }, z)).toBeCloseTo(1 / sigmoid(0.7), 15);
    expect(ipwWeight({ gamma0: -10, gamma }, z)).toBe(1 / IPW_FLOOR);
  });

  it('fitStageB = unpenalised IPW fit, then the λ-penalised weighted fit; calibration has 10 equal-count bins', () => {
    const rng = rngStream(4, 'stage-b-test');
    const rows: StageBRow[] = Array.from({ length: 400 }, (_, i) => {
      const z = zOf(Array.from({ length: FEATURE_COUNT }, () => rng.nextFloat()));
      const approached = rng.nextFloat() < sigmoid(z[1]!) ? 1 : 0;
      return { pivotId: i, z, approached, label: approached === 1 ? (rng.nextFloat() < sigmoid(2 * z[0]!) ? 1 : 0) : null };
    });
    const fit = fitStageB(rows, 3, 1);
    const ipw = fitLogistic(rows.map((r) => r.z), rows.map((r) => r.approached), rows.map(() => 1), 0);
    expect(fit.model.ipwModel.gamma0).toBe(ipw.beta0);
    const labelled = rows.filter((r) => r.label !== null);
    const w = labelled.map((r) => ipwWeight({ gamma0: ipw.beta0, gamma: ipw.beta }, r.z));
    const direct = fitLogistic(labelled.map((r) => r.z), labelled.map((r) => r.label!), w, 1);
    expect(fit.model.beta0).toBe(direct.beta0);
    expect(Array.from(fit.model.beta)).toEqual(Array.from(direct.beta));
    expect(fit.model.beta[0]).toBeGreaterThan(0.5);                                // the planted feature
    expect([fit.model.foldId, fit.model.lambda, fit.nIpw, fit.nLabelled]).toEqual([3, 1, 400, labelled.length]);
    expect(fit.model.calibration.map((c) => c.bin)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(fit.model.calibration.reduce((s, c) => s + c.n, 0)).toBe(labelled.length);
    for (let b = 1; b < 10; b++) expect(fit.model.calibration[b]!.meanP).toBeGreaterThanOrEqual(fit.model.calibration[b - 1]!.meanP);
    expect(fit.warnings).toEqual([]);
  });

  it('an empty or single-outcome train set gives β = 0 and a warning', () => {
    const empty = fitStageB([], 0, 1);
    expect([empty.model.beta0, ...empty.model.beta]).toEqual(Array(FEATURE_COUNT + 1).fill(0));
    expect(empty.warnings.join(' ')).toMatch(/degenerate/);
    const same = fitStageB([{ pivotId: 0, z: new Float64Array(FEATURE_COUNT), approached: 1, label: 1 }], 0, 1);
    expect(Array.from(same.model.beta)).toEqual(Array(FEATURE_COUNT).fill(0));
  });
});

// ---------------------------------------------------------------- on a replay

const VENUE = VENUE_IDS[0];
const fees = Object.fromEntries(VENUE_IDS.map((v) => [v, { TakerFee: 0.0005, MakerFee: 0.0002, verifiedAt: '2026-09-19' }]));
const cfg = parseRunConfig({ fees, data: { lowCapSymbol: 'SOLUSDT' }, strengthModel: 'stageB' });
let dir: string;
let run: ReactionRun;
let rows: StoredPivot[];
let folds: Fold[];
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wsr-stageb-'));
  await writeSyntheticDataRoot({ dataRoot: dir, venue: VENUE, symbol: 'ETHUSDT', from: { y: 2025, m: 1, d: 1 }, days: 12, seed: 1 });
  run = await runReactionTest({ dataRoot: dir, venue: VENUE, symbol: 'ETHUSDT', from: { y: 2025, m: 1, d: 9 }, to: { y: 2025, m: 1, d: 12 } }, cfg, 1, { B: 20 });
  rows = run.engine.store.snapshot();
  folds = foldSchedule(Date.UTC(2025, 0, 9), Date.UTC(2025, 0, 13), { train: 2, test: 1, step: 1 }, { allowShort: true });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('fold fits on a reaction replay (Spec §6.3)', () => {
  it('decidedAt: approached ⇒ the window-end print (≥ approachT), notApproached ⇒ the expiry print, pending ⇒ NaN', () => {
    const byStatus = (s: string) => run.observations.filter((o) => o.status === s && o.level.setId !== 'random');
    for (const o of byStatus('approached')) {
      if (o.complete) expect(o.decidedAt).toBeGreaterThanOrEqual(o.approachT);
      else expect(o.decidedAt).toBeNaN();
    }
    expect(byStatus('notApproached').length).toBeGreaterThan(0);
    for (const o of byStatus('notApproached')) expect(o.decidedAt).toBeGreaterThan(o.level.availableAt);
    for (const o of byStatus('pending')) expect(o.decidedAt).toBeNaN();
  });

  it('fits every fold; MinStrength follows strengthModel; the schedule applies fold 0 from −∞ and fold k from testStart_k', () => {
    const fits = fitFolds(rows, run.observations, folds, cfg);
    expect(fits).toHaveLength(2);
    for (const f of fits) {
      expect(f.stageBFit.nLabelled).toBeGreaterThan(20);
      expect(f.MinStrength).toBe(f.MinStrength_B);
      expect(f.stageB.minStrengthQuantile).toBe(f.MinStrength_B);
      expect(Number.isFinite(f.MinStrength_A)).toBe(true);
    }
    const stageA = fitFolds(rows, run.observations, folds, { ...cfg, strengthModel: 'stageA' });
    expect(stageA.map((f) => f.MinStrength)).toEqual(stageA.map((f) => f.MinStrength_A));
    expect(toFoldSchedule(folds, fits).map((e) => e.at)).toEqual([-Infinity, folds[1]!.testStart]);
  });

  it('property: foldFitCausal (L10) — perturbing everything at or after trainEnd leaves the model bytes and MinStrength unchanged', () => {
    const fingerprint = (fold: Fold, r: ReadonlyArray<StoredPivot>, o: ReadonlyArray<ReactionObservation>): string => {
      const [f] = fitFolds(r, o, [fold], cfg);
      return canonicalJson({ stageB: f!.stageB, MinStrength: f!.MinStrength, MinStrength_A: f!.MinStrength_A, MinStrength_B: f!.MinStrength_B });
    };
    const base = folds.map((fold) => fingerprint(fold, rows, run.observations));
    // Control: the same perturbation one step earlier (labels decided before trainEnd) does change the fit.
    const flipped = run.observations.map((o) => (o.decidedAt < folds[0]!.trainEnd ? { ...o, ReactionHit: o.ReactionHit === 1 ? 0 as const : 1 as const } : o));
    expect(fingerprint(folds[0]!, rows, flipped)).not.toBe(base[0]);
    fc.assert(fc.property(fc.integer({ min: 0, max: folds.length - 1 }), fc.integer({ min: 1, max: 2 ** 31 - 1 }), (k, seed) => {
      const fold = folds[k]!;
      const rng = rngStream(seed, 'foldFitCausal');
      const trainEnd = fold.trainEnd;
      // Later rows: dropped, shifted later, or re-scored with random ranks / WickStrength_0.
      const pRows = rows.flatMap((r): StoredPivot[] => {
        if (r.classifiedAt < trainEnd) return [r];
        const u = rng.nextFloat();
        if (u < 0.3) return [];
        if (u < 0.6) return [{ ...r, classifiedAt: r.classifiedAt + Math.floor(rng.nextFloat() * DAY) }];
        return [{ ...r, WickStrength_0: rng.nextFloat(), ranks: Array.from({ length: FEATURE_COUNT }, () => rng.nextFloat()) }];
      });
      // Later fates: labels flipped, windows / expiries moved (never before trainEnd).
      const pObs = run.observations.map((o): ReactionObservation => {
        if (o.decidedAt < trainEnd) return o;
        const approachedBefore = o.status === 'approached' && o.approachT < trainEnd;
        const status = approachedBefore ? 'approached' : (['approached', 'notApproached', 'pending'] as const)[rng.nextInt(3)]!;
        return {
          ...o, status, ReactionHit: o.ReactionHit === 1 ? 0 : 1, complete: rng.nextFloat() < 0.5,
          approachT: approachedBefore ? o.approachT : trainEnd + Math.floor(rng.nextFloat() * DAY),
          decidedAt: rng.nextFloat() < 0.2 ? NaN : trainEnd + Math.floor(rng.nextFloat() * DAY),
        };
      });
      expect(fingerprint(fold, pRows, pObs)).toBe(base[k]);
    }), { seed: 7, numRuns: RUNS });
  });
});
