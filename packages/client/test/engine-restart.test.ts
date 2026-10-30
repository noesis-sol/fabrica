import {
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Schema,
  Scope,
  Stream,
} from 'effect'
import { RpcClientError, RpcSerialization, RpcServer } from 'effect/rpc'
import { SocketServer } from 'effect/socket'
import { join } from 'node:path'

import { NodeSocketServer } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import {
  EngineHello,
  EngineId,
  EngineRpcs,
  EngineStatus,
  Resume,
  StreamEpoch,
  type VersionMismatch,
  protocolVersion,
} from '@fabrica/contracts'
import { tempFolder } from '@fabrica/testkit'

import {
  type EngineClientShape,
  Link,
  type StreamItem,
  isDefect,
  make,
} from '../src'
import { layerUnixSocket } from '../src/node'

// A graceful stop of the engine (SIGTERM, `engine.stop`, an update's restart) is a lost connection
// the next engine mends (fab-mgi.4.47): Effect's RPC server, as it stops, interrupts every request in
// flight and answers each with its interrupt before it closes the connection. The client takes that
// answer as the connection's loss: a watched stream resumes from where it stood once the engine is
// back, and a request in flight fails with a client error its caller catches, rather than both being
// interrupted. The client's own close still interrupts what it has in flight.

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

/** What the engine saw: each status subscription's resume, and each settings request as it came. */
interface Seen {
  readonly resumes: Queue.Queue<Option.Option<Resume>>
  readonly asked: Queue.Queue<void>
}

/**
 * An engine that says hello, sends its status's snapshot and then nothing, and never answers a
 * settings request.
 */
const handlers = (seen: Seen) =>
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
    'engine.settings': () =>
      Effect.andThen(Queue.offer(seen.asked, undefined), Effect.never),
    'engine.stop': () => Effect.die('not served'),
    'engine.update': () => Effect.die('not served'),
    'engine.watchStatus': ({ resume }) =>
      Stream.unwrap(
        Effect.as(
          Queue.offer(seen.resumes, resume),
          Stream.concat(Stream.make(snapshot), Stream.never),
        ),
      ),
    'engine.watchLoad': () => Stream.die('not served'),
  })

/** An engine on the Unix socket at `path`, stopped gracefully as `stop` closes its scope. */
const engineAt = (path: string, seen: Seen) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* Effect.gen(function* () {
      const server = yield* NodeSocketServer.make({ path })
      yield* Layer.build(
        RpcServer.layer(EngineRpcs).pipe(
          Layer.provide(handlers(seen)),
          Layer.provide(RpcServer.layerProtocolSocketServer),
          Layer.provide(RpcSerialization.layerNdjson),
          Layer.provide(Layer.succeed(SocketServer.SocketServer, server)),
        ),
      )
    }).pipe(Scope.provide(scope))
    return { stop: Scope.close(scope, Exit.void) }
  })

/** A folder for the engine's socket, what the engine sees, and the client's socket to it. */
const wired = Effect.gen(function* () {
  const path = join(yield* tempFolder('client'), 'engine.sock')
  const seen: Seen = {
    resumes: yield* Queue.unbounded<Option.Option<Resume>>(),
    asked: yield* Queue.unbounded<void>(),
  }
  const socket = yield* Layer.build(layerUnixSocket(path))
  return { path, seen, socket }
})

/** The client's status stream: each item, and whether it has ended. */
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
    return { take: Queue.take(items), done: Deferred.isDone(ended) }
  })

/** A settings request in flight, forked: how it ended. */
const askSettings = (client: EngineClientShape, seen: Seen) =>
  Effect.gen(function* () {
    const ended =
      yield* Deferred.make<Exit.Exit<unknown, RpcClientError.RpcClientError>>()
    yield* client.rpc['engine.settings']().pipe(
      Effect.exit,
      Effect.flatMap(exit => Deferred.succeed(ended, exit)),
      Effect.forkScoped,
    )
    yield* Queue.take(seen.asked)
    return Deferred.await(ended)
  })

/** The link's next change to `Up` on a connection after `connection`. */
const upAfter = (client: EngineClientShape, connection: number) =>
  client.links.pipe(
    Stream.filter(link => Link.$is('Up')(link) && link.connection > connection),
    Stream.runHead,
  )

const options = {
  name: 'test client',
  kind: 'cli',
  release: '0.1.0',
} as const

describe('a graceful engine stop', () => {
  it.live(
    'resumes a watched stream from where it stood once the engine is back',
    () =>
      Effect.gen(function* () {
        const { path, seen, socket } = yield* wired
        const first = yield* engineAt(path, seen)
        const client = yield* make(options).pipe(Effect.provide(socket))
        const watched = yield* watchStatus(client)
        expect(yield* Queue.take(seen.resumes)).toStrictEqual(Option.none())
        expect((yield* watched.take)._tag).toBe('snapshot')

        yield* first.stop
        yield* engineAt(path, seen)
        yield* upAfter(client, 1)

        expect(yield* Queue.take(seen.resumes)).toStrictEqual(
          Option.some(
            new Resume({ epoch: snapshot.epoch, after: snapshot.seq }),
          ),
        )
        expect((yield* watched.take)._tag).toBe('snapshot')
        expect(yield* watched.done).toBe(false)
      }),
  )

  it.live('fails a request in flight as a lost connection, not a defect', () =>
    Effect.gen(function* () {
      const { path, seen, socket } = yield* wired
      const engine = yield* engineAt(path, seen)
      const client = yield* make(options).pipe(Effect.provide(socket))
      const ended = yield* askSettings(client, seen)

      yield* engine.stop
      const exit = yield* ended
      const error = Exit.findErrorOption(exit)
      expect(
        Option.exists(
          error,
          error =>
            error instanceof RpcClientError.RpcClientError && !isDefect(error),
        ),
      ).toBe(true)
      expect(Exit.hasInterrupts(exit)).toBe(false)
    }),
  )

  it.live('leaves interrupted what the client has in flight as it closes', () =>
    Effect.gen(function* () {
      const { path, seen, socket } = yield* wired
      yield* engineAt(path, seen)
      const scope = yield* Scope.make()
      const client = yield* make(options).pipe(
        Effect.provide(socket),
        Scope.provide(scope),
      )
      const ended = yield* askSettings(client, seen)

      yield* Scope.close(scope, Exit.void)
      const exit = yield* ended
      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(Option.isNone(Exit.findErrorOption(exit))).toBe(true)
    }),
  )
})
