import { defineProject } from 'vitest/config'

import { testLimits } from './src/limits.ts'

export default defineProject({
  test: {
    ...testLimits,
    name: 'testkit',
    include: ['test/**/*.test.ts'],
  },
})
