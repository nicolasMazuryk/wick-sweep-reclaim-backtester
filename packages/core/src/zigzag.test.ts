import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Pivot } from './types.js';
import { Zigzag } from './zigzag.js';

// Literal port of strategy.md Appendix A `Zigzag` (differential reference).
type RefPivot = [kind: 'high' | 'low', price: number, time: number, confirmedAt: number];
class RefZigzag {
  LegDir: 'up' | 'down' | null = null;
  LegExtreme = NaN;
  LegExtremeTime = NaN;
  update(t: number, p: number, pivotReversal: number): RefPivot | null {
    if (this.LegDir === null) {
      this.LegDir = 'up'; this.LegExtreme = p; this.LegExtremeTime = t; return null;
    }
    if (this.LegDir === 'up') {
      if (p > this.LegExtreme) { this.LegExtreme = p; this.LegExtremeTime = t; }
      else if (p <= this.LegExtreme - pivotReversal) {
        const piv: RefPivot = ['high', this.LegExtreme, this.LegExtremeTime, t];
        this.LegDir = 'down'; this.LegExtreme = p; this.LegExtremeTime = t; return piv;
      }
    } else {
      if (p < this.LegExtreme) { this.LegExtreme = p; this.LegExtremeTime = t; }
      else if (p >= this.LegExtreme + pivotReversal) {
        const piv: RefPivot = ['low', this.LegExtreme, this.LegExtremeTime, t];
        this.LegDir = 'up'; this.LegExtreme = p; this.LegExtremeTime = t; return piv;
      }
    }
    return null;
  }
}

interface Print { t: number; seq: number; p: number; q: number; Vol: number; PivotReversal: number }

// Random walk with random dt, random sizes and a piecewise-constant PivotReversal
// that may change mid-leg (as at a bucket close).
const pathArb = fc
  .record({
    p0: fc.integer({ min: 1000, max: 100_000 }),
    pr0: fc.integer({ min: 1, max: 30 }),
    steps: fc.array(
      fc.record({
        dp: fc.integer({ min: -12, max: 12 }),
        dt: fc.integer({ min: 0, max: 5_000 }),
        q: fc.integer({ min: 1, max: 20 }),
        pr: fc.option(fc.integer({ min: 1, max: 30 }), { freq: 20 }),
      }),
      { minLength: 1, maxLength: 600 },
    ),
  })
  .map(({ p0, pr0, steps }) => {
    const out: Print[] = [];
    let t = 1_700_000_000_000, p = p0, Vol = 0, pr = pr0;
    steps.forEach((s, seq) => {
      t += s.dt; p += s.dp; Vol += s.q;
      if (s.pr !== null) pr = s.pr;
      out.push({ t, seq, p, q: s.q, Vol, PivotReversal: pr });
    });
    return out;
  });

function run(prints: readonly Print[], z = new Zigzag()): (Pivot | null)[] {
  return prints.map((e) => z.update(e.t, e.seq, e.p, e.q, e.Vol, e.PivotReversal));
}

function pivotsOf(prints: readonly Print[]): Pivot[] {
  return run(prints).filter((x): x is Pivot => x !== null);
}

// Builds prints from prices with t = 1000·i, q = 1, fixed PivotReversal.
function prints(prices: number[], PivotReversal = 10): Print[] {
  return prices.map((p, i) => ({ t: 1000 * i, seq: i, p, q: 1, Vol: i + 1, PivotReversal }));
}

describe('Zigzag (Spec §3.4)', () => {
  it('property: matches Appendix A reference on random paths', () => {
    fc.assert(
      fc.property(pathArb, (path) => {
        const ref = new RefZigzag();
        const expected = path.map((e) => ref.update(e.t, e.p, e.PivotReversal));
        const actual = run(path).map((x): RefPivot | null =>
          x === null ? null : [x.kind === 'PivotHigh' ? 'high' : 'low', x.price, x.time, x.confirmed_at]);
        expect(actual).toEqual(expected);
      }),
      { numRuns: 300 },
    );
  });

  it('first print initialises and returns null', () => {
    const z = new Zigzag();
    expect(z.initialized).toBe(false);
    expect(z.update(0, 0, 100, 1, 1, 10)).toBeNull();
    expect(z.initialized).toBe(true);
  });

  it('init starts an up leg without emitting', () => {
    const z = new Zigzag();
    z.init(0, 0, 100, 1);
    expect(z.initialized).toBe(true);
    expect(z.update(1, 1, 90, 1, 2, 10)?.kind).toBe('PivotHigh');
  });

  it('exact threshold triggers, one tick short does not', () => {
    expect(pivotsOf(prints([100, 91]))).toHaveLength(0);
    const [piv] = pivotsOf(prints([100, 90]));
    expect(piv).toMatchObject({ kind: 'PivotHigh', side: 1, price: 100 });
    // down leg: symmetric at +PivotReversal
    expect(pivotsOf(prints([100, 90, 99]))).toHaveLength(1);
    expect(pivotsOf(prints([100, 90, 100]))[1]).toMatchObject({ kind: 'PivotLow', side: -1, price: 90 });
  });

  it('equal-price retest keeps the first extreme time and seq', () => {
    const [piv] = pivotsOf(prints([100, 105, 103, 105, 95]));
    expect(piv).toMatchObject({ price: 105, time: 1000, seq: 1 });
  });

  it('pivot carries extreme and confirmation fields', () => {
    const path = prints([100, 110, 105, 101, 100, 111]);
    const pivs = pivotsOf(path);
    expect(pivs).toEqual([
      { kind: 'PivotHigh', side: 1, price: 110, time: 1000, seq: 1, confirmed_at: 4000, confirmedSeq: 4, confirmedVol: 5, pivotId: 0 },
      { kind: 'PivotLow', side: -1, price: 100, time: 4000, seq: 4, confirmed_at: 5000, confirmedSeq: 5, confirmedVol: 6, pivotId: 1 },
    ]);
  });

  it('huge alternating swings emit exactly one pivot per print', () => {
    const prices = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 1000 : 0));
    const out = run(prints(prices));
    expect(out[0]).toBeNull();
    // print 1 confirms the high at 1000; every later print confirms the previous extreme
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toMatchObject({ kind: i % 2 === 1 ? 'PivotHigh' : 'PivotLow', pivotId: i - 1, time: 1000 * (i - 1) });
    }
  });

  it('PivotReversal shrink mid-leg triggers earlier, growth delays', () => {
    const base = prints([100, 110, 104, 103, 100]);
    expect(pivotsOf(base)[0]?.confirmed_at).toBe(4000);
    const shrunk = base.map((e, i) => (i >= 2 ? { ...e, PivotReversal: 6 } : e));
    expect(pivotsOf(shrunk)[0]?.confirmed_at).toBe(2000);
    const grown = base.map((e, i) => (i >= 2 ? { ...e, PivotReversal: 11 } : e));
    expect(pivotsOf(grown)).toHaveLength(0);
  });

  it('minExtremeQty: small prints beyond the extreme do not move it', () => {
    const z = new Zigzag();
    z.update(0, 0, 100, 5, 5, 10, 3);
    expect(z.update(1, 1, 150, 1, 6, 10, 3)).toBeNull();          // one-lot outlier ignored
    expect(z.update(2, 2, 102, 3, 9, 10, 3)).toBeNull();          // extreme → 102 (q = threshold)
    const piv = z.update(3, 3, 92, 1, 10, 10, 3);                 // flip print may be small
    expect(piv).toMatchObject({ kind: 'PivotHigh', price: 102, time: 2, seq: 2 });
    // the flip print sets the down-leg extreme regardless of q
    expect(z.update(4, 4, 102, 1, 11, 10, 3)).toMatchObject({ kind: 'PivotLow', price: 92, time: 3 });
  });

  it('reset returns to uninitialised; pivotId stays monotone', () => {
    const z = new Zigzag();
    run(prints([100, 90]), z);
    z.reset();
    expect(z.initialized).toBe(false);
    expect(z.update(0, 0, 500, 1, 1, 10)).toBeNull();
    expect(z.update(1, 1, 490, 1, 2, 10)).toMatchObject({ kind: 'PivotHigh', price: 500, pivotId: 1 });
  });

  // Spec §3.12. Init is always `up`, so the first leg is asymmetric; once both
  // runs flip on the same print into mirrored legs, every later pivot mirrors.
  it('property: mirror symmetry', () => {
    let synced = 0;
    fc.assert(
      fc.property(pathArb, fc.integer({ min: 0, max: 200_000 }), (path, c) => {
        const mirrored = path.map((e) => ({ ...e, p: 2 * c - e.p }));
        const a = run(path);
        const b = run(mirrored);
        const i = a.findIndex((x, j) => x !== null && b[j] !== null && b[j]!.kind !== x.kind);
        if (i < 0) return;
        synced++;
        for (let j = i + 1; j < a.length; j++) {
          const x = a[j] ?? null, y = b[j] ?? null;
          expect(x === null).toBe(y === null);
          if (x === null || y === null) continue;
          expect(y.kind).toBe(x.kind === 'PivotHigh' ? 'PivotLow' : 'PivotHigh');
          expect(y.side).toBe(-x.side);
          expect(y.price).toBe(2 * c - x.price);
          expect([y.time, y.seq, y.confirmed_at, y.confirmedSeq, y.confirmedVol])
            .toEqual([x.time, x.seq, x.confirmed_at, x.confirmedSeq, x.confirmedVol]);
        }
      }),
      { numRuns: 300 },
    );
    expect(synced).toBeGreaterThan(30);
  });

  it('property: pivotNotVisibleBeforeConfirmedAt (zigzag level)', () => {
    fc.assert(
      fc.property(pathArb, fc.nat(), (path, cutRaw) => {
        const cut = cutRaw % path.length;
        const full = pivotsOf(path);
        const truncated = pivotsOf(path.slice(0, cut + 1));
        expect(truncated).toEqual(full.filter((x) => x.confirmedSeq <= cut));
        for (const x of truncated) expect(x.seq).toBeLessThan(x.confirmedSeq);
      }),
      { numRuns: 300 },
    );
  });
});
