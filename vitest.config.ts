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
       * Read the statement number with care. The six tool registrars under
       * `src/tools/` report 0% here because they run only when the server
       * starts, and `test/live.test.ts` starts it as a subprocess. The v8
       * provider cannot see coverage across that process boundary, so roughly
       * 1,400 lines that the live and contract suites do exercise appear
       * uncovered. Branch coverage, at 86%, is the number that reflects the
       * units this run can actually observe.
       *
       * To raise the statement number honestly, add in-process tests that call
       * the tool handlers against a mocked `EutilsClient`. Do not lower these
       * values to make a build pass.
       */
      thresholds: {
        statements: 30,
        branches: 80,
        functions: 80,
        lines: 30,
      },
    },
  },
});
