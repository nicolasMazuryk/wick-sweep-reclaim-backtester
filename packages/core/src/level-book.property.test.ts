import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LevelBook, type LevelContext } from './level-book.js';
import { ALLOWED_TRANSITIONS, type Level, transitionKey } from './level.js';
import type { ScoredResolution } from './pivot-pipeline.js';
import { PivotStore } from './pivot-store.js';
import type { FrozenStats } from './stats.js';
import { LEVEL_CFG } from './testing/level-script.js';
import { RecordingPort } from './testing/recording-port.js';
import { ReplayHarness, syntheticPath } from './testing/replay-harness.js';
import type { MergedEvent, Pivot, Side } from './types.js';

const EVENTS = 20_000;

interface CtxView { t: number; seq: number; Vol: number; BucketVolume: number; frozen: FrozenStats }
type TapeEntry =
  | { kind: 'close'; k: number; ctx: CtxView }
  | { kind: 'pivot'; piv: Pivot; ctx: CtxView }
  | { kind: 'resolved'; r: ScoredResolution; ctx: CtxView }
  | { kind: 'print'; e: MergedEvent; ctx: CtxView };

// Records every LevelBook input with the context it was read under, and the
// answers of the pipeline's rejectSpeedOf (pending-pivot state is not on the tape).
class TapingLevelBook extends LevelBook {
  readonly tape: TapeEntry[] = [];
  readonly rejectSpeeds: number[];
  maxOpen = 0;
  constructor(store: PivotStore, private readonly view: LevelContext, readonly port = new RecordingPort()) {
    const answers: number[] = [];
    const taped: LevelContext = Object.create(view, {
      rejectSpeedOf: { value: (id: number): number => { const x = view.rejectSpeedOf!(id); answers.push(x); return x; } },
    });
    super(LEVEL_CFG, store, port, taped);
    this.rejectSpeeds = answers;
  }
  private get snap(): CtxView {
    const v = this.view;
    return { t: v.t, seq: v.seq, Vol: v.Vol, BucketVolume: v.BucketVolume, frozen: v.frozen };
  }
  override onBucketClose(k: number): void { this.tape.push({ kind: 'close', k, ctx: this.snap }); super.onBucketClose(k); }
  override onPivot(piv: Pivot): boolean { this.tape.push({ kind: 'pivot', piv, ctx: this.snap }); return super.onPivot(piv); }
  override onPendingResolved(r: ScoredResolution): Level | null {
    this.tape.push({ kind: 'resolved', r, ctx: this.snap });
    return super.onPendingResolved(r);
  }
  override onPrint(e: MergedEvent): void {
    this.tape.push({ kind: 'print', e, ctx: this.snap });
    super.onPrint(e);
    const open = [...this.live(1), ...this.live(-1)].filter((l) => l.State === 'IN_TRADE').length;
    this.maxOpen = Math.max(this.maxOpen, open);
  }
}

function record(seed: number): { h: ReplayHarness; book: TapingLevelBook } {
  let book: TapingLevelBook | null = null;
  const h = new ReplayHarness({ book: (store, ctx) => (book = new TapingLevelBook(store, ctx)) });
  h.run(syntheticPath(seed, { events: EVENTS }));
  return { h, book: book! };
}

const mirrorSide = (s: Side): Side => (-s as Side);
function mirrorPivot(piv: Pivot, c: number): Pivot {
  return { ...piv, kind: piv.kind === 'PivotHigh' ? 'PivotLow' : 'PivotHigh', side: mirrorSide(piv.side), price: 2 * c - piv.price };
}

// Replays a tape into a fresh LevelBook, optionally mirrored p → 2c − p,
// s → −s, TrendSign → −TrendSign; pivots are stored as the pipeline would.
function replay(tape: ReadonlyArray<TapeEntry>, c: number | null, rejectSpeeds: ReadonlyArray<number>): { book: LevelBook; port: RecordingPort } {
  let answer = 0;
  const ctx = {
    t: 0, seq: 0, Vol: 0, BucketVolume: 1, frozen: null as unknown as FrozenStats, inBlacklist: false, killSwitchActive: false,
    rejectSpeedOf: (): number => rejectSpeeds[answer++]!,
  };
  const store = new PivotStore();
  const port = new RecordingPort();
  const book = new LevelBook(LEVEL_CFG, store, port, ctx);
  for (const x of tape) {
    Object.assign(ctx, x.ctx);
    if (c !== null) ctx.frozen = { ...x.ctx.frozen, TrendSign: -x.ctx.frozen.TrendSign + 0 };
    switch (x.kind) {
      case 'close': book.onBucketClose(x.k); break;
      case 'pivot': book.onPivot(c === null ? x.piv : mirrorPivot(x.piv, c)); break;
      case 'resolved': {
        const r = c === null ? x.r : { ...x.r, pivot: mirrorPivot(x.r.pivot, c) };
        if (r.phase !== 'featuresFinal') store.add(r.pivot, r.features, r.gate, r.ranks, r.WickStrength_0, r.WickStrength_B, -1, r.note, r.VolUnit_created, r.resolvedVol);
        book.onPendingResolved(r);
        break;
      }
      case 'print': book.onPrint(c === null ? x.e : { ...x.e, p: 2 * c - x.e.p, s: mirrorSide(x.e.s) }); break;
    }
  }
  return { book, port };
}

function mirroredLevel(l: Level, c: number): Level {
  const m = (p: number): number => (p === -1 ? -1 : 2 * c - p);
  return {
    ...l, Side: mirrorSide(l.Side), WickLevel: m(l.WickLevel), SweepExtreme: m(l.SweepExtreme), SweepRunningMax: m(l.SweepRunningMax),
    StopLoss: m(l.StopLoss), Target: m(l.Target), returnSq: -l.returnSq + 0,
    regimeAtArm: l.regimeAtArm && { ...l.regimeAtArm, TrendSign: -l.regimeAtArm.TrendSign + 0 },
  };
}

describe('LevelBook on synthetic replays (Spec §3.12, §11.2)', () => {
  it('attached to the harness, a replay produces setups through to closed trades', () => {
    const { book } = record(1);
    const reasons = new Set(book.transitions.map((r) => transitionKey(r.from, r.to, r.reason)));
    for (const key of ['PIVOT_PENDING → WICK_ACTIVE (register)', 'SWEEPING → SWEEP_CONFIRMED (confirm)', 'SWEEP_CONFIRMED → ORDER_ARMED (arm)',
      'ORDER_ARMED → IN_TRADE (trigger)', 'WICK_ACTIVE → WICK_ACTIVE (merge)']) {
      expect(reasons.has(key), key).toBe(true);
    }
  });

  it('property: side symmetry — the mirrored input tape gives the identical transition log with mirrored levels and orders', () => {
    // Paths start at 100 000 ticks: c keeps mirrored prices positive (−1 is the Ticks sentinel).
    fc.assert(fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), fc.integer({ min: 100_000, max: 200_000 }), (seed, c) => {
      const { book } = record(seed);
      const upright = replay(book.tape, null, book.rejectSpeeds);
      expect(upright.book.snapshot()).toEqual(book.snapshot());
      const mirrored = replay(book.tape, c, book.rejectSpeeds);
      const a = upright.book.snapshot();
      const b = mirrored.book.snapshot();
      expect(b.transitions).toEqual(a.transitions);
      expect(b.counters).toEqual(a.counters);
      expect(b.levels.map((l) => mirroredLevel(l, c))).toEqual(a.levels);
      expect(mirrored.port.calls.map((x) => ({ ...x, price: x.price === -1 ? -1 : 2 * c - x.price }))).toEqual(upright.port.calls);
    }), { seed: 11, numRuns: 60 });
  });

  it('property: stateMachineClosed / onePositionPerSymbol — every transition is a table row, chained per level; ≤ 1 open trade on every print', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
      const { h, book } = record(seed);
      const last = new Map<number, string>();
      for (const r of book.transitions) {
        expect(ALLOWED_TRANSITIONS.has(transitionKey(r.from, r.to, r.reason))).toBe(true);
        expect(r.from).toBe(last.get(r.levelId) ?? 'PIVOT_PENDING');
        last.set(r.levelId, r.to);
      }
      expect(book.maxOpen).toBeLessThanOrEqual(1);
      // Entries and exits alternate: never two open trades.
      let open = 0;
      for (const call of book.port.calls) {
        if (call.kind === 'enter') open++;
        if (call.kind === 'exit') open--;
        expect(open === 0 || open === 1).toBe(true);
      }
      // Every terminal state is written back to the PivotStore (§9.5 survivorship).
      for (const l of book.snapshot().levels) {
        const stored = h.store.byId(l.pivotId)!;
        expect([stored.cls, stored.levelId]).toEqual(['WickLevel', l.levelId]);
        if (['INVALIDATED', 'EXPIRED', 'CANCELLED', 'RETIRED'].includes(l.State)) {
          expect([stored.finalState, stored.reason, l.OrderIds.entry]).toEqual([l.State, l.stateReason, -1]);
        }
      }
    }), { seed: 13, numRuns: 60 });
  });

  it('property: sweepExtremeCausal (L4) / truncation — a prefix replay equals the full replay at every cut', () => {
    const pathArb = fc.record({
      seed: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
      cuts: fc.array(fc.integer({ min: 1, max: EVENTS }), { minLength: 1, maxLength: 6 }),
    });
    const make = (): ReplayHarness => new ReplayHarness({ book: (store, ctx) => new LevelBook(LEVEL_CFG, store, new RecordingPort(), ctx) });
    fc.assert(fc.property(pathArb, ({ seed, cuts }) => {
      const events = syntheticPath(seed, { events: EVENTS });
      const full = make();
      for (const cut of [...new Set(cuts)].sort((a, b) => a - b)) {
        full.run(events, cut);
        const prefix = make().run(events.slice(0, cut));
        expect(prefix.snapshot()).toEqual(full.snapshot());
        // L4: a SweepExtreme is only ever a price already printed, fixed after its print.
        for (const l of prefix.book!.snapshot().levels) {
          if (l.SweepExtreme !== -1) expect(events.slice(0, cut).some((e) => e.p === l.SweepExtreme)).toBe(true);
        }
      }
    }), { seed: 42, numRuns: 60 });
  });

  it('property: sweepExtremeCausal (L4) — every confirm is strictly after the print that set SweepRunningMax, and fixes S = R', () => {
    // (t, seq) of the last print that moved each level's SweepRunningMax.
    class RTimedLevelBook extends LevelBook {
      readonly rAt = new Map<number, [number, number]>();
      confirms = 0;
      override onPrint(e: MergedEvent): void {
        const before = new Map<number, number>();
        for (const side of [1, -1] as const) for (const l of this.live(side)) before.set(l.levelId, l.SweepRunningMax);
        const n = this.transitions.length;
        super.onPrint(e);
        for (const side of [1, -1] as const) {
          for (const l of this.live(side)) {
            if (l.SweepRunningMax !== -1 && l.SweepRunningMax !== before.get(l.levelId)) this.rAt.set(l.levelId, [e.t, e.seq]);
          }
        }
        for (const r of this.transitions.slice(n)) {
          if (r.reason !== 'confirm' && r.reason !== 'reconfirm') continue;
          this.confirms++;
          const [t, seq] = this.rAt.get(r.levelId)!;
          expect(r.t > t || (r.t === t && r.seq > seq), `level ${r.levelId} confirmed at the R print`).toBe(true);
          const l = this.byId(r.levelId)!;
          expect(l.SweepExtreme).toBe(l.SweepRunningMax);
        }
      }
    }
    let confirms = 0;
    fc.assert(fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
      let book: RTimedLevelBook | null = null;
      new ReplayHarness({ book: (store, ctx) => (book = new RTimedLevelBook(LEVEL_CFG, store, new RecordingPort(), ctx)) })
        .run(syntheticPath(seed, { events: EVENTS }));
      confirms += book!.confirms;
    }), { seed: 17, numRuns: 20 });
    expect(confirms).toBeGreaterThan(0);                   // the property is not vacuous
  });
});
