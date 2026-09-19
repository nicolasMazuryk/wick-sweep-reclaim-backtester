import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRunConfig, VENUE_IDS } from '@wsr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BacktestResult, LATENCY_SWEEP_MS, runBacktest } from './backtest-run.js';
import { trainWickScores } from './fold-fit.js';
import { executeTask, runPointTask, runVariantTask, type TaskResult, type TaskSpec } from './grid-cell.js';
import { parseVariants } from './grid-space.js';
import type { ReplayInput } from './replay.js';
import { writeSyntheticDataRoot } from './synthetic-data-root.js';
import { type TaskRunner } from './worker-pool.js';

// Spec §4.1 latency sweep, §9.4 slippage curve and scenario variants of `wsr backtest` (plan items 6/7/10, A-130, A-132).
const VENUE = VENUE_IDS[0];
const fees = Object.fromEntries(VENUE_IDS.map((v) => [v, { TakerFee: 0, MakerFee: 0, verifiedAt: '2026-09-19' }]));
const cfg = parseRunConfig({ fees, data: { lowCapSymbol: 'SOLUSDT' }, MinSweepMult: 0.3, BreakoutMult: 4, latencyMs: 100 });
const FOLDS = { train: 2, test: 1, step: 1 };

let dir: string;
let input: ReplayInput;
let bt: BacktestResult;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wsr-bt-sweep-'));
  await writeSyntheticDataRoot({ dataRoot: dir, venue: VENUE, symbol: 'ETHUSDT', from: { y: 2025, m: 1, d: 1 }, days: 12, seed: 1 });
  input = { dataRoot: dir, venue: VENUE, symbol: 'ETHUSDT', from: { y: 2025, m: 1, d: 9 }, to: { y: 2025, m: 1, d: 12 } };
  bt = await runBacktest(input, cfg, 1, { B: 50, folds: FOLDS, forcePnl: true, latencySweep: true, slippageSweep: true, workers: 0 });
}, 120_000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('wsr backtest --latency-sweep / --slippage-sweep / --variants', () => {
  it('curves: {0, 50, 150, 500} ∪ configured latency and SlipCoef ×{1, 2, 4} in every FoldMetrics; the configured point is the run itself', () => {
    expect(bt.nConfigs).toEqual({ cells: 1, variants: 1, latencyPoints: 5, N: 5 });
    for (const m of bt.foldMetrics) {
      expect(m.latencyCurve.map((c) => c.latencyMs)).toEqual([0, 50, 100, 150, 500]);
      expect(m.slippageCurve.map((c) => c.slipCoefMult)).toEqual([1, 2, 4]);
      const own = m.latencyCurve.find((c) => c.latencyMs === cfg.latencyMs)!;
      expect([own.trades, own.expectancy_bps]).toEqual([m.trades, m.expectancy_bps]);
      expect(m.slippageCurve[0]!.expectancy_bps).toEqual(m.expectancy_bps);
    }
    const pooled = bt.foldMetrics.find((m) => m.foldId === 'pooled')!;
    expect(pooled.trades).toBeGreaterThan(0);
    for (const c of pooled.latencyCurve) expect(c.trades).toBeGreaterThan(0);
    expect(new Set(pooled.latencyCurve.map((c) => c.expectancy_bps)).size).toBeGreaterThan(1);
    expect(pooled.slippageCurve[2]!.expectancy_bps).toBeLessThanOrEqual(pooled.slippageCurve[0]!.expectancy_bps);  // ceil(·) ⇒ often equal
  });

  it('a point replay at the configured parameters reproduces the run window by window', async () => {
    const plan = bt.reaction.plan;
    const point = await runPointTask(plan, bt.folds, { cfg, schedule: bt.schedule });
    for (const [k, fold] of bt.folds.entries()) {
      for (const window of ['train', 'test'] as const) {
        const m = bt.foldMetrics.find((x) => x.foldId === fold.foldId && x.window === window)!;
        expect([point.folds[k]![window].trades, point.folds[k]![window].expectancy_bps]).toEqual([m.trades, m.expectancy_bps]);
      }
    }
  }, 60_000);

  it('results merge by task id: a runner that finishes in reverse order gives identical FoldMetrics', async () => {
    const plan = bt.reaction.plan;
    const reversed: TaskRunner<TaskSpec, TaskResult> = {
      run: async (tasks, opts) => {
        const done = await Promise.all(tasks.map(async (t) => [t.taskId, await executeTask(plan, bt.folds, t.spec)] as const));
        for (const [id, r] of done.reverse()) await opts.onResult(id, r);
        return { completed: tasks.length, stopped: false };
      },
      close: async () => {},
    };
    const again = await runBacktest(input, cfg, 1, { B: 50, folds: FOLDS, forcePnl: true, latencySweep: true, slippageSweep: true, runner: reversed });
    expect(again.foldMetrics).toEqual(bt.foldMetrics);
  }, 120_000);

  it('without the flags the curves hold the configured point only', async () => {
    expect(LATENCY_SWEEP_MS).toEqual([0, 50, 150, 500]);
    const plain = await runBacktest(input, cfg, 1, { B: 50, folds: FOLDS, forcePnl: true });
    const pooled = plain.foldMetrics.find((m) => m.foldId === 'pooled')!;
    expect(pooled.latencyCurve).toEqual([{ latencyMs: 100, expectancy_bps: pooled.expectancy_bps, trades: pooled.trades }]);
    expect(pooled.slippageCurve).toEqual([{ slipCoefMult: 1, expectancy_bps: pooled.expectancy_bps }]);
    expect(plain.nConfigs.N).toBe(1);
  }, 60_000);

  it('--variants: one FoldMetrics set per variant, each trading on the synthetic path; a baseline pass reproduces the run', async () => {
    const variants = parseVariants('armMode,targetMode,timeStop,counterTrendBlock,ageClock', cfg);
    const r = await runBacktest(input, cfg, 1, { B: 50, folds: FOLDS, forcePnl: true, variants, workers: 0 });
    expect(r.variants.map((v) => v.variant)).toEqual(variants.slice(1).map((v) => v.id));
    expect(r.nConfigs).toEqual({ cells: 1, variants: variants.length, latencyPoints: 1, N: variants.length });
    for (const v of r.variants) {
      expect(v.folds.map((m) => `${m.foldId}/${m.window}`)).toEqual(r.foldMetrics.map((m) => `${m.foldId}/${m.window}`));
      expect(v.folds.find((m) => m.foldId === 'pooled')!.trades, v.variant).toBeGreaterThan(0);
    }
    expect(r.variants.find((v) => v.variant === 'armMode')!.overrides).toEqual({ ArmMode: 'ArmOnApproach' });
    const rows = bt.reaction.engine.store.snapshot();
    const trainScores = bt.folds.map((fold) => trainWickScores(rows, fold, null).filter(Number.isFinite).sort((a, b) => a - b));
    const same = await runVariantTask(bt.reaction.plan, bt.folds, { cfg, schedule: r.schedule, trainScores, seed: 1, B: 50 });
    expect(same.foldMetrics).toEqual(r.foldMetrics);
  }, 120_000);
});
