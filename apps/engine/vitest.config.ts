import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'engine-app',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
})
