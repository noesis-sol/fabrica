import { Effect, Option, Ref, Schedule } from 'effect'
import { Socket } from 'effect/socket'

import { describe, expect, it } from '@effect/vitest'

import {
  ConnectionFailed,
  connectionFailed,
  connectionRefused,
  make,
  portReconnect,
  portServer,
  portSocket,
  webPortEnd,
} from '../src'

// A connection the relay couldn't make, in words (spec §7.1, §8.2): its handler ends with a
// ConnectionFailed (the local engine couldn't be started), which the port carries to the page as a
// `Failed` signal, its words with it; the page's open fails with it, and its client's first hello, as
// a failure, not a refusal; the page's reconnects stop there, so its next attempt says the words.
// Over a real MessageChannel.

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

const failure = 'the bundled engine couldn’t be installed: no space left'

/** The relay, its every connection failing with the failure's words. */
const failingRelay = (relay: ReturnType<typeof webPortEnd>) =>
  portServer(relay)
    .run(() => Effect.fail(new ConnectionFailed({ reason: failure })))
    .pipe(Effect.forkScoped)

describe('a connection the relay failed in words', () => {
  it.effect(
    "fails the page's open with the relay's words, not as refused",
    () =>
      Effect.gen(function* () {
        const { page, relay } = yield* ports
        yield* failingRelay(relay)
        const socket = yield* portSocket(page)
        const error = yield* Effect.flip(Effect.scoped(socket.reader))
        expect(
          Option.map(connectionFailed(error), ({ reason }) => reason),
        ).toEqual(Option.some(failure))
        expect(connectionRefused(error)).toEqual(Option.none())
      }).pipe(Effect.scoped),
  )

  it.effect("fails the client's first hello with the relay's words", () =>
    Effect.gen(function* () {
      const { page, relay } = yield* ports
      yield* failingRelay(relay)
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
            ? connectionFailed(failed)
            : Option.none(),
          ({ reason }) => reason,
        ),
      ).toEqual(Option.some(failure))
    }).pipe(Effect.scoped),
  )

  it.effect('stops the reconnects at the failure', () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const attempt: Effect.Effect<never, Socket.SocketError> = Effect.andThen(
        Ref.update(attempts, count => count + 1),
        Effect.fail(
          new Socket.SocketError({
            reason: new Socket.SocketOpenError({
              kind: 'Unknown',
              cause: new ConnectionFailed({ reason: failure }),
            }),
          }),
        ),
      )
      yield* Effect.ignore(
        Effect.retry(attempt, portReconnect(Schedule.recurs(3))),
      )
      expect(yield* Ref.get(attempts)).toBe(1)
    }),
  )
})
