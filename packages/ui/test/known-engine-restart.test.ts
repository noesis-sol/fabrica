import { Deferred, Effect, Fiber, Layer, Queue, Stream } from 'effect'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { SocketServer } from 'effect/socket'

import { describe, expect, it } from '@effect/vitest'
import { ConnectionFailed, portServer, webPortEnd } from '@fabrica/client'
import {
  EngineHello,
  EngineId,
  EngineRpcs,
  protocolVersion,
} from '@fabrica/contracts'

import { clientName } from '../src/app/connection'
import { Message } from '../src/app/message'
import * as RemoteEngines from '../src/app/remote-engines'

// A known engine's connection as the connection process starts anew (spec §8.2): the port it was
// attempting over is dead with the process that relayed it, so its open goes unanswered; main hands
// over a new port for the same request, and the attempt is taken up over it, without waiting for the
// dead one to fail; the attempt still ends as the link over its newest port does, its pause and the
// next attempt following.

const notServed = () => Effect.die('not served')

const engine = EngineRpcs.toLayer({
  'engine.connect': () =>
    Effect.succeed(
      new EngineHello({
        protocol: protocolVersion,
        engine: EngineId.make('e-build-box'),
        release: '0.2.0',
      }),
    ),
  'engine.version': notServed,
  'engine.status': notServed,
  'engine.settings': notServed,
  'engine.stop': notServed,
  'engine.update': notServed,
  'engine.watchStatus': () => Stream.die('not served'),
  'engine.watchLoad': () => Stream.die('not served'),
})

/** A port pair, closed with the scope: the page's end, and the relay's. */
const channel = Effect.acquireRelease(
  Effect.sync(() => new MessageChannel()),
  ({ port1, port2 }) =>
    Effect.sync(() => {
      port1.close()
      port2.close()
    }),
)

/** The page's end of a port whose relay serves the test engine. */
const servedPort = Effect.gen(function* () {
  const { port1, port2 } = yield* channel
  yield* Layer.build(
    RpcServer.layer(EngineRpcs).pipe(
      Layer.provide(engine),
      Layer.provide(RpcServer.layerProtocolSocketServer),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(
        Layer.succeed(SocketServer.SocketServer, portServer(webPortEnd(port2))),
      ),
    ),
  )
  return port1
})

describe('a known engine’s connection, the connection process started anew', () => {
  it.live(
    'is taken up over the port main hands over again, the one before unanswered',
    () =>
      Effect.gen(function* () {
        // The dead process's port: nothing answers its open, which the page is seen to post.
        const dead = yield* channel
        const opened = yield* Queue.unbounded<void>()
        dead.port2.addEventListener('message', () =>
          Queue.offerUnsafe(opened, undefined),
        )
        dead.port2.start()
        const ports = yield* Queue.unbounded<MessagePort>()
        yield* Queue.offer(ports, dead.port1)
        const messages = yield* RemoteEngines.remoteEngineMessages({
          name: 'build-box',
          ports: Stream.fromQueue(ports),
          client: { name: clientName, kind: 'app', release: '0.2.0' },
          streams: () => Stream.empty,
          keep: () => Effect.void,
        }).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
        yield* Queue.take(opened)
        yield* Queue.offer(ports, yield* servedPort)
        const [connected] = yield* Fiber.join(messages)
        expect(connected?._tag).toBe('ConnectedToRemote')
      }).pipe(Effect.scoped),
  )

  it.live(
    'ends as the attempt over the newest port does, its ports still open',
    () =>
      Effect.gen(function* () {
        const { port1, port2 } = yield* channel
        yield* portServer(webPortEnd(port2))
          .run(() =>
            Effect.fail(
              new ConnectionFailed({
                reason: 'the engine could not be started',
              }),
            ),
          )
          .pipe(Effect.forkScoped)
        const ports = yield* Queue.unbounded<MessagePort>()
        yield* Queue.offer(ports, port1)
        const said: Array<Message> = []
        const paused = yield* Deferred.make<void>()
        yield* RemoteEngines.remoteEngineMessages(
          {
            name: 'build-box',
            ports: Stream.fromQueue(ports),
            client: { name: clientName, kind: 'app', release: '0.2.0' },
            streams: () => Stream.empty,
            keep: () => Effect.void,
          },
          Effect.andThen(Deferred.succeed(paused, undefined), Effect.never),
        ).pipe(
          Stream.runForEach(next => Effect.sync(() => said.push(next))),
          Effect.forkScoped,
        )
        yield* Deferred.await(paused)
        expect(said).toEqual([
          Message.FailedToConnectRemote({
            name: 'build-box',
            reason: 'the engine could not be started',
          }),
        ])
      }).pipe(Effect.scoped),
  )
})
