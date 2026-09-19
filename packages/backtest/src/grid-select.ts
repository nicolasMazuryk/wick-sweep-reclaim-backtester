import { type CellParams, GRID_PARAMS, type GridAxes } from './grid-space.js';
import { median, PLATEAU_TOP_SHARE, snapToGrid } from './target-validation.js';

// Spec §6.4 plateau selection, per fold and variant, on the train window.

export const MIN_TRADES_TRAIN = 100;

export interface CellObjective {
  readonly cellIndex: number;
  readonly params: CellParams;
  readonly trades: number;                  // train-window trades
  readonly expectancy_bps: number;          // train-window net expectancy (objective)
}

export interface PlateauSelection {
  readonly admissible: number;              // cells with ≥ minTradesTrain trades and a finite objective
  readonly top: ReadonlyArray<number>;      // cellIndex of the top 20 %, best first
  readonly chosen: CellParams | null;       // per-parameter median of `top`, snapped; null when nothing is admissible
}

// Top 20 % of the admissible cells by objective (at least one, ceil; ties by
// cellIndex), then per parameter the median of those cells snapped to the
// nearest grid value (a tie goes to the lower value). "Centre of the best
// plateau, not the argmax" (§9.3).
export function selectPlateau(cells: ReadonlyArray<CellObjective>, axes: GridAxes, minTradesTrain = MIN_TRADES_TRAIN): PlateauSelection {
  const admissible = cells.filter((c) => c.trades >= minTradesTrain && Number.isFinite(c.expectancy_bps));
  if (admissible.length === 0) return { admissible: 0, top: [], chosen: null };
  const ranked = [...admissible].sort((a, b) => b.expectancy_bps - a.expectancy_bps || a.cellIndex - b.cellIndex);
  const top = ranked.slice(0, Math.max(1, Math.ceil(PLATEAU_TOP_SHARE * admissible.length - 1e-9)));
  return { admissible: admissible.length, top: top.map((c) => c.cellIndex), chosen: centreOf(top.map((c) => c.params), axes) };
}

// Per-parameter median of `params`, snapped to the axes; null when empty.
export function centreOf(params: ReadonlyArray<CellParams>, axes: GridAxes): CellParams | null {
  if (params.length === 0) return null;
  const out = {} as Record<(typeof GRID_PARAMS)[number], number>;
  for (const p of GRID_PARAMS) out[p] = snapToGrid(median(params.map((x) => x[p])), axes[p]);
  return out;
}
