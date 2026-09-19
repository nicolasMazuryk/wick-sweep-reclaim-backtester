import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRunConfig, VENUE_IDS } from '@wsr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BacktestResult, runBacktest } from './backtest-run.js';
import { runCellTask, runFitTask, runSensitivityTask } from './grid-cell.js';
import type { ReplayInput } from './replay.js';
import { writeSyntheticDataRoot } from './synthetic-data-root.js';

const VENUE = VENUE_IDS[0];
const fees = Object.fromEntries(VENUE_IDS.map((v) => [v, { TakerFee: 0, MakerFee: 0, verifiedAt: '2026-09-19' }]));
const cfg = parseRunConfig({ fees, data: { lowCapSymbol: 'SOLUSDT' }, MinSweepMult: 0.3, BreakoutMult: 4 });

let dir: string;
let input: ReplayInput;
let bt: BacktestResult;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wsr-grid-cell-'));
  await writeSyntheticDataRoot({ dataRoot: dir, venue: VENUE, symbol: 'ETHUSDT', from: { y: 2025, m: 1, d: 1 }, days: 12, seed: 1 });
  input = { dataRoot: dir, venue: VENUE, symbol: 'ETHUSDT', from: { y: 2025, m: 1, d: 9 }, to: { y: 2025, m: 1, d: 12 } };
  bt = await runBacktest(input, cfg, 1, { B: 50, folds: { train: 2, test: 1, step: 1 }, forcePnl: true });
}, 60_000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('grid tasks (Spec §6.4)', () => {
  it('a cell at the configured values reproduces `wsr backtest` (Stage A): same MinStrength per fold, same trades per window', async () => {
    const plan = bt.reaction.plan;
    const folds = bt.folds;
    expect(folds).toHaveLength(2);
    const fit = await runFitTask(plan, folds, { cfg, passRates: [0.3, cfg.minStrengthPassRate, 0.6] });
    expect(fit.MinStrength.map((row) => row[1])).toEqual(bt.fits.map((f) => f.MinStrength_A));
    expect(fit.nTrainWick).toEqual(bt.fits.map((f) => f.nTrainWick));
    for (const row of fit.MinStrength) {                                                   // lower pass rate ⇒ higher threshold
      expect(row[0]!).toBeGreaterThanOrEqual(row[1]!);
      expect(row[1]!).toBeGreaterThanOrEqual(row[2]!);
    }

    const cell = await runCellTask(plan, folds, { cfg, MinStrength: fit.MinStrength.map((row) => row[1]!) });
    for (const [k, fold] of folds.entries()) {
      for (const window of ['train', 'test'] as const) {
        const m = bt.foldMetrics.find((x) => x.foldId === fold.foldId && x.window === window)!;
        const s = cell.folds[k]![window];
        expect([s.trades, s.expectancy_bps], `${fold.foldId}/${window}`).toEqual([m.trades, m.expectancy_bps]);
      }
    }
    const oosIds = bt.records.filter((r) => r.foldId >= 0 && Number.isFinite(r.pnl_bps) && Number.isFinite(r.pnl_R)).map((r) => r.tradeId);
    expect(cell.oos.map((t) => t.tradeId)).toEqual(oosIds);
    expect(cell.oos.length).toBeGreaterThan(0);
    for (const t of cell.oos) expect(t.volumeDay).toBeGreaterThanOrEqual(0);

    // Sensitivity task = fit + trade in one task: the same result for the same config.
    expect(await runSensitivityTask(plan, folds, { cfg })).toEqual(cell);
  }, 60_000);
});
