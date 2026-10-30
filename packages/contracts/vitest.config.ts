import { defineProject } from 'vitest/config'

import { testLimits } from '../testkit/src/limits.ts'

export default defineProject({
  test: {
    ...testLimits,
    name: 'contracts',
    include: ['src/**/*.test.ts'],
  },
})
