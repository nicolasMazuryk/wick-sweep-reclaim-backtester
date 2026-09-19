import { parseRunConfig, VENUE_IDS } from '@wsr/core';
import { describe, expect, it } from 'vitest';
import { ReplayInputError } from './blacklist-load.js';
import {
  applyCell, cellIdOf, cellIndexOf, configCount, DEFAULT_GRID, enumerateCells, GRID_PARAMS, gridAxes, parseVariants, variantConfig, withOverrides,
} from './grid-space.js';

const fees = Object.fromEntries(VENUE_IDS.map((v) => [v, { TakerFee: 0.0005, MakerFee: 0.0002, verifiedAt: '2026-09-19' }]));
const cfg = parseRunConfig({ fees, data: { lowCapSymbol: 'SOLUSDT' } });

describe('grid space (Spec §6.4)', () => {
  it('default config ⇒ the six Spec §6.4 axes, 1 296 cells; with --variants armMode,timeStop N_configs = 3 888', () => {
    const axes = gridAxes(cfg);
    expect(axes).toEqual(DEFAULT_GRID);
    const cells = enumerateCells(axes);
    expect(cells).toHaveLength(1296);
    expect(configCount(axes, parseVariants(undefined, cfg))).toEqual({ cells: 1296, variants: 1, latencyPoints: 1, N: 1296 });
    expect(configCount(axes, parseVariants('armMode,timeStop', cfg)).N).toBe(3888);
  });

  it('stable cell ids: mixed radix in axis order, last axis (minStrengthPassRate) fastest; fit groups are consecutive', () => {
    const axes = gridAxes(cfg);
    const cells = enumerateCells(axes);
    expect(cells[0]).toEqual({
      cellIndex: 0, cellId: 'c0000', group: 0,
      params: { PivotMult: 0.8, BandWidthMult: 0.3, MinSpikeSize: 1, MinSweepMult: 0.3, BreakoutMult: 1.5, minStrengthPassRate: 0.3 },
    });
    expect(cells[1]!.params.minStrengthPassRate).toBe(0.4);
    expect(cells[4]!.params.BreakoutMult).toBe(2.5);
    expect(cells[4]!.group).toBe(1);
    expect(cells[1295]!.cellId).toBe('c1295');
    expect(cells[1295]!.params).toEqual({ PivotMult: 2, BandWidthMult: 0.8, MinSpikeSize: 3, MinSweepMult: 1, BreakoutMult: 4, minStrengthPassRate: 0.6 });
    for (const c of cells) expect(cellIndexOf(axes, c.params)).toBe(c.cellIndex);
    expect(cellIndexOf(axes, { ...cells[0]!.params, PivotMult: 1.3 })).toBe(-1);
    expect(new Set(cells.map((c) => c.group)).size).toBe(1296 / 4);
    expect(cellIdOf(42)).toBe('c0042');
  });

  it('search.grid lists replace the defaults (sorted, de-duplicated); an out-of-range value is rejected by the config schema', () => {
    const small = parseRunConfig({ fees, data: { lowCapSymbol: 'SOLUSDT' }, search: { grid: { MinSweepMult: [0.5, 0.3, 0.5], PivotMult: [1.2] } } });
    const axes = gridAxes(small);
    expect(axes.MinSweepMult).toEqual([0.3, 0.5]);
    expect(axes.PivotMult).toEqual([1.2]);
    expect(axes.BandWidthMult).toEqual(DEFAULT_GRID.BandWidthMult);
    expect(() => parseRunConfig({ fees, data: { lowCapSymbol: 'SOLUSDT' }, search: { grid: { PivotMult: [5] } } })).toThrow(/less than or equal to 2/);
    // applyCell still re-validates (a patched config can bypass the schema).
    const patched = { ...small, search: { ...small.search, grid: { ...small.search.grid, PivotMult: [5] } } };
    expect(() => applyCell(patched, enumerateCells(gridAxes(patched))[0]!.params)).toThrow(ReplayInputError);
  });

  it('applyCell sets the six values and Stage A scoring (A-48); withOverrides re-derives MaxAge', () => {
    const b = parseRunConfig({ fees, data: { lowCapSymbol: 'SOLUSDT' }, strengthModel: 'stageB' });
    const cell = enumerateCells(gridAxes(b))[777]!;
    const c = applyCell(b, cell.params);
    for (const p of GRID_PARAMS) expect(c[p]).toBe(cell.params[p]);
    expect(c.strengthModel).toBe('stageA');
    expect(withOverrides(cfg, { AgeScale: 100 }).MaxAge).toBe(300);
  });

  it('variants: toggles of the configured value, every other targetMode; unknown variants are usage errors', () => {
    const v = parseVariants('armMode, timeStop,counterTrendBlock,armMode', cfg);
    expect(v.map((x) => x.id)).toEqual(['baseline', 'armMode', 'timeStop', 'counterTrendBlock']);
    expect(variantConfig(cfg, v[1]!).ArmMode).toBe('ArmOnApproach');
    expect(variantConfig(cfg, v[2]!).timeStop).toBe(true);
    expect(variantConfig(cfg, v[3]!).counterTrendBlock).toBe(true);
    expect(variantConfig(cfg, v[0]!)).toBe(cfg);
    expect(() => parseVariants('latency', cfg)).toThrow(/unknown variant 'latency'/);
    const t = parseVariants('targetMode,ageClock', cfg);
    expect(t.map((x) => x.id)).toEqual(['baseline', 'targetMode.volUnit', 'targetMode.market', 'targetMode.twoStage', 'ageClock']);
    expect(t.slice(1).map((x) => variantConfig(cfg, x))).toMatchObject([
      { targetMode: 'volUnit' }, { targetMode: 'market' }, { targetMode: 'twoStage' }, { ageClock: 'wall' },
    ]);
  });
});
