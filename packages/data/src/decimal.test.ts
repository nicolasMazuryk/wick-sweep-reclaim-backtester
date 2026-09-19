import { describe, expect, it } from 'vitest';
import { canonicalDecimal, formatDecimal, gcdDecimal, multiplyDecimal, parseDecimal, parseEpochMs, parseEpochSeconds, quantize } from './decimal.js';

describe('parseDecimal / formatDecimal', () => {
  it('round-trips and strips trailing zeros (KuCoin zero-padded prices)', () => {
    expect(canonicalDecimal('3327.32000000000000000000')).toBe('3327.32');
    expect(canonicalDecimal('3346')).toBe('3346');
    expect(canonicalDecimal('0.010')).toBe('0.01');
    expect(canonicalDecimal('-0.5')).toBe('-0.5');
    expect(canonicalDecimal('+2.50')).toBe('2.5');
  });

  it('accepts exponent notation (JSON numbers such as 1e-7)', () => {
    expect(canonicalDecimal('1e-7')).toBe('0.0000001');
    expect(canonicalDecimal('6.6E-5')).toBe('0.000066');
    expect(canonicalDecimal('2e3')).toBe('2000');
  });

  it('rejects non-numbers', () => {
    expect(() => parseDecimal('abc')).toThrow();
    expect(() => parseDecimal('')).toThrow();
    expect(() => parseDecimal('.')).toThrow();
  });

  it('multiplies exactly (contracts × multiplier)', () => {
    expect(formatDecimal(multiplyDecimal(parseDecimal('1.17'), parseDecimal('0.1')))).toBe('0.117');
    expect(formatDecimal(multiplyDecimal(parseDecimal('26'), parseDecimal('0.01')))).toBe('0.26');
  });
});

describe('quantize (Spec §2.3.1 p and q)', () => {
  it('is exact for on-grid values without float error', () => {
    // 0.1 + 0.2 style float traps: 3325.38 / 0.01 must be exactly 332538.
    expect(quantize(parseDecimal('3325.38'), parseDecimal('0.01'))).toEqual({ n: 332538, exact: true });
    expect(quantize(parseDecimal('0.117'), parseDecimal('0.001'))).toEqual({ n: 117, exact: true });
    expect(quantize(parseDecimal('3346'), parseDecimal('0.01'))).toEqual({ n: 334600, exact: true });
  });

  it('flags off-grid values and rounds half away from zero', () => {
    expect(quantize(parseDecimal('3325.385'), parseDecimal('0.01'))).toEqual({ n: 332539, exact: false });
    expect(quantize(parseDecimal('3325.384'), parseDecimal('0.01'))).toEqual({ n: 332538, exact: false });
    expect(quantize(parseDecimal('-1.005'), parseDecimal('0.01'))).toEqual({ n: -101, exact: false });
  });

  it('treats a remainder within 1e-9 relative tolerance as exact', () => {
    expect(quantize(parseDecimal('1.0000000000001'), parseDecimal('1'))).toEqual({ n: 1, exact: true });
  });

  it('rejects a non-positive step', () => {
    expect(() => quantize(parseDecimal('1'), parseDecimal('0'))).toThrow();
  });
});

describe('gcdDecimal (grid inference)', () => {
  it('finds the finest common grid', () => {
    expect(formatDecimal(gcdDecimal(parseDecimal('3325.385'), parseDecimal('0.01')))).toBe('0.005');
    expect(formatDecimal(gcdDecimal(parseDecimal('3325.38'), parseDecimal('0.01')))).toBe('0.01');
    expect(formatDecimal(gcdDecimal(parseDecimal('0.0005'), parseDecimal('0.001')))).toBe('0.0005');
  });
});

describe('timestamps', () => {
  it('splits fractional epoch seconds into ms + ns remainder without floats', () => {
    expect(parseEpochSeconds('1736380800.1104')).toEqual({ t: 1736380800110, tNsRemainder: 400_000 });
    expect(parseEpochSeconds('1735689600.932703')).toEqual({ t: 1735689600932, tNsRemainder: 703_000 });
    expect(parseEpochSeconds('1735689600')).toEqual({ t: 1735689600000, tNsRemainder: 0 });
    expect(parseEpochSeconds('1735689600.123456789123')).toEqual({ t: 1735689600123, tNsRemainder: 456_789 });
  });

  it('parses integer epoch ms', () => {
    expect(parseEpochMs('1736380805115')).toEqual({ t: 1736380805115, tNsRemainder: 0 });
  });
});
