import { defineConfig } from 'vitest/config'

// The rerun script's fixtures (testkit.test.ts runs the script here): files named `*.fixture.ts`, so no
// project of the repository's runs them.
export default defineConfig({
  test: {
    include: ['*.fixture.ts'],
    maxWorkers: 1,
  },
})
