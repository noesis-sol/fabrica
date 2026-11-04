import { Effect } from 'effect'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'

import { linuxDistribution } from '../src/hosting'
import { DISTRIBUTION_LAYOUT } from '../src/layout'

// The Linux distribution a project's containers mount (spec §12.7): a Linux engine's own, and refused for
// an engine run from a checkout. A macOS engine's fetch is the update's tests'.

describe('linuxDistribution', () => {
  const inDistribution = NodePath.join(
    '/opt/engine',
    DISTRIBUTION_LAYOUT.bundle,
  )

  it.effect("is a Linux engine's own folder", () =>
    Effect.gen(function* () {
      const found = yield* linuxDistribution({
        self: inDistribution,
        data: '/data',
        release: '0.2.0',
        platform: 'linux',
        arch: 'x64',
      })
      expect(found).toEqual({
        root: '/opt/engine',
        node: DISTRIBUTION_LAYOUT.node,
        cli: DISTRIBUTION_LAYOUT.piCli,
        extension: DISTRIBUTION_LAYOUT.extension,
      })
    }),
  )

  it.effect('is refused for an engine run from a checkout', () =>
    Effect.gen(function* () {
      const why = yield* linuxDistribution({
        self: '/repo/apps/engine/src/main.ts',
        data: '/data',
        release: '0.2.0',
        platform: 'linux',
        arch: 'x64',
      }).pipe(Effect.flip)
      expect(why).toContain('from a checkout')
    }),
  )

  it.effect('is refused on a machine releases have none for', () =>
    Effect.gen(function* () {
      const why = yield* linuxDistribution({
        self: inDistribution,
        data: '/data',
        release: '0.2.0',
        platform: 'darwin',
        arch: 'ppc64',
      }).pipe(Effect.flip)
      expect(why).toContain('no Linux distribution')
    }),
  )
})
