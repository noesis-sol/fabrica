import { Effect, Ref, Schedule } from 'effect'
import { Socket } from 'effect/socket'

import { describe, expect, it } from '@effect/vitest'

import { CertificateChanged, TokenRefused, tlsReconnect } from '../src/node'

// The client's reconnect over TLS (spec §8.2, §9.3): a lost connection is tried again; an engine that
// refused its certificate or token would refuse again, so it isn't.

const lost = (cause: unknown) =>
  new Socket.SocketError({
    reason: new Socket.SocketOpenError({ kind: 'Unknown', cause }),
  })

/** How many tries a connection failing with `cause` gets, with three more at most. */
const tries = (cause: unknown) =>
  Effect.gen(function* () {
    const made = yield* Ref.make(0)
    yield* Ref.update(made, count => count + 1).pipe(
      Effect.andThen(Effect.fail(lost(cause))),
      Effect.retry(tlsReconnect(Schedule.recurs(3))),
      Effect.ignore,
    )
    return yield* Ref.get(made)
  })

describe('tlsReconnect', () => {
  it.effect('tries again after a connection that was only lost', () =>
    Effect.gen(function* () {
      expect(yield* tries(new Error('connect ECONNREFUSED'))).toBe(4)
    }),
  )

  it.effect('stops at a changed certificate', () =>
    Effect.gen(function* () {
      expect(
        yield* tries(new CertificateChanged({ pinned: 'A', presented: 'B' })),
      ).toBe(1)
    }),
  )

  it.effect('stops at a refused token', () =>
    Effect.gen(function* () {
      expect(yield* tries(new TokenRefused({ status: 401 }))).toBe(1)
    }),
  )
})
