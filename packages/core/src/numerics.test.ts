import { describe, expect, it } from 'vitest';
import {
  assertTickRange,
  assertVolumeBound,
  ceilTicksConservative,
  floorTicksConservative,
  parseDecimalLots,
  parseDecimalTicks,
} from './numerics.js';

describe('ceilTicksConservative', () => {
  it('rounds an exact integer up to itself, not down (1e-9 must not flip a boundary)', () => {
    expect(ceilTicksConservative(5)).toBe(5);
  });

  it('rounds a non-integer distance up', () => {
    expect(ceilTicksConservative(5.5)).toBe(6);
  });
});

describe('floorTicksConservative', () => {
  it('rounds an exact integer down to itself, not up (1e-9 must not flip a boundary)', () => {
    expect(floorTicksConservative(5)).toBe(5);
  });

  it('rounds a non-integer distance down', () => {
    expect(floorTicksConservative(5.5)).toBe(5);
  });
});

describe('parseDecimalTicks', () => {
  it('divides exact decimal strings', () => {
    expect(parseDecimalTicks('123.45', '0.01')).toBe(12345);
  });

  it('is exact even when both operands individually exceed 2^53 (proves the BigInt path, not a float division)', () => {
    // 9007199254740993 = 2^53 + 1; Number("9007199254740993") already rounds
    // to 9007199254740992, so a naive parseFloat-based division would not
    // reliably see an exact quotient of 1 here.
    expect(parseDecimalTicks('9007199254740993', '9007199254740993')).toBe(1);
  });

  it('throws when the result is not an integer within tolerance', () => {
    expect(() => parseDecimalTicks('100.03', '0.02')).toThrow();
  });
});

describe('parseDecimalLots', () => {
  it('divides and applies the contract multiplier', () => {
    expect(parseDecimalLots('1.5', '0.1', 10)).toBe(150);
  });
});

describe('assertVolumeBound', () => {
  it('does not throw just under 2^52', () => {
    expect(() => assertVolumeBound(2 ** 52 - 1)).not.toThrow();
  });

  it('throws at exactly 2^52', () => {
    expect(() => assertVolumeBound(2 ** 52)).toThrow();
  });

  it('throws above 2^52', () => {
    expect(() => assertVolumeBound(2 ** 52 + 1)).toThrow();
  });
});

describe('assertTickRange', () => {
  it('does not throw just under 2^31 in absolute value', () => {
    expect(() => assertTickRange(2 ** 31 - 1)).not.toThrow();
    expect(() => assertTickRange(-(2 ** 31 - 1))).not.toThrow();
  });

  it('throws at exactly 2^31', () => {
    expect(() => assertTickRange(2 ** 31)).toThrow();
    expect(() => assertTickRange(-(2 ** 31))).toThrow();
  });
});
