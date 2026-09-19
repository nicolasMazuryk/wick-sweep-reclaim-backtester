import { defineConfig } from 'vitest/config';

// `pnpm test:coverage` — Spec §12 Definition of Done: @wsr/core ≥ 90 % lines.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['packages/{core,data,backtest,cli}/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/testing/**'],
      reporter: ['text-summary', 'html'],
      thresholds: {
        'packages/core/src/**': { lines: 90 },
      },
    },
  },
});
