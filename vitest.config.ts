import { availableParallelism } from 'node:os'
import { defineConfig } from 'vitest/config'

// Test files run side by side in as many workers as the run's share of the cores
// (FABRICA_CORES), or half the machine's without one (spec §24).
const cores = Number.parseInt(process.env['FABRICA_CORES'] ?? '', 10)

export default defineConfig({
  test: {
    projects: [
      'apps/*/vitest.config.ts',
      'packages/*/vitest.config.ts',
      'scripts/vitest.config.ts',
    ],
    maxWorkers:
      cores > 0 ? cores : Math.max(1, Math.floor(availableParallelism() / 2)),
    passWithNoTests: true,
    testTimeout: 15_000,
  },
})
