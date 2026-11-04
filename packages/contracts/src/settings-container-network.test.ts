import { Effect, Option, Schema } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import { Container } from './settings'

// A container's network (spec §12.7, "the network as configured"): the settings may name one, and leave
// it to the runtime otherwise.

describe('a container network', () => {
  it.effect('is read and written where the settings name one', () =>
    Effect.gen(function* () {
      const container = yield* Schema.decodeUnknownEffect(Container)({
        image: 'node:26',
        network: 'none',
      })
      expect(container.network).toEqual(Option.some('none'))
      expect(yield* Schema.encodeEffect(Container)(container)).toEqual({
        image: 'node:26',
        network: 'none',
      })
    }),
  )

  it.effect('is none otherwise, and written as nothing', () =>
    Effect.gen(function* () {
      const container = yield* Schema.decodeUnknownEffect(Container)({
        image: 'node:26',
      })
      expect(container.network).toEqual(Option.none())
      expect(yield* Schema.encodeEffect(Container)(container)).toEqual({
        image: 'node:26',
      })
    }),
  )
})
