import { KahanSum, percentile } from './numeric.js';
import type { Xoshiro128ss } from './rng.js';

// Spec §6.1.4 block bootstrap: blocks are volume-days (Spec §3.2.5); a
// resample draws nBlocks blocks with replacement. Statistics are computed from
// per-(row, block) pre-aggregated sums, so one resample costs O(rows · blocks)
// whatever the number of observations. Paired contrasts use the same counts.

// counts[b] = how often block b was drawn in one resample of nBlocks draws.
export function resampleBlockCounts(nBlocks: number, rng: Xoshiro128ss, out = new Uint32Array(nBlocks)): Uint32Array {
  out.fill(0);
  for (let i = 0; i < nBlocks; i++) out[rng.nextInt(nBlocks)]! += 1;
  return out;
}

// Dense block index for arbitrary block keys (e.g. volumeDay), ascending by key.
export class BlockIndex {
  readonly keys: ReadonlyArray<number>;
  private readonly index = new Map<number, number>();

  constructor(keys: Iterable<number>) {
    this.keys = [...new Set(keys)].sort((a, b) => a - b);
    this.keys.forEach((k, i) => this.index.set(k, i));
  }

  get size(): number { return this.keys.length; }

  of(key: number): number {
    const i = this.index.get(key);
    if (i === undefined) throw new Error(`BlockIndex: unknown block ${key}`);
    return i;
  }
}

// rows × blocks × channels sums (e.g. channels n, ΣReactionDisplacement, ΣReactionHit).
export class BlockSums {
  private readonly data: Float64Array;

  constructor(readonly rows: number, readonly blocks: number, readonly channels: number) {
    this.data = new Float64Array(rows * blocks * channels);
  }

  add(row: number, block: number, channel: number, x: number): void {
    this.data[(row * this.blocks + block) * this.channels + channel]! += x;
  }

  // Σ_b counts[b] · sums[row, b, channel]; counts = null ⇒ every block once (the point estimate).
  weighted(row: number, channel: number, counts: ArrayLike<number> | null): number {
    const k = new KahanSum();
    const base = row * this.blocks;
    for (let b = 0; b < this.blocks; b++) {
      const c = counts === null ? 1 : counts[b]!;
      if (c !== 0) k.add(c * this.data[(base + b) * this.channels + channel]!);
    }
    return k.value;
  }

  // weighted(num) / weighted(den); NaN when the denominator is 0.
  ratio(row: number, num: number, den: number, counts: ArrayLike<number> | null): number {
    const d = this.weighted(row, den, counts);
    return d > 0 ? this.weighted(row, num, counts) / d : NaN;
  }
}

// Runs `B` resamples; `stat(counts)` returns a fixed-length vector per resample.
// Result: samples[j] = the B values of component j (NaN kept; see percentileCI).
export function blockBootstrap(
  nBlocks: number, B: number, rng: Xoshiro128ss, stat: (counts: Uint32Array) => ArrayLike<number>,
): Float64Array[] {
  const counts = new Uint32Array(nBlocks);
  let samples: Float64Array[] | null = null;
  for (let r = 0; r < B; r++) {
    const v = stat(resampleBlockCounts(nBlocks, rng, counts));
    samples ??= Array.from({ length: v.length }, () => new Float64Array(B));
    for (let j = 0; j < v.length; j++) samples[j]![r] = v[j]!;
  }
  return samples ?? [];
}

// Percentile CI at `level` (0.95 ⇒ [2.5 %, 97.5 %]) over the finite samples;
// [NaN, NaN] when none is finite (a resample without data for that statistic).
export function percentileCI(samples: ArrayLike<number>, level = 0.95): [number, number] {
  const finite: number[] = [];
  for (let i = 0; i < samples.length; i++) if (Number.isFinite(samples[i]!)) finite.push(samples[i]!);
  const a = (1 - level) / 2;
  return [percentile(finite, a), percentile(finite, 1 - a)];
}

// CI excludes 0 (both ends strictly on one side).
export function excludesZero(ci: readonly [number, number]): boolean {
  return (ci[0] > 0 && ci[1] > 0) || (ci[0] < 0 && ci[1] < 0);
}
