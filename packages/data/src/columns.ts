import type { Side } from '@wsr/core';

// Struct-of-arrays form of one partition's raw trades. A liquid venue-day is
// 5–10 M prints; one object per print (plus a BigInt per Int64 cell at write
// time) costs several GB, typed arrays ≈ 45 B/print + the tradeId strings.
export interface TradeColumns {
  readonly length: number;
  readonly tradeId: readonly string[];
  readonly t: Float64Array;
  readonly tNsRemainder: Int32Array;
  readonly seq: Float64Array;
  readonly p: Float64Array;
  readonly q: Float64Array;
  readonly s: Int8Array;
}

export interface TradeRowLike {
  readonly tradeId: string;
  readonly t: number;
  readonly tNsRemainder: number;
  readonly seq: number;
  readonly p: number;
  readonly q: number;
  readonly s: Side;
}

export class TradeColumnsBuilder {
  private n = 0;
  private tradeId: string[] = [];
  private t: Float64Array;
  private tNsRemainder: Int32Array;
  private seq: Float64Array;
  private p: Float64Array;
  private q: Float64Array;
  private s: Int8Array;

  constructor(capacity = 1 << 16) {
    this.t = new Float64Array(capacity);
    this.tNsRemainder = new Int32Array(capacity);
    this.seq = new Float64Array(capacity);
    this.p = new Float64Array(capacity);
    this.q = new Float64Array(capacity);
    this.s = new Int8Array(capacity);
  }

  get length(): number {
    return this.n;
  }

  private grow(): void {
    const capacity = this.t.length * 2;
    const resize = <A extends Float64Array | Int32Array | Int8Array>(old: A, make: (n: number) => A): A => {
      const next = make(capacity);
      next.set(old);
      return next;
    };
    this.t = resize(this.t, (n) => new Float64Array(n));
    this.tNsRemainder = resize(this.tNsRemainder, (n) => new Int32Array(n));
    this.seq = resize(this.seq, (n) => new Float64Array(n));
    this.p = resize(this.p, (n) => new Float64Array(n));
    this.q = resize(this.q, (n) => new Float64Array(n));
    this.s = resize(this.s, (n) => new Int8Array(n));
  }

  push(row: TradeRowLike): void {
    if (this.n === this.t.length) {
      this.grow();
    }
    const i = this.n;
    this.tradeId.push(row.tradeId);
    this.t[i] = row.t;
    this.tNsRemainder[i] = row.tNsRemainder;
    this.seq[i] = row.seq;
    this.p[i] = row.p;
    this.q[i] = row.q;
    this.s[i] = row.s;
    this.n += 1;
  }

  build(): TradeColumns {
    const n = this.n;
    return {
      length: n,
      tradeId: this.tradeId,
      t: this.t.slice(0, n),
      tNsRemainder: this.tNsRemainder.slice(0, n),
      seq: this.seq.slice(0, n),
      p: this.p.slice(0, n),
      q: this.q.slice(0, n),
      s: this.s.slice(0, n),
    };
  }
}

export function tradeColumnsFromRows(rows: readonly TradeRowLike[]): TradeColumns {
  const builder = new TradeColumnsBuilder(Math.max(1, rows.length));
  rows.forEach((row) => builder.push(row));
  return builder.build();
}

// Indices in (t asc, seq asc) order, optionally restricted to `keep[i] = 1`
// (Spec §2.4 step 1). Skips the sort when the input is already ordered.
export function sortedIndices(cols: Pick<TradeColumns, 'length' | 't' | 'seq'>, keep?: Uint8Array): Uint32Array {
  let count = 0;
  for (let i = 0; i < cols.length; i += 1) {
    if (keep === undefined || keep[i] === 1) {
      count += 1;
    }
  }
  const idx = new Uint32Array(count);
  let k = 0;
  let ordered = true;
  for (let i = 0; i < cols.length; i += 1) {
    if (keep !== undefined && keep[i] !== 1) {
      continue;
    }
    if (k > 0) {
      const j = idx[k - 1]!;
      if (cols.t[i]! < cols.t[j]! || (cols.t[i] === cols.t[j] && cols.seq[i]! < cols.seq[j]!)) {
        ordered = false;
      }
    }
    idx[k] = i;
    k += 1;
  }
  if (!ordered) {
    idx.sort((a, b) => cols.t[a]! - cols.t[b]! || cols.seq[a]! - cols.seq[b]!);
  }
  return idx;
}

export function toBigInt64(values: Float64Array | Int32Array): BigInt64Array {
  const out = new BigInt64Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    out[i] = BigInt(values[i]!);
  }
  return out;
}

export function fromBigInt64(values: BigInt64Array): Float64Array {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    out[i] = Number(values[i]!);
  }
  return out;
}
