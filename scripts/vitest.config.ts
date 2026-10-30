import { defineProject } from 'vitest/config'

import { testLimits } from '../packages/testkit/src/limits.ts'

export default defineProject({
  test: {
    ...testLimits,
    name: 'scripts',
    include: ['*.test.ts'],
  },
})
