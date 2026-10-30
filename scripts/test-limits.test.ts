import { fileURLToPath } from 'node:url'
import { createVitest } from 'vitest/node'

import { describe, expect, it } from '@effect/vitest'

import { testLimits } from '../packages/testkit/src/limits.ts'

// Every project the root Vitest config runs resolves its tests' time limit to the one the test kit sets
// (spec §24, fab-mgi.93): a project's config file inherits nothing of the root's, so a project whose
// config leaves testLimits out runs at Vitest's own 5 s.

const root = fileURLToPath(new URL('..', import.meta.url))

describe('the test time limit', () => {
  it('is the test kit’s in every project', async () => {
    const vitest = await createVitest('test', { root, watch: false })
    try {
      const limits = vitest.projects.map(project => [
        project.name,
        project.config.testTimeout,
      ])
      expect(limits.length).toBeGreaterThan(1)
      expect(limits).toEqual(
        limits.map(([name]) => [name, testLimits.testTimeout]),
      )
    } finally {
      await vitest.close()
    }
  })
})
