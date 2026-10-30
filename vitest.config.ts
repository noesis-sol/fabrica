import { defineConfig } from 'vitest/config'

import {
  testWorkers,
  workerFactsOfProcess,
} from './packages/testkit/src/workers.ts'

// Test files run side by side in as many workers as the run's share of the cores (FABRICA_CORES),
// every core on CI, or half the machine's (spec §24). A test's default time limit allows for a loaded
// machine: each project's config sets it (packages/testkit/src/limits.ts), as a project's config file
// inherits nothing of this one's. A failed or timed-out test is rerun by scripts/test-rerun.ts, which
// `pnpm test` runs.
export default defineConfig({
  test: {
    projects: [
      'apps/*/vitest.config.ts',
      'packages/*/vitest.config.ts',
      'scripts/vitest.config.ts',
    ],
    maxWorkers: testWorkers(workerFactsOfProcess()),
    passWithNoTests: true,
  },
})
