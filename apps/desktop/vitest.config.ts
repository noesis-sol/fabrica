import { configDefaults, defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'desktop',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The packaged app's smoke test runs on an artifact, by its own config (vitest.smoke.config.ts).
    exclude: [...configDefaults.exclude, 'test/smoke.test.ts'],
  },
})
