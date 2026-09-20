#!/usr/bin/env node
// Phase 0 P0.9 — hygiene admission per §A.7, over the RUN span (warm-up days excluded from the ratio).
// Reads the per-partition hygiene reports the fetch wrote (data/hygiene/<venue>/<symbol>/<day>.json)
// and the `wsr data verify` exit codes collected in /mnt/wsr/logs/verify/<venue>-<symbol>.log.
// Writes `admission` per triple into research/data-manifest.json and a table to stdout.
//   coverage  daysPresent / daysRequested ≥ 0.95      (run span)
//   suspect   daysSuspect ≤ 0.02 × daysPresent
//   blacklist blacklistedMinutes ≤ 0.03 × daysPresent × 1440
//   holes     no ≥ 7 consecutive missing days inside the run span
//   integrity `wsr data verify` exit 0 (4 = fail)
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const VERIFY = process.env.WSR_VERIFY_DIR ?? '/mnt/wsr/logs/verify';
const manifestPath = join(here, 'data-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const dayList = (from, to) => {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
};

const rows = [];
for (const t of manifest.triples) {
  if (t.feasibility !== 'feasible') { t.admission = { status: 'not-applicable', reason: t.feasibility }; continue; }
  const dir = join('data/hygiene', t.venue, t.symbol);
  const span = dayList(t.from, t.to);
  let present = 0, suspect = 0, blacklistMin = 0, hole = 0, maxHole = 0;
  for (const day of span) {
    const f = join(dir, `${day}.json`);
    if (!existsSync(f)) { hole++; maxHole = Math.max(maxHole, hole); continue; }
    hole = 0; present++;
    try {
      const h = JSON.parse(readFileSync(f, 'utf8'));
      if (h.suspect || h.checksumFailed) suspect++;
      for (const b of h.blacklist ?? []) {
        const ms = b.tEnd - b.tStart;                       // hygiene.ts BlacklistInterval
        blacklistMin += Number.isFinite(ms) && ms > 0 ? ms / 60000 : 0;
      }
    } catch { suspect++; }
  }
  const coverage = present / span.length;
  const vlog = join(VERIFY, `${t.venue}-${t.symbol}.log`);
  const vtxt = existsSync(vlog) ? readFileSync(vlog, 'utf8') : '';
  const verifyExit = vtxt ? Number((vtxt.match(/exit=(\d+)/) ?? [])[1] ?? NaN) : NaN;
  // `verified 0 partition(s)` is an empty result, not a clean pass (A.7 integrity)
  const verifiedPartitions = Number((vtxt.match(/verified (\d+) partition/) ?? [])[1] ?? NaN);
  const checks = {
    coverage: coverage >= 0.95,
    suspect: suspect <= 0.02 * present,
    blacklist: blacklistMin <= 0.03 * present * 1440,
    holes: maxHole < 7,
    integrity: verifyExit === 0 && verifiedPartitions > 0,
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  t.admission = {
    status: failed.length ? 'rejected' : 'admitted',
    daysRequested: span.length, daysPresent: present, coverage: Number(coverage.toFixed(4)),
    daysSuspect: suspect, blacklistedMinutes: Math.round(blacklistMin), maxConsecutiveMissing: maxHole,
    verifyExit: Number.isNaN(verifyExit) ? null : verifyExit,
    verifiedPartitions: Number.isNaN(verifiedPartitions) ? null : verifiedPartitions,
    ...(failed.length ? { failed } : {}),
  };
  rows.push({ venue: t.venue, symbol: t.symbol, tier: t.tier, purpose: t.purpose, ...t.admission });
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const by = {};
for (const r of rows) (by[r.venue] ??= { admitted: 0, rejected: 0 })[r.status]++;
console.log(JSON.stringify(by));
const bad = rows.filter((r) => r.status === 'rejected');
console.log(`rejected ${bad.length}:`);
for (const r of bad) console.log(`  ${r.venue} ${r.symbol} (${r.tier}) present ${r.daysPresent}/${r.daysRequested} cov ${(r.coverage * 100).toFixed(1)} % suspect ${r.daysSuspect} bl ${r.blacklistedMinutes} min hole ${r.maxConsecutiveMissing} verify exit ${r.verifyExit} (${r.verifiedPartitions} partitions) — failed: ${r.failed.join(', ')}`);
const binBad = bad.filter((r) => r.venue === 'binance');
console.log(binBad.length ? `BINANCE REJECTIONS (A.3 replacement needed): ${binBad.map((r) => r.symbol).join(', ')}` : 'no Binance rejection');
