import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { VENUE_IDS } from '@wsr/core';
import { atomicWriteFile } from '@wsr/data';
import { reportValue } from './output.js';
import { finite, mdTable, num } from './report-format.js';
import { pooledOf, reportGate, type ReportInputs } from './report.js';

// Spec §6.5 / Appendix B Q9: runs are (venue, symbol) and never mixed; the
// comparison of several runs is its own artefact,
// runs/compare-{hash}/comparison.json + comparison.md (A-135).

export type Agreement = 'yes' | 'no' | 'n/a';

export interface ComparisonRow {
  readonly venue: string;
  readonly symbol: string;
  readonly runId: string;
  readonly gate: string;
  readonly trades: number;                  // pooled test
  readonly HitRate: number;
  readonly HitRate_0: number;
  readonly BreakevenHitRate: number;
  readonly expectancy_bps: number;
  readonly plateau: { readonly TargetMult: number; readonly StopMult: number } | null;
  readonly sign: -1 | 0 | 1 | null;        // of the pooled test expectancy
}

export interface ComparisonFile {
  readonly compareId: string;               // 'compare-' + 16 hex
  readonly runIds: ReadonlyArray<string>;   // sorted
  readonly rows: ReadonlyArray<ComparisonRow>;
  readonly signAgreement: Agreement;
  readonly plateauAgreement: Agreement;
  readonly verdict: string;                 // Appendix B Q9
}

// compare-{first 16 hex of sha256 of the sorted runIds joined by '|'}: the same set of runs, the same directory.
export function compareIdOf(runIds: ReadonlyArray<string>): string {
  return `compare-${createHash('sha256').update([...runIds].sort().join('|')).digest('hex').slice(0, 16)}`;
}

const venueRank = (v: string): number => {
  const i = (VENUE_IDS as readonly string[]).indexOf(v);
  return i < 0 ? VENUE_IDS.length : i;
};

// Rows by (venue order, symbol, runId), so the bytes do not depend on the argument order.
export function comparisonOf(runs: ReadonlyArray<ReportInputs>): ComparisonFile {
  const rows = runs.map((inp): ComparisonRow => {
    const p = pooledOf(inp);
    const st = inp.targetGrid?.stability ?? null;
    const e = finite(p?.expectancy_bps);
    return {
      venue: inp.manifest.venue, symbol: inp.manifest.symbol, runId: inp.manifest.runId, gate: reportGate(inp), trades: p?.trades ?? 0,
      HitRate: p?.HitRate ?? NaN, HitRate_0: p?.HitRate_0 ?? NaN, BreakevenHitRate: p?.BreakevenHitRate ?? NaN, expectancy_bps: p?.expectancy_bps ?? NaN,
      plateau: st === null ? null : { TargetMult: st.TargetMult, StopMult: st.StopMult }, sign: e === null ? null : (Math.sign(e) as -1 | 0 | 1),
    };
  }).sort((a, b) => venueRank(a.venue) - venueRank(b.venue) || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)
    || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  const agree = (xs: ReadonlyArray<unknown>): Agreement => (xs.some((x) => x === null) ? 'n/a' : new Set(xs).size <= 1 ? 'yes' : 'no');
  const signAgreement = agree(rows.map((r) => r.sign));
  const plateauAgreement = agree(rows.map((r) => (r.plateau === null ? null : `${r.plateau.TargetMult}|${r.plateau.StopMult}`)));
  const runIds = rows.map((r) => r.runId).sort();
  const scope = `${rows.length} runs (${[...new Set(rows.map((r) => `${r.venue} ${r.symbol}`))].join(', ')})`;
  // Q9 verdict rule (Appendix B): sign and plateau agreement across venues / symbols.
  const verdict = rows.length < 2 ? 'not answered — a comparison needs ≥ 2 runs'
    : signAgreement === 'n/a' || plateauAgreement === 'n/a'
      ? `inconclusive — sign agreement ${signAgreement}, plateau agreement ${plateauAgreement} over ${scope}`
      : signAgreement === 'yes' && plateauAgreement === 'yes' ? `yes — same expectancy sign and plateau across ${scope}`
        : signAgreement === 'yes' ? `partly — same expectancy sign, different plateaus across ${scope}`
          : `no — expectancy sign differs across ${scope}`;
  return { compareId: compareIdOf(runIds), runIds, rows, signAgreement, plateauAgreement, verdict };
}

// Markdown lines (stdout and comparison.md).
export function comparisonLines(c: ComparisonFile): string[] {
  const sign = (s: ComparisonRow['sign']): string => (s === null ? 'n/a' : s > 0 ? '+' : s < 0 ? '−' : '0');
  return ['## Cross-venue / cross-symbol comparison (Appendix B Q9)', '',
    ...mdTable(['venue', 'symbol', 'runId', 'gate verdict', 'pooled trades', 'HitRate', 'HitRate_0', 'Breakeven', 'exp bps', 'plateau (TargetMult, StopMult)', 'sign'],
      c.rows.map((r) => [r.venue, r.symbol, r.runId, r.gate, String(r.trades), num(r.HitRate), num(r.HitRate_0), num(r.BreakevenHitRate),
        num(r.expectancy_bps, 2), r.plateau === null ? 'n/a' : `(${r.plateau.TargetMult}, ${r.plateau.StopMult})`, sign(r.sign)])),
    '', `Sign agreement: ${c.signAgreement}; plateau agreement: ${c.plateauAgreement}.`, '', `Q9 verdict: ${c.verdict}.`];
}

// Stdout form used by `wsr backtest --venue a,b` and `wsr report` with several runs.
export function comparisonTable(runs: ReadonlyArray<ReportInputs>): string[] {
  return comparisonLines(comparisonOf(runs));
}

// Writes runs/compare-{hash}/comparison.json and comparison.md atomically.
export async function writeComparison(runsRoot: string, c: ComparisonFile): Promise<{ readonly dir: string; readonly json: string; readonly md: string }> {
  const dir = join(runsRoot, c.compareId);
  const json = join(dir, 'comparison.json');
  const md = join(dir, 'comparison.md');
  await atomicWriteFile(json, Buffer.from(`${JSON.stringify(reportValue(c), null, 2)}\n`));
  await atomicWriteFile(md, Buffer.from(`${comparisonLines(c).join('\n')}\n`));
  return { dir, json, md };
}
