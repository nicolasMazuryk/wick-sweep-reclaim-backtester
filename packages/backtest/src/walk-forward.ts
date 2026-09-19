import type { Ms } from '@wsr/core';
import { ReplayInputError } from './blacklist-load.js';

// Spec §6.3 fold lengths in UTC calendar days (A-47): train 8 weeks, test 2
// weeks, rolling by 2 weeks; F ≥ 12 folds.
export interface FoldDays {
  readonly train: number;
  readonly test: number;
  readonly step: number;
}
export const FOLD_DAYS: FoldDays = { train: 56, test: 14, step: 14 };
export const MIN_FOLDS = 12;

const DAY_MS = 86_400_000;

export type FoldWindow = 'train' | 'test';

// Half-open windows [trainStart, trainEnd) and [testStart, testEnd), testStart = trainEnd.
export interface Fold {
  readonly foldId: number;
  readonly trainStart: Ms;
  readonly trainEnd: Ms;
  readonly testStart: Ms;
  readonly testEnd: Ms;
}

// Folds over the span [spanStart, spanEnd) (both at UTC midnight): fold k
// trains on [spanStart + k·step, + train) and tests on the following `test`
// days; folds stop at the first whose testEnd > spanEnd. Fewer than
// MIN_FOLDS throws unless `allowShort` (the hidden `--folds` diagnostic).
export function foldSchedule(
  spanStart: Ms, spanEnd: Ms, days: FoldDays = FOLD_DAYS, opts: { readonly allowShort?: boolean } = {},
): Fold[] {
  for (const [name, n] of Object.entries(days)) {
    if (!(Number.isInteger(n) && n > 0)) throw new ReplayInputError(`fold ${name} length ${n} must be a positive whole number of days`);
  }
  if (spanStart % DAY_MS !== 0 || spanEnd % DAY_MS !== 0) throw new ReplayInputError('fold span must start and end at UTC midnight');
  const folds: Fold[] = [];
  for (let k = 0; ; k++) {
    const trainStart = spanStart + k * days.step * DAY_MS;
    const trainEnd = trainStart + days.train * DAY_MS;
    const testEnd = trainEnd + days.test * DAY_MS;
    if (testEnd > spanEnd) break;
    folds.push({ foldId: k, trainStart, trainEnd, testStart: trainEnd, testEnd });
  }
  const spanDays = (spanEnd - spanStart) / DAY_MS;
  if (folds.length < MIN_FOLDS && opts.allowShort !== true) {
    throw new ReplayInputError(`span of ${spanDays} day(s) gives ${folds.length} folds; Spec §6.3 requires F ≥ ${MIN_FOLDS} (${days.train}/${days.test}/${days.step} days)`);
  }
  if (folds.length === 0) throw new ReplayInputError(`span of ${spanDays} day(s) holds no fold of ${days.train}+${days.test} days`);
  return folds;
}

export function windowOf(fold: Fold, window: FoldWindow): { readonly from: Ms; readonly to: Ms } {
  return window === 'train' ? { from: fold.trainStart, to: fold.trainEnd } : { from: fold.testStart, to: fold.testEnd };
}

export function inWindow(t: Ms, fold: Fold, window: FoldWindow): boolean {
  const w = windowOf(fold, window);
  return t >= w.from && t < w.to;
}

// foldId of the test window holding t (test windows do not overlap when
// step ≥ test); −1 when none. Train windows overlap, so there is no train analogue.
export function foldOf(t: Ms, folds: ReadonlyArray<Fold>): number {
  for (const f of folds) if (t >= f.testStart && t < f.testEnd) return f.foldId;
  return -1;
}

// Parses the hidden `--folds <train>,<test>,<step>` flag (days).
export function parseFoldDays(text: string): FoldDays {
  const parts = text.split(',').map((x) => x.trim());
  const nums = parts.map(Number);
  if (parts.length !== 3 || nums.some((n, i) => !/^\d+$/.test(parts[i]!) || !(n > 0))) {
    throw new ReplayInputError(`--folds expects <train>,<test>,<step> positive whole days, got '${text}'`);
  }
  return { train: nums[0]!, test: nums[1]!, step: nums[2]! };
}
