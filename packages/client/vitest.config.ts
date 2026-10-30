import { defineProject } from 'vitest/config'

import { testLimits } from '../testkit/src/limits.ts'

export default defineProject({
  test: {
    ...testLimits,
    name: 'client',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
})
