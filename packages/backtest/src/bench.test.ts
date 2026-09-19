import { describe, expect, it } from 'vitest';
import { baselineOf, benchCoreLoop, compareBaseline } from './bench.js';

describe('wsr bench core loop (Spec §10)', () => {
  it('times the synthetic path and reports throughput, allocation, latency and engine counts', () => {
    const r = benchCoreLoop({ events: 60_000, seed: 1, warmupEvents: 40_000, latencyEvents: 20_000, latencyEvery: 10 });
    expect(r.events).toBe(60_000);
    expect(r.eventsPerSec).toBeGreaterThan(0);
    expect(r.allocMBps).toBeGreaterThanOrEqual(0);
    expect(r.latencySamples).toBe(2000);
    expect(r.p99Us).toBeGreaterThanOrEqual(r.p50Us);
    expect(r.pivots).toBeGreaterThan(0);
    expect(r.levels).toBeGreaterThan(0);
    expect(r.trades).toBeGreaterThan(0);
  }, 30_000);

  it('the same seed gives the same engine counts', () => {
    const o = { events: 30_000, seed: 7, warmupEvents: 20_000, latencyEvents: 5_000 };
    const a = benchCoreLoop(o);
    const b = benchCoreLoop(o);
    expect([b.pivots, b.levels, b.trades]).toEqual([a.pivots, a.levels, a.trades]);
  }, 30_000);

  it('baseline: throughput below 80 % is a regression', () => {
    expect(compareBaseline({ eventsPerSec: 79 }, { eventsPerSec: 100 }).ok).toBe(false);
    expect(compareBaseline({ eventsPerSec: 80 }, { eventsPerSec: 100 })).toEqual({ ratio: 0.8, ok: true });
    const r = benchCoreLoop({ events: 1000, seed: 1, warmupEvents: 1000, latencyEvents: 100 });
    expect(baselineOf(r, 't')).toEqual({ eventsPerSec: r.eventsPerSec, allocMBps: r.allocMBps, p99Us: r.p99Us, events: 1000, node: r.node, cpu: r.cpu, createdAt: 't' });
  });
});
