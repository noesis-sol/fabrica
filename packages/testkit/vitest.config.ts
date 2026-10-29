import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'testkit',
    include: ['test/**/*.test.ts'],
  },
})
