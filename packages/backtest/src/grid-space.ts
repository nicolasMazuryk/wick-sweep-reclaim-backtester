import { parseRunConfig, type RunConfig } from '@wsr/core';
import { ReplayInputError } from './blacklist-load.js';

// Spec §6.4 parameter search: exactly the six §9.3 parameters, in this
// (fixed) axis order. cellIndex is mixed-radix over the axes with the last
// axis fastest, so the cells of one fit group (the first five axes; Spec
// §6.4 fitting of MinStrength per pass rate) are consecutive.
export const GRID_PARAMS = ['PivotMult', 'BandWidthMult', 'MinSpikeSize', 'MinSweepMult', 'BreakoutMult', 'minStrengthPassRate'] as const;
export type GridParam = (typeof GRID_PARAMS)[number];
export type GridAxes = Readonly<Record<GridParam, ReadonlyArray<number>>>;
export type CellParams = Readonly<Record<GridParam, number>>;

export const DEFAULT_GRID: GridAxes = {
  PivotMult: [0.8, 1.2, 2.0],
  BandWidthMult: [0.3, 0.5, 0.8],
  MinSpikeSize: [1.0, 1.5, 2.0, 3.0],
  MinSweepMult: [0.3, 0.5, 1.0],
  BreakoutMult: [1.5, 2.5, 4.0],
  minStrengthPassRate: [0.3, 0.4, 0.5, 0.6],
};

// Latency points evaluated per cell (the configured latencyMs only).
export const LATENCY_POINTS = 1;

export interface GridCell {
  readonly cellIndex: number;
  readonly cellId: string;                  // 'c0042'
  readonly group: number;                   // fit group: index over the first five axes
  readonly params: CellParams;
}

// Config `search.grid` lists where given (sorted, de-duplicated), else the
// Spec §6.4 defaults. Values are range-checked by applyCell.
export function gridAxes(cfg: RunConfig): GridAxes {
  const out = {} as Record<GridParam, number[]>;
  for (const p of GRID_PARAMS) {
    const configured = cfg.search.grid[p];
    out[p] = [...new Set(configured.length > 0 ? configured : DEFAULT_GRID[p])].sort((a, b) => a - b);
  }
  return out;
}

export function cellIdOf(cellIndex: number): string {
  return `c${String(cellIndex).padStart(4, '0')}`;
}

export function cellCount(axes: GridAxes): number {
  return GRID_PARAMS.reduce((n, p) => n * axes[p].length, 1);
}

export function enumerateCells(axes: GridAxes): GridCell[] {
  const n = cellCount(axes);
  const perGroup = axes.minStrengthPassRate.length;
  const cells: GridCell[] = [];
  for (let cellIndex = 0; cellIndex < n; cellIndex++) {
    let rest = cellIndex;
    const params = {} as Record<GridParam, number>;
    for (let a = GRID_PARAMS.length - 1; a >= 0; a--) {
      const p = GRID_PARAMS[a]!;
      const len = axes[p].length;
      params[p] = axes[p][rest % len]!;
      rest = Math.floor(rest / len);
    }
    cells.push({ cellIndex, cellId: cellIdOf(cellIndex), group: Math.floor(cellIndex / perGroup), params });
  }
  return cells;
}

// Inverse of enumerateCells for params on the grid; −1 when a value is off-grid.
export function cellIndexOf(axes: GridAxes, params: CellParams): number {
  let index = 0;
  for (const p of GRID_PARAMS) {
    const j = axes[p].indexOf(params[p]);
    if (j < 0) return -1;
    index = index * axes[p].length + j;
  }
  return index;
}

export function groupIdOf(group: number): string {
  return `g${String(group).padStart(3, '0')}`;
}

// Re-validated copy of cfg with `patch` applied (MaxAge re-derived). A value
// outside its Spec §8.2 range is a usage error.
export function withOverrides(cfg: RunConfig, patch: Readonly<Record<string, unknown>>, what = 'override'): RunConfig {
  const input: Record<string, unknown> = { ...cfg, ...patch };
  delete input.MaxAge;
  try {
    return parseRunConfig(input);
  } catch (error) {
    throw new ReplayInputError(`${what} ${JSON.stringify(patch)}: ${(error as Error).message}`);
  }
}

// The cell's run config: the six grid values, Stage A scoring (A-48).
export function applyCell(cfg: RunConfig, params: CellParams): RunConfig {
  return withOverrides(cfg, { ...params, strengthModel: 'stageA' }, 'grid cell');
}

// Scenario variants (Spec §8.2 class `variant`, §9.3 N_configs). Each named
// variant expands to one config per non-configured value.
export const VARIANT_NAMES = ['armMode', 'timeStop', 'counterTrendBlock', 'targetMode', 'ageClock'] as const;
export type VariantName = (typeof VARIANT_NAMES)[number];

export interface Variant {
  readonly id: string;                      // 'baseline', 'armMode', 'targetMode.market', …
  readonly overrides: Readonly<Record<string, string | boolean>>;
}

export const BASELINE: Variant = { id: 'baseline', overrides: {} };

const TARGET_MODES = ['sweepDepth', 'volUnit', 'market', 'twoStage'] as const;

function expandVariant(name: VariantName, cfg: RunConfig): Variant[] {
  switch (name) {
    case 'armMode':
      return [{ id: 'armMode', overrides: { ArmMode: cfg.ArmMode === 'RestEarly' ? 'ArmOnApproach' : 'RestEarly' } }];
    case 'timeStop':
      return [{ id: 'timeStop', overrides: { timeStop: !cfg.timeStop } }];
    case 'counterTrendBlock':
      return [{ id: 'counterTrendBlock', overrides: { counterTrendBlock: !cfg.counterTrendBlock } }];
    case 'targetMode':
      return TARGET_MODES.filter((m) => m !== cfg.targetMode).map((m) => ({ id: `targetMode.${m}`, overrides: { targetMode: m } }));
    case 'ageClock':
      return [{ id: 'ageClock', overrides: { ageClock: cfg.ageClock === 'volume' ? 'wall' : 'volume' } }];
  }
}

// `--variants a,b` → [baseline, …expanded]; unknown names are usage errors.
export function parseVariants(text: string | undefined, cfg: RunConfig): Variant[] {
  const names = (text ?? '').split(',').map((x) => x.trim()).filter((x) => x.length > 0);
  const out: Variant[] = [BASELINE];
  const seen = new Set<string>();
  for (const name of names) {
    if (!(VARIANT_NAMES as readonly string[]).includes(name)) {
      throw new ReplayInputError(`unknown variant '${name}' (known: ${VARIANT_NAMES.join(', ')})`);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(...expandVariant(name as VariantName, cfg));
  }
  return out;
}

export function variantConfig(cfg: RunConfig, v: Variant): RunConfig {
  return Object.keys(v.overrides).length === 0 ? cfg : withOverrides(cfg, v.overrides, `variant ${v.id}`);
}

// Spec §6.4: N_configs = grid cells × scenario variants × latency points.
export interface ConfigCount {
  readonly cells: number;
  readonly variants: number;
  readonly latencyPoints: number;
  readonly N: number;
}

export function configCount(axes: GridAxes, variants: ReadonlyArray<Variant>): ConfigCount {
  const cells = cellCount(axes);
  return { cells, variants: variants.length, latencyPoints: LATENCY_POINTS, N: cells * variants.length * LATENCY_POINTS };
}
