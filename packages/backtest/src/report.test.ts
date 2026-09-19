import { parseRunConfig, VENUE_IDS, type VenueId } from '@wsr/core';
import { describe, expect, it } from 'vitest';
import { FORCED_BANNER, REFUSED_BANNER } from './backtest-run.js';
import type { FoldMetrics } from './fold-metrics.js';
import { buildManifest, type RunManifest } from './output.js';
import { CONCLUSION_ONLY_EXTREMUM, type ReactionTestResult } from './reaction-run.js';
import { reactionStats } from './reaction.js';
import {
  decileVerdict, LATENCY_SENTENCE, latencySentenceApplies, openQuestionVerdicts, priorTouchesSign, renderReport, type ReportInputs,
  reportGate, reportSections,
} from './report.js';
import { rngStream } from './rng.js';
import { comparisonOf, comparisonTable, compareIdOf } from './comparison.js';

const ALL = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
const fees = Object.fromEntries(VENUE_IDS.map((v) => [v, { TakerFee: 0.0005, MakerFee: 0.0002, verifiedAt: '2026-09-19' }]));

function manifest(warnings: string[] = [], venue: VenueId = VENUE_IDS[0]): RunManifest {
  return buildManifest({
    venue, symbol: 'ETHUSDT', span: { from: '2025-01-09', to: '2025-01-12' }, seed: 1, config: parseRunConfig({ fees, data: { lowCapSymbol: 'SOLUSDT' } }),
    dataChecksums: [], feesVerifiedAt: null, warnings, createdAt: 'x', gitCommit: 'x', wsrVersion: 'x',
  });
}

function reaction(pass: boolean, ci12: [number, number]): ReactionTestResult {
  const stats = reactionStats([], { B: 1, rng: rngStream(1, 'bootstrap', 0) });
  return {
    ...stats, venue: VENUE_IDS[0], symbol: 'ETHUSDT', span: { from: 0, to: 1 }, seed: 1, randomClipped: 0, blacklistedBuckets: 3, totalBuckets: 100,
    contrasts: { ...stats.contrasts, '1-2': { ...stats.contrasts['1-2'], diffDisp: 0.1, ci95: ci12 } },
    conclusion12: null, configHash: 'h', gateConfigHash: 'g', reactionKey: 'k', gate: pass ? { pass: true, reasons: [] } : { pass: false, reasons: ['(1)−(4): CI contains 0'] },
  };
}

function pooled(over: Partial<FoldMetrics> = {}): FoldMetrics {
  const nan = NaN;
  return {
    foldId: 'pooled', window: 'test', from: '2025-01-11', to: '2025-01-12', volumeDays: 2, trades: 100, realised: 100, HitRate: 0.6, HitRate_0: 1 / 3,
    BreakevenHitRate: 0.4, HitRateMinusBreakeven: 0.2, expectancy_bps: 3, expectancy_R: 0.2, profitFactor: 1.5, sharpeTrade: 0.1, sharpeDaily: 0.2,
    maxDrawdown_R: 4, meanHoldBuckets: 5, touchAndReverseShare: 0.1, targetFill: { conservative: 3, optimistic: 4 },
    latencyCurve: [{ latencyMs: 150, expectancy_bps: 3, trades: 100 }], slippageCurve: [{ slipCoefMult: 1, expectancy_bps: 3 }],
    byDecile: [], bySweepDepthBin: [], byRegime: [], byHour: [], bySweepCount: [], byPriorTouches: [], byReturnSpeed: [],
    mechanism: { winnersMeanImb: 0.3, losersMeanImb: 0.1, diff: 0.2, ci95: [0.05, 0.35] }, ruleBinding: { 'book.resweeps': 2 },
    costFloor: { minSweepSetByCost: 1, shareOfSpikes: 0.5 }, blacklistedBucketShare: nan, killSwitchTrips: 0, ringUnderflow: 0, ...over,
  };
}

function inputs(over: Partial<ReportInputs> = {}): ReportInputs {
  return {
    manifest: manifest(), reaction: reaction(true, [0.05, 0.2]), folds: null, targetGrid: null, stageB: null, trades: null, transitions: null,
    levels: null, grid: null, sensitivity: null, hygiene: null, ...over,
  };
}

describe('renderReport (Spec §7.2)', () => {
  it('always renders sections 0–12; missing artefacts are named with the command that writes them', () => {
    const md = renderReport(inputs());
    expect(reportSections(md)).toEqual(ALL);
    expect(md.split('\n')[0]).toBe(`# WSR backtest — ${VENUE_IDS[0]} ETHUSDT 2025-01-09…2025-01-12`);
    expect(md).toContain('[VERIFY] fees unverified');
    expect(md).toContain('## 11. Parameter search (§9.3)\n\n_Not available — grid.json / sensitivity.json missing (run `wsr grid`)._');
    expect(md).toContain('_Not available — folds.json missing (run `wsr backtest`)._');
    expect(md).toContain('Blacklisted buckets (reaction replay, span): 3/100 (3.0 %).');
    expect(md.endsWith('\n')).toBe(true);
    expect(renderReport(inputs())).toBe(md);
  });

  it('refused run: the refusal banner is line 1 with the reasons; §3–§11 say "P&L backtest not run"', () => {
    const inp = inputs({ reaction: reaction(false, [-0.1, 0.2]) });
    expect(reportGate(inp)).toBe('fail');
    const md = renderReport(inp);
    expect(md.split('\n').slice(0, 2)).toEqual([REFUSED_BANNER, '- (1)−(4): CI contains 0']);
    expect(reportSections(md)).toEqual(ALL);
    for (const n of ['3', '4', '5', '6', '7', '8', '9', '10', '11']) {
      expect(md).toMatch(new RegExp(`## ${n}\\. [^\\n]*\\n\\n_P&L backtest not run`));
    }
    expect(md).toContain('**GATE VERDICT: FAIL**');
  });

  it('forced run: FORCED_BANNER first; the gate comes from grid.json when present', () => {
    const forced = inputs({ manifest: manifest([FORCED_BANNER]), reaction: reaction(false, [0, 1]), folds: { folds: [pooled()], schedule: [] } });
    expect(reportGate(forced)).toBe('forced');
    expect(renderReport(forced).split('\n')[0]).toBe(FORCED_BANNER);
    expect(reportGate({ ...forced, grid: { gate: 'pass' } as ReportInputs['grid'] })).toBe('pass');
  });

  it('§6 prints the §7.1 sentence iff expectancy(150 ms) < 0 ≤ expectancy(50 ms)', () => {
    const curve = (e50: number, e150: number) => [{ latencyMs: 0, expectancy_bps: 5 }, { latencyMs: 50, expectancy_bps: e50 }, { latencyMs: 150, expectancy_bps: e150 }];
    expect(latencySentenceApplies(curve(0, -1))).toBe(true);
    expect(latencySentenceApplies(curve(-0.5, -1))).toBe(false);
    expect(latencySentenceApplies(curve(1, 0))).toBe(false);
    const latencyCurve = curve(1, -1).map((c) => ({ ...c, trades: 10 }));
    const md = renderReport(inputs({ folds: { folds: [pooled({ latencyCurve })], schedule: [] } }));
    expect(md).toContain(`**${LATENCY_SENTENCE}**`);
    expect(openQuestionVerdicts(inputs({ folds: { folds: [pooled({ latencyCurve })], schedule: [] } }))[7]).toBe(`edge gone at 150 ms ${LATENCY_SENTENCE}`);
    const swept = renderReport(inputs({ folds: { folds: [pooled({ latencyCurve })], schedule: [], nConfigs: { cells: 1, variants: 1, latencyPoints: 4, N: 4 } } }));
    expect(swept).toContain('N_configs (§6.4) = 1 cell × 1 variant(s) × 4 latency point(s) = 4.');
    expect(swept).not.toContain('Latency sweep not run');
  });
});

describe('report §5 parameters column (A-134)', () => {
  const schedule = [{ foldId: 0, trainStart: 0, trainEnd: 1, testStart: 1, testEnd: 2, MinStrength: 0.5 }];
  const test0 = pooled({ foldId: 0 });
  const grid = { gate: 'pass', walkForward: [{ variant: 'baseline', folds: [{ foldId: 0, chosen: { cellId: 'c0042' } }], pooled: {} }] } as unknown as ReportInputs['grid'];

  it('a plain backtest never prints grid cell ids, even next to a grid.json', () => {
    const md = renderReport(inputs({ folds: { folds: [test0, pooled()], schedule }, grid }));
    const s5 = md.slice(md.indexOf('## 5.'), md.indexOf('## 6.'));
    expect(s5).toContain('| 0 | test | 2025-01-11 | 2025-01-12 | 0.5000 | configured |');
    expect(s5).not.toContain('c0042');
  });

  it('a --from-grid run prints each fold\'s cell and target pair', () => {
    const m = { ...manifest(), fromGrid: 'feedbeef' };
    const md = renderReport(inputs({ manifest: m, folds: { folds: [test0, pooled()], schedule: [{ ...schedule[0]!, cellId: 'c0042', TargetMult: 1.5, StopMult: 0.75 }] } }));
    const s5 = md.slice(md.indexOf('## 5.'), md.indexOf('## 6.'));
    expect(s5).toContain('grid run feedbeef');
    expect(s5).toContain('| 0 | test | 2025-01-11 | 2025-01-12 | 0.5000 | c0042 (1.5, 0.75) |');
  });
});

describe('A-137: VolUnit table HitRate_0 and per-fold consistency; §11 Stage B calibration', () => {
  const tgCell = (TargetMult: number, StopMult: number, Expectancy: number) => ({ TargetMult, StopMult, HitRate: 0.5, HitRate_0: StopMult / (TargetMult + StopMult), Expectancy, n: 10, unresolvedShare: 0 });
  const uCell = (TargetUnits: number, StopMult: number, Expectancy: number) => ({ TargetUnits, StopMult, HitRate: 0.4, HitRate_0: 0.25, Expectancy, n: 10, unresolvedShare: 0 });
  const fold = (foldId: number, sd: number, vu: number) => ({
    foldId, trainTrades: 10, testTrades: 10, train: [], plateau: { TargetMult: 2, StopMult: 1, cells: 1, admissible: 1 }, oos: tgCell(2, 1, sd),
    unitsPlateau: { TargetUnits: 1, StopMult: 1, cells: 1, admissible: 1 }, unitsOos: uCell(1, 1, vu),
  });
  const tg = {
    TargetMults: [2], StopMults: [1], TargetUnits: [1], folds: [fold(0, 1, 2), fold(1, 1, 3), fold(2, 1, 4), fold(3, 5, 1)], pooledTest: [tgCell(2, 1, 1)],
    stability: { TargetMult: 2, StopMult: 1, share: 1, folds: 4 }, byTargetUnits: [uCell(1, 1, 2)], unitsStability: { TargetUnits: 1, StopMult: 1, share: 1, folds: 4 },
    conditional: [], twoStage: [],
  };

  it('§4 prints the VolUnit HitRate_0 and per-fold VolUnit plateaus; Q5 counts the folds', () => {
    const inp = inputs({ folds: { folds: [pooled()], schedule: [] }, targetGrid: tg });
    const md = renderReport(inp);
    expect(md).toContain('| 1 | 1 | 10 | 0.400 | 0.250 | 2.00 | 0.000 |');
    expect(md).toContain('| 0 | 10 | 10 | (2, 1) | 1 / 1 | 10 | 0.500 | 0.333 | 1.00 | (1, 1) | 0.400 | 0.250 | 2.00 |');
    expect(md).toContain('VolUnit plateau stability: (1, 1) in 100 % of 4 folds.');
    expect(openQuestionVerdicts(inp)[4]).toBe('VolUnit — plateau expectancy 1.00 bps (SweepDepth 2×) vs 2.00 bps (VolUnit 1×); VolUnit ahead in 3 of 4 folds (OOS at each fold\'s train plateaus) — consistent (≥ 75 %)');
  });

  it('§11 renders the Stage B calibration pooled (n-weighted) and per fold', () => {
    const f = (foldId: number, meanY: number) => ({
      foldId, MinStrength: 0.5, nTrainWick: 1, stageBFit: { nIpw: 1, nApproached: 1, nLabelled: 1, converged: true, ipwConverged: true },
      model: { beta0: 0, beta: [], calibration: [{ bin: 1, meanP: 0.2, meanY, n: 10 }, { bin: 2, meanP: 0.6, meanY: 0.5, n: 30 }] },
    });
    const md = renderReport(inputs({ folds: { folds: [pooled()], schedule: [] }, stageB: { strengthModel: 'stageA', folds: [f(0, 0.1), f(1, 0.3)] } }));
    expect(md).toContain('### Stage B calibration (labelled train rows, equal-count bins of P̂)');
    expect(md).toContain('| 1 | 20 | 0.200 | 0.200 |');
    expect(md).toContain('| 2 | 60 | 0.600 | 0.500 |');
    expect(md).toContain('| 1 | 1 | 10 | 0.200 | 0.300 |');
  });
});

describe('backtest --variants (A-132)', () => {
  it('§8 lists baseline + variant pooled rows; Q6 compares total OOS P&L of the armMode variant', () => {
    const arm = { variant: 'armMode', overrides: { ArmMode: 'ArmOnApproach' }, folds: [pooled({ trades: 50, realised: 40, expectancy_bps: 10 })] };
    const inp = inputs({ folds: { folds: [pooled()], schedule: [], variants: [arm] } });
    const md = renderReport(inp);
    expect(md).toContain('| baseline |  | RestEarly | 100 | 100 | 0.600 | 0.333 | 3.00 | 300.0 | 0.100 |');
    expect(md).toContain('| armMode | ArmMode=ArmOnApproach | ArmOnApproach | 50 | 40 | 0.600 | 0.333 | 10.00 | 400.0 | 0.100 |');
    expect(md).not.toContain('ArmMode variant not run');
    expect(openQuestionVerdicts(inp)[5]).toBe('ArmOnApproach — total OOS P&L RestEarly 300.0 bps vs ArmOnApproach 400.0 bps (backtest, configured parameters)');
  });
});

describe('placebo swept levels (Spec §6.1.4, A-131)', () => {
  const placeboSwept = {
    TargetMult: 2, StopMult: 1, HitRate_0: 1 / 3, B: 100, blocks: 20,
    actual: { n: 100, HitRate: 0.6, ci95: [0.5, 0.7] as [number, number] },
    placebo: { n: 80, HitRate: 0.3, ci95: [0.2, 0.4] as [number, number], levels: 400, unresolvedShare: 0.05 },
    diff: { value: 0.3, ci95: [0.15, 0.45] as [number, number], significant: true },
    configured: { TargetMult: 2, StopMult: 1, n: 100, HitRate: 0.6, ci95: [0.45, 0.72] as [number, number] },
  };
  const tg = {
    TargetMults: [2], StopMults: [1], TargetUnits: [1], folds: [], pooledTest: [], stability: { TargetMult: 2, StopMult: 1, share: 1, folds: 4 },
    byTargetUnits: [], conditional: [], twoStage: [], placeboSwept,
  };

  it('§4 renders actual vs placebo vs 1/3; Q4 uses the bootstrap CI of the configured pair', () => {
    const inp = inputs({ folds: { folds: [pooled()], schedule: [] }, targetGrid: tg });
    const md = renderReport(inp);
    expect(md).toContain('### Placebo swept levels (§9.2 second test, Spec §6.1.4), pooled test windows');
    expect(md).toMatch(/\| actual \(filled trades\) \| 100 \| 0\.600 \[0\.500, 0\.700\] \| 0\.333 \| above 1\/3 \|/);
    expect(md).toMatch(/\| placebo swept \| 80 \| 0\.300 \[0\.200, 0\.400\] \| 0\.333 \| contains 1\/3 \| 0\.050 \|/);
    expect(md).toContain('significant (CI excludes 0)');
    expect(openQuestionVerdicts(inp)[3]).toBe('yes — HitRate − Breakeven 0.200 [0.050, 0.320] (volume-day block bootstrap); plateau (2, 1) in 100 % of folds');
    const old = inputs({ folds: { folds: [pooled()], schedule: [] }, targetGrid: { ...tg, placeboSwept: undefined } });
    expect(renderReport(old)).toContain('_Not available — target_grid.json has no placeboSwept (rerun `wsr backtest`)._');
    expect(openQuestionVerdicts(old)[3]).toMatch(/\(normal approx\.\)/);
  });
});

describe('Appendix B verdicts (report §12)', () => {
  it('Q1 = gate; Q2 = (1)−(2) CI: contains 0 ⇒ the §9.2 conclusion verbatim', () => {
    expect(openQuestionVerdicts(inputs())[0]).toBe('yes — gate PASS');
    expect(openQuestionVerdicts(inputs())[1]).toMatch(/^yes — \(1\)−\(2\)/);
    const v = openQuestionVerdicts(inputs({ reaction: reaction(true, [-0.1, 0.3]) }));
    expect(v[1]).toBe(`no — "${CONCLUSION_ONLY_EXTREMUM}"`);
    expect(v).toHaveLength(9);
  });

  it('Q3 sign of the PriorTouches coefficient needs ≥ 75 % of folds', () => {
    const stageB = (signs: number[]) => ({
      strengthModel: 'stageB', folds: signs.map((x, foldId) => ({
        foldId, MinStrength: 0.5, nTrainWick: 1, stageBFit: { nIpw: 1, nApproached: 1, nLabelled: 1, converged: true, ipwConverged: true },
        model: { beta0: 0, beta: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, x, 0] },
      })),
    });
    expect(priorTouchesSign(stageB([1, 1, 1, -1]))!.verdict).toBe('positive');
    expect(priorTouchesSign(stageB([1, 1, -1, -1]))!.verdict).toBe('inconclusive');
    expect(priorTouchesSign(stageB([-1, -1, -1, 0]))!.verdict).toBe('negative');
    expect(priorTouchesSign(null)).toBeNull();
  });

  it('Q7 mechanism: CI above 0 ⇒ yes; Q6 / Q9 not run without grid variants / several runs', () => {
    const v = openQuestionVerdicts(inputs({ folds: { folds: [pooled()], schedule: [] } }));
    expect(v[6]).toMatch(/^yes/);
    expect(v[5]).toBe('not run (`wsr backtest --variants armMode` or `wsr grid --variants armMode`)');
    expect(v[8]).toMatch(/^not answered by a single run/);
    const w = openQuestionVerdicts(inputs({ folds: { folds: [pooled({ mechanism: { winnersMeanImb: 0, losersMeanImb: 0, diff: 0, ci95: [-0.1, 0.1] } })], schedule: [] } }));
    expect(w[6]).toBe('no — CI contains 0');
  });
});

describe('breakdown helpers', () => {
  it('decile monotonicity verdict from the pooled byDecile rows', () => {
    const rows = (es: number[]) => es.map((e, i) => ({ key: String(i + 1).padStart(2, '0'), trades: 5, HitRate: 0.3, HitRate_0: 1 / 3, expectancy_bps: e, expectancy_R: e }));
    expect(decileVerdict(rows([1, 2, 3, 4]))).toMatch(/^increasing in WickStrength/);
    expect(decileVerdict(rows([4, 3, 2, 1]))).toMatch(/^decreasing in WickStrength/);
    expect(decileVerdict(rows([1, 2]))).toMatch(/^inconclusive/);
  });

  it('comparison table: one row per run, sign and plateau agreement', () => {
    const a = inputs({ folds: { folds: [pooled()], schedule: [] } });
    const b = inputs({ manifest: manifest([], VENUE_IDS[1]), folds: { folds: [pooled({ expectancy_bps: -1 })], schedule: [] } });
    const lines = comparisonTable([a, b]);
    for (const v of VENUE_IDS.slice(0, 2)) expect(lines.filter((l) => l.startsWith(`| ${v} | ETHUSDT |`))).toHaveLength(1);
    expect(lines).toContain('Sign agreement: no; plateau agreement: n/a.');
    expect(lines[lines.length - 1]).toBe(`Q9 verdict: inconclusive — sign agreement no, plateau agreement n/a over 2 runs (${VENUE_IDS[0]} ETHUSDT, ${VENUE_IDS[1]} ETHUSDT).`);
  });

  it('Q9 verdict (A-135): sign and plateau agreement; rows sorted by venue order; the run\'s report reads the comparison', () => {
    const st = (TargetMult: number) => ({ stability: { TargetMult, StopMult: 1, share: 1, folds: 4 } }) as unknown as ReportInputs['targetGrid'];
    const run = (venue: VenueId, e: number, T: number) => inputs({ manifest: manifest([], venue), folds: { folds: [pooled({ expectancy_bps: e })], schedule: [] }, targetGrid: st(T) });
    const same = comparisonOf([run(VENUE_IDS[1], 2, 2), run(VENUE_IDS[0], 3, 2)]);
    expect(same.rows.map((r) => r.venue)).toEqual([VENUE_IDS[0], VENUE_IDS[1]]);
    expect(same.verdict).toMatch(/^yes — same expectancy sign and plateau/);
    expect(same.compareId).toBe(compareIdOf([same.runIds[1]!, same.runIds[0]!]));
    expect(comparisonOf([run(VENUE_IDS[0], 2, 2), run(VENUE_IDS[1], 3, 3)]).verdict).toMatch(/^partly/);
    expect(comparisonOf([run(VENUE_IDS[0], 2, 2), run(VENUE_IDS[1], -3, 2)]).verdict).toMatch(/^no — expectancy sign differs/);
    expect(openQuestionVerdicts(inputs({ comparisons: [same] }))[8]).toBe(`${same.verdict} (${same.compareId})`);
  });
});
