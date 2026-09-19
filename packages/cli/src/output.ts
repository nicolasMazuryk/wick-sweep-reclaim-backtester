import {
  type BacktestResult, BASELINE_MIN_RATIO, type BenchBaseline, type BenchResult, ci, compareBaseline, type EndToEndResult, FORCED_BANNER,
  gridReportSection, type GridResult, LEVEL_SET_IDS, type SyntheticDriftlessResult, num, type ReactionTestResult, REFUSED_BANNER, type RunManifest, TARGET_ALLOC_MBPS,
  TARGET_E2E_EVENTS_PER_SEC, TARGET_EVENTS_PER_SEC, textTable as table,
} from '@wsr/backtest';
import type { CoverageRow, PartitionResult } from '@wsr/data';

// One human-readable line per partition (Spec §2.7 "prints per-partition status").
export function formatPartitionLine(result: PartitionResult): string {
  const parts = [result.status.padEnd(15), result.venue.padEnd(8), result.symbol.padEnd(12), result.day];
  if (result.rowsRaw !== undefined) {
    parts.push(`raw=${result.rowsRaw}`);
  }
  if (result.rowsMerged !== undefined) {
    parts.push(`merged=${result.rowsMerged}`);
  }
  if (result.suspect === true) {
    parts.push('SUSPECT');
  }
  if (result.error !== undefined) {
    parts.push(`— ${result.error}`);
  }
  return parts.join('  ');
}

// `--summary` coverage table: days requested / present / suspect / blacklisted-minutes.
export function formatCoverageTable(rows: readonly CoverageRow[]): string[] {
  const header = ['venue', 'symbol', 'requested', 'present', 'suspect', 'blacklisted_min'];
  const body = rows.map((r) => [r.venue, r.symbol, String(r.daysRequested), String(r.daysPresent), String(r.daysSuspect), String(r.blacklistedMinutes)]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: readonly string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)];
}

// `wsr reaction` human-readable summary (Spec §6.1.4–§6.1.6).
export function formatReaction(manifest: RunManifest, r: ReactionTestResult, warnings: readonly string[], reactionJson: string): string[] {
  const lines = [
    `reaction test  ${manifest.venue} ${manifest.symbol} ${manifest.span.from}…${manifest.span.to}  seed=${manifest.seed}  B=${r.B}  volume-day blocks=${r.blocks}  runId=${manifest.runId}`,
    '',
    ...table([
      ['set', 'n', 'approached', 'complete', 'E[ReactionDisplacement] (95% CI)', 'P(ReactionHit) (95% CI)', 'unresolved'],
      ...LEVEL_SET_IDS.map((id) => {
        const s = r.sets[id];
        return [id, String(s.n), String(s.approached), String(s.complete), `${num(s.meanDisp)} ${ci(s.ci95Disp)}`, `${num(s.pHit)} ${ci(s.ci95Hit)}`, num(s.unresolvedShare)];
      }),
    ]),
    '',
    ...table([
      ['contrast', 'ΔDisp (95% CI)', 'ΔHit (95% CI)', 'significant'],
      ...(['1-4', '1-2', '1-3'] as const).map((k) => {
        const c = r.contrasts[k];
        return [`(${k.replace('-', ')−(')})`, `${num(c.diffDisp)} ${ci(c.ci95)}`, `${num(c.diffHit)} ${ci(c.ci95Hit)}`, c.significant ? 'yes' : 'no'];
      }),
    ]),
    '',
    `monotone in WickStrength: slope ${num(r.monotone.slope, 4)} ${ci(r.monotone.ci95)}  spearman ${num(r.monotone.spearman)}  ${r.monotone.pass ? 'PASS' : 'FAIL'}`,
  ];
  if (r.conclusion12 !== null) lines.push(`(1)−(2) CI contains 0: ${r.conclusion12}`);
  lines.push(`blacklisted buckets ${r.blacklistedBuckets}/${r.totalBuckets}  random levels clipped ${r.randomClipped}`);
  lines.push('', `GATE ${r.gate.pass ? 'PASS' : 'FAIL'}`, ...r.gate.reasons.map((reason) => `  - ${reason}`));
  if (warnings.length > 0) lines.push('', 'warnings:', ...warnings.map((w) => `  - ${w}`));
  lines.push('', `reaction.json: ${reactionJson}`);
  return lines;
}

// `wsr backtest` summary: banner, per-fold table (MinStrength, train/test
// trades, test HitRate vs HitRate_0 vs Breakeven, expectancy), the train
// plateau per fold, output paths.
export function formatBacktest(manifest: RunManifest, r: BacktestResult, files: Readonly<Record<string, string>>): string[] {
  const lines: string[] = [];
  if (r.gate === 'fail') lines.push(REFUSED_BANNER, ...r.gateReasons.map((reason) => `  - ${reason}`), '');
  if (r.gate === 'forced') lines.push(FORCED_BANNER, '');
  lines.push(
    `backtest  ${manifest.venue} ${manifest.symbol} ${manifest.span.from}…${manifest.span.to}  seed=${manifest.seed}  strengthModel=${manifest.config.strengthModel}  folds=${r.folds.length} (${r.foldDays.train}/${r.foldDays.test}/${r.foldDays.step} d)  runId=${manifest.runId}`,
  );
  if (r.gate !== 'fail') {
    const test = new Map(r.foldMetrics.filter((m) => m.window === 'test').map((m) => [m.foldId, m]));
    const train = new Map(r.foldMetrics.filter((m) => m.window === 'train').map((m) => [m.foldId, m]));
    const plateau = new Map((r.targetGrid?.folds ?? []).map((f) => [f.foldId, f.plateau]));
    lines.push('', ...table([
      ['fold', 'MinStrength', 'train', 'test', 'HitRate', 'HitRate_0', 'Breakeven', 'expectancy_bps', 'expectancy_R', 'plateau (T,S)'],
      ...r.fits.map((f) => {
        const m = test.get(f.foldId)!;
        const p = plateau.get(f.foldId);
        return [String(f.foldId), num(f.MinStrength, 4), String(train.get(f.foldId)?.trades ?? 0), String(m.trades), num(m.HitRate), num(m.HitRate_0),
          num(m.BreakevenHitRate), num(m.expectancy_bps, 2), num(m.expectancy_R), p ? `(${p.TargetMult}, ${p.StopMult})` : 'n/a'];
      }),
      ...r.foldMetrics.filter((m) => m.foldId === 'pooled').map((m) => ['pooled', '', '', String(m.trades), num(m.HitRate), num(m.HitRate_0),
        num(m.BreakevenHitRate), num(m.expectancy_bps, 2), num(m.expectancy_R), '']),
    ]));
    const pooled = r.foldMetrics.find((m) => m.foldId === 'pooled');
    if (pooled !== undefined && pooled.latencyCurve.length > 1) {
      lines.push('', `latency curve (pooled test, expectancy bps): ${pooled.latencyCurve.map((c) => `${c.latencyMs} ms ${num(c.expectancy_bps, 2)} (${c.trades})`).join(', ')}`);
    }
    if (pooled !== undefined && pooled.slippageCurve.length > 1) {
      lines.push(`slippage curve (pooled test, expectancy bps): ${pooled.slippageCurve.map((c) => `SlipCoef ×${c.slipCoefMult} ${num(c.expectancy_bps, 2)}`).join(', ')}`);
    }
    for (const v of r.variants) {
      const m = v.folds.find((x) => x.foldId === 'pooled');
      lines.push(`variant ${v.variant} (pooled test): trades ${m?.trades ?? 0}, HitRate ${num(m?.HitRate)}, expectancy ${num(m?.expectancy_bps, 2)} bps`);
    }
    lines.push(`N_configs ${r.nConfigs.cells} cell × ${r.nConfigs.variants} variant(s) × ${r.nConfigs.latencyPoints} latency point(s) = ${r.nConfigs.N}`);
  }
  if (r.warnings.length > 0) lines.push('', 'warnings:', ...r.warnings.map((w) => `  - ${w}`));
  lines.push('', ...Object.entries(files).map(([name, path]) => `${name}: ${path}`));
  return lines;
}

// `wsr backtest --synthetic driftless` (Spec §11.3, §12.2): HitRate(2,1) vs
// 1/3 ± 3σ, then the reaction test of the separate walk stream and its gate.
export function formatSynthetic(r: SyntheticDriftlessResult): string[] {
  const c = r.reaction.contrasts['1-4'];
  return [
    `backtest --synthetic driftless  seed=${r.seed}  events=${r.events}  trades=${r.trades}  unresolved=${r.unresolved}`,
    `HitRate(2,1) ${num(r.HitRate, 4)} vs HitRate_0 ${num(r.HitRate_0, 4)} ± 3σ ${num(3 * r.sigma, 4)} (σ ${num(r.sigma, 4)}, z ${num(r.z, 2)}): ${r.within3Sigma ? 'within 3σ — PASS' : 'outside 3σ — FAIL'}`,
    `reaction test (${r.reactionEvents} prints, B=${r.reaction.B}, ${r.reaction.blocks} volume-days): (1)−(4) ΔDisp ${num(c.diffDisp)} ${ci(c.ci95)}, monotone slope ${num(r.reaction.monotone.slope, 4)} ${ci(r.reaction.monotone.ci95)}`,
    `GATE ${r.reaction.gate.pass ? 'PASS (unexpected on a driftless walk)' : 'FAIL (expected on a driftless walk)'}`,
    ...r.reaction.gate.reasons.map((reason) => `  - ${reason}`),
  ];
}

// `wsr grid` summary: banner, the cell-count line (Spec §12.1 step 13),
// task counts (ran / skipped on resume), report §11, warnings, output paths.
export function formatGrid(manifest: RunManifest, r: GridResult, files: Readonly<Record<string, string>>): string[] {
  const lines: string[] = [];
  if (r.status === 'refused') lines.push(REFUSED_BANNER, ...r.gateReasons.map((reason) => `  - ${reason}`), '');
  if (r.gate === 'forced') lines.push(FORCED_BANNER, '');
  const n = r.nConfigs;
  lines.push(
    `grid  ${manifest.venue} ${manifest.symbol} ${manifest.span.from}…${manifest.span.to}  seed=${manifest.seed}  folds=${r.folds.length} (${r.foldDays.train}/${r.foldDays.test}/${r.foldDays.step} d)  runId=${manifest.runId}`,
    `cells ${n.cells} × variants ${n.variants} × latency ${n.latencyPoints} = N_configs ${n.N}`,
  );
  if (r.status !== 'refused') lines.push(`tasks ${r.tasks.total}: ran ${r.tasks.ran}, skipped ${r.tasks.skipped} (completed earlier)`);
  if (r.status === 'interrupted') {
    lines.push('', `interrupted: resume with \`wsr grid --run-id ${manifest.runId} --runs-root <same root>\` (same --variants / --folds)`);
  }
  if (r.status === 'complete') lines.push('', ...gridReportSection(r.report, r.sensitivity));
  if (r.warnings.length > 0) lines.push('', 'warnings:', ...r.warnings.map((w) => `  - ${w}`));
  if (Object.keys(files).length > 0) lines.push('', ...Object.entries(files).map(([name, path]) => `${name}: ${path}`));
  return lines;
}

const mega = (x: number): string => `${num(x / 1e6, 2)} M events/s`;

// `wsr bench` (Spec §10): throughput, allocation rate, p99 per-print latency,
// each against its target (PASS / WARN), and the baseline comparison.
export function formatBench(r: BenchResult, baseline: { readonly path: string; readonly value: BenchBaseline } | null): string[] {
  const lines = [
    `bench core loop (synthetic)  events=${r.events}  warm-up=${r.warmupEvents}  elapsed=${num(r.elapsedMs / 1000, 2)} s  node=${r.node}  cpu=${r.cpu}`,
    ...table([
      ['metric', 'value', 'target', ''],
      ['throughput', mega(r.eventsPerSec), `≥ ${mega(TARGET_EVENTS_PER_SEC)}`, r.eventsPerSec >= TARGET_EVENTS_PER_SEC ? 'PASS' : 'WARN'],
      ['allocation', `${num(r.allocMBps, 2)} MB/s`, `< ${TARGET_ALLOC_MBPS} MB/s`, r.allocMBps < TARGET_ALLOC_MBPS ? 'PASS' : 'WARN'],
      ['p99 per-print latency', `${num(r.p99Us, 2)} µs`, `(p50 ${num(r.p50Us, 2)} µs, ${r.latencySamples} samples)`, ''],
    ]).map((l) => `  ${l}`),
    `  pivots ${r.pivots}  levels ${r.levels}  trades ${r.trades}  GCs ${r.gcCount}`,
  ];
  if (baseline !== null) {
    const c = compareBaseline(r, baseline.value);
    lines.push(`  baseline ${mega(baseline.value.eventsPerSec)} (${baseline.path}, ${baseline.value.cpu}): ratio ${num(c.ratio, 2)} ${c.ok ? '≥' : '<'} ${BASELINE_MIN_RATIO} ${c.ok ? 'OK' : 'REGRESSION'}`);
  }
  return lines;
}

export function formatBenchEndToEnd(r: EndToEndResult): string {
  return `bench end-to-end  events=${r.events}  days=${r.days}  elapsed=${num(r.elapsedMs / 1000, 2)} s  throughput ${mega(r.eventsPerSec)} (target ≥ ${mega(TARGET_E2E_EVENTS_PER_SEC)}) ${r.eventsPerSec >= TARGET_E2E_EVENTS_PER_SEC ? 'PASS' : 'WARN'}`;
}
