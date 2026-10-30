import { configDefaults, defineProject } from 'vitest/config'

import { testLimits } from '../../packages/testkit/src/limits.ts'

export default defineProject({
  test: {
    ...testLimits,
    name: 'desktop',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The packaged app's smoke test runs on an artifact, by its own config (vitest.smoke.config.ts), and
    // its update test on a published release's (vitest.update-smoke.config.ts).
    exclude: [
      ...configDefaults.exclude,
      'test/smoke.test.ts',
      'test/update-smoke.test.ts',
    ],
  },
})
