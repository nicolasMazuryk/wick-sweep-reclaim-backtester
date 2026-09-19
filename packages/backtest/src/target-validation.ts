import { KahanSum } from './numeric.js';
import {
  hitRate0, hitRateOf, targetGridTable, type TargetGridCell, targetUnitsTable, type TargetUnitsCell, type TradePath,
} from './mfe-mae.js';
import type { PlaceboSweptStats } from './placebo-sweep.js';
import { type Fold, inWindow } from './walk-forward.js';

// Spec §6.2 target validation (§6.5).

export const PLATEAU_TOP_SHARE = 0.2;
// §6.5 conditional table bins of SweepDepth/VolUnit_created; the last is closed.
export const SWEEP_DEPTH_BINS: ReadonlyArray<readonly [number, number]> = [[0.3, 0.5], [0.5, 0.75], [0.75, 1], [1, 1.5], [1.5, 2.5]];

export interface Plateau {
  readonly TargetMult: number;
  readonly StopMult: number;
  readonly cells: number;                   // cells in the top 20 %
  readonly admissible: number;              // cells with trades and a finite Expectancy
}

// Nearest grid value; a tie goes to the lower value. Distances within
// floating-point noise count as a tie (the median of 0.3 and 0.5 is 0.4).
export function snapToGrid(x: number, grid: ReadonlyArray<number>): number {
  let best = NaN;
  for (const g of [...grid].sort((a, b) => a - b)) {
    if (Number.isNaN(best) || Math.abs(g - x) < Math.abs(best - x) - 1e-9 * Math.max(1, Math.abs(x))) best = g;
  }
  return best;
}

// Mean of the two middles for an even count (A-49); NaN when empty.
export function median(xs: ReadonlyArray<number>): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? NaN : n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

// §6.5 "plateau, not the peak": the top 20 % of cells by Expectancy (at
// least one; ties by (TargetMult, StopMult) ascending), then the median
// TargetMult and median StopMult of those cells, each snapped to its grid.
// null when no cell is admissible.
export function plateauOf(cells: ReadonlyArray<TargetGridCell>): Plateau | null {
  const admissible = cells.filter((c) => c.n > 0 && Number.isFinite(c.Expectancy));
  if (admissible.length === 0) return null;
  const ranked = [...admissible].sort((a, b) => b.Expectancy - a.Expectancy || a.TargetMult - b.TargetMult || a.StopMult - b.StopMult);
  const top = ranked.slice(0, Math.max(1, Math.ceil(PLATEAU_TOP_SHARE * admissible.length - 1e-9)));
  const TargetMults = [...new Set(cells.map((c) => c.TargetMult))];
  const StopMults = [...new Set(cells.map((c) => c.StopMult))];
  return {
    TargetMult: snapToGrid(median(top.map((c) => c.TargetMult)), TargetMults),
    StopMult: snapToGrid(median(top.map((c) => c.StopMult)), StopMults), cells: top.length, admissible: admissible.length,
  };
}

export interface TwoStageRow {
  readonly TargetMult: number;
  readonly n: number;
  readonly Expectancy: number;              // bps, net of the trade's RoundTripCost
  readonly firstHalfHitRate: number;        // 1·SweepDepth reached before the stop
  readonly secondHalfHitRate: number;       // TargetMult reached before the stop / back to EntryFill
  readonly unresolvedShare: number;         // second half neither at TargetMult nor back at EntryFill
}

// §6.5 two-stage exit per TargetMult, simulated from the recorded path: half
// at 1·SweepDepth (the first-passage rule of the grid), the stop then moved
// to EntryFill, half at TargetMult. Before 1·SweepDepth the StopMult stop
// takes the whole position; an unresolved first half is a stop (as in
// expectancyOf); an unresolved second half closes at EntryFill (0).
// Needs 1 on the TargetMult grid and StopMult on the stop grid.
export function twoStageExpectancy(paths: ReadonlyArray<TradePath>, StopMult: number): TwoStageRow[] {
  const first = paths[0];
  if (first === undefined) return [];
  const j1 = first.TargetMults.indexOf(1);
  const js = first.StopMults.indexOf(StopMult);
  if (j1 < 0 || js < 0) return [];
  return first.TargetMults.map((TargetMult, jt) => {
    const k = new KahanSum();
    let n = 0;
    let firstHits = 0;
    let secondHits = 0;
    let unresolved = 0;
    for (const path of paths) {
      const costBps = path.trade.RoundTripCost_bps;
      if (!Number.isFinite(costBps)) continue;
      const toBps = 1e4 / path.EntryFill;
      const i1 = path.firstTIdx[j1]!;
      const is = path.firstSIdx[js]!;
      let ticks: number;
      if (i1 >= 0 && (is < 0 || i1 < is)) {
        firstHits++;
        const it = path.firstTIdx[jt]!;
        const back = path.firstBackToEntryAfter1Idx;
        let second = 0;
        if (it >= 0 && (it <= i1 || back < 0 || it < back)) {
          second = TargetMult;
          secondHits++;
        } else if (back < 0) {
          unresolved++;
        }
        ticks = 0.5 * path.SweepDepth + 0.5 * second * path.SweepDepth;
      } else {
        ticks = -StopMult * path.SweepDepth;
      }
      k.add((ticks - costBps / toBps) * toBps);
      n++;
    }
    return {
      TargetMult, n, Expectancy: n === 0 ? NaN : k.value / n, firstHalfHitRate: n === 0 ? NaN : firstHits / n,
      secondHalfHitRate: firstHits === 0 ? NaN : secondHits / firstHits, unresolvedShare: firstHits === 0 ? NaN : unresolved / firstHits,
    };
  });
}

export interface ConditionalRow {
  readonly bin: string;                     // '[lo,hi)' ('[1.5,2.5]' for the last)
  readonly n: number;
  readonly HitRate: number;
  readonly HitRate_0: number;
}

function binLabel(i: number): string {
  const [lo, hi] = SWEEP_DEPTH_BINS[i]!;
  return `[${lo},${hi}${i === SWEEP_DEPTH_BINS.length - 1 ? ']' : ')'}`;
}

// Index into SWEEP_DEPTH_BINS of SweepDepth/VolUnit_created, −1 outside.
export function sweepDepthBin(SweepDepth: number, VolUnit_created: number): number {
  const r = SweepDepth / VolUnit_created;
  return SWEEP_DEPTH_BINS.findIndex(([lo, hi], i) => r >= lo && (r < hi || (i === SWEEP_DEPTH_BINS.length - 1 && r <= hi)));
}

export function sweepDepthBinLabel(SweepDepth: number, VolUnit_created: number): string {
  const i = sweepDepthBin(SweepDepth, VolUnit_created);
  return i < 0 ? 'outside' : binLabel(i);
}

// §6.5 HitRate(2, 1) | SweepDepth/VolUnit_created bin.
export function conditionalHitRate(paths: ReadonlyArray<TradePath>, TargetMult = 2, StopMult = 1): ConditionalRow[] {
  const first = paths[0];
  if (first === undefined || !first.TargetMults.includes(TargetMult) || !first.StopMults.includes(StopMult)) {
    return SWEEP_DEPTH_BINS.map((_, i) => ({ bin: binLabel(i), n: 0, HitRate: NaN, HitRate_0: hitRate0(TargetMult, StopMult) }));
  }
  return SWEEP_DEPTH_BINS.map((_, i) => {
    const members = paths.filter((x) => sweepDepthBin(x.SweepDepth, x.VolUnit_created) === i);
    return { bin: binLabel(i), n: members.length, HitRate: hitRateOf(members, TargetMult, StopMult).HitRate, HitRate_0: hitRate0(TargetMult, StopMult) };
  });
}

export interface FoldTargetValidation {
  readonly foldId: number;
  readonly trainTrades: number;
  readonly testTrades: number;
  readonly train: ReadonlyArray<TargetGridCell>;
  readonly plateau: Plateau | null;
  readonly oos: TargetGridCell | null;      // test-window cell at the train plateau
  // VolUnit-scaled table (A-137): train plateau (TargetUnits, StopMult) and the test-window cell there.
  readonly unitsPlateau?: UnitsPlateau | null;
  readonly unitsOos?: TargetUnitsCell | null;
}

export interface UnitsPlateau {
  readonly TargetUnits: number;
  readonly StopMult: number;
  readonly cells: number;
  readonly admissible: number;
}

export interface TargetValidation {
  readonly TargetMults: ReadonlyArray<number>;
  readonly StopMults: ReadonlyArray<number>;
  readonly TargetUnits: ReadonlyArray<number>;
  readonly folds: ReadonlyArray<FoldTargetValidation>;
  readonly pooledTest: ReadonlyArray<TargetGridCell>;
  // Share of folds whose plateau equals the modal pair (Appendix B Q4: ≥ 75 %).
  readonly stability: { readonly TargetMult: number; readonly StopMult: number; readonly share: number; readonly folds: number } | null;
  readonly byTargetUnits: ReadonlyArray<TargetUnitsCell>;       // VolUnit-scaled, pooled test
  // Share of folds whose VolUnit plateau is the modal pair (A-137); absent in older files.
  readonly unitsStability?: { readonly TargetUnits: number; readonly StopMult: number; readonly share: number; readonly folds: number } | null;
  readonly conditional: ReadonlyArray<ConditionalRow>;          // pooled test
  readonly twoStage: ReadonlyArray<TwoStageRow>;                // pooled test
  // Spec §6.1.4 second test (pooled test); absent in target_grid.json files written before it.
  readonly placeboSwept?: PlaceboSweptStats;
}

// One fold: train-window (TargetMult × StopMult) table, its plateau, and the
// test-window cell at that plateau; the same for the VolUnit-scaled table.
export function foldTargetValidation(
  fold: Pick<Fold, 'foldId'>, train: ReadonlyArray<TradePath>, test: ReadonlyArray<TradePath>,
  grid: { readonly TargetMults: ReadonlyArray<number>; readonly StopMults: ReadonlyArray<number>; readonly TargetUnits: ReadonlyArray<number> },
): FoldTargetValidation {
  const trainTable = targetGridTable(train, grid.TargetMults, grid.StopMults);
  const plateau = plateauOf(trainTable);
  const oos = plateau === null ? null : targetGridTable(test, [plateau.TargetMult], [plateau.StopMult])[0]!;
  const u = plateauOf(targetUnitsTable(train, grid.TargetUnits, grid.StopMults).map((c) => ({ ...c, TargetMult: c.TargetUnits })));
  const unitsPlateau = u === null ? null : { TargetUnits: u.TargetMult, StopMult: u.StopMult, cells: u.cells, admissible: u.admissible };
  const unitsOos = unitsPlateau === null ? null : targetUnitsTable(test, [unitsPlateau.TargetUnits], [unitsPlateau.StopMult])[0]!;
  return { foldId: fold.foldId, trainTrades: train.length, testTrades: test.length, train: trainTable, plateau, oos, unitsPlateau, unitsOos };
}

// VolUnit plateau stability (A-137), as stabilityOf.
export function unitsStabilityOf(perFold: ReadonlyArray<FoldTargetValidation>): TargetValidation['unitsStability'] {
  const s = stabilityOf(perFold.map((f) => ({
    ...f, plateau: f.unitsPlateau == null ? null : { TargetMult: f.unitsPlateau.TargetUnits, StopMult: f.unitsPlateau.StopMult, cells: 0, admissible: 0 },
  })));
  return s === null ? null : { TargetUnits: s.TargetMult, StopMult: s.StopMult, share: s.share, folds: s.folds };
}

// Share of the folds with a plateau whose plateau is the modal pair (ties: smaller pair).
export function stabilityOf(perFold: ReadonlyArray<FoldTargetValidation>): TargetValidation['stability'] {
  const counts = new Map<string, { TargetMult: number; StopMult: number; n: number }>();
  for (const f of perFold) {
    if (f.plateau === null) continue;
    const key = `${f.plateau.TargetMult}|${f.plateau.StopMult}`;
    const c = counts.get(key) ?? { TargetMult: f.plateau.TargetMult, StopMult: f.plateau.StopMult, n: 0 };
    c.n++;
    counts.set(key, c);
  }
  const withPlateau = perFold.filter((f) => f.plateau !== null).length;
  const modal = [...counts.values()].sort((a, b) => b.n - a.n || a.TargetMult - b.TargetMult || a.StopMult - b.StopMult)[0];
  return modal === undefined ? null : { TargetMult: modal.TargetMult, StopMult: modal.StopMult, share: modal.n / withPlateau, folds: withPlateau };
}

// Paths are assigned to windows by TriggerTime. `StopMult` is the configured
// stop used by the two-stage variant.
export function targetValidation(
  paths: ReadonlyArray<TradePath>, folds: ReadonlyArray<Fold>, grid: { readonly TargetMults: ReadonlyArray<number>; readonly StopMults: ReadonlyArray<number>; readonly TargetUnits: ReadonlyArray<number> },
  StopMult: number,
): TargetValidation {
  const { TargetMults, StopMults, TargetUnits } = grid;
  const perFold = folds.map((fold) => foldTargetValidation(
    fold, paths.filter((x) => inWindow(x.trade.TriggerTime, fold, 'train')), paths.filter((x) => inWindow(x.trade.TriggerTime, fold, 'test')), grid,
  ));
  const pooled = paths.filter((x) => folds.some((f) => inWindow(x.trade.TriggerTime, f, 'test')));
  return {
    TargetMults, StopMults, TargetUnits, folds: perFold, pooledTest: targetGridTable(pooled, TargetMults, StopMults),
    stability: stabilityOf(perFold),
    byTargetUnits: targetUnitsTable(pooled, TargetUnits, StopMults), unitsStability: unitsStabilityOf(perFold),
    conditional: conditionalHitRate(pooled),
    twoStage: twoStageExpectancy(pooled, StopMult),
  };
}
