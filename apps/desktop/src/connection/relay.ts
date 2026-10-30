import { Effect, Option } from 'effect'
import type { Socket } from 'effect/socket'

import {
  type ConnectionFailed,
  type ConnectionRefused,
  type PortEnd,
  portClosed,
  portServer,
} from '@fabrica/client'

import type { EngineSocket } from './transports'

// The connection process's relay (spec §5, §8.2): it owns the connections to the engine, and copies
// RPC frames, as bytes, between each connection the page opens on its port and a connection of its
// own to the engine. It reads nothing in them: the page runs the engine client, which says hello and
// resumes its streams after each reconnect. A connection the engine drops is closed to the page, and
// the page's client opens the next, for which the relay opens a new engine connection; one refused, in a
// way trying again won't mend (ssh refused the host's key), is said to the page as refused, in words, so
// its client stops reconnecting and the app shows why; one that failed in words (the local engine
// couldn't be started) is said as failed, and the app shows why as it tries again.

/** Copies `from`'s frames to `to` until `from` ends. */
const copy = (from: Socket.Reader, to: Socket.Writer) =>
  Effect.forever(Effect.flatMap(from.pull, frames => to.writeAll(frames)))

/** What the relay says of an engine connection's failure: a refusal or a failure in words, or nothing. */
export type Said = (
  error: Socket.SocketError,
) => Option.Option<ConnectionRefused | ConnectionFailed>

/**
 * Joins one connection of the page's to a new one to the engine, until either ends; a refusal or a
 * failure in words is said.
 * The page's connection is read only once the engine's is open, so the page's opens only then (H61):
 * while ssh asks for what it needs, or a cold engine starts, the page's client waits on its open.
 */
const join = Effect.fn('ConnectionRelay.join')(function* (
  page: Socket.Socket,
  engine: EngineSocket,
  said: Said,
) {
  return yield* Effect.gen(function* () {
    const socket = yield* engine
    const fromEngine = yield* socket.reader
    const toEngine = yield* socket.writer
    // The page's connection opens here, as it is first read.
    const fromPage = yield* page.reader
    const toPage = yield* page.writer
    return yield* Effect.raceFirst(
      copy(fromEngine, toPage),
      copy(fromPage, toEngine),
    )
  }).pipe(
    Effect.scoped,
    Effect.catchTag('SocketError', error =>
      Effect.fail(
        Option.match(said(error), {
          onNone: ():
            | Socket.SocketError
            | ConnectionRefused
            | ConnectionFailed => error,
          onSome: words => words,
        }),
      ),
    ),
  )
})

/** Relays the page's connections on `port` to the engine until the port closes. */
export const relay = Effect.fn('ConnectionRelay.relay')(function* (options: {
  readonly port: PortEnd
  readonly engine: EngineSocket
  readonly said: Said
}) {
  yield* Effect.raceFirst(
    portServer(options.port).run(page =>
      join(page, options.engine, options.said),
    ),
    portClosed(options.port),
  )
})
