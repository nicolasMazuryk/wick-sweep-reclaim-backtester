import { describe, expect, it } from 'vitest';
import { SpreadEst } from './spread.js';
import type { Side } from './types.js';

function feed(est: SpreadEst, prints: ReadonlyArray<readonly [number, Side]>): void {
  for (const [p, s] of prints) est.onPrint(p, s);
}

// Alternating sides, each change with price gap `gaps[i % gaps.length]`.
function alternating(count: number, gaps: readonly number[], start = 1000): Array<[number, Side]> {
  const out: Array<[number, Side]> = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    if (i > 0) p += gaps[(i - 1) % gaps.length]!;
    out.push([p, i % 2 === 0 ? 1 : -1]);
  }
  return out;
}

describe('SpreadEst', () => {
  it('takes gaps only at aggressor-side changes', () => {
    // Sides + + − − + + …: same-side steps jump 500, side changes step 2.
    const prints: Array<[number, Side]> = [];
    let p = 1000;
    for (let i = 0; i < 200; i++) {
      const s: Side = Math.floor(i / 2) % 2 === 0 ? 1 : -1;
      if (i > 0) p += i % 2 === 1 ? 500 : 2;
      prints.push([p, s]);
    }
    const est = new SpreadEst();
    feed(est, prints);
    expect(est.samples).toBe(99);
    expect(est.refresh(1)).toBe(2);
  });

  it('floors at Tick', () => {
    const est = new SpreadEst();
    feed(est, alternating(100, [2]));
    expect(est.refresh(5)).toBe(5);
  });

  it('publishes Tick below 50 samples', () => {
    const est = new SpreadEst();
    // 100 events, 40 of them side changes with gap 7.
    const prints: Array<[number, Side]> = [];
    let s: Side = 1;
    for (let i = 0; i < 100; i++) {
      if (i > 0 && i <= 40) s = s === 1 ? -1 : 1;
      prints.push([1000 + i * 7, s]);
    }
    feed(est, prints);
    expect(est.samples).toBe(40);
    expect(est.refresh(1)).toBe(1);
  });

  it('rounds an even-sample median up (mean of middles, then ceil)', () => {
    const est = new SpreadEst();
    // A leading same-side print makes the recompute at event 200 see 198 samples: 99 × 2, 99 × 3.
    feed(est, [[1000, 1], ...alternating(199, [2, 3])]);
    expect(est.samples).toBe(198);
    expect(est.refresh(1)).toBe(3);
  });

  it('value changes only on refresh, never on onPrint', () => {
    const est = new SpreadEst();
    expect(est.value).toBeNaN();
    feed(est, alternating(100, [4]));
    expect(est.value).toBeNaN();
    expect(est.refresh(1)).toBe(4);
    for (const [p, s] of alternating(600, [9])) {
      est.onPrint(p, s);
      expect(est.value).toBe(4);
    }
    expect(est.refresh(1)).toBe(9);
    expect(est.value).toBe(9);
  });

  it('keeps only the last 500 samples', () => {
    const est = new SpreadEst();
    feed(est, alternating(501, [100]));
    feed(est, alternating(300, [1], 10_000));
    // 300 events of gap 1 after 500 of gap 100: 299 small + 1 boundary + 200 large in the window.
    expect(est.samples).toBe(500);
    expect(est.refresh(1)).toBe(1);
  });

  it('reset clears samples and value', () => {
    const est = new SpreadEst();
    feed(est, alternating(100, [4]));
    est.refresh(1);
    est.reset();
    expect(est.samples).toBe(0);
    expect(est.value).toBeNaN();
    expect(est.refresh(1)).toBe(1);
  });
});
