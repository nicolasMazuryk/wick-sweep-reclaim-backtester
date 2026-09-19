import type { Ms } from '@wsr/core';

// Exact decimal arithmetic for venue price/size/timestamp strings (Spec
// §3.11: never parseFloat(price)/tick). A Decimal is units / 10^scale with
// trailing fractional zeros stripped, so equal values compare structurally.
// @wsr/core's parseDecimalTicks covers the on-grid case and throws off-grid;
// the pipeline needs the off-grid case as data (bad print / tick-size change,
// Spec §2.3.1, §2.6.1), hence these helpers.
export interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

const TEN = 10n;

function pow10(n: number): bigint {
  return TEN ** BigInt(n);
}

function normalise(units: bigint, scale: number): Decimal {
  let u = units;
  let s = scale;
  while (s > 0 && u % TEN === 0n) {
    u /= TEN;
    s -= 1;
  }
  if (s < 0) {
    u *= pow10(-s);
    s = 0;
  }
  return { units: u, scale: s };
}

const DECIMAL_PATTERN = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

export function parseDecimal(text: string): Decimal {
  const match = DECIMAL_PATTERN.exec(text.trim());
  if (match === null || ((match[2] ?? '') === '' && (match[3] ?? '') === '')) {
    throw new Error(`parseDecimal: not a decimal number: '${text}'`);
  }
  const negative = match[1] === '-';
  const intPart = match[2] ?? '';
  const fracPart = match[3] ?? '';
  const exponent = match[4] === undefined ? 0 : Number(match[4]);
  const digits = BigInt(`${intPart}${fracPart}` || '0');
  return normalise(negative ? -digits : digits, fracPart.length - exponent);
}

export function formatDecimal(value: Decimal): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString();
  if (value.scale === 0) {
    return `${negative ? '-' : ''}${digits}`;
  }
  const padded = digits.padStart(value.scale + 1, '0');
  const intPart = padded.slice(0, padded.length - value.scale);
  const fracPart = padded.slice(padded.length - value.scale);
  return `${negative ? '-' : ''}${intPart}.${fracPart}`;
}

// Canonical decimal string (e.g. '3327.32000' → '3327.32', '1e-2' → '0.01').
export function canonicalDecimal(text: string): string {
  return formatDecimal(parseDecimal(text));
}

export function decimalToNumber(value: Decimal): number {
  return Number(formatDecimal(value));
}

export function multiplyDecimal(a: Decimal, b: Decimal): Decimal {
  return normalise(a.units * b.units, a.scale + b.scale);
}

function aligned(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.units * pow10(scale - a.scale), b.units * pow10(scale - b.scale), scale];
}

export function compareDecimal(a: Decimal, b: Decimal): number {
  const [x, y] = aligned(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export interface QuantizeResult {
  // round(value / step), half away from zero.
  readonly n: number;
  // value / step is an integer (within the Spec §2.3.1 1e-9 relative tolerance).
  readonly exact: boolean;
}

const RELATIVE_TOLERANCE_PPB = 1n; // 1e-9 expressed as parts per 10^9

// round(value / step) in exact decimal arithmetic (Spec §2.3.1 p and q).
export function quantize(value: Decimal, step: Decimal): QuantizeResult {
  const [x, y] = aligned(value, step);
  if (y <= 0n) {
    throw new Error(`quantize: step must be positive, got ${formatDecimal(step)}`);
  }
  const negative = x < 0n;
  const ax = negative ? -x : x;
  let quotient = ax / y;
  const remainder = ax % y;
  const exact = remainder === 0n || remainder * 1_000_000_000n <= RELATIVE_TOLERANCE_PPB * y || (y - remainder) * 1_000_000_000n <= RELATIVE_TOLERANCE_PPB * y;
  if (remainder * 2n >= y) {
    quotient += 1n;
  }
  const n = Number(negative ? -quotient : quotient);
  return { n, exact };
}

function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

// Largest decimal step that divides both values exactly (the finest common
// grid): gcd(3325.385, 0.01) = 0.005. Used to infer a finer Tick/LotSize.
export function gcdDecimal(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = aligned(a, b);
  return normalise(gcdBigInt(x, y), scale);
}

export interface SubMsTimestamp {
  readonly t: Ms;
  readonly tNsRemainder: number;
}

// Epoch seconds with an optional fractional part ('1736380800.1104',
// '1735689600.932703') → ms (truncated, Spec §2.3.1) + ns remainder, without
// floats.
export function parseEpochSeconds(text: string): SubMsTimestamp {
  const value = parseDecimal(text);
  const ns = value.units * pow10(9 - Math.min(value.scale, 9)) / pow10(Math.max(0, value.scale - 9));
  return splitNs(ns);
}

// Integer epoch milliseconds ('1736380805115').
export function parseEpochMs(text: string): SubMsTimestamp {
  const value = parseDecimal(text);
  return splitNs(value.units * pow10(6) / pow10(value.scale));
}

function splitNs(ns: bigint): SubMsTimestamp {
  const t = ns / 1_000_000n;
  return { t: Number(t), tNsRemainder: Number(ns - t * 1_000_000n) };
}
