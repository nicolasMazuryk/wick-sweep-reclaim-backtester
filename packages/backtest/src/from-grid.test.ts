import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRunConfig, VENUE_IDS } from '@wsr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BacktestResult, runBacktest } from './backtest-run.js';
import { ReplayInputError } from './blacklist-load.js';
import { type FromGrid, fromGridOf } from './from-grid.js';
import { type CellParams, GRID_PARAMS } from './grid-space.js';
import type { ReplayInput } from './replay.js';
import { writeSyntheticDataRoot } from './synthetic-data-root.js';
import { inWindow } from './walk-forward.js';

// `wsr backtest --from-grid` (plan item 12, Spec §6.3 / §6.4, A-48, A-134).
const VENUE = VENUE_IDS[0];
const fees = Object.fromEntries(VENUE_IDS.map((v) => [v, { TakerFee: 0, MakerFee: 0, verifiedAt: '2026-09-19' }]));
const cfg = parseRunConfig({ fees, data: { lowCapSymbol: 'SOLUSDT' }, MinSweepMult: 0.3, BreakoutMult: 4 });
const FOLDS = { train: 2, test: 1, step: 1 };
const params = (over: Partial<CellParams> = {}): CellParams => ({ ...Object.fromEntries(GRID_PARAMS.map((p) => [p, cfg[p]])) as CellParams, ...over });
const isoDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

let dir: string;
let input: ReplayInput;
let base: BacktestResult;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wsr-from-grid-'));
  await writeSyntheticDataRoot({ dataRoot: dir, venue: VENUE, symbol: 'ETHUSDT', from: { y: 2025, m: 1, d: 1 }, days: 12, seed: 1 });
  input = { dataRoot: dir, venue: VENUE, symbol: 'ETHUSDT', from: { y: 2025, m: 1, d: 9 }, to: { y: 2025, m: 1, d: 12 } };
  base = await runBacktest(input, cfg, 1, { B: 50, folds: FOLDS, forcePnl: true });
}, 60_000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function gridOf(chosen: FromGrid['chosen']): FromGrid {
  return {
    runId: 'g', chosen,
    folds: base.folds.map((f) => ({ foldId: f.foldId, trainFrom: isoDay(f.trainStart), testFrom: isoDay(f.testStart), testTo: isoDay(f.testEnd - 86_400_000) })),
  };
}

describe('runBacktest with fromGrid', () => {
  it('the configured cell in every fold: its test window equals a plain run at the fold\'s train plateau pair', async () => {
    const fg = gridOf(base.folds.map(() => ({ cellId: 'c0001', params: params() })));
    const r = await runBacktest(input, cfg, 1, { B: 50, folds: FOLDS, forcePnl: true, fromGrid: fg });
    expect(r.fromGrid!.map((x) => x.cellId)).toEqual(['c0001', 'c0001']);
    expect(r.records.length).toBeGreaterThan(0);
    expect(r.fromGrid!.some((x) => x.plateau && (x.TargetMult !== cfg.TargetMult || x.StopMult !== cfg.StopMult))).toBe(true);
    expect(r.fits.map((f) => f.MinStrength)).toEqual(base.fits.map((f) => f.MinStrength));                    // reaction pass reused
    expect(r.engine).toBeNull();
    expect(r.warnings.some((w) => w.startsWith('--from-grid g:'))).toBe(true);
    for (const [k, fold] of r.folds.entries()) {
      const row = r.fromGrid![k]!;
      const plain = await runBacktest(input, { ...cfg, TargetMult: row.TargetMult!, StopMult: row.StopMult! }, 1, { B: 50, folds: FOLDS, forcePnl: true });
      const pick = (x: BacktestResult) => x.foldMetrics.find((m) => m.foldId === fold.foldId && m.window === 'test')!;
      expect(pick(r)).toEqual(pick(plain));
      const recs = r.records.filter((x) => x.foldId === fold.foldId);
      expect(recs.map((x) => x.tradeId)).toEqual(plain.records.filter((x) => inWindow(x.TriggerTime, fold, 'test')).map((x) => x.tradeId));
      for (const x of recs) expect(x.cellId).toBe(`c0001@${row.TargetMult}x${row.StopMult}`);
    }
    for (const x of r.records) expect(r.folds.some((f) => inWindow(x.TriggerTime, f, 'test'))).toBe(true);
    const pooled = r.foldMetrics.find((m) => m.foldId === 'pooled')!;
    expect(pooled.trades).toBe(r.records.length);
    expect(r.targetGrid!.folds.map((f) => f.plateau === null ? null : [f.plateau.TargetMult, f.plateau.StopMult]))
      .toEqual(r.fromGrid!.map((x) => (x.plateau ? [x.TargetMult, x.StopMult] : null)));
  }, 180_000);

  it('a fold without a chosen cell trades nothing; another cell refits its own MinStrength', async () => {
    const fg = gridOf([null, { cellId: 'c0099', params: params({ MinSweepMult: 0.5 }) }]);
    const r = await runBacktest(input, cfg, 1, { B: 50, folds: FOLDS, forcePnl: true, fromGrid: fg });
    expect(r.fromGrid![0]).toEqual({ foldId: 0, cellId: null, TargetMult: null, StopMult: null, plateau: false });
    expect(r.foldMetrics.find((m) => m.foldId === 0 && m.window === 'test')!.trades).toBe(0);
    expect(r.records.every((x) => x.foldId === 1 && x.cellId.startsWith('c0099@'))).toBe(true);
    expect(r.stageB).toHaveLength(2);
  }, 120_000);

  it('a grid with another fold schedule, or no chosen cell at all, is refused', async () => {
    const shifted = { ...gridOf([null, null]), folds: gridOf([null, null]).folds.map((f) => ({ ...f, testTo: '2030-01-01' })) };
    await expect(runBacktest(input, cfg, 1, { B: 50, folds: FOLDS, forcePnl: true, fromGrid: shifted })).rejects.toThrow(ReplayInputError);
    await expect(runBacktest(input, cfg, 1, { B: 50, folds: FOLDS, forcePnl: true, fromGrid: gridOf([null, null]) })).rejects.toThrow(/no fold has a chosen grid cell/);
    await expect(runBacktest(input, cfg, 1, { B: 50, folds: FOLDS, forcePnl: true, latencySweep: true, fromGrid: gridOf([null, null]) }))
      .rejects.toThrow(/--from-grid runs without/);
  }, 60_000);

  it('fromGridOf reads the baseline walk-forward of grid.json', () => {
    const fg = fromGridOf('abc', {
      folds: [{ foldId: 0, trainFrom: 'a', testFrom: 'b', testTo: 'c' }, { foldId: 1, trainFrom: 'd', testFrom: 'e', testTo: 'f' }],
      walkForward: [
        { variant: 'armMode', folds: [] },
        { variant: 'baseline', folds: [{ foldId: 1, chosen: { cellId: 'c0002', params: params() } }, { foldId: 0, chosen: null }] },
      ],
    });
    expect(fg.chosen.map((c) => c?.cellId ?? null)).toEqual([null, 'c0002']);
    expect(() => fromGridOf('abc', { folds: [], walkForward: [] })).toThrow(/no baseline walk-forward/);
  });
});
