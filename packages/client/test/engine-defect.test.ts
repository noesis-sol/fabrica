import { Context, Effect, Layer, Option, Stream } from 'effect'
import { RpcClientError, RpcSerialization, RpcServer } from 'effect/rpc'
import { SocketServer } from 'effect/socket'

import { describe, expect, it } from '@effect/vitest'
import {
  EngineHello,
  EngineId,
  EngineRpcs,
  type VersionMismatch,
  protocolVersion,
} from '@fabrica/contracts'

import { type EngineClientShape, isDefect, layerMemory, make } from '../src'

// The engine's defects reaching the client (fab-mgi.87): the engine answers a request or stream it
// doesn't serve yet with a defect, `NotImplemented`, as its server does any request whose group it
// doesn't serve. The client fails such a request or stream with an `RpcClientError` whose reason is an
// `RpcClientDefect`, which its callers catch, and a watched stream ends with it.

/** What the engine's unserved handlers die with (packages/engine/src/rpc/not-implemented.ts). */
class NotImplemented extends Error {
  override readonly name = 'NotImplemented'
  constructor(readonly rpc: string) {
    super(`${rpc} is not implemented yet`)
  }
}

const notImplemented = (rpc: string) => () =>
  Effect.die(new NotImplemented(rpc))

/** An engine that says hello and serves nothing else of the Engine group. */
const handlers = EngineRpcs.toLayer({
  'engine.connect': () =>
    Effect.succeed(
      new EngineHello({
        protocol: protocolVersion,
        engine: EngineId.make('e-1'),
        release: '0.1.0',
      }),
    ),
  'engine.version': notImplemented('engine.version'),
  'engine.status': notImplemented('engine.status'),
  'engine.settings': notImplemented('engine.settings'),
  'engine.stop': notImplemented('engine.stop'),
  'engine.update': notImplemented('engine.update'),
  'engine.watchStatus': notImplemented('engine.watchStatus'),
  'engine.watchLoad': () => Stream.die(new NotImplemented('engine.watchLoad')),
})

/** A client of that engine, in memory. */
const connected = Effect.gen(function* () {
  const memory = yield* Layer.build(layerMemory)
  yield* Layer.build(
    // As the engine's server does (packages/engine/src/rpc/server.ts), a defect answers its own request.
    RpcServer.layer(EngineRpcs, { disableFatalDefects: true }).pipe(
      Layer.provide(handlers),
      Layer.provide(RpcServer.layerProtocolSocketServer),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(
        Layer.succeed(
          SocketServer.SocketServer,
          Context.get(memory, SocketServer.SocketServer),
        ),
      ),
    ),
  )
  return yield* make({
    name: 'test client',
    kind: 'cli',
    release: '0.1.0',
  }).pipe(Effect.provide(memory))
})

/** The client error's reason and message, where the failure is one. */
const defectOf = (error: RpcClientError.RpcClientError | VersionMismatch) =>
  error instanceof RpcClientError.RpcClientError
    ? Option.some({
        defect: isDefect(error),
        message: error.reason.message,
      })
    : Option.none()

const watchLoad = (client: EngineClientShape) =>
  client.watch(resume => client.rpc['engine.watchLoad']({ resume }))

describe("the engine's defects", () => {
  it.live('fail a request as a client defect, the client still up', () =>
    Effect.gen(function* () {
      const client = yield* connected
      const error = yield* Effect.flip(client.rpc['engine.status']())
      expect(defectOf(error)).toStrictEqual(
        Option.some({
          defect: true,
          message: 'engine.status failed: engine.status is not implemented yet',
        }),
      )
      const hello = yield* client.rpc['engine.connect']({
        name: 'test client',
        kind: 'cli',
        release: '0.1.0',
        protocol: protocolVersion,
      })
      expect(hello.engine).toBe('e-1')
    }),
  )

  it.live('fail a stream, whether its handler dies or its stream does', () =>
    Effect.gen(function* () {
      const client = yield* connected
      const dying = yield* Effect.flip(
        Stream.runDrain(
          client.rpc['engine.watchStatus']({ resume: Option.none() }),
        ),
      )
      expect(defectOf(dying)).toStrictEqual(
        Option.some({
          defect: true,
          message:
            'engine.watchStatus failed: engine.watchStatus is not implemented yet',
        }),
      )
      const failing = yield* Effect.flip(
        Stream.runDrain(
          client.rpc['engine.watchLoad']({ resume: Option.none() }),
        ),
      )
      expect(defectOf(failing)).toStrictEqual(
        Option.some({
          defect: true,
          message:
            'engine.watchLoad failed: engine.watchLoad is not implemented yet',
        }),
      )
    }),
  )

  it.live('end a watched stream rather than wait for a reconnect', () =>
    Effect.gen(function* () {
      const client = yield* connected
      const error = yield* Effect.flip(Stream.runDrain(watchLoad(client)))
      expect(Option.map(defectOf(error), ({ defect }) => defect)).toStrictEqual(
        Option.some(true),
      )
    }),
  )

  it.live("fail a request of a group the engine doesn't serve", () =>
    Effect.gen(function* () {
      const client = yield* connected
      const error = yield* Effect.flip(
        client.rpc['attention.list']({ project: Option.none() }),
      )
      expect(
        error instanceof RpcClientError.RpcClientError && isDefect(error),
      ).toBe(true)
    }),
  )
})
