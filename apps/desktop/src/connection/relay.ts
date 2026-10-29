import { Context, Effect, Layer, type Scope } from 'effect'
import { Socket } from 'effect/socket'

import { type PortEnd, portClosed, portServer } from '@fabrica/client'
import { layerUnixSocket } from '@fabrica/client/node'

import { ConnectionTarget } from './target'

// The connection process's relay (spec §5, §8.2): it owns the connections to the engine, and copies
// RPC frames, as bytes, between each connection the page opens on its port and a connection of its
// own to the engine. It reads nothing in them: the page runs the engine client, which says hello and
// resumes its streams after each reconnect. A connection the engine drops is closed to the page, and
// the page's client opens the next, for which the relay opens a new engine connection.

/** A socket to the engine, made anew for each connection the page opens, and closed with its scope. */
export type EngineSocket = Effect.Effect<Socket.Socket, never, Scope.Scope>

/** The engine's socket for `target`. */
export const engineSocket = (target: ConnectionTarget): EngineSocket =>
  ConnectionTarget.match(target, {
    LocalSocket: ({ path }) =>
      Effect.map(
        Layer.build(layerUnixSocket(path)),
        Context.get(Socket.Socket),
      ),
    Unavailable: ({ reason }) =>
      Socket.fromTransformStream(
        Effect.fail(
          new Socket.SocketError({
            reason: new Socket.SocketOpenError({
              kind: 'Unknown',
              cause: new Error(reason),
            }),
          }),
        ),
      ),
  })

/** Copies `from`'s frames to `to` until `from` ends. */
const copy = (from: Socket.Reader, to: Socket.Writer) =>
  Effect.forever(Effect.flatMap(from.pull, frames => to.writeAll(frames)))

/** Joins one connection of the page's to a new one to the engine, until either ends. */
const join = Effect.fn('ConnectionRelay.join')(function* (
  page: Socket.Socket,
  engine: EngineSocket,
) {
  const socket = yield* engine
  const fromEngine = yield* socket.reader
  const toEngine = yield* socket.writer
  const fromPage = yield* page.reader
  const toPage = yield* page.writer
  yield* Effect.raceFirst(copy(fromEngine, toPage), copy(fromPage, toEngine))
}, Effect.scoped)

/** Relays the page's connections on `port` to the engine until the port closes. */
export const relay = Effect.fn('ConnectionRelay.relay')(function* (options: {
  readonly port: PortEnd
  readonly engine: EngineSocket
}) {
  yield* Effect.raceFirst(
    portServer(options.port).run(page => join(page, options.engine)),
    portClosed(options.port),
  )
})
