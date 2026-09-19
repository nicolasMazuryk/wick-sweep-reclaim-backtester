import { type FoldSchedule, type RunConfig, type StageBModel, stageBScore, type StoredPivot } from '@wsr/core';
import { minStrengthForPassRate } from './min-strength.js';
import type { ReactionObservation } from './reaction.js';
import { fitStageB, observationsByPivot, type StageBFit, stageBRows } from './stage-b.js';
import type { Fold } from './walk-forward.js';

// Fold-scoped quantities (Spec §6.3), each fitted on [trainStart, trainEnd) only (L10).
export interface FoldFit {
  readonly foldId: number;
  readonly stageB: StageBModel;             // always fitted and reported (report §11, Appendix B Q3)
  readonly stageBFit: Omit<StageBFit, 'model' | 'warnings'>;
  readonly MinStrength: number;             // of the configured strengthModel
  readonly MinStrength_A: number;           // over WickStrength_0
  readonly MinStrength_B: number;           // over this fold's Stage B scores
  readonly nTrainWick: number;              // WickLevels classified in the train window
  readonly warnings: readonly string[];
}

// Train-window WickLevel scores of the selected model, recomputed from the
// stored ranks (Stage A = WickStrength_0, Stage B = the fold's model).
export function trainWickScores(
  rows: ReadonlyArray<StoredPivot>, fold: Pick<Fold, 'trainStart' | 'trainEnd'>, model: StageBModel | null,
): number[] {
  const out: number[] = [];
  for (const row of rows) {
    if (row.cls !== 'WickLevel' || !(row.classifiedAt >= fold.trainStart && row.classifiedAt < fold.trainEnd)) continue;
    out.push(model === null ? row.WickStrength_0 : row.ranks === null ? NaN : stageBScore(model, row.ranks));
  }
  return out;
}

// `rows`: the PivotStore of the reaction replay (pass 1); `observations`: its
// reaction observations (Stage B labels and approach status).
export function fitFolds(
  rows: ReadonlyArray<StoredPivot>, observations: ReadonlyArray<ReactionObservation>, folds: ReadonlyArray<Fold>, cfg: RunConfig,
): FoldFit[] {
  const byPivot = observationsByPivot(observations);
  return folds.map((fold) => {
    const fit = fitStageB(stageBRows(rows, byPivot, fold), fold.foldId, cfg.stageB.lambda);
    const scoresA = trainWickScores(rows, fold, null);
    const MinStrength_A = minStrengthForPassRate(scoresA, cfg.minStrengthPassRate);
    const MinStrength_B = minStrengthForPassRate(trainWickScores(rows, fold, fit.model), cfg.minStrengthPassRate);
    const stageB: StageBModel = { ...fit.model, minStrengthQuantile: MinStrength_B };
    const MinStrength = cfg.strengthModel === 'stageB' ? MinStrength_B : MinStrength_A;
    const warnings = [...fit.warnings];
    if (Number.isNaN(MinStrength)) warnings.push(`fold ${fold.foldId}: no scored WickLevel in the train window — MinStrength undefined, nothing arms`);
    const stageBFit = {
      nIpw: fit.nIpw, nApproached: fit.nApproached, nLabelled: fit.nLabelled, ipwConverged: fit.ipwConverged, converged: fit.converged,
      iterations: fit.iterations,
    };
    return { foldId: fold.foldId, stageB, stageBFit, MinStrength, MinStrength_A, MinStrength_B, nTrainWick: scoresA.length, warnings };
  });
}

// Engine schedule: fold 0's values from the first print (its train window is
// before every testStart, so this is causal for every fold), fold k's from testStart_k.
export function toFoldSchedule(folds: ReadonlyArray<Fold>, fits: ReadonlyArray<FoldFit>): FoldSchedule {
  return folds.map((fold, k) => ({ at: k === 0 ? -Infinity : fold.testStart, MinStrength: fits[k]!.MinStrength, stageB: fits[k]!.stageB }));
}
