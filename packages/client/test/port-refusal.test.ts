import { Data, Effect, Option, Ref, Schedule } from 'effect'
import { Socket } from 'effect/socket'

import { describe, expect, it } from '@effect/vitest'

import {
  ConnectionRefused,
  connectionRefused,
  make,
  portReconnect,
  portServer,
  portSocket,
  webPortEnd,
} from '../src'

// A connection the relay refuses (spec §8.2, §9.1): its handler ends with a ConnectionRefused, which the
// port carries to the page as a `Refused` signal, its words with it; the page's reads fail with it, and
// its client's first hello; the page's reconnects stop there. Over a real MessageChannel.

/** A port pair: the page's end and the relay's, closed with the scope. */
const ports = Effect.acquireRelease(
  Effect.sync(() => new MessageChannel()),
  ({ port1, port2 }) =>
    Effect.sync(() => {
      port1.close()
      port2.close()
    }),
).pipe(
  Effect.map(({ port1, port2 }) => ({
    page: webPortEnd(port1),
    relay: webPortEnd(port2),
  })),
)

const refusal = 'the host key of u@server-1 has changed'

/** The relay's link to the engine, lost. */
class LinkLost extends Data.TaggedError('LinkLost') {}

/** The page's first connection over a relay whose handler ends with `ending`: what its read fails with. */
const firstRead = (ending: Effect.Effect<void, Error>) =>
  Effect.gen(function* () {
    const { page, relay } = yield* ports
    yield* portServer(relay)
      .run(() => ending)
      .pipe(Effect.forkScoped)
    const socket = yield* portSocket(page)
    const reader = yield* socket.reader
    return yield* Effect.flip(reader.pull)
  })

describe('a refused connection', () => {
  it.effect("fails the page's reads with the relay's words", () =>
    Effect.gen(function* () {
      const error = yield* firstRead(
        Effect.fail(new ConnectionRefused({ reason: refusal })),
      )
      expect(
        Option.map(connectionRefused(error), ({ reason }) => reason),
      ).toEqual(Option.some(refusal))
    }).pipe(Effect.scoped),
  )

  it.effect('is only a refusal where the relay says so', () =>
    Effect.gen(function* () {
      const closed = yield* firstRead(Effect.void)
      const failed = yield* firstRead(Effect.fail(new LinkLost()))
      expect(connectionRefused(closed)).toEqual(Option.none())
      expect(connectionRefused(failed)).toEqual(Option.none())
    }).pipe(Effect.scoped),
  )

  it.effect("fails the client's first hello with the relay's words", () =>
    Effect.gen(function* () {
      const { page, relay } = yield* ports
      yield* portServer(relay)
        .run(() => Effect.fail(new ConnectionRefused({ reason: refusal })))
        .pipe(Effect.forkScoped)
      const socket = yield* portSocket(page)
      const failed = yield* Effect.flip(
        make({
          name: 'test',
          kind: 'app',
          release: '0.1.0',
          reconnect: portReconnect(Schedule.recurs(5)),
        }).pipe(Effect.provideService(Socket.Socket, socket)),
      )
      expect(
        Option.map(
          failed._tag === 'RpcClientError'
            ? connectionRefused(failed)
            : Option.none(),
          ({ reason }) => reason,
        ),
      ).toEqual(Option.some(refusal))
    }).pipe(Effect.scoped),
  )

  it.effect('stops the reconnects at a refusal, and only there', () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const attempt = (cause: Error) =>
        Effect.andThen(
          Ref.update(attempts, count => count + 1),
          Effect.fail(
            new Socket.SocketError({
              reason: new Socket.SocketReadError({ cause }),
            }),
          ),
        )
      yield* Effect.ignore(
        Effect.retry(
          attempt(new ConnectionRefused({ reason: refusal })),
          portReconnect(Schedule.recurs(3)),
        ),
      )
      expect(yield* Ref.get(attempts)).toBe(1)
      yield* Ref.set(attempts, 0)
      yield* Effect.ignore(
        Effect.retry(
          attempt(new Error('lost the link')),
          portReconnect(Schedule.recurs(3)),
        ),
      )
      expect(yield* Ref.get(attempts)).toBe(4)
    }),
  )
})
