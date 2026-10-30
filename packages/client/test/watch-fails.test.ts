import {
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Ref,
  Schedule,
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
  Link,
  MemoryTransport,
  type StreamItem,
  isDefect,
  layerMemory,
  make,
} from '../src'
import { maxFrame } from '../src/frames'
import { layerUnixSocket } from '../src/node'

// A watched stream fails where no reconnect follows the error it got (fab-mgi.25), rather than wait
// for one for ever: when the client's `reconnect` schedule ends after a lost connection, its link is
// `Lost` and the stream ends with the connection's loss; when the engine sends a frame the client
// can't read, which Effect's socket protocol reports as a defect on a connection it keeps open, the
// stream ends with that defect. (Its NDJSON parser skips a line that isn't JSON: what it can't read is
// a line longer than its buffer, `maxFrame`, sent here over the local socket as the CLI reaches its
// engine.)

/** A line longer than the NDJSON parser's buffer. */
const overlong = `${'x'.repeat(maxFrame + 1)}\n`

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

/** An engine that says hello and sends its status's snapshot, then nothing. */
const handlers = EngineRpcs.toLayer({
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
    Stream.concat(Stream.make(snapshot), Stream.never),
  'engine.watchLoad': () => Stream.die('not served'),
})

/** The engine and the client in memory: the client's socket, the engine's server, and the drop. */
const inMemory = Effect.gen(function* () {
  const memory = yield* Layer.build(layerMemory)
  return {
    socket: Context.get(memory, Socket.Socket),
    server: Context.get(memory, SocketServer.SocketServer),
    drop: Context.get(memory, MemoryTransport).drop,
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
 * own, and the client's socket, whose opens fail once `refuse` is set, as an engine gone for good.
 */
const wired = <
  T extends {
    readonly socket: Socket.Socket
    readonly server: SocketServer.SocketServer['Service']
  },
  E,
  R,
>(
  transport: Effect.Effect<T, E, R>,
) =>
  Effect.gen(function* () {
    const wire = yield* transport
    const { server, socket } = wire
    const writers = yield* Ref.make<ReadonlyArray<Socket.Writer>>([])
    const keepingWriters = SocketServer.SocketServer.of({
      address: server.address,
      run: handler =>
        server.run(socket =>
          handler(
            Socket.make({
              reader: socket.reader,
              writer: Effect.tap(socket.writer, writer =>
                Ref.update(writers, kept => [...kept, writer]),
              ),
            }),
          ),
        ),
    })
    yield* Layer.build(
      RpcServer.layer(EngineRpcs).pipe(
        Layer.provide(handlers),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(Layer.succeed(SocketServer.SocketServer, keepingWriters)),
      ),
    )
    const refusing = yield* Ref.make(false)
    const refusable = Socket.make({
      reader: Effect.flatMap(Ref.get(refusing), refused =>
        refused
          ? Effect.fail(
              new Socket.SocketError({
                reason: new Socket.SocketOpenError({
                  kind: 'Unknown',
                  cause: new Error('no engine'),
                }),
              }),
            )
          : socket.reader,
      ),
      writer: socket.writer,
    })
    return {
      ...wire,
      socket: Context.make(Socket.Socket, refusable),
      refuse: Ref.set(refusing, true),
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

/** Whether a stream ended with a client error, and whether that was a defect. */
const failure = (
  exit: Exit.Exit<void, VersionMismatch | RpcClientError.RpcClientError>,
) =>
  Option.map(Exit.findErrorOption(exit), error =>
    error instanceof RpcClientError.RpcClientError
      ? { client: true, defect: isDefect(error) }
      : { client: false, defect: false },
  )

const options = {
  name: 'test client',
  kind: 'cli',
  release: '0.1.0',
} as const

describe('a watched stream no reconnect follows', () => {
  it.live(
    'ends with the lost connection once the reconnect schedule ends',
    () =>
      Effect.gen(function* () {
        const { socket, drop, refuse } = yield* wired(inMemory)
        const client = yield* make({
          ...options,
          reconnect: Schedule.upTo(Schedule.spaced('10 millis'), { times: 2 }),
        }).pipe(Effect.provide(socket))
        const { take, ended } = yield* watchStatus(client)
        expect((yield* take)._tag).toBe('snapshot')
        yield* refuse
        yield* drop
        expect(failure(yield* ended)).toStrictEqual(
          Option.some({ client: true, defect: false }),
        )
        const link = yield* client.link
        expect(Link.$is('Lost')(link)).toBe(true)
        const asked = yield* Effect.flip(client.rpc['engine.status']())
        expect(asked).toBeInstanceOf(RpcClientError.RpcClientError)
      }),
  )

  it.live('fails a stream watched after the link is lost', () =>
    Effect.gen(function* () {
      const { socket, drop, refuse } = yield* wired(inMemory)
      const client = yield* make({
        ...options,
        reconnect: Schedule.upTo(Schedule.spaced('10 millis'), { times: 1 }),
      }).pipe(Effect.provide(socket))
      yield* refuse
      yield* drop
      yield* client.links.pipe(Stream.filter(Link.$is('Lost')), Stream.runHead)
      const { ended } = yield* watchStatus(client)
      expect(failure(yield* ended)).toStrictEqual(
        Option.some({ client: true, defect: false }),
      )
    }),
  )

  it.live(
    'ends with a defect when the engine sends a frame it can’t read',
    () =>
      Effect.gen(function* () {
        const { socket, send } = yield* wired(onUnixSocket)
        const client = yield* make(options).pipe(Effect.provide(socket))
        const { take, ended } = yield* watchStatus(client)
        expect((yield* take)._tag).toBe('snapshot')
        yield* send(overlong)
        expect(failure(yield* ended)).toStrictEqual(
          Option.some({ client: true, defect: true }),
        )
        // The connection stays open, and up: no reconnect would have followed.
        const link = yield* client.link
        expect(Link.$is('Up')(link) && link.connection).toBe(1)
      }),
  )
})
