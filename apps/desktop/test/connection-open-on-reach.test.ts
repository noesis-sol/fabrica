import { Deferred, Effect, Fiber, Layer, Option, Stream } from 'effect'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { Socket, SocketServer } from 'effect/socket'
import { TestClock } from 'effect/testing'
import { join } from 'node:path'

import { NodeSocketServer } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { Link, make, portSocket, webPortEnd } from '@fabrica/client'
import { EngineHello, EngineId, EngineRpcs } from '@fabrica/contracts'
import { tempFolder } from '@fabrica/testkit'

import { LocalEngineReach } from '../src/connection/local-engine'
import { relay } from '../src/connection/relay'
import { ConnectionTarget } from '../src/connection/target'
import {
  type EngineSocket,
  engineSocket,
  saidOf,
} from '../src/connection/transports'

/** The local engine answers: main's answer to every ask. */
const engineAnswers = Effect.succeed(LocalEngineReach.cases.Reached.make({}))

// The page's connection through the relay opens once the relay's own connection to the engine has
// (H61): while that waits (ssh asking for a passphrase, a cold engine starting), the page's client waits
// on its open, so the RPC's pinger, which fails a connection whose ping goes unanswered for about 10 s
// once it opens, never fails it. The engine's open here waits on the test's word; on the TestClock.

/** A minimal engine on a Unix socket in a temp folder: its hello, nothing else. */
const serveEngine = Effect.gen(function* () {
  const handlers = EngineRpcs.toLayer({
    'engine.connect': hello =>
      Effect.succeed(
        new EngineHello({
          protocol: hello.protocol,
          engine: EngineId.make('e-1'),
          release: '0.1.0',
        }),
      ),
    'engine.version': () => Effect.die('not served'),
    'engine.status': () => Effect.die('not served'),
    'engine.settings': () => Effect.die('not served'),
    'engine.stop': () => Effect.die('not served'),
    'engine.update': () => Effect.die('not served'),
    'engine.watchStatus': () => Stream.die('not served'),
    'engine.watchLoad': () => Stream.die('not served'),
  })
  const path = join(yield* tempFolder('open-on-reach'), 'engine.sock')
  const server: SocketServer.SocketServer['Service'] =
    yield* NodeSocketServer.make({ path })
  yield* Layer.build(
    RpcServer.layer(EngineRpcs).pipe(
      Layer.provide(handlers),
      Layer.provide(RpcServer.layerProtocolSocketServer),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(Layer.succeed(SocketServer.SocketServer, server)),
    ),
  )
  return path
})

/** The engine at `path`, its every open told to `opening` and held until `reached`. */
const heldEngine = (
  path: string,
  opening: Deferred.Deferred<void>,
  reached: Deferred.Deferred<void>,
): EngineSocket =>
  Effect.map(
    engineSocket(ConnectionTarget.cases.LocalSocket.make({ path }), {
      env: {},
      localEngine: engineAnswers,
      askpass: Option.none(),
    }),
    socket =>
      Socket.make({
        reader: Deferred.succeed(opening, undefined).pipe(
          Effect.andThen(Deferred.await(reached)),
          Effect.andThen(socket.reader),
        ),
        writer: socket.writer,
      }),
  )

/** One turn of the event loop, for the port's messages to cross. */
const turn = Effect.promise(
  () => new Promise<void>(resolve => setImmediate(resolve)),
)

/**
 * Moves the TestClock on 30 s, past the pinger's 10 s, a second at a time with turns of the event
 * loop between: the pinger writes its ping before it waits for the next.
 */
const holdPastPinger = Effect.forEach(
  Array.from({ length: 30 }),
  () =>
    Effect.andThen(TestClock.adjust('1 second'), Effect.andThen(turn, turn)),
  { discard: true },
)

describe('a page connection through the relay', () => {
  it.effect(
    'opens once the engine is reached, and says hello on its first connection',
    () =>
      Effect.gen(function* () {
        const path = yield* serveEngine
        const opening = yield* Deferred.make<void>()
        const reached = yield* Deferred.make<void>()
        const channel = yield* Effect.acquireRelease(
          Effect.sync(() => new MessageChannel()),
          ({ port1, port2 }) =>
            Effect.sync(() => {
              port1.close()
              port2.close()
            }),
        )
        yield* Effect.forkScoped(
          relay({
            port: webPortEnd(channel.port2),
            engine: heldEngine(path, opening, reached),
            said: saidOf,
          }),
        )
        const starting = yield* Effect.forkChild(
          Effect.flatMap(portSocket(webPortEnd(channel.port1)), socket =>
            make({ name: 'test app', kind: 'app', release: '0.1.0' }).pipe(
              Effect.provideService(Socket.Socket, socket),
            ),
          ),
        )
        yield* Deferred.await(opening)
        yield* holdPastPinger
        yield* Deferred.succeed(reached, undefined)
        const client = yield* Fiber.join(starting)
        const link = yield* client.link
        expect(Link.$is('Up')(link) && link.connection).toBe(1)
      }).pipe(Effect.scoped),
  )
})
