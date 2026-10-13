#!/usr/bin/env node
// Phase 2 (H2–H4a) ledger + memo generator.
// Reads the runner's results.tsv and each runs/<runId>/reaction.json, writes:
//   - runs/<runId>/MEMO.md          (C.9 template, one per run)
//   - runs/INDEX.md rows            (appended, §C columns)  [--append-index]
//   - research/phase2-summary.json  (machine table for runs/MEMO-phase2.md)
// Pure reporting over existing artefacts; no thresholds are computed here that
// the register does not define: H2 = gate.pass && sets.wick.approached >= 500.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const RESULTS = '/mnt/wsr/logs/phase2/results.tsv';
const OUT = 'research/phase2-summary.json';
const APPEND_INDEX = process.argv.includes('--append-index');

const APPROACHED_MIN = 500;                 // register H2 power floor
const universe = JSON.parse(readFileSync('research/universe.json', 'utf8'));
const tierOf = new Map(universe.symbols.map((s) => [s.symbol, s.tier]));
const slotOf = new Map(universe.symbols.map((s) => [s.symbol, s.slot]));
const costfloor = JSON.parse(readFileSync('research/costfloor-proxy.json', 'utf8'));
const eligible = new Set(costfloor.symbols.filter((s) => s.eligible).map((s) => s.symbol));

const rows = readFileSync(RESULTS, 'utf8').trim().split('\n').map((l) => {
  const [start, end, venue, symbol, from, to, runId, exit] = l.split('\t');
  return { start, end, venue, symbol, from, to, runId, exit: Number(exit) };
});

const f = (x, d = 4) => (x === null || x === undefined || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
const ci = (a, d = 4) => (Array.isArray(a) ? `[${f(a[0], d)}, ${f(a[1], d)}]` : '—');

const out = [];
for (const r of rows) {
  const path = `runs/${r.runId}/reaction.json`;
  if (r.runId === 'none' || !existsSync(path)) {
    out.push({ ...r, ok: false, note: 'no reaction.json' });
    continue;
  }
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const w = j.sets.wick;
  const h2 = j.gate.pass === true && w.approached >= APPROACHED_MIN;
  const underpowered = w.approached < APPROACHED_MIN;
  const c14 = j.contrasts['1-4'], c12 = j.contrasts['1-2'], c13 = j.contrasts['1-3'];
  const rec = {
    ...r,
    tier: tierOf.get(r.symbol) ?? '—',
    slot: slotOf.get(r.symbol) ?? '—',
    h1aEligible: eligible.has(r.symbol),
    configHash: j.configHash.slice(0, 12),
    gateConfigHash: j.gateConfigHash.slice(0, 12),
    B: j.B,
    blocks: j.blocks,
    sets: {
      n: w.n, approached: w.approached, complete: w.complete,
      unresolvedShare: w.unresolvedShare, meanDisp: w.meanDisp, pHit: w.pHit,
    },
    blacklistedBuckets: j.blacklistedBuckets,
    totalBuckets: j.totalBuckets,
    blacklistShare: j.blacklistedBuckets / j.totalBuckets,
    randomClipped: j.randomClipped,
    contrasts: {
      '1-4': { diffDisp: c14.diffDisp, ci95: c14.ci95, significant: c14.significant },
      '1-2': { diffDisp: c12.diffDisp, ci95: c12.ci95, significant: c12.significant },
      '1-3': { diffDisp: c13.diffDisp, ci95: c13.ci95, significant: c13.significant },
    },
    conclusion12: j.conclusion12,
    monotone: { slope: j.monotone.slope, ci95: j.monotone.ci95, spearman: j.monotone.spearman, pass: j.monotone.pass },
    gate: { pass: j.gate.pass, reasons: j.gate.reasons },
    // register verdicts
    H2: underpowered ? 'underpowered' : (h2 ? 'PASS' : 'FAIL'),
    H3: c12.significant && c12.diffDisp > 0 ? 'YES' : 'NO',
    H4a: c13.significant && c13.diffDisp > 0 ? 'PASS' : 'FAIL',
    ok: true,
  };
  out.push(rec);

  const memo = `# MEMO — phase 2 / H2, H3, H4(a) — ${r.runId}

date (UTC) ${r.start} → ${r.end} | command:
\`node packages/cli/dist/main.js reaction --venue ${r.venue} --symbol ${r.symbol} --from ${r.from} --to ${r.to} --config configs/research/p2-h2-reaction.json\`
config \`configs/research/p2-h2-reaction.json\` | configHash \`${rec.configHash}\` | gateConfigHash \`${rec.gateConfigHash}\`
exit ${r.exit}${r.exit === 3 ? ' (gate FAIL — a result, §C exit codes)' : ''} | nConfigs.N — (reaction run) | forced: no
tier ${rec.tier} (${rec.slot}) | H1a: ${rec.h1aEligible ? 'P&L-eligible' : 'reaction-only'} | B ${rec.B}, blocks ${rec.blocks}

## Numbers (the register's metric fields, with CI)

| metric | value | CI | threshold | pass? |
|---|---|---|---|---|
| \`sets.wick.n\` | ${w.n} | — | — | — |
| \`sets.wick.approached\` | ${w.approached} | — | ≥ ${APPROACHED_MIN} (H2 power) | ${w.approached >= APPROACHED_MIN ? 'yes' : '**underpowered**'} |
| \`sets.wick.complete\` | ${w.complete} | — | — | — |
| \`sets.wick.unresolvedShare\` | ${f(w.unresolvedShare)} | — | — | — |
| \`blacklistedBuckets/totalBuckets\` | ${j.blacklistedBuckets}/${j.totalBuckets} = ${f(rec.blacklistShare)} | — | — | — |
| \`randomClipped\` | ${j.randomClipped} | — | — | — |
| contrast (1)−(4) \`diffDisp\` | ${f(c14.diffDisp)} | ${ci(c14.ci95)} | > 0, CI excludes 0 | ${c14.significant && c14.diffDisp > 0 ? 'yes' : 'no'} |
| contrast (1)−(2) \`diffDisp\` | ${f(c12.diffDisp)} | ${ci(c12.ci95)} | H3 informational | ${rec.H3} |
| contrast (1)−(3) \`diffDisp\` | ${f(c13.diffDisp)} | ${ci(c13.ci95)} | > 0, CI excludes 0 (H4a) | ${rec.H4a} |
| \`monotone.slope\` | ${f(j.monotone.slope)} | ${ci(j.monotone.ci95)} | > 0, CI excludes 0 | ${j.monotone.pass ? 'yes' : 'no'} |
| \`gate.pass\` | ${j.gate.pass} | — | true | ${j.gate.pass ? 'yes' : 'no'} |

gate reasons: ${j.gate.reasons.length ? j.gate.reasons.map((x) => `\n  - ${x}`).join('') : '(none — gate passed)'}

## Verdict against the pre-registered threshold

- **H2: ${rec.H2}** (gate.pass ${j.gate.pass} ∧ approached ${w.approached} ${w.approached >= APPROACHED_MIN ? '≥' : '<'} ${APPROACHED_MIN})
- **H3: ${rec.H3}** — \`conclusion12\`: "${j.conclusion12}"
- **H4(a): ${rec.H4a}**
- H1b, H5–H12: not run (later phases).

## Deviations from specs/research-plan.md

Phase-level only (see \`runs/MEMO-phase2.md\`): per-regime reaction slicing is tooling gap **G3**
(not available); run concurrency was raised above the §C "3 concurrent jobs" rule on the 16-OCPU
burst box. No threshold, span, seed or config changed.

## Post-hoc observations (exploratory, not in the verdict)

None for this run beyond the table above.
`;
  writeFileSync(`runs/${r.runId}/MEMO.md`, memo);
}

writeFileSync(OUT, `${JSON.stringify({ phase: 2, generatedAt: new Date().toISOString(), approachedMin: APPROACHED_MIN, runs: out }, null, 2)}\n`);

if (APPEND_INDEX) {
  const lines = out.map((r) => `| ${r.start} | 2 | H2/H3/H4a | \`CLI reaction --venue ${r.venue} --symbol ${r.symbol} --from ${r.from} --to ${r.to} --config configs/research/p2-h2-reaction.json\` | p2-h2-reaction.json | ${r.runId} | ${r.venue} | ${r.symbol} | ${r.from}→${r.to} | ${r.ok ? (r.gate.pass ? 'PASS' : 'FAIL') : '—'} | — | no | ${r.exit} |`);
  appendFileSync('runs/INDEX.md', `${lines.join('\n')}\n`);
  console.log(`appended ${lines.length} rows to runs/INDEX.md`);
}

const ok = out.filter((r) => r.ok);
console.log(`runs ${out.length} (with reaction.json: ${ok.length})`);
const tally = (k) => Object.entries(ok.reduce((a, r) => ((a[r[k]] = (a[r[k]] || 0) + 1), a), {})).map(([v, n]) => `${v} ${n}`).join(', ');
console.log(`H2: ${tally('H2')}`);
console.log(`H3: ${tally('H3')}`);
console.log(`H4a: ${tally('H4a')}`);
console.log(`wrote ${OUT} and ${ok.length} runs/<runId>/MEMO.md`);
