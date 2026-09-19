import type { Lots, Ticks } from './types.js';

// Products of a multiplier and a VolUnit that set a distance the price must
// exceed are rounded up (conservative: harder to qualify). The 1e-9 epsilon
// absorbs float noise from the multiplication without changing the rounding
// direction for any value that isn't already (near-)integral.
export function ceilTicksConservative(x: number): Ticks {
  return Math.ceil(x - 1e-9);
}

// Target distance is rounded down (conservative: target harder to reach).
export function floorTicksConservative(x: number): Ticks {
  return Math.floor(x + 1e-9);
}

const RELATIVE_TOLERANCE = 1e-9;

function countDecimals(decimalStr: string): number {
  const dot = decimalStr.indexOf('.');
  return dot === -1 ? 0 : decimalStr.length - dot - 1;
}

function toBigIntScaled(decimalStr: string, scale: number): bigint {
  const negative = decimalStr.startsWith('-');
  const unsigned = negative ? decimalStr.slice(1) : decimalStr;
  const dot = unsigned.indexOf('.');
  const digits = dot === -1 ? unsigned : unsigned.slice(0, dot) + unsigned.slice(dot + 1);
  const decimals = countDecimals(unsigned);
  const padded = digits + '0'.repeat(scale - decimals);
  const value = BigInt(padded);
  return negative ? -value : value;
}

function exactDecimalDivide(numeratorStr: string, denominatorStr: string): number {
  const scale = Math.max(countDecimals(numeratorStr), countDecimals(denominatorStr));
  const numerator = toBigIntScaled(numeratorStr, scale);
  const denominator = toBigIntScaled(denominatorStr, scale);
  if (denominator === 0n) {
    throw new Error(`exactDecimalDivide: division by zero (${numeratorStr} / ${denominatorStr})`);
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) {
    return Number(quotient);
  }
  const remainderRatio = Math.abs(Number(remainder)) / Math.abs(Number(denominator));
  if (remainderRatio > RELATIVE_TOLERANCE) {
    throw new Error(
      `exactDecimalDivide: ${numeratorStr} / ${denominatorStr} is not an integer within tolerance (remainder ratio ${remainderRatio})`,
    );
  }
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return Number(rounded);
}

// p = round(price / Tick) via exact decimal string arithmetic (Spec §3.11).
export function parseDecimalTicks(priceDecimalStr: string, tickDecimalStr: string): Ticks {
  return exactDecimalDivide(priceDecimalStr, tickDecimalStr);
}

export function parseDecimalLots(
  sizeDecimalStr: string,
  lotSizeDecimalStr: string,
  contractMultiplier: number,
): Lots {
  const lots = exactDecimalDivide(sizeDecimalStr, lotSizeDecimalStr);
  return lots * contractMultiplier;
}

const MAX_VOLUME = 2 ** 52;

export function assertVolumeBound(sumQ: number): void {
  if (sumQ >= MAX_VOLUME) {
    throw new Error(`assertVolumeBound: Σq ${sumQ} >= 2^52`);
  }
}

const MAX_TICK_RANGE = 2 ** 31;

export function assertTickRange(p: Ticks): void {
  if (Math.abs(p) >= MAX_TICK_RANGE) {
    throw new Error(`assertTickRange: |p| ${p} >= 2^31`);
  }
}
