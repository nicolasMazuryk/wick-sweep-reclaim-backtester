import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sortedIndices, tradeColumnsFromRows, type TradeRowLike } from './columns.js';
import { merge, mergeColumns, mergedColumnsToRecords } from './merge.js';

const rowArb = fc.record({
  t: fc.integer({ min: 0, max: 20 }),
  p: fc.integer({ min: 1, max: 6 }),
  q: fc.integer({ min: 1, max: 5 }),
  s: fc.constantFrom<1 | -1>(1, -1),
});

function rows(input: Array<{ t: number; p: number; q: number; s: 1 | -1 }>): TradeRowLike[] {
  return input.map((r, seq) => ({ ...r, seq, tradeId: String(seq), tNsRemainder: 0 }));
}

describe('columnar merge', () => {
  it('property: mergeColumns with a keep mask == merge of the kept records', () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 60 }), fc.array(fc.boolean(), { maxLength: 60 }), (input, mask) => {
        const raw = rows(input);
        const keep = Uint8Array.from(raw, (_, i) => (mask[i] === false ? 0 : 1));
        const columnar = mergedColumnsToRecords(mergeColumns(tradeColumnsFromRows(raw), keep));
        expect(columnar).toEqual(merge(raw.filter((_, i) => keep[i] === 1)).records);
      }),
      { seed: 1, numRuns: 300 },
    );
  });

  it('property: conserves Σq and Σn over kept records', () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 80 }), (input) => {
        const cols = tradeColumnsFromRows(rows(input));
        const merged = mergeColumns(cols);
        expect(merged.n.reduce((a, b) => a + b, 0)).toBe(input.length);
        expect(merged.q.reduce((a, b) => a + b, 0)).toBe(input.reduce((a, r) => a + r.q, 0));
      }),
      { seed: 2, numRuns: 200 },
    );
  });
});

describe('sortedIndices', () => {
  it('orders by (t, seq) and honours the mask', () => {
    const cols = tradeColumnsFromRows(rows([
      { t: 5, p: 1, q: 1, s: 1 },
      { t: 3, p: 1, q: 1, s: 1 },
      { t: 3, p: 1, q: 1, s: 1 },
      { t: 1, p: 1, q: 1, s: 1 },
    ]));
    expect([...sortedIndices(cols)]).toEqual([3, 1, 2, 0]);
    expect([...sortedIndices(cols, Uint8Array.from([1, 0, 1, 1]))]).toEqual([3, 2, 0]);
  });
});
