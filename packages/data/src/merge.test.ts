import { describe, expect, it } from 'vitest';
import { merge, type RawMergeInput } from './merge.js';

function record(t: number, seq: number, p: number, q: number, s: 1 | -1): RawMergeInput {
  return { t, seq, p, q, s };
}

describe('merge', () => {
  it('A-1: monotone buy run merges into one event with the last (extreme) price', () => {
    const raw = [record(1000, 0, 100, 1, 1), record(1000, 1, 101, 2, 1), record(1000, 2, 103, 3, 1)];
    const { records } = merge(raw);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ t: 1000, seq: 0, p: 103, q: 6, s: 1, n: 3, pFirst: 100, rawSeqFirst: 0 });
  });

  it('A-2: same (t,s) but non-monotone prices splits into separate events', () => {
    const raw = [record(1000, 0, 100, 1, 1), record(1000, 1, 99, 2, 1)];
    const { records } = merge(raw);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ p: 100, q: 1, n: 1 });
    expect(records[1]).toMatchObject({ p: 99, q: 2, n: 1 });
  });

  it('A-3: repeated identical (t,s,p) merges (equal prices are monotone)', () => {
    const raw = [record(1000, 0, 100, 1, 1), record(1000, 1, 100, 2, 1), record(1000, 2, 100, 3, 1)];
    const { records } = merge(raw);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ p: 100, q: 6, n: 3 });
  });

  it('sell-side mirror: monotone non-increasing run merges to the lowest (extreme) price', () => {
    const raw = [record(1000, 0, 100, 1, -1), record(1000, 1, 99, 2, -1), record(1000, 2, 97, 3, -1)];
    const { records } = merge(raw);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ p: 97, q: 6, s: -1, n: 3 });
  });

  it('sell-side mirror: non-monotone same-(t,s) splits', () => {
    const raw = [record(1000, 0, 100, 1, -1), record(1000, 1, 101, 2, -1)];
    const { records } = merge(raw);
    expect(records).toHaveLength(2);
  });

  it('different t starts a new group even with the same side', () => {
    const raw = [record(1000, 0, 100, 1, 1), record(1001, 1, 101, 2, 1)];
    const { records } = merge(raw);
    expect(records).toHaveLength(2);
  });

  it('different s at the same t starts a new group', () => {
    const raw = [record(1000, 0, 100, 1, 1), record(1000, 1, 100, 2, -1)];
    const { records } = merge(raw);
    expect(records).toHaveLength(2);
  });

  it('is stable and sorts by (t asc, seq asc) regardless of input order', () => {
    const inOrder = [record(1000, 0, 100, 1, 1), record(1000, 1, 101, 1, 1), record(1001, 2, 50, 1, -1)];
    const shuffled = [inOrder[2]!, inOrder[0]!, inOrder[1]!];
    expect(merge(shuffled)).toEqual(merge(inOrder));
  });

  it('midnight boundary: flags midnightSplit when the day would have continued the previous run', () => {
    const raw = [record(86_400_000, 0, 105, 1, 1)];
    const { midnightSplit } = merge(raw, { previousDayLast: { p: 104, s: 1 } });
    expect(midnightSplit).toBe(true);
  });

  it('midnight boundary: no flag when the side differs from the previous day', () => {
    const raw = [record(86_400_000, 0, 105, 1, 1)];
    const { midnightSplit } = merge(raw, { previousDayLast: { p: 104, s: -1 } });
    expect(midnightSplit).toBe(false);
  });

  it('midnight boundary: no flag when the price reverses the previous run direction', () => {
    const raw = [record(86_400_000, 0, 100, 1, 1)];
    const { midnightSplit } = merge(raw, { previousDayLast: { p: 104, s: 1 } });
    expect(midnightSplit).toBe(false);
  });

  it('midnight boundary: no flag when there is no previous day', () => {
    const raw = [record(86_400_000, 0, 105, 1, 1)];
    expect(merge(raw).midnightSplit).toBe(false);
  });

  it('assigns 0-based output seq to merged events, independent of raw seq', () => {
    const raw = [record(1000, 5, 100, 1, 1), record(2000, 9, 50, 1, -1)];
    const { records } = merge(raw);
    expect(records.map((r) => r.seq)).toEqual([0, 1]);
    expect(records.map((r) => r.rawSeqFirst)).toEqual([5, 9]);
  });
});
