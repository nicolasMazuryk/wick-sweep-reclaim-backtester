#!/usr/bin/env node
// Phase 0 P0.6 — apply the §A.4 feasibility rule to the dry-run probes and write the result into
// research/universe.json (per-triple `feasibility`) and research/data-manifest.json (row fields).
// build-manifest.mjs always writes feasibility: 'probe-in-phase-0'; this script is run after it.
// Rule (research-plan.md §A.4, fixed before any download):
//   keep iff planned ≥ 0.95 × requested days within the run span AND no run of ≥ 7 consecutive
//   `unavailable` days inside the run span. Days after the venue's venueTo are ignored by
//   construction (the manifest already ends each span at venueTo).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const LOGS = process.env.WSR_DRYRUN_DIR ?? '/mnt/wsr/logs/dryrun';
const manifestPath = join(here, 'data-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const summary = [];
for (const t of manifest.triples) {
  const log = join(LOGS, `${t.purpose}-${t.venue}-${t.symbol}.jsonl`);
  if (!existsSync(log)) { t.feasibility = 'not-probed'; t.reason = `no dry-run log ${log}`; continue; }
  const parts = readFileSync(log, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((o) => o && o.type === 'partition');
  // the run span starts at t.from (the warm-up days before it may be unavailable, §A.4)
  const inSpan = parts.filter((p) => p.day >= t.from && p.day <= t.to).sort((a, b) => (a.day < b.day ? -1 : 1));
  const warmup = parts.filter((p) => p.day < t.from);
  const planned = inSpan.filter((p) => p.status === 'planned').length;
  let hole = 0, maxHole = 0;
  for (const p of inSpan) { hole = p.status === 'planned' ? 0 : hole + 1; maxHole = Math.max(maxHole, hole); }
  const share = inSpan.length ? planned / inSpan.length : 0;
  const ok = share >= 0.95 && maxHole < 7;
  t.dryRunResult = {
    requestedDays: inSpan.length, plannedDays: planned, share: Number(share.toFixed(4)), maxConsecutiveUnavailable: maxHole,
    warmupDays: warmup.length, warmupPlanned: warmup.filter((p) => p.status === 'planned').length,
  };
  t.feasibility = ok ? 'feasible' : 'dropped';
  if (!ok) t.reason = share < 0.95 ? `planned ${planned}/${inSpan.length} = ${(share * 100).toFixed(1)} % < 95 %` : `hole of ${maxHole} consecutive unavailable days inside the run span`;
  else delete t.reason;
  summary.push({ venue: t.venue, symbol: t.symbol, purpose: t.purpose, ...t.dryRunResult, feasibility: t.feasibility, reason: t.reason });
}

manifest.feasibilityRule = 'planned ≥ 95 % of the run-span days and no ≥ 7 consecutive unavailable days inside the run span (research-plan.md §A.4); warm-up days before --from may be unavailable';
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const universePath = join(here, 'universe.json');
const universe = JSON.parse(readFileSync(universePath, 'utf8'));
universe.feasibility = summary;
writeFileSync(universePath, `${JSON.stringify(universe, null, 2)}\n`);

const byVenue = {};
for (const s of summary) (byVenue[s.venue] ??= { feasible: 0, dropped: 0, 'not-probed': 0 })[s.feasibility]++;
console.log(JSON.stringify(byVenue, null, 1));
const bad = summary.filter((s) => s.feasibility !== 'feasible');
console.log(`dropped/unprobed ${bad.length}:`);
for (const s of bad) console.log(`  ${s.venue} ${s.symbol} (${s.purpose}) ${s.plannedDays}/${s.requestedDays} maxHole=${s.maxConsecutiveUnavailable} — ${s.reason ?? ''}`);
const binanceBad = bad.filter((s) => s.venue === 'binance');
console.log(binanceBad.length ? `BINANCE DROPS (symbol replacement per A.3): ${binanceBad.map((s) => s.symbol).join(', ')}` : 'no Binance drop — no symbol replacement needed');
