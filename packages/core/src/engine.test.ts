import { describe, expect, it } from 'vitest';
import { Blacklist } from './blacklist.js';
import { parseRunConfig, type VenueId } from './config.js';
import { canonicalJson, Engine, type EngineObserver } from './engine.js';
import { InvariantViolation } from './invariant.js';
import { LevelBook, type LevelBookConfig } from './level-book.js';
import type { FrozenStats } from './stats.js';
import { fullHarness } from './testing/full-harness.js';
import { LEVEL_CFG } from './testing/level-script.js';
import { RecordingPort } from './testing/recording-port.js';
import { DEFAULT_PIPELINE_CONFIG, ReplayHarness, syntheticPath } from './testing/replay-harness.js';
import type { MergedEvent } from './types.js';
import { FEATURE_COUNT, type StageBModel, stageBScore } from './wickstrength.js';

const EVENTS = 20_000;
const path = syntheticPath(1, { events: EVENTS });

function recordingHarness(blacklist: Blacklist | null = null): ReplayHarness {
  return new ReplayHarness({ blacklist, book: (store, ctx) => new LevelBook(LEVEL_CFG, store, new RecordingPort(), ctx) });
}

describe('Engine input invariants (Spec §3.10, §3.11)', () => {
  const e0: MergedEvent = { t: 1_000, seq: 5, p: 100, q: 1, s: 1, n: 1 };
  it.each([
    ['same (t, seq)', { ...e0 }],
    ['earlier t', { ...e0, t: 999, seq: 6 }],
    ['same t, lower seq', { ...e0, seq: 4 }],
    ['non-integer price', { ...e0, seq: 6, p: 100.5 }],
    ['price beyond int32', { ...e0, seq: 6, p: 2 ** 31 }],
    ['zero size', { ...e0, seq: 6, q: 0 }],
    ['aggressor side 0', { ...e0, seq: 6, s: 0 as never }],
  ])('%s throws InvariantViolation', (_name, e) => {
    const h = new ReplayHarness();
    h.onPrint(e0);
    expect(() => h.onPrint(e)).toThrow(InvariantViolation);
    h.onPrint({ ...e0, t: 1_001 });                    // state untouched by the rejected event
    expect(h.events).toBe(2);
  });
});

describe('Engine counters (Spec §5)', () => {
  it('burstPivots = BurstPivot resolutions; liquidityGuardBuckets = post-warm-up closes with LiquidityGuard', () => {
    let guarded = 0;
    const observer: EngineObserver = { onPrint: () => {}, onBucketClose: (_k, e) => { if (e.stats.frozen.LiquidityGuard) guarded++; } };
    const h = new ReplayHarness({ observers: [observer] });
    h.run(syntheticPath(3, { events: EVENTS, gapRate: 0.002 }));
    const bursts = h.resolutions.filter((r) => r.gate.cls === 'BurstPivot').length;
    expect(bursts).toBeGreaterThan(0);
    expect([h.counters.burstPivots, h.counters.liquidityGuardBuckets]).toEqual([bursts, guarded]);
  });
});

describe('Engine scenario variants on a synthetic path (Spec §8.2, plan item 9)', () => {
  it.each([
    ['targetMode volUnit', { targetMode: 'volUnit' }],
    ['targetMode twoStage', { targetMode: 'twoStage' }],
    ['ageClock wall', { ageClock: 'wall' }],
  ] as const)('%s produces closed trades', (_name, over: Partial<LevelBookConfig>) => {
    const h = fullHarness({ level: over, exec: over.targetMode ? { targetMode: over.targetMode } : {} }).run(path).finish();
    const done = h.exec!.trades().filter((tr) => tr.exit !== null);
    expect(done.length).toBeGreaterThan(0);
    if (over.targetMode === 'twoStage') expect(done.some((tr) => tr.partial !== null)).toBe(true);
  });
});

describe('Engine warm-up (Spec §3.2.4)', () => {
  it('the warm-up span emits no pivots, levels or trades', () => {
    const h = fullHarness();
    let i = 0;
    while (h.warmup) h.onPrint(path[i++]!);
    expect(i).toBeGreaterThan(500);
    expect([h.store.size, h.book!.transitions.length, h.exec!.trades().length, h.counters.totalBuckets]).toEqual([0, 0, 0, 0]);
    h.run(path).finish();
    expect(h.store.size).toBeGreaterThan(0);
    expect(h.exec!.trades().length).toBeGreaterThan(0);
    const warmupEnd = path[i - 1]!.t;
    for (const s of h.store.snapshot()) expect(s.pivot.time).toBeGreaterThanOrEqual(warmupEnd);
  });

  it('the default warm-up (7 UTC days, 1440 buckets, …) does not end on a < 1-day path', () => {
    const e = new Engine({ pipeline: DEFAULT_PIPELINE_CONFIG, PivotMult: 1.2, ringCapacity: 1 << 13 }).run(path);
    expect([e.warmup, e.store.size]).toEqual([true, 0]);
  });
});

describe('Engine L5 (Spec §9.1)', () => {
  it('bucketStatsFrozenMidBucket: the frozen stats object and its hash are constant between closes', () => {
    let closedK = -1;
    let ref: FrozenStats | null = null;
    let hash = '';
    let checks = 0;
    let closes = 0;
    const observer: EngineObserver = {
      onBucketClose(k) { closedK = k; },
      onPrint(_e, engine) {
        const f = engine.stats.frozen;
        if (closedK >= 0) {
          expect(f.k).toBe(closedK);
          closes++;
          closedK = -1;
        } else if (ref !== null) {
          expect(f).toBe(ref);
          expect(canonicalJson(f)).toBe(hash);
          checks++;
        }
        ref = f;
        hash = canonicalJson(f);
      },
    };
    fullHarness({ observers: [observer] }).run(path);
    expect(closes).toBeGreaterThan(100);
    expect(checks).toBeGreaterThan(10 * closes);
  });
});

describe('Blacklist (Spec §2.6.3)', () => {
  it('merges overlapping / touching [start, end) pairs, drops empty ones', () => {
    const bl = new Blacklist([20, 30, 0, 10, 5, 12, 30, 35, 50, 50]);
    expect(bl.intervals()).toEqual([[0, 12], [20, 35]]);
    expect(() => new Blacklist([1, 2, 3])).toThrow(InvariantViolation);
    expect(Blacklist.empty().contains(0)).toBe(false);
  });

  it('contains: half-open bounds with a monotone cursor, and a backward query', () => {
    const bl = new Blacklist([0, 12, 20, 35]);
    expect([-1, 0, 11, 12, 19, 20, 34, 35, 1e9].map((t) => bl.contains(t))).toEqual([false, true, true, false, false, true, true, false, false]);
    expect(bl.contains(5)).toBe(true);
    expect(bl.contains(15)).toBe(false);
  });

  it('overlaps: closed span [a, b] against [start, end)', () => {
    const bl = new Blacklist([0, 12, 20, 35]);
    expect(bl.overlaps(12, 19)).toBe(false);
    expect(bl.overlaps(12, 20)).toBe(true);
    expect(bl.overlaps(-5, 0)).toBe(true);
    expect(bl.overlaps(-5, -1)).toBe(false);
    expect(bl.overlaps(35, 100)).toBe(false);
    expect(bl.overlaps(11, 11)).toBe(true);
    expect(bl.overlaps(-100, 100)).toBe(true);
  });

  it('an interval over a spike ⇒ its pivot is stored Unresolved(blacklist), unscored, and never becomes a level', () => {
    const base = recordingHarness().run(path);
    const level = base.book!.snapshot().levels[0]!;
    const piv = base.store.byId(level.pivotId)!.pivot;
    const h = recordingHarness(new Blacklist([piv.time, piv.time + 1])).run(path);
    const stored = h.store.byId(level.pivotId)!;
    expect(stored.pivot).toEqual(piv);
    expect([stored.cls, stored.note, stored.levelId, stored.ranks]).toEqual(['Unresolved', 'blacklist', -1, null]);
    expect(h.book!.snapshot().levels.some((l) => l.pivotId === level.pivotId)).toBe(false);
    const events = h.resolutions.filter((r) => r.pivot.pivotId === level.pivotId);
    expect(events.length).toBeGreaterThan(0);
    for (const r of events) expect([r.gate.cls, r.ranks, Number.isNaN(r.WickStrength_0)]).toEqual(['Unresolved', null, true]);
  });

  // MaxSpikeDuration 1 and a wide band: many early-G2 SlowExtremes (Spec §3.5.1, A-13).
  const slowHarness = (blacklist: Blacklist | null = null): ReplayHarness => new ReplayHarness({
    blacklist, cfg: { ...DEFAULT_PIPELINE_CONFIG, MaxSpikeDuration: 1, UnitWindow: 30, BandWidthMult: 0.8 }, PivotMult: 0.8,
  }).run(path);

  it('rule 2 for an early-G2 SlowExtreme: [EnterTime, verdict] overlapping an interval ⇒ Unresolved(blacklist) at the verdict (A-86)', () => {
    const r = slowHarness().resolutions.find((x) => x.phase === 'classified')!;
    expect([r.gate.cls, r.EnterTime < r.pivot.time]).toEqual(['SlowExtreme', true]);
    const h = slowHarness(new Blacklist([r.EnterTime, r.EnterTime + 1]));
    const stored = h.store.byId(r.pivot.pivotId)!;
    expect([stored.cls, stored.note, stored.classifiedAt]).toEqual(['Unresolved', 'blacklist', r.gate.classifiedAt]);
    for (const x of h.resolutions.filter((y) => y.pivot.pivotId === r.pivot.pivotId)) expect([x.gate.cls, x.ranks]).toEqual(['Unresolved', null]);
  });

  it('rule 2 after an early-G2 verdict: the class stays SlowExtreme (no look-ahead), the row is unranked with note blacklist (A-86)', () => {
    const base = slowHarness();
    const r = base.resolutions.find((x) => x.phase === 'classified' &&
      base.resolutions.some((y) => y.pivot.pivotId === x.pivot.pivotId && y.phase === 'featuresFinal' && y.resolvedAt > x.resolvedAt + 1))!;
    const h = slowHarness(new Blacklist([r.resolvedAt + 1, r.resolvedAt + 2]));
    const stored = h.store.byId(r.pivot.pivotId)!;
    expect([stored.cls, stored.note, stored.ranks, stored.classifiedAt]).toEqual(['SlowExtreme', 'blacklist', null, r.gate.classifiedAt]);
  });

  it('arming inside an interval is suppressed with reason blacklist', () => {
    const base = recordingHarness().run(path);
    const arm = base.book!.transitions.find((r) => r.reason === 'arm')!;
    const h = recordingHarness(new Blacklist([arm.t, arm.t + 1])).run(path);
    expect(h.book!.byId(arm.levelId)!.pivotId).toBe(base.book!.byId(arm.levelId)!.pivotId);
    expect(h.book!.transitions.some((r) => r.levelId === arm.levelId && r.reason === 'arm' && r.t === arm.t)).toBe(false);
    expect(h.book!.counters['bound.blacklist']).toBeGreaterThanOrEqual(1);
  });

  it('counts blacklisted buckets out of the post-warm-up total', () => {
    const t0 = path[0]!.t;
    const h = recordingHarness(new Blacklist([t0 + 3 * 3_600_000, t0 + 4 * 3_600_000])).run(path);
    expect(h.counters.blacklistedBuckets).toBeGreaterThan(0);
    expect(h.counters.blacklistedBuckets).toBeLessThan(h.counters.totalBuckets);
  });
});

describe('Engine TradeRing underflow (Spec §3.1)', () => {
  it('a ring holding < 2·UnitWindow completed buckets grows and counts ringUnderflow', () => {
    const h = new ReplayHarness({ ringCapacity: 1 << 10 }).run(path);
    expect(h.counters.ringUnderflow).toBeGreaterThan(0);
    expect(h.ring.capacity).toBeGreaterThan(1 << 10);
    expect(h.ring.completedBucketsHeld(h.builder.completedCount)).toBeGreaterThanOrEqual(2 * h.cfg.UnitWindow);
    expect(h.store.size).toBeGreaterThan(0);
    expect(new ReplayHarness({ ringCapacity: 1 << 16 }).run(path).counters.ringUnderflow).toBe(0);
  });
});

describe('Engine TradeRing capacity from the warm-up day (Spec §3.1)', () => {
  // One print per second, q = 1: BucketVolume_0 = 60, median event size 1. With UnitWindow 4 000
  // capacityFor = 2·ceil(2·4 000·60 / 1) = 0.96 M → 2^21 (floor); with 10 000 → 2.4 M → 2^22.
  const day: MergedEvent[] = [];
  const t0 = Date.UTC(2025, 0, 1);
  for (let i = 0; i <= 86_400; i++) day.push({ t: t0 + 1000 * i, seq: i, p: 100_000 + (i % 7), q: 1, s: i % 2 === 0 ? 1 : -1, n: 1 });

  it.each([[4_000, 2 ** 21], [10_000, 2 ** 22]])('UnitWindow %i ⇒ capacity %i from the first print of day 2; a fixed ringCapacity is kept', (UnitWindow, capacity) => {
    const e = new Engine({ pipeline: { ...DEFAULT_PIPELINE_CONFIG, UnitWindow }, PivotMult: 1.2 });
    e.run(day, day.length - 1);
    expect(e.ring.capacity).toBe(2 ** 21);
    e.run(day);
    expect([e.builder.BucketVolume_next, e.ring.capacity, e.counters.ringUnderflow]).toEqual([60, capacity, 0]);
    const fixed = new Engine({ pipeline: { ...DEFAULT_PIPELINE_CONFIG, UnitWindow }, PivotMult: 1.2, ringCapacity: 1 << 13 }).run(day);
    expect(fixed.ring.capacity).toBe(1 << 13);
  });
});

describe('Engine.resetOnTickChange (Spec §3.11)', () => {
  it('live levels → INVALIDATED(tickChange), the open trade closes, warm-up restarts, history is kept', () => {
    const long = syntheticPath(1, { events: 50_000 });   // leaves room for a second warm-up
    const h = fullHarness();
    let i = 0;
    while (h.book!.openTrade() === null || h.exec!.trades().at(-1)!.entry === null) h.onPrint(long[i++]!);
    const live = [...h.book!.live(1), ...h.book!.live(-1)].map((l) => l.levelId);
    expect(live.length).toBeGreaterThan(0);
    const storeSize = h.store.size;
    const transitions = [...h.book!.transitions];
    const pivotsBefore = h.store.snapshot().map((s) => s.pivot.pivotId);

    h.resetOnTickChange({ Tick: 0.5, LotSize: 1 });
    expect([h.book!.live(1).length, h.book!.live(-1).length, h.book!.openTrade(), h.exec!.flat()]).toEqual([0, 0, null, true]);
    for (const id of live) expect(h.book!.byId(id)!.stateReason).toBe('tickChange');
    const trade = h.exec!.trades().at(-1)!;
    expect([trade.exitKind, trade.exit !== null]).toEqual(['tickChange', true]);
    expect([h.warmup, h.warmupEvents, h.counters.tickChanges]).toEqual([true, 0, 1]);
    expect(h.store.size).toBe(storeSize);
    expect(h.book!.transitions.slice(0, transitions.length)).toEqual(transitions);

    // The rest of the path in the new tick unit (half the old tick).
    const rest = long.slice(i).map((e) => ({ ...e, p: 2 * e.p }));
    for (const e of rest) h.onPrint(e);
    h.finish();
    expect(h.warmup).toBe(false);
    const after = h.store.snapshot().filter((s) => !pivotsBefore.includes(s.pivot.pivotId));
    expect(after.length).toBeGreaterThan(0);
    for (const s of after) expect(s.pivot.time).toBeGreaterThan(long[i - 1]!.t);
  });
});

describe('Engine observers (Spec §3.10 steps 10–11)', () => {
  it('are called once per post-warm-up print, after LevelBook, and on post-warm-up closes', () => {
    class CountingBook extends LevelBook {
      prints = 0;
      override onPrint(e: MergedEvent): void { super.onPrint(e); this.prints++; }
    }
    let book: CountingBook | null = null;
    let prints = 0;
    let closes = 0;
    const observer: EngineObserver = {
      onPrint(e, engine) {
        prints++;
        expect(book!.prints).toBe(prints);
        expect([engine.warmup, engine.lastSeq]).toEqual([false, e.seq]);
      },
      onBucketClose(_k, engine) { closes++; expect(engine.warmup).toBe(false); },
    };
    const h = new ReplayHarness({ observers: [observer], book: (store, ctx) => (book = new CountingBook(LEVEL_CFG, store, new RecordingPort(), ctx)) });
    let warmupPrints = 0;
    for (const e of path) {
      h.onPrint(e);
      if (h.warmup) warmupPrints++;                    // the print ending warm-up runs steps 5–11
    }
    expect(prints).toBe(EVENTS - warmupPrints);
    expect(closes).toBe(h.counters.totalBuckets);
  });
});

describe('Engine.fromConfig', () => {
  const fee = { TakerFee: 0.0004, MakerFee: 0.0002, verifiedAt: '2026-01-01' };
  const input = {
    fees: { binance: fee, bybit: fee, okx: fee, bitget: fee, gate: fee, kucoin: fee }, data: { lowCapSymbol: 'DOGEUSDT' },
  };
  const venue = Object.keys(input.fees)[0] as VenueId;
  const shortWarmup = (e: Engine): boolean => e.builder.completedCount >= e.cfg.UnitWindow && e.warmupEvents >= 500;

  it('wires pipeline, LevelBook and ExecutionModel from a RunConfig and runs a synthetic path', () => {
    const cfg = parseRunConfig(input);
    const e = Engine.fromConfig(cfg, venue, { Tick: 0.01, LotSize: 0.001 }, { warmupDone: shortWarmup, ringCapacity: 1 << 13, MinStrength: 0.3 });
    e.run(path).finish();
    expect(e.warmup).toBe(false);
    expect(e.store.size).toBeGreaterThan(0);
    expect(e.book!.transitions.length).toBeGreaterThan(0);
    expect(e.snapshot().book!.MinStrength).toBe(0.3);
    e.setMinStrength(0.5);
    expect(e.snapshot().book!.MinStrength).toBe(0.5);
    expect(e.snapshotHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('test switches (Spec §11.3) reach LevelBook and ExecutionModel; off by default', () => {
    const cfg = parseRunConfig(input);
    const inst = { Tick: 0.01, LotSize: 0.001 };
    const levelCfg = (e: Engine): unknown => (e.book as unknown as { cfg: { targetOnTouch: boolean } }).cfg.targetOnTouch;
    const off = Engine.fromConfig(cfg, venue, inst);
    const on = Engine.fromConfig(cfg, venue, inst, { test: { targetOnTouch: true, zeroCosts: true } });
    expect([levelCfg(off), levelCfg(on)]).toEqual([false, true]);
    expect(off.exec!.roundTripCostTicks(100_000)).toBeGreaterThan(0);
    expect(on.exec!.roundTripCostTicks(100_000)).toBe(0);
  });

  it('the §11.3 gate values (0, ∞, −1, 0, ∞) flow through the pipeline: no early-G2 verdict, no gate but G1 fails', () => {
    const cfg = {
      ...parseRunConfig(input), MinSpikeSize: 0, MaxSpikeDuration: Infinity, MinRejectSpeed: 0, MinRejectImbalance: -1,
      MinRetrace: 0, MaxTopDwell: Infinity,
    };
    const e = Engine.fromConfig(cfg, venue, { Tick: 0.01, LotSize: 0.001 }, {
      warmupDone: shortWarmup, ringCapacity: 1 << 13, MinStrength: -Infinity, test: { zeroCosts: true },
    });
    e.run(path).finish();
    const rows = e.store.snapshot();
    expect(rows.filter((r) => r.cls === 'WickLevel').length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.failed.filter((id) => id !== 'G1')).toEqual([]);
      if (r.cls === 'SlowExtreme' && r.featuresAvailable) expect(r.features!.SpikeSize).toBeLessThan(0);
    }
    // MinStrength −∞ reaches sizing with g = 1 (not ∞/∞ = NaN, which would pass
    // the minQty check); the < 1-day path keeps Vol100ms at 1 lot ⇒ minQty.
    expect(e.exec!.counters.capMinQty).toBeGreaterThan(0);
    for (const tr of e.exec!.trades()) expect(Number.isInteger(tr.Qty) && tr.Qty >= 1).toBe(true);
  });

  it('minExtremePrintQtyPct feeds eventSizeP10 to Zigzag (a different pivot set)', () => {
    // Every 13th print is 1 lot (< 10 % of the sampled sizes), the rest ≥ 5: eventSizeP10 = 5 locks them out of LegExtreme.
    const sized = path.map((e) => ({ ...e, q: e.seq % 13 === 0 ? 1 : 5 * e.q }));
    const run = (x: unknown): Engine =>
      Engine.fromConfig(parseRunConfig({ ...input, minExtremePrintQtyPct: x }), venue, { Tick: 0.01, LotSize: 0.001 }, { warmupDone: shortWarmup, ringCapacity: 1 << 13 }).run(sized);
    const off = run(false).store.snapshot().map((s) => s.pivot);
    const on = run(0.1).store.snapshot().map((s) => s.pivot);
    expect(on.length).toBeGreaterThan(0);
    expect(on).not.toEqual(off);
  });

  it('foldSchedule (Spec §6.3): MinStrength and the Stage B model switch on the first print with t ≥ at', () => {
    const cfg = { ...parseRunConfig(input), strengthModel: 'stageB' as const };
    const beta = new Float64Array(FEATURE_COUNT).map((_, j) => (j % 3) - 1);
    const model: StageBModel = {
      foldId: 1, beta0: 0.2, beta, lambda: 1, ipwModel: { gamma0: 0, gamma: new Float64Array(FEATURE_COUNT) }, minStrengthQuantile: 0.6,
      calibration: [],
    };
    const at = path[Math.floor(EVENTS * 0.85)]!.t + 1;
    const e = Engine.fromConfig(cfg, venue, { Tick: 0.01, LotSize: 0.001 }, {
      warmupDone: shortWarmup, ringCapacity: 1 << 13,
      foldSchedule: [{ at: -Infinity, MinStrength: 0.1, stageB: null }, { at, MinStrength: 0.6, stageB: model }],
    });
    expect(e.foldIndex).toBe(-1);
    for (const ev of path) {
      e.onPrint(ev);
      expect(e.foldIndex).toBe(ev.t >= at ? 1 : 0);
      if (ev.t < at) expect(e.snapshot().book!.MinStrength).toBe(0.1);
      else break;
    }
    expect(e.snapshot().book!.MinStrength).toBe(0.6);
    expect(e.snapshot().foldIndex).toBe(1);
    e.run(path).finish();
    const ranked = e.store.snapshot().filter((r) => r.ranks !== null);
    const before = ranked.filter((r) => r.classifiedAt < at - 1);
    const after = ranked.filter((r) => r.classifiedAt >= at);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    for (const r of before) expect(r.WickStrength_B).toBeNaN();
    for (const r of after) expect(r.WickStrength_B).toBe(stageBScore(model, r.ranks!));
    for (const l of e.book!.snapshot().levels) expect(Object.is(l.WickStrength, l.WickStrength_B)).toBe(true);
  });
});
