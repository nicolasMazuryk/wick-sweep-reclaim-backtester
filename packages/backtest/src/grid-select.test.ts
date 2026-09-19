import { describe, expect, it } from 'vitest';
import { centreOf, type CellObjective, selectPlateau } from './grid-select.js';
import { type CellParams, enumerateCells, type GridAxes } from './grid-space.js';
import { snapToGrid } from './target-validation.js';

const axes: GridAxes = {
  PivotMult: [0.8, 1.2, 2], BandWidthMult: [0.5], MinSpikeSize: [1.5], MinSweepMult: [0.3, 0.5, 1], BreakoutMult: [2.5], minStrengthPassRate: [0.3, 0.4],
};
const cells = enumerateCells(axes);                  // 3 × 3 × 2 = 18

function objectives(exp: (c: CellParams, i: number) => number, trades: (i: number) => number = () => 200): CellObjective[] {
  return cells.map((c) => ({ cellIndex: c.cellIndex, params: c.params, trades: trades(c.cellIndex), expectancy_bps: exp(c.params, c.cellIndex) }));
}

describe('plateau selection (Spec §6.4)', () => {
  it('cells below MinTradesTrain or with a non-finite objective are not admissible; none ⇒ chosen null', () => {
    const sel = selectPlateau(objectives((_, i) => (i === 3 ? NaN : i), (i) => (i < 8 ? 99 : 100)), axes);
    expect(sel.admissible).toBe(10);
    expect(Math.min(...sel.top)).toBeGreaterThanOrEqual(8);
    expect(selectPlateau(objectives(() => 1, () => 5), axes)).toEqual({ admissible: 0, top: [], chosen: null });
    expect(selectPlateau(objectives(() => 1, () => 5), axes, 5).admissible).toBe(18);
  });

  it('top 20 % = ceil(0.2·admissible), at least one; ties by cellIndex; chosen = per-parameter median snapped', () => {
    // Argmax = (1.2, 0.5, 0.4); the top 4 also hold (1.2, 0.5, 0.3), (1.2, 0.3, 0.4), (1.2, 0.3, 0.3):
    // medians MinSweepMult 0.4 → 0.3 and passRate 0.35 → 0.3 (ties snap low) — the centre, not the argmax.
    const sel = selectPlateau(objectives((c) => -Math.abs(c.PivotMult - 1.2) - Math.abs(c.MinSweepMult - 0.5) + (c.minStrengthPassRate === 0.4 ? 0.01 : 0)), axes);
    expect(sel.admissible).toBe(18);
    expect(sel.top).toHaveLength(4);                  // ceil(3.6)
    expect(sel.chosen).toEqual({ PivotMult: 1.2, BandWidthMult: 0.5, MinSpikeSize: 1.5, MinSweepMult: 0.3, BreakoutMult: 2.5, minStrengthPassRate: 0.3 });
    const flat = selectPlateau(objectives(() => 0), axes);
    expect(flat.top).toEqual([0, 1, 2, 3]);           // all tied: lowest cellIndex first
    expect(selectPlateau(objectives(() => 0).slice(0, 2), axes).top).toEqual([0]);
  });

  it('median of an even count snaps a floating-point tie to the lower grid value', () => {
    expect(snapToGrid((0.3 + 0.5) / 2, [0.3, 0.5, 1])).toBe(0.3);
    expect(snapToGrid(0.75, [0.5, 1])).toBe(0.5);
    expect(snapToGrid(0.76, [0.5, 1])).toBe(1);
    const c = centreOf([cells[0]!.params, cells[3]!.params], axes);       // MinSweepMult 0.3 and 0.5 → 0.4 → 0.3
    expect(c!.MinSweepMult).toBe(0.3);
    expect(centreOf([], axes)).toBeNull();
  });
});
