import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { getHeapStatistics, GCProfiler } from 'node:v8';
import { Engine, type MergedEvent, type RunConfig, type Side } from '@wsr/core';
import { minStrengthForPassRate } from './min-strength.js';
import { initialInstrument, planReplay, replay, type ReplayInput } from './replay.js';
import { rngStream } from './rng.js';
import { SYNTHETIC_INSTRUMENT, SYNTHETIC_TEST, SYNTHETIC_VENUE, syntheticRunConfig } from './synthetic-config.js';

// Spec §10 `wsr bench`: core-loop throughput (≥ 3 M merged events/s per
// worker), allocation rate at steady state (< 1 MB/s) and p99 per-print
// latency on the synthetic path; optionally end-to-end over a data root
// including Parquet decode (≥ 1 M events/s).

export const TARGET_EVENTS_PER_SEC = 3_000_000;
export const TARGET_ALLOC_MBPS = 1;
export const TARGET_E2E_EVENTS_PER_SEC = 1_000_000;
// CI fails when throughput drops more than 20 % below the checked-in baseline.
export const BASELINE_MIN_RATIO = 0.8;

export interface BenchOptions {
  readonly events: number;                  // timed events
  readonly seed: number;
  readonly warmupEvents?: number;           // untimed, before the timed pass (engine warm-up + JIT); default 200 000
  readonly latencyEvents?: number;          // latency pass after the timed pass; default min(events, 500 000)
  readonly latencyEvery?: number;           // time every K-th print of the latency pass; default 16
}

export interface BenchResult {
  readonly kind: 'coreLoop';
  readonly events: number;
  readonly elapsedMs: number;
  readonly eventsPerSec: number;
  readonly allocBytes: number;              // bytes allocated on the V8 heap during the timed pass
  readonly allocMBps: number;               // MB (10⁶ B) per second of the timed pass
  readonly gcCount: number;
  readonly p50Us: number;
  readonly p99Us: number;
  readonly latencySamples: number;
  readonly warmupEvents: number;
  readonly pivots: number;
  readonly levels: number;
  readonly trades: number;
  readonly node: string;
  readonly cpu: string;
}

export interface EndToEndResult {
  readonly kind: 'endToEnd';
  readonly events: number;
  readonly days: number;
  readonly elapsedMs: number;               // planReplay + replay, Parquet decode included
  readonly eventsPerSec: number;
  readonly node: string;
  readonly cpu: string;
}

// Checked-in baseline (benchmarks/baseline.json).
export interface BenchBaseline {
  readonly eventsPerSec: number;
  readonly allocMBps: number;
  readonly p99Us: number;
  readonly events: number;
  readonly node: string;
  readonly cpu: string;
  readonly createdAt: string;
}

const DT_MS = 5000;                         // one print per 5 s (as the §11.3 smoke test)
const SIZE = 10;
const SPIKE_EVERY = 2000;                   // a planted spike every 2 000 prints
const SPIKE_LEG = 8;                        // prints up, then the same number back
const SPIKE_STEP = 3;                       // ticks per spike print

interface Path {
  readonly t: Float64Array;
  readonly p: Int32Array;
  readonly s: Int8Array;
  readonly length: number;
}

// §11.3 random walk (±1 tick per print, i.i.d. aggressor) with a fast
// excursion of 2·SPIKE_LEG prints every SPIKE_EVERY prints, so the engine
// registers WickLevels, sweeps and trades. Generated up front into typed arrays.
function syntheticPath(n: number, seed: number): Path {
  const rng = rngStream(seed, 'bench');
  const t = new Float64Array(n);
  const p = new Int32Array(n);
  const s = new Int8Array(n);
  const t0 = Date.UTC(2025, 0, 1);
  let price = 100_000;
  for (let i = 0; i < n; i++) {
    const phase = i % SPIKE_EVERY;
    const dir = phase < SPIKE_LEG ? 1 : phase < 2 * SPIKE_LEG ? -1 : 0;
    if (dir === 0) price += rng.nextFloat() < 0.5 ? 1 : -1;
    else price += dir * SPIKE_STEP;
    t[i] = t0 + (i + 1) * DT_MS;
    p[i] = price;
    s[i] = dir !== 0 ? dir : rng.nextFloat() < 0.5 ? 1 : -1;
  }
  return { t, p, s, length: n };
}

// Wiring of synthetic-engine.test.ts: the §11.3 config, zero costs, warm-up
// shortened to one UTC day + UnitWindow buckets.
function benchEngine(): Engine {
  const cfg = syntheticRunConfig();
  return Engine.fromConfig(cfg, SYNTHETIC_VENUE, SYNTHETIC_INSTRUMENT, {
    test: SYNTHETIC_TEST, MinStrength: minStrengthForPassRate([], cfg.minStrengthPassRate),
    warmupDone: (e) => e.builder.daysConsumed >= 1 && e.builder.completedCount >= e.cfg.UnitWindow && e.warmupEvents >= 500,
  });
}

type Cursor = { -readonly [K in keyof MergedEvent]: MergedEvent[K] };

function feed(engine: Engine, path: Path, cursor: Cursor, from: number, to: number): void {
  for (let i = from; i < to; i++) {
    cursor.t = path.t[i]!;
    cursor.seq = i;
    cursor.p = path.p[i]!;
    cursor.s = path.s[i]! as Side;
    engine.onPrint(cursor);
  }
}

function machine(): { node: string; cpu: string } {
  return { node: process.version, cpu: cpus()[0]?.model.trim() ?? 'unknown' };
}

// Bytes allocated between start and stop: heap growth between consecutive GCs
// (before_i − after_{i−1}) plus the growth after the last one.
function allocatedBytes(startUsed: number, endUsed: number, stats: ReadonlyArray<{ beforeGC: { heapStatistics: { usedHeapSize: number } }; afterGC: { heapStatistics: { usedHeapSize: number } } }>): number {
  let prev = startUsed;
  let total = 0;
  for (const g of stats) {
    total += Math.max(0, g.beforeGC.heapStatistics.usedHeapSize - prev);
    prev = g.afterGC.heapStatistics.usedHeapSize;
  }
  return total + Math.max(0, endUsed - prev);
}

// Linear-interpolation percentile of a sorted sample.
function sortedPercentile(xs: Float64Array, q: number): number {
  if (xs.length === 0) return NaN;
  const h = (xs.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, xs.length - 1);
  return xs[lo]! + (h - lo) * (xs[hi]! - xs[lo]!);
}

// Core loop on the synthetic path: an untimed warm-up pass, the timed pass
// (throughput, allocation via GCProfiler), then a latency pass timing every
// K-th print with performance.now(). The engine is fed through one reused
// MergedEvent cursor (Spec §10: no per-print allocation by the driver).
export function benchCoreLoop(o: BenchOptions): BenchResult {
  const warmupEvents = o.warmupEvents ?? 200_000;
  const latencyEvents = o.latencyEvents ?? Math.min(o.events, 500_000);
  const every = Math.max(1, o.latencyEvery ?? 16);
  const path = syntheticPath(warmupEvents + o.events + latencyEvents, o.seed);
  const engine = benchEngine();
  const cursor: Cursor = { t: 0, seq: 0, p: 0, q: SIZE, s: 1, n: 1 };

  feed(engine, path, cursor, 0, warmupEvents);

  const profiler = new GCProfiler();
  const startUsed = getHeapStatistics().used_heap_size;
  profiler.start();
  const t0 = performance.now();
  feed(engine, path, cursor, warmupEvents, warmupEvents + o.events);
  const elapsedMs = performance.now() - t0;
  const endUsed = getHeapStatistics().used_heap_size;
  const gc = profiler.stop();
  const allocBytes = allocatedBytes(startUsed, endUsed, gc.statistics);

  const from = warmupEvents + o.events;
  const samples = new Float64Array(Math.ceil(latencyEvents / every));
  let k = 0;
  for (let i = from; i < from + latencyEvents; i++) {
    cursor.t = path.t[i]!;
    cursor.seq = i;
    cursor.p = path.p[i]!;
    cursor.s = path.s[i]! as Side;
    if ((i - from) % every === 0) {
      const a = performance.now();
      engine.onPrint(cursor);
      samples[k++] = (performance.now() - a) * 1000;
    } else {
      engine.onPrint(cursor);
    }
  }
  engine.finish();
  const lat = samples.subarray(0, k).sort();
  const seconds = elapsedMs / 1000;
  return {
    kind: 'coreLoop', events: o.events, elapsedMs, eventsPerSec: o.events / seconds, allocBytes, allocMBps: allocBytes / 1e6 / seconds,
    gcCount: gc.statistics.length, p50Us: sortedPercentile(lat, 0.5), p99Us: sortedPercentile(lat, 0.99), latencySamples: k, warmupEvents,
    pivots: engine.store.size, levels: engine.book?.snapshot().levels.length ?? 0, trades: engine.exec?.trades().length ?? 0, ...machine(),
  };
}

// End-to-end over stored merged partitions: planReplay + replay of the span
// with its warm-up days (Parquet decode and sha256 checks included).
export async function benchEndToEnd(input: ReplayInput, cfg: RunConfig): Promise<EndToEndResult> {
  const t0 = performance.now();
  const plan = await planReplay(input, cfg);
  const engine = Engine.fromConfig(cfg, input.venue, initialInstrument(plan), { blacklist: plan.blacklist.blacklist, funding: plan.funding });
  await replay(plan, engine);
  const elapsedMs = performance.now() - t0;
  const ok = plan.days.filter((d) => d.status === 'ok');
  const events = ok.reduce((n, d) => n + d.rows, 0);
  return { kind: 'endToEnd', events, days: ok.length, elapsedMs, eventsPerSec: events / (elapsedMs / 1000), ...machine() };
}

export function baselineOf(r: BenchResult, createdAt: string): BenchBaseline {
  return { eventsPerSec: r.eventsPerSec, allocMBps: r.allocMBps, p99Us: r.p99Us, events: r.events, node: r.node, cpu: r.cpu, createdAt };
}

// Throughput vs the baseline: ok ⇔ ratio ≥ BASELINE_MIN_RATIO.
export function compareBaseline(r: Pick<BenchResult, 'eventsPerSec'>, b: Pick<BenchBaseline, 'eventsPerSec'>): { readonly ratio: number; readonly ok: boolean } {
  const ratio = r.eventsPerSec / b.eventsPerSec;
  return { ratio, ok: ratio >= BASELINE_MIN_RATIO };
}
