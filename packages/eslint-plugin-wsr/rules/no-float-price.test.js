import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import tsParser from '@typescript-eslint/parser';
import rule from './no-float-price.js';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('no-float-price', rule, {
  valid: [
    { code: 'const p = parseFloat(priceStr);', filename: 'packages/core/src/numerics.ts' },
    { code: 'const p = +priceStr;', filename: 'packages/core/src/numerics.ts' },
    { code: 'const x = +5;', filename: 'packages/core/src/level.ts' },
  ],
  invalid: [
    {
      code: 'const p = parseFloat(priceStr);',
      filename: 'packages/core/src/level.ts',
      errors: [{ messageId: 'noParseFloat' }],
    },
    {
      code: 'const p = Number.parseFloat(priceStr);',
      filename: 'packages/core/src/level.ts',
      errors: [{ messageId: 'noParseFloat' }],
    },
    {
      code: 'const p = +priceStr;',
      filename: 'packages/core/src/level.ts',
      errors: [{ messageId: 'noUnaryPlus' }],
    },
  ],
});

// Spec §3.11 "no float price is ever compared" (syntactic Ticks detection, A-120).
const tsRuleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

const file = 'packages/core/src/level-book.ts';
tsRuleTester.run('no-float-price (Ticks comparisons)', rule, {
  valid: [
    { code: 'function f(a: Ticks, b: Ticks) { return a < b; }', filename: file },
    { code: 'function f(a: Ticks, x: number) { return a <= Math.floor(x / 2); }', filename: file },
    { code: 'function f(l: Level, d: number) { return l.StopLoss === l.WickLevel - floorTicksConservative(d * 1.5); }', filename: file },
    { code: 'function f(a: number, b: number) { return a < b / 2; }', filename: file },
    { code: 'function f(r: number) { return r > 0.5; }', filename: file },
    { code: 'function f(a: Ticks, n: number) { return a * 2 > n + 3; }', filename: file },
  ],
  invalid: [
    { code: 'function f(a: Ticks) { return a < 1.5; }', filename: file, errors: [{ messageId: 'noFloatCompare' }] },
    { code: 'function f(a: Ticks, b: Ticks) { return a === b / 2; }', filename: file, errors: [{ messageId: 'noFloatCompare' }] },
    { code: 'function f(e: MergedEvent, v: number) { return v * 0.5 > e.p; }', filename: file, errors: [{ messageId: 'noFloatCompare' }] },
    { code: 'function f(l: Level, x: number) { return -l.SweepExtreme >= Math.sqrt(x); }', filename: file, errors: [{ messageId: 'noFloatCompare' }] },
    { code: 'class A { private hi: Ticks = 0; g(x: number) { return this.hi > x / 3; } }', filename: file, errors: [{ messageId: 'noFloatCompare' }] },
    { code: 'function f(a: Ticks | -1, b: number) { return a !== b / 4; }', filename: file, errors: [{ messageId: 'noFloatCompare' }] },
  ],
});
