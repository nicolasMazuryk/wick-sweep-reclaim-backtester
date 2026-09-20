#!/usr/bin/env node
// Phase 1 (H1a) cost-floor proxy screen — specs/research-plan.md §C Phase 1, register H1a.
// Tooling gap G9 workaround: documented arithmetic over research/universe.json + the verified fee
// table. Nothing under packages/ is touched; no engine run, no data read.
//
//   RTC_bps    = 2*taker_bps + 2*max(0.5*tickBps, 0.4) + 1.0      (S §7.4)
//   floorRatio = 4*RTC_bps / volUnitBps                            (= 2*RTC / (0.5*VU))
//   SweepDepth = max(0.5*VU, 2*RTC)                                (the floored depth)
//   BE_atFloor = (SweepDepth + RTC) / (3*SweepDepth)               (reported only)
//
// Decision (pre-registered, fixed 2026-09-19): symbol P&L-eligible iff floorRatio <= 4;
// tier eligible iff >= 2 of its symbols are eligible.

import { readFileSync, writeFileSync } from 'node:fs';

const UNIVERSE = 'research/universe.json';
const BASE_CONFIG = 'configs/research/base.json';
const MANIFEST = 'research/data-manifest.json';
const OUT = 'research/costfloor-proxy.json';

const PRIMARY_VENUE = 'binance';          // Phase 3 is Binance-only (plan §C Phase 3)
const ELIGIBLE_MAX_FLOOR_RATIO = 4;       // register H1a
const TIER_MIN_ELIGIBLE = 2;              // register H1a

const universe = JSON.parse(readFileSync(UNIVERSE, 'utf8'));
const base = JSON.parse(readFileSync(BASE_CONFIG, 'utf8'));
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

const takerBps = Object.fromEntries(
  Object.entries(base.fees).map(([venue, f]) => [venue, f.TakerFee * 1e4]),
);
const feesVerifiedAt = base.fees[PRIMARY_VENUE].verifiedAt;

const rowBySymbol = new Map(universe.rows.map((r) => [r.symbol, r]));

function proxy(volUnitBps, tickBps, taker) {
  const RTC_bps = 2 * taker + 2 * Math.max(0.5 * tickBps, 0.4) + 1.0;
  const floorRatio = (4 * RTC_bps) / volUnitBps;
  const SweepDepth_bps = Math.max(0.5 * volUnitBps, 2 * RTC_bps);
  const BE_atFloor = (SweepDepth_bps + RTC_bps) / (3 * SweepDepth_bps);
  return { RTC_bps, floorRatio, SweepDepth_bps, BE_atFloor };
}

// admitted venues per symbol (data-manifest.json, Phase 0 P0.9)
const admittedVenues = new Map();
for (const t of manifest.triples) {
  if (t.purpose !== 'primary') continue;
  if (t.admission?.status !== 'admitted') continue;
  if (!admittedVenues.has(t.symbol)) admittedVenues.set(t.symbol, []);
  admittedVenues.get(t.symbol).push(t.venue);
}

const symbols = [];
for (const s of universe.symbols) {
  const r = rowBySymbol.get(s.symbol);
  if (!r) throw new Error(`symbol ${s.symbol} not found in universe.rows`);
  const p = proxy(r.volUnitBps, r.tickBps, takerBps[PRIMARY_VENUE]);
  symbols.push({
    slot: s.slot,
    symbol: s.symbol,
    tier: s.tier,
    alsoT6: s.alsoT6 ?? null,
    rank: r.rank,
    volUnitBps: r.volUnitBps,
    tickBps: r.tickBps,
    tpm: r.tpm,
    takerBps: takerBps[PRIMARY_VENUE],
    ...p,
    eligible: p.floorRatio <= ELIGIBLE_MAX_FLOOR_RATIO,
    admittedVenues: (admittedVenues.get(s.symbol) ?? []).sort(),
  });
}
symbols.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));

// ---- tier aggregation (a symbol counts in every tier slot it holds, e.g. SUIUSDT = T2#2 + T6#2)
function pct(values, q) {                       // nearest-rank percentile, as used in A.3
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 0) return null;
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1));
  return v[idx];
}

const tierMembers = new Map();
for (const s of symbols) {
  for (const tier of [s.tier, s.alsoT6 ? s.alsoT6.slice(0, 2) : null].filter(Boolean)) {
    if (!tierMembers.has(tier)) tierMembers.set(tier, []);
    tierMembers.get(tier).push(s);
  }
}

const tiers = [...tierMembers.keys()].sort().map((tier) => {
  const members = tierMembers.get(tier);
  const col = (k) => members.map((m) => m[k]);
  const eligibleCount = members.filter((m) => m.eligible).length;
  return {
    tier,
    n: members.length,
    volUnitBps: { p10: pct(col('volUnitBps'), 0.1), p50: pct(col('volUnitBps'), 0.5), p90: pct(col('volUnitBps'), 0.9) },
    tickBps: { p10: pct(col('tickBps'), 0.1), p50: pct(col('tickBps'), 0.5), p90: pct(col('tickBps'), 0.9) },
    RTC_bps: { p10: pct(col('RTC_bps'), 0.1), p50: pct(col('RTC_bps'), 0.5), p90: pct(col('RTC_bps'), 0.9) },
    floorRatio: { p10: pct(col('floorRatio'), 0.1), p50: pct(col('floorRatio'), 0.5), p90: pct(col('floorRatio'), 0.9) },
    eligibleCount,
    eligibleSymbols: members.filter((m) => m.eligible).map((m) => m.symbol),
    tierEligible: eligibleCount >= TIER_MIN_ELIGIBLE,
  };
});

// ---- secondary, INFORMATIONAL ONLY (post-hoc): the same arithmetic on each admitted venue's taker fee.
// Never a threshold or a verdict input; §D rule 1.
const byVenueInformational = {};
for (const venue of Object.keys(takerBps)) {
  byVenueInformational[venue] = {
    takerBps: takerBps[venue],
    note: 'informational only (post-hoc); VolUnit/tick are the Binance screen values',
    rows: symbols
      .filter((s) => s.admittedVenues.includes(venue))
      .map((s) => {
        const p = proxy(s.volUnitBps, s.tickBps, takerBps[venue]);
        return {
          symbol: s.symbol, tier: s.tier,
          RTC_bps: p.RTC_bps, floorRatio: p.floorRatio,
          wouldBeEligible: p.floorRatio <= ELIGIBLE_MAX_FLOOR_RATIO,
        };
      }),
  };
}

const eligibleSymbols = symbols.filter((s) => s.eligible);
const out = {
  phase: 1,
  hypothesis: 'H1a',
  computedAt: new Date().toISOString(),
  inputs: {
    universe: UNIVERSE,
    universeScreenedAt: universe.screenedAt,
    baseConfig: BASE_CONFIG,
    manifest: MANIFEST,
    feesVerifiedAt,
    primaryVenue: PRIMARY_VENUE,
    takerBps,
  },
  formulas: {
    RTC_bps: '2*taker_bps + 2*max(0.5*tickBps, 0.4) + 1.0',
    floorRatio: '4*RTC_bps / volUnitBps',
    SweepDepth_bps: 'max(0.5*volUnitBps, 2*RTC_bps)',
    BE_atFloor: '(SweepDepth_bps + RTC_bps) / (3*SweepDepth_bps)',
  },
  thresholds: {
    symbolEligible: `floorRatio <= ${ELIGIBLE_MAX_FLOOR_RATIO}`,
    tierEligible: `>= ${TIER_MIN_ELIGIBLE} eligible symbols in the tier`,
    universeKill: '0 eligible symbols => verdict (a) "cost floor"; Phase 2 still runs, Phases 3-7 skipped',
  },
  counts: {
    symbols: symbols.length,
    eligible: eligibleSymbols.length,
    reactionOnly: symbols.length - eligibleSymbols.length,
    tiersEligible: tiers.filter((t) => t.tierEligible).map((t) => t.tier),
  },
  symbols,
  tiers,
  byVenueInformational,
};

writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);

const f = (x, d = 2) => (x === null ? '—' : x.toFixed(d));
console.log(`# H1a cost-floor proxy — ${PRIMARY_VENUE} taker ${takerBps[PRIMARY_VENUE].toFixed(1)} bps, fees verifiedAt ${feesVerifiedAt}`);
console.log('| slot | symbol | VU bps | tick bps | RTC bps | floorRatio | SweepDepth bps | BE_atFloor | eligible |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const s of symbols) {
  console.log(`| ${s.slot} | ${s.symbol} | ${f(s.volUnitBps)} | ${f(s.tickBps)} | ${f(s.RTC_bps)} | ${f(s.floorRatio)} | ${f(s.SweepDepth_bps)} | ${f(s.BE_atFloor, 3)} | ${s.eligible ? 'YES' : 'reaction-only'} |`);
}
console.log('');
console.log('| tier | n | VU p10/p50/p90 | tick p10/p50/p90 | RTC p10/p50/p90 | floorRatio p10/p50/p90 | eligible | tier eligible? |');
console.log('|---|---|---|---|---|---|---|---|');
for (const t of tiers) {
  console.log(`| ${t.tier} | ${t.n} | ${f(t.volUnitBps.p10)}/${f(t.volUnitBps.p50)}/${f(t.volUnitBps.p90)} | ${f(t.tickBps.p10)}/${f(t.tickBps.p50)}/${f(t.tickBps.p90)} | ${f(t.RTC_bps.p10)}/${f(t.RTC_bps.p50)}/${f(t.RTC_bps.p90)} | ${f(t.floorRatio.p10)}/${f(t.floorRatio.p50)}/${f(t.floorRatio.p90)} | ${t.eligibleCount}/${t.n} | ${t.tierEligible ? 'YES' : 'no'} |`);
}
console.log('');
console.log(`eligible symbols (${eligibleSymbols.length}/${symbols.length}): ${eligibleSymbols.map((s) => s.symbol).join(', ') || '(none)'}`);
console.log(`tiers eligible: ${out.counts.tiersEligible.join(', ') || '(none)'}`);
console.log(`wrote ${OUT}`);
