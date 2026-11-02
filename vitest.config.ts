import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // `src/index.ts` only wires the server to the transport. It has no
      // unit-testable body; the live suite exercises it end to end.
      exclude: ['src/index.ts'],
      /**
       * Thresholds sit just below the measured baseline, so they catch a
       * regression without failing on noise. Raising them is the point.
       *
       * The tool handlers are exercised in-process by test/toolHarness.ts, so
       * src/tools/ no longer reports 0%. The measured baseline is roughly 77%
       * statements, 80% branches, and 87% functions. Do not lower these values
       * to make a build pass; add a test instead.
       */
      thresholds: {
        statements: 70,
        branches: 80,
        functions: 80,
        lines: 70,
      },
    },
  },
});
