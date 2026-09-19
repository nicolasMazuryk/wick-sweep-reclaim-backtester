import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import wsrPlugin from './packages/eslint-plugin-wsr/index.js';

const tsRecommended = (tsPlugin.configs['flat/recommended'] ?? []).map((config) => ({
  ...config,
  files: config.files ?? ['**/*.ts'],
}));

const WORKSPACE_SRC_GLOB = 'packages/{core,data,backtest,cli}/src/**/*.ts';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'runs/**', 'fixtures/**', 'coverage/**'],
  },
  ...tsRecommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 2022,
      },
    },
  },
  // Dependency-direction and WSR-specific rules apply to the four workspace
  // packages' source only, not to the (plain-JS) lint plugin or its tests.
  {
    files: [WORKSPACE_SRC_GLOB],
    plugins: {
      import: importPlugin,
      wsr: wsrPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: true,
      },
    },
    rules: {
      'wsr/reserved-identifiers': 'error',
      'wsr/no-float-price': 'error',
      'wsr/no-venue-literal': 'error',
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './packages/core',
              from: ['./packages/data', './packages/backtest', './packages/cli'],
            },
            {
              target: './packages/data',
              from: ['./packages/backtest', './packages/cli'],
            },
            {
              target: './packages/backtest',
              from: ['./packages/cli'],
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
];
