#!/usr/bin/env node
// Phase 0 P0.3 — universe screen (Tooling gap G1 workaround), implements specs/research-plan.md
// §A.1 (sources), §A.2 (exclusion), §A.3 (tiers) exactly. Static Binance USDⓈ-M archives plus
// GET /fapi/v1/exchangeInfo only. Writes research/universe.json:
//   G1 schema {screenedAt, runDate, exclusions, rows[]} plus `symbols` / `longWindow` (the keys
//   research/build-manifest.mjs reads) and `tierCandidates` (ordered next-by-rule lists, A.3 replacement).
// Downloads are cached under $WSR_SCREEN_CACHE (default /mnt/wsr/cache/screen).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RUN_DATE = '2026-09-19';
const DAYS = [];
for (let d = new Date('2026-08-20T00:00:00Z'); d <= new Date('2026-09-18T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) DAYS.push(d.toISOString().slice(0, 10));
const FUNDING_MONTH = '2026-08';
const EXCLUDE = /^(BTC|ETH)/;
const NAMED_T1 = ['BNBUSDT', 'XRPUSDT', 'SOLUSDT'];
const CACHE = process.env.WSR_SCREEN_CACHE ?? '/mnt/wsr/cache/screen';
const S3 = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision';
const DV = 'https://data.binance.vision/data/futures/um';
const CONC = 16;

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const std = (xs) => {
  if (xs.length < 2) return null;
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1));
};
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

async function get(url, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 404 || r.status === 403) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i + 1 >= tries) throw new Error(`${url}: ${e.message}`);
      await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
    }
  }
}
// cached zip → csv text (null if the archive does not exist)
async function zipCsv(rel) {
  const path = join(CACHE, rel);
  const miss = `${path}.missing`;
  if (existsSync(miss)) return null;
  if (!existsSync(path)) {
    const buf = await get(`${DV}/${rel}`);
    mkdirSync(dirname(path), { recursive: true });
    if (buf === null) { writeFileSync(miss, ''); return null; }
    writeFileSync(path, buf);
  }
  return execFileSync('unzip', ['-p', path], { maxBuffer: 1 << 28 }).toString('utf8');
}
const rowsOf = (csv) => csv.split('\n').map((l) => l.trim()).filter((l) => l && /^\d/.test(l)).map((l) => l.split(','));
async function pool(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONC }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}
async function s3List(prefix, maxKeys) {
  const prefixes = [], keys = [];
  let marker = '';
  for (;;) {
    const q = `?delimiter=/&prefix=${encodeURIComponent(prefix)}${marker ? `&marker=${encodeURIComponent(marker)}` : ''}${maxKeys ? `&max-keys=${maxKeys}` : ''}`;
    const xml = (await get(`${S3}${q}`)).toString('utf8');
    for (const m of xml.matchAll(/<CommonPrefixes><Prefix>([^<]+)<\/Prefix><\/CommonPrefixes>/g)) prefixes.push(m[1]);
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    if (maxKeys || !/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
    marker = xml.match(/<NextMarker>([^<]+)<\/NextMarker>/)?.[1] ?? (prefixes.at(-1) ?? keys.at(-1));
  }
  return { prefixes, keys };
}

// 1. symbol enumeration (S3 listing) ∩ exchangeInfo (PERPETUAL, USDT, TRADING)
const { prefixes } = await s3List('data/futures/um/daily/trades/');
const s3Symbols = new Set(prefixes.map((p) => p.split('/').at(-2)));
const info = JSON.parse((await get('https://fapi.binance.com/fapi/v1/exchangeInfo')).toString('utf8'));
const perps = info.symbols.filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING' && s3Symbols.has(s.symbol));
const excluded = perps.filter((s) => EXCLUDE.test(s.baseAsset)).map((s) => s.symbol).sort();
const cands = perps.filter((s) => !EXCLUDE.test(s.baseAsset));
console.error(`S3 symbols ${s3Symbols.size}; USDT perpetual TRADING ${perps.length}; excluded ${excluded.length}; candidates ${cands.length}`);

// 2. listing day (first daily trades archive) and 1d klines for every candidate
const rows = await pool(cands, async (s) => {
  const { keys } = await s3List(`data/futures/um/daily/trades/${s.symbol}/`, 1);
  const listedOn = keys[0]?.match(/(\d{4}-\d{2}-\d{2})\.zip/)?.[1] ?? null;
  const k1d = [];
  for (const d of DAYS) {
    const csv = await zipCsv(`daily/klines/${s.symbol}/1d/${s.symbol}-1d-${d}.zip`);
    if (csv) for (const r of rowsOf(csv)) k1d.push(r);
  }
  const tickSize = Number(s.filters.find((f) => f.filterType === 'PRICE_FILTER').tickSize);
  const price = median(k1d.map((r) => Number(r[4])));
  return {
    symbol: s.symbol, baseAsset: s.baseAsset, listedOn,
    ageDays: listedOn ? dayDiff(listedOn, RUN_DATE) : null,
    klineDays: k1d.length,
    quoteVol30d: median(k1d.map((r) => Number(r[7]))),
    tpm: median(k1d.map((r) => Number(r[8]) / 1440)),
    price, tickSize,
    tickBps: price ? (tickSize / price) * 1e4 : null,
  };
});
const ranked = rows.filter((r) => r.quoteVol30d !== null).sort((a, b) => b.quoteVol30d - a.quoteVol30d || (a.symbol < b.symbol ? -1 : 1));
ranked.forEach((r, i) => { r.rank = i + 1; });
const noKlines = rows.filter((r) => r.quoteVol30d === null).map((r) => r.symbol);

// 3. 1m klines (VolUnit proxy) + August funding std: ranks ≤ 200 and T5 candidates
const isT5cand = (r) => r.ageDays !== null && r.ageDays >= 250 && r.ageDays < 410 && r.tpm >= 10;
const need1m = ranked.filter((r) => r.rank <= 200 || isT5cand(r));
await pool(need1m, async (r) => {
  const perDay = [];
  for (const d of DAYS) {
    const csv = await zipCsv(`daily/klines/${r.symbol}/1m/${r.symbol}-1m-${d}.zip`);
    if (!csv) continue;
    const m = median(rowsOf(csv).map((b) => ((Number(b[2]) - Number(b[3])) / Number(b[4])) * 1e4));
    if (m !== null) perDay.push(m);
  }
  r.volUnitBps = median(perDay);
  r.volUnitDays = perDay.length;
  const fcsv = await zipCsv(`monthly/fundingRate/${r.symbol}/${r.symbol}-fundingRate-${FUNDING_MONTH}.zip`);
  r.fundingStd30d = fcsv ? std(rowsOf(fcsv).map((f) => Number(f[2]))) : null;
});
for (const r of ranked) { r.volUnitBps ??= null; r.fundingStd30d ??= null; }

// 4. tiers (A.3)
const floor = (r) => r.tpm >= 10 && r.ageDays !== null && r.ageDays >= 410;
const taken = new Set();
const tier = {};
const cand = {};
const byRank = (a, b) => a.rank - b.rank;
// T1: named majors ∪ next by rank until 5
const t1 = NAMED_T1.map((s) => ranked.find((r) => r.symbol === s)).filter(Boolean);
cand.T1 = ranked.filter((r) => floor(r) && !NAMED_T1.includes(r.symbol));
for (const r of cand.T1) { if (t1.length >= 5) break; t1.push(r); }
tier.T1 = t1; t1.forEach((r) => taken.add(r.symbol));
// quantile positions {min, p25, p50, p75, max} of volUnitBps within a rank window; ties → lower rank
function quantilePick(win) {
  const s = [...win].sort((a, b) => a.volUnitBps - b.volUnitBps || a.rank - b.rank);
  const n = s.length;
  const pos = [1, Math.ceil(0.25 * n), Math.ceil(0.5 * n), Math.ceil(0.75 * n), n];
  return { pick: pos.map((p) => s[p - 1]), sorted: s };
}
for (const [t, lo, hi] of [['T2', 6, 25], ['T3', 26, 75]]) {
  const win = ranked.filter((r) => r.rank >= lo && r.rank <= hi && floor(r) && r.volUnitBps !== null && !taken.has(r.symbol));
  const { pick, sorted } = quantilePick(win);
  tier[t] = pick; cand[t] = sorted; pick.forEach((r) => taken.add(r.symbol));
}
cand.T4 = ranked.filter((r) => r.rank >= 76 && r.rank <= 200 && floor(r) && r.volUnitBps !== null && !taken.has(r.symbol)).sort((a, b) => b.volUnitBps - a.volUnitBps || byRank(a, b));
tier.T4 = cand.T4.slice(0, 5); tier.T4.forEach((r) => taken.add(r.symbol));
cand.T5 = ranked.filter((r) => isT5cand(r) && !taken.has(r.symbol)).sort(byRank);
tier.T5 = cand.T5.slice(0, 4); tier.T5.forEach((r) => taken.add(r.symbol));
cand.T6 = ranked.filter((r) => floor(r) && r.tickBps !== null && r.tickBps >= 1).sort(byRank);
tier.T6 = cand.T6.slice(0, 2);

const tierOf = new Map();
for (const t of ['T1', 'T2', 'T3', 'T4', 'T5']) tier[t].forEach((r, i) => tierOf.set(r.symbol, { tier: t, slot: `${t}#${i + 1}` }));
for (const r of ranked) {
  const a = tierOf.get(r.symbol);
  const t6 = tier.T6.findIndex((x) => x.symbol === r.symbol);
  r.tier = a ? (t6 >= 0 ? `T6+${a.tier}` : a.tier) : (t6 >= 0 ? 'T6' : null);
  r.slot = [a?.slot, t6 >= 0 ? `T6#${t6 + 1}` : null].filter(Boolean).join(',') || null;
}

const RESOLVED = {
  T1: 'rule T1: named majors ∪ next by 30-day median quote-volume rank until 5 (tpm ≥ 10, age ≥ 410 d)',
  T2: 'rule T2: ranks 6–25, VolUnit-bps quantile positions {min,p25,p50,p75,max} (nearest rank, ties → lower rank)',
  T3: 'rule T3: ranks 26–75, VolUnit-bps quantile positions {min,p25,p50,p75,max} (nearest rank, ties → lower rank)',
  T4: 'rule T4: ranks 76–200 ∧ tpm ≥ 10, top 5 by VolUnit bps',
  T5: 'rule T5: listing age ∈ [250, 410) d ∧ tpm ≥ 10, top 4 by 30-day quote volume',
  T6: 'rule T6: tick/price ≥ 1 bp, top 2 by 30-day quote volume',
};
const symbols = [];
for (const t of ['T1', 'T2', 'T3', 'T4', 'T5']) for (const r of tier[t]) {
  const e = { symbol: r.symbol, tier: t, slot: tierOf.get(r.symbol).slot, resolvedBy: RESOLVED[t] };
  if (t === 'T5') e.listedOn = r.listedOn;
  if (tier.T6.some((x) => x.symbol === r.symbol)) e.alsoT6 = `T6#${tier.T6.findIndex((x) => x.symbol === r.symbol) + 1}`;
  symbols.push(e);
}
tier.T6.forEach((r, i) => { if (!tierOf.has(r.symbol)) symbols.push({ symbol: r.symbol, tier: 'T6', slot: `T6#${i + 1}`, resolvedBy: RESOLVED.T6 }); });
const longWindow = [...tier.T2].sort((a, b) => b.ageDays - a.ageDays || a.rank - b.rank).slice(0, 2)
  .map((r) => ({ symbol: r.symbol, tier: 'T2', listedOn: r.listedOn, resolvedBy: 'rule: the two T2 symbols with the greatest listing age (tie → volume rank)' }));

const pickRow = ({ symbol, listedOn, ageDays, quoteVol30d, rank, tpm, price, volUnitBps, tickBps, fundingStd30d, tier: t, slot, klineDays }) =>
  ({ symbol, listedOn, ageDays, quoteVol30d, rank, tpm, price, volUnitBps, tickBps, fundingStd30d, tier: t, slot, klineDays });
const out = {
  screenedAt: new Date().toISOString(),
  runDate: RUN_DATE,
  sources: { listing: `${S3}?delimiter=/&prefix=data/futures/um/daily/trades/`, klines: `${DV}/daily/klines/{S}/{1d,1m}/ ${DAYS[0]}…${DAYS.at(-1)}`, funding: `${DV}/monthly/fundingRate/{S}/{S}-fundingRate-${FUNDING_MONTH}.zip`, exchangeInfo: 'https://fapi.binance.com/fapi/v1/exchangeInfo' },
  exclusions: { regex: EXCLUDE.source, appliedTo: 'baseAsset', symbols: excluded },
  counts: { s3Symbols: s3Symbols.size, usdtPerpTrading: perps.length, excluded: excluded.length, ranked: ranked.length, noKlines },
  symbols,
  longWindow,
  tierCandidates: Object.fromEntries(Object.entries(cand).map(([t, xs]) => [t, xs.map((r) => r.symbol)])),
  rows: ranked.map(pickRow),
};
writeFileSync(join(here, 'universe.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote research/universe.json: ${symbols.length} symbols, long window ${longWindow.map((r) => r.symbol).join(', ')}`);
for (const t of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']) console.log(t, tier[t].map((r) => `${r.symbol}(r${r.rank} vu${r.volUnitBps?.toFixed(1)} tick${r.tickBps?.toFixed(2)} tpm${r.tpm?.toFixed(0)} age${r.ageDays})`).join('  '));
