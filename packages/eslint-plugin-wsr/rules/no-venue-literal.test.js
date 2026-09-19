import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import rule from './no-venue-literal.js';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('no-venue-literal', rule, {
  valid: [
    { code: "export const id = 'binance';", filename: 'packages/data/src/venues/binance.ts' },
    { code: "const label = 'other';", filename: 'packages/core/src/level.ts' },
  ],
  invalid: [
    {
      code: "const id = 'binance';",
      filename: 'packages/core/src/level.ts',
      errors: [{ messageId: 'noVenueLiteral' }],
    },
  ],
});
