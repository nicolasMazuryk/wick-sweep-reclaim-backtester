// Spec §9.2: all randomness flows from one uint32 `seed` through splitmix32 →
// per-purpose xoshiro128** streams. A stream is derived by hashing the seed,
// the purpose string and the ids (FNV-1a), never by call order.

// splitmix32: a stateful uint32 generator (seed expander).
export function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let z = a;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

const TWO_POW_32 = 4294967296;

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

// xoshiro128** (Blackman & Vigna), 32-bit state words.
export class Xoshiro128ss {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(s0: number, s1: number, s2: number, s3: number) {
    this.s0 = s0 >>> 0;
    this.s1 = s1 >>> 0;
    this.s2 = s2 >>> 0;
    this.s3 = s3 >>> 0;
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) throw new Error('Xoshiro128ss: all-zero state');
  }

  static fromSeed(seed: number): Xoshiro128ss {
    const sm = splitmix32(seed);
    return new Xoshiro128ss(sm(), sm(), sm(), sm());
  }

  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const x = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ x) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  // Uniform on [0, 1) with 32 bits of resolution.
  nextFloat(): number {
    return this.nextU32() / TWO_POW_32;
  }

  // Uniform integer on [0, n), unbiased (rejection sampling); 1 ≤ n ≤ 2^32.
  nextInt(n: number): number {
    if (!(Number.isInteger(n) && n >= 1 && n <= TWO_POW_32)) throw new Error(`Xoshiro128ss.nextInt: bad bound ${n}`);
    const limit = TWO_POW_32 - (TWO_POW_32 % n);
    for (;;) {
      const x = this.nextU32();
      if (x < limit) return x % n;
    }
  }
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnvByte(h: number, b: number): number {
  return Math.imul(h ^ (b & 0xff), FNV_PRIME) >>> 0;
}

function fnvU32(h: number, x: number): number {
  for (let k = 0; k < 32; k += 8) h = fnvByte(h, x >>> k);
  return h;
}

// FNV-1a over (seed, purpose as UTF-8, 0x00, ids as uint32 little-endian).
export function streamHash(seed: number, purpose: string, ids: ReadonlyArray<number>): number {
  let h = fnvU32(FNV_OFFSET, seed >>> 0);
  for (const b of new TextEncoder().encode(purpose)) h = fnvByte(h, b);
  h = fnvByte(h, 0);
  for (const id of ids) {
    if (!(Number.isInteger(id) && id >= 0 && id < TWO_POW_32)) throw new Error(`rngStream: id ${id} is not a uint32`);
    h = fnvU32(h, id);
  }
  return h;
}

// Independent stream for (seed, purpose, ...ids), e.g. rngStream(seed, 'bootstrap', foldId).
export function rngStream(seed: number, purpose: string, ...ids: number[]): Xoshiro128ss {
  return Xoshiro128ss.fromSeed(streamHash(seed, purpose, ids));
}
