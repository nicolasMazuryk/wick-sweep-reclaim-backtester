import { join } from 'node:path';
import { atomicWriteFile } from '@wsr/data';
import type { GridReport, GridResult, SensitivityReport } from './grid-run.js';
import { GRID_PARAMS } from './grid-space.js';
import { runDirOf, type RunManifest, toReportJson } from './output.js';
import { num } from './report-format.js';

export interface GridOutputPaths {
  readonly runDir: string;
  readonly files: Readonly<Record<string, string>>;         // file name → path, in write order
}

// runs/{runId}/: run.json and reaction.json always; grid.json (every cell,
// plateau per fold, walk-forward, DSR, reality check) and sensitivity.json
// for a complete run. report.md is assembled by `wsr report` (build step 14).
export async function writeGridOutputs(runsRoot: string, manifest: RunManifest, result: GridResult): Promise<GridOutputPaths> {
  const runDir = runDirOf(runsRoot, manifest.runId);
  const files: Record<string, string> = {};
  const write = async (name: string, text: string): Promise<void> => {
    const path = join(runDir, name);
    await atomicWriteFile(path, Buffer.from(text));
    files[name] = path;
  };
  await write('run.json', toReportJson(manifest));
  await write('reaction.json', toReportJson(manifest, result.reaction.result as unknown as Record<string, unknown>));
  if (result.status === 'complete') {
    await write('grid.json', toReportJson(manifest, { gate: result.gate, ...(result.report as unknown as Record<string, unknown>) }));
    await write('sensitivity.json', toReportJson(manifest, { ...(result.sensitivity as unknown as Record<string, unknown>) }));
  }
  return { runDir, files };
}

// Report §11 (Spec §7.2): N_configs, plateau cells per fold, sensitivity
// table, DSR, reality-check p-value. Markdown lines.
export function gridReportSection(report: GridReport, sensitivity: SensitivityReport): string[] {
  const n = report.nConfigs;
  const lines: string[] = [];
  lines.push('## 11. Parameter search (§9.3)', '',
    `N_configs = ${n.cells} cells × ${n.variants} variant(s) × ${n.latencyPoints} latency point(s) = ${n.N}`,
    `Plateau: top 20 % of cells with ≥ ${report.minTradesTrain} train trades by train expectancy_bps; chosen = per-parameter median, snapped.`);
  for (const wf of report.walkForward) {
    lines.push('', `### Plateau per fold — ${wf.variant}`, '',
      `| fold | test from | admissible | top | chosen | ${GRID_PARAMS.join(' | ')} | train trades | train exp_bps | test trades | test exp_bps |`,
      `|${'---|'.repeat(9 + GRID_PARAMS.length)}`);
    for (const f of wf.folds) {
      const from = report.folds.find((x) => x.foldId === f.foldId)?.testFrom ?? '';
      const params = GRID_PARAMS.map((p) => (f.chosen === null ? '' : String(f.chosen.params[p])));
      lines.push(`| ${f.foldId} | ${from} | ${f.admissible} | ${f.top.length} | ${f.chosen?.cellId ?? 'n/a'} | ${params.join(' | ')} | ${f.train?.trades ?? 0} | ${num(f.train?.expectancy_bps, 2)} | ${f.test?.trades ?? 0} | ${num(f.test?.expectancy_bps, 2)} |`);
    }
    lines.push(`| pooled |  |  |  |  | ${GRID_PARAMS.map(() => '').join(' | ')} |  |  | ${wf.pooled.trades} | ${num(wf.pooled.expectancy_bps, 2)} |`,
      '', `Walk-forward OOS (${wf.variant}): ${wf.pooled.trades} trades, expectancy ${num(wf.pooled.expectancy_bps, 2)} bps, Sharpe/trade ${num(wf.pooled.sharpeTrade_bps)}.`);
  }
  lines.push('', '### Sensitivity (one at a time, OOS)', '');
  if (sensitivity.centre === null) {
    lines.push('Not run: no fold has an admissible cell.');
  } else {
    lines.push(`Centre of the fold plateaus: ${sensitivity.centre.cellId} (${GRID_PARAMS.map((p) => `${p}=${sensitivity.centre!.params[p]}`).join(', ')}).`, '',
      '| parameter | value | OOS trades | OOS expectancy_bps | Sharpe/trade |', '|---|---|---|---|---|');
    for (const r of sensitivity.rows) {
      lines.push(`| ${r.param} | ${r.value ?? 'centre'} | ${r.oosTrades} | ${num(r.expectancy_bps, 2)} | ${num(r.sharpeTrade_bps)} |`);
    }
  }
  const d = report.dsr;
  const rc = report.realityCheck;
  lines.push('', '### Multiple testing', '',
    `- Deflated Sharpe ratio: ${num(d.DSR, 4)} (SR̂ ${num(d.SR, 4)}/trade, SR₀ ${num(d.SR0, 4)}, T ${d.nTrades}, γ₃ ${num(d.skew)}, γ₄ ${num(d.kurt)}, V[SR] ${num(d.VSR, 5)} over ${d.trials} trials, N ${d.N})`,
    `- Reality check (White, stationary bootstrap B = ${rc.B}, mean block ${rc.meanBlock} volume-day): p = ${num(rc.p, 4)} (V ${num(rc.V, 3)}, ${rc.n} volume-days, ${rc.cells} cells)`);
  return lines;
}
