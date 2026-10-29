import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'pi-extension',
    include: ['src/**/*.test.ts'],
  },
})
