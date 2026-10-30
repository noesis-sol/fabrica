import {
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from 'effect'
import { RpcClientError, RpcSerialization, RpcServer } from 'effect/rpc'
import { Socket, SocketServer } from 'effect/socket'
import { join } from 'node:path'

import { NodeSocketServer } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import {
  EngineHello,
  EngineId,
  EngineRpcs,
  EngineStatus,
  StreamEpoch,
  type VersionMismatch,
  protocolVersion,
} from '@fabrica/contracts'
import { tempFolder } from '@fabrica/testkit'

import {
  type EngineClientShape,
  type StreamItem,
  isDefect,
  layerMemory,
  make,
} from '../src'
import { layerUnixSocket } from '../src/node'

// The streams a protocol defect ends are interrupted at the engine (fab-mgi.94): when the engine sends
// a frame the client can't read (a line longer than the NDJSON parser's buffer, 16 MiB), Effect's
// client fails every request in flight with the defect and forgets it, sending the engine nothing, so
// the engine's side of a watched stream ran on, on a connection that stays open. The client now tells
// the engine to interrupt each request the defect ended, and a request made after the defect is
// answered as any other.

/** A line longer than the NDJSON parser's buffer. */
const overlong = `${'x'.repeat(16 * 1024 * 1024 + 1)}\n`

const status = Schema.decodeUnknownSync(EngineStatus)({
  id: 'e-1',
  release: '0.1.0',
  startedAt: 1_793_268_900_000,
  host: { platform: 'linux', arch: 'x64', hostname: 'server-1', cores: 16 },
  listening: null,
  projects: 0,
  runs: 0,
  liveWorkers: 0,
  machineWorkers: 8,
  clients: 1,
  stopping: false,
})

const snapshot: StreamItem<EngineStatus, EngineStatus> = {
  _tag: 'snapshot',
  epoch: StreamEpoch.make('epoch-1'),
  seq: 0,
  value: status,
}

/** An engine that says hello and sends its status's snapshot, then nothing, until `ended`. */
const handlers = (ended: Deferred.Deferred<void>) =>
  EngineRpcs.toLayer({
    'engine.connect': () =>
      Effect.succeed(
        new EngineHello({
          protocol: protocolVersion,
          engine: EngineId.make('e-1'),
          release: '0.1.0',
        }),
      ),
    'engine.version': () => Effect.die('not served'),
    'engine.status': () => Effect.succeed(status),
    'engine.settings': () => Effect.die('not served'),
    'engine.stop': () => Effect.die('not served'),
    'engine.update': () => Effect.die('not served'),
    'engine.watchStatus': () =>
      Stream.concat(Stream.make(snapshot), Stream.never).pipe(
        Stream.ensuring(Deferred.succeed(ended, undefined)),
      ),
    'engine.watchLoad': () => Stream.die('not served'),
  })

/** The engine and the client in memory. */
const inMemory = Effect.gen(function* () {
  const memory = yield* Layer.build(layerMemory)
  return {
    socket: Context.get(memory, Socket.Socket),
    server: Context.get(memory, SocketServer.SocketServer),
  }
})

/** The engine on a Unix socket in a temp folder, and the client's socket to it. */
const onUnixSocket = Effect.gen(function* () {
  const path = join(yield* tempFolder('client'), 'engine.sock')
  const server = yield* NodeSocketServer.make({ path })
  const client = yield* Layer.build(layerUnixSocket(path))
  return { socket: Context.get(client, Socket.Socket), server }
})

/**
 * The engine over `transport`, its connections' writers kept so a test sends the client a frame of its
 * own, and `ended`, done as the engine's status stream ends.
 */
const wired = <E, R>(
  transport: Effect.Effect<
    {
      readonly socket: Socket.Socket
      readonly server: SocketServer.SocketServer['Service']
    },
    E,
    R
  >,
) =>
  Effect.gen(function* () {
    const { server, socket } = yield* transport
    const writers = yield* Ref.make<ReadonlyArray<Socket.Writer>>([])
    const keepingWriters = SocketServer.SocketServer.of({
      address: server.address,
      run: handler =>
        server.run(connection =>
          handler(
            Socket.make({
              reader: connection.reader,
              writer: Effect.tap(connection.writer, writer =>
                Ref.update(writers, kept => [...kept, writer]),
              ),
            }),
          ),
        ),
    })
    const ended = yield* Deferred.make<void>()
    yield* Layer.build(
      RpcServer.layer(EngineRpcs, { disableFatalDefects: true }).pipe(
        Layer.provide(handlers(ended)),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(Layer.succeed(SocketServer.SocketServer, keepingWriters)),
      ),
    )
    return {
      socket: Context.make(Socket.Socket, socket),
      ended: Deferred.await(ended),
      /** Sends `frame` to the client on every connection the engine has had. */
      send: (frame: string) =>
        Effect.flatMap(Ref.get(writers), kept =>
          Effect.forEach(kept, writer =>
            Effect.ignore(writer.write(new TextEncoder().encode(frame))),
          ),
        ),
    }
  })

/** The client's status stream: its first item, and how it ended. */
const watchStatus = (client: EngineClientShape) =>
  Effect.gen(function* () {
    const items =
      yield* Queue.unbounded<StreamItem<EngineStatus, EngineStatus>>()
    const ended =
      yield* Deferred.make<
        Exit.Exit<void, VersionMismatch | RpcClientError.RpcClientError>
      >()
    yield* client
      .watch(resume => client.rpc['engine.watchStatus']({ resume }))
      .pipe(
        Stream.runForEach(item => Queue.offer(items, item)),
        Effect.exit,
        Effect.flatMap(exit => Deferred.succeed(ended, exit)),
        Effect.forkScoped,
      )
    return { take: Queue.take(items), ended: Deferred.await(ended) }
  })

/** Whether a stream ended with a client error that is a defect. */
const endedWithDefect = (
  exit: Exit.Exit<void, VersionMismatch | RpcClientError.RpcClientError>,
) =>
  Option.exists(
    Exit.findErrorOption(exit),
    error => error instanceof RpcClientError.RpcClientError && isDefect(error),
  )

const options = {
  name: 'test client',
  kind: 'cli',
  release: '0.1.0',
} as const

describe('the streams a protocol defect ends', () => {
  it.live('are interrupted at the engine, over the local socket', () =>
    Effect.gen(function* () {
      const { socket, send, ended } = yield* wired(onUnixSocket)
      const client = yield* make(options).pipe(Effect.provide(socket))
      const watched = yield* watchStatus(client)
      expect((yield* watched.take)._tag).toBe('snapshot')
      yield* send(overlong)
      expect(endedWithDefect(yield* watched.ended)).toBe(true)
      yield* ended
    }),
  )

  it.live('are interrupted at the engine, in memory', () =>
    Effect.gen(function* () {
      const { socket, send, ended } = yield* wired(inMemory)
      const client = yield* make(options).pipe(Effect.provide(socket))
      const watched = yield* watchStatus(client)
      expect((yield* watched.take)._tag).toBe('snapshot')
      yield* send(overlong)
      expect(endedWithDefect(yield* watched.ended)).toBe(true)
      yield* ended
    }),
  )

  it.live('leave a request made as the defect ends them to be answered', () =>
    Effect.gen(function* () {
      const { socket, send } = yield* wired(onUnixSocket)
      const client = yield* make(options).pipe(Effect.provide(socket))
      const asked =
        yield* Deferred.make<
          Exit.Exit<EngineStatus, RpcClientError.RpcClientError>
        >()
      const watched = yield* watchStatus(client)
      yield* client
        .watch(resume => client.rpc['engine.watchStatus']({ resume }))
        .pipe(
          Stream.runDrain,
          Effect.ignore,
          Effect.andThen(Effect.exit(client.rpc['engine.status']())),
          Effect.flatMap(exit => Deferred.succeed(asked, exit)),
          Effect.forkScoped,
        )
      expect((yield* watched.take)._tag).toBe('snapshot')
      yield* send(overlong)
      expect(endedWithDefect(yield* watched.ended)).toBe(true)
      expect(Exit.isSuccess(yield* Deferred.await(asked))).toBe(true)
      expect(
        Exit.isSuccess(yield* Effect.exit(client.rpc['engine.status']())),
      ).toBe(true)
    }),
  )
})
