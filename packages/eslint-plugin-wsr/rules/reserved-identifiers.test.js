import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import tsParser from '@typescript-eslint/parser';
import rule from './reserved-identifiers.js';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('reserved-identifiers', rule, {
  valid: [
    { code: 'export type Side = 1 | -1;' },
    { code: 'interface Pivot { readonly price: number; }' },
    { code: 'const Vol = 1;' },
  ],
  invalid: [
    {
      code: 'const vol = 1;',
      errors: [{ messageId: 'wrongCase' }],
    },
    {
      code: 'interface Foo { readonly wickStrength: number; }',
      errors: [{ messageId: 'wrongCase' }],
    },
  ],
});
