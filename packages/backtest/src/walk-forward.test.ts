import { describe, expect, it } from 'vitest';
import { ReplayInputError } from './blacklist-load.js';
import { FOLD_DAYS, foldOf, foldSchedule, inWindow, MIN_FOLDS, parseFoldDays } from './walk-forward.js';

const DAY = 86_400_000;
const start = Date.UTC(2025, 0, 1);

describe('foldSchedule (Spec §6.3, A-47)', () => {
  it('calendar folds: train 56 d, test the next 14 d, rolling by 14 d; testStart = trainEnd at UTC midnight', () => {
    const folds = foldSchedule(start, start + 365 * DAY);
    expect(folds[0]).toEqual({ foldId: 0, trainStart: start, trainEnd: start + 56 * DAY, testStart: start + 56 * DAY, testEnd: start + 70 * DAY });
    expect(folds[1]!.trainStart).toBe(start + 14 * DAY);
    for (const [k, f] of folds.entries()) {
      expect(f.foldId).toBe(k);
      expect(f.testStart).toBe(f.trainEnd);
      expect(f.testEnd - f.testStart).toBe(14 * DAY);
      expect(f.trainEnd - f.trainStart).toBe(56 * DAY);
      expect(f.testStart % DAY).toBe(0);
      if (k > 0) expect(f.testStart).toBe(folds[k - 1]!.testEnd);      // test windows tile the span
    }
  });

  it('12 months ⇒ 22 folds; the last test window ends inside the span', () => {
    const end = start + 365 * DAY;
    const folds = foldSchedule(start, end);
    expect(folds).toHaveLength(22);
    expect(folds.at(-1)!.testEnd).toBeLessThanOrEqual(end);
    expect(folds.at(-1)!.testEnd + 14 * DAY).toBeGreaterThan(end);
  });

  it('F < 12 throws unless allowShort; no fold at all always throws', () => {
    const end = start + (70 + 10 * 14) * DAY;                      // exactly 11 folds
    expect(() => foldSchedule(start, end)).toThrow(ReplayInputError);
    expect(() => foldSchedule(start, end)).toThrow(`requires F ≥ ${MIN_FOLDS}`);
    expect(foldSchedule(start, end, FOLD_DAYS, { allowShort: true })).toHaveLength(11);
    expect(foldSchedule(start, end + 14 * DAY)).toHaveLength(12);
    expect(() => foldSchedule(start, start + 69 * DAY, FOLD_DAYS, { allowShort: true })).toThrow('no fold');
    expect(() => foldSchedule(start + 1, end)).toThrow('UTC midnight');
  });

  it('foldOf / inWindow are half-open', () => {
    const folds = foldSchedule(start, start + 14 * DAY, { train: 4, test: 2, step: 2 }, { allowShort: true });
    expect(folds).toHaveLength(5);
    expect(foldOf(start, folds)).toBe(-1);                          // train only
    expect(foldOf(folds[0]!.testStart, folds)).toBe(0);
    expect(foldOf(folds[0]!.testEnd - 1, folds)).toBe(0);
    expect(foldOf(folds[0]!.testEnd, folds)).toBe(1);
    expect(foldOf(folds[4]!.testEnd, folds)).toBe(-1);
    expect(inWindow(folds[1]!.trainStart, folds[1]!, 'train')).toBe(true);
    expect(inWindow(folds[1]!.trainEnd, folds[1]!, 'train')).toBe(false);
  });

  it('parseFoldDays', () => {
    expect(parseFoldDays('4,2,2')).toEqual({ train: 4, test: 2, step: 2 });
    for (const bad of ['4,2', '4,0,2', 'a,b,c', '4,2,2,2', '4.5,2,2']) expect(() => parseFoldDays(bad)).toThrow(ReplayInputError);
  });
});
