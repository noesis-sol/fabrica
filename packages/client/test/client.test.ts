import {
  Context,
  Deferred,
  Effect,
  Exit,
  Latch,
  Layer,
  Match,
  Option,
  PubSub,
  Queue,
  Ref,
  Result,
  Schedule,
  Schema,
  Stream,
} from 'effect'
import { RpcClientError, RpcSerialization, RpcServer } from 'effect/rpc'
import { type Socket, SocketServer } from 'effect/socket'
import { dirname, join } from 'node:path'

import { NodeSocketServer } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import {
  type ClientHello,
  EngineHello,
  EngineId,
  EngineRpcs,
  EngineStatus,
  EngineVersion,
  type ProtocolVersion,
  type Resume,
  ResumePlan,
  StreamEpoch,
  VersionMismatch,
  negotiate,
  planResume,
  supportedVersions,
} from '@fabrica/contracts'
import { airtightEnv, tempFolder } from '@fabrica/testkit'

import {
  type ClientOptions,
  type EngineClientShape,
  Link,
  MemoryTransport,
  type StreamItem,
  advance,
  layerMemory,
  make,
} from '../src'
import { layerBridge, layerUnixSocket } from '../src/node'

// The client against a minimal engine serving the Engine group over each transport: in memory, the
// local socket, and a bridge child's stdio. The engine's `engine.watchStatus` keeps its statuses as a
// stream does (a snapshot at 0, then a patch for each), forgets its patches when told, and records the
// hellos and resume points it is given, so a test sees what the client asked for after a reconnect.

const statusWith = (clients: number): EngineStatus =>
  Schema.decodeUnknownSync(EngineStatus)({
    id: 'e-1',
    release: '0.1.0',
    startedAt: 1_793_268_900_000,
    host: { platform: 'linux', arch: 'x64', hostname: 'server-1', cores: 16 },
    listening: null,
    projects: 0,
    runs: 0,
    liveWorkers: 0,
    machineWorkers: 8,
    clients,
    stopping: false,
  })

type StatusItem = StreamItem<EngineStatus, EngineStatus>

const epoch = Schema.decodeUnknownSync(StreamEpoch)('epoch-1')

interface TestEngine {
  /** The protocol version the engine is at; a test raises it to stand for an updated engine. */
  readonly version: Ref.Ref<ProtocolVersion>
  readonly hellos: Ref.Ref<ReadonlyArray<ClientHello>>
  /** Each `engine.watchStatus` subscription's resume point, in order. */
  readonly resumes: Ref.Ref<ReadonlyArray<Option.Option<Resume>>>
  /** Sends a patch: the status with `clients` clients. */
  readonly publish: (clients: number) => Effect.Effect<void>
  /** Sends a patch two numbers on from the last, as a broken engine would. */
  readonly skip: (clients: number) => Effect.Effect<void>
  /** Forgets every patch sent: a client resuming gets a new snapshot. */
  readonly forget: Effect.Effect<void>
  /** Holds new subscriptions back until `release`, so a test changes the stream before they read it. */
  readonly hold: Effect.Effect<void>
  readonly release: Effect.Effect<void>
}

const makeEngine = (protocol: ProtocolVersion) =>
  Effect.gen(function* () {
    const version = yield* Ref.make(protocol)
    const hellos = yield* Ref.make<ReadonlyArray<ClientHello>>([])
    const resumes = yield* Ref.make<ReadonlyArray<Option.Option<Resume>>>([])
    const log = yield* Ref.make<ReadonlyArray<EngineStatus>>([statusWith(1)])
    const oldest = yield* Ref.make(1)
    const patches = yield* PubSub.unbounded<StatusItem>()
    const subscribing = yield* Latch.make(true)
    const send = (seq: number, clients: number) =>
      Effect.flatMap(
        Ref.update(log, statuses => [...statuses, statusWith(clients)]),
        () =>
          PubSub.publish(patches, {
            _tag: 'patch',
            seq,
            value: statusWith(clients),
          }),
      )
    const latest = Effect.map(Ref.get(log), statuses => statuses.length - 1)
    const engine: TestEngine = {
      version,
      hellos,
      resumes,
      publish: clients => Effect.flatMap(latest, seq => send(seq + 1, clients)),
      skip: clients =>
        Effect.flatMap(latest, seq =>
          Effect.andThen(
            Ref.update(log, statuses => [...statuses, statusWith(clients)]),
            send(seq + 2, clients),
          ),
        ),
      forget: Effect.flatMap(latest, seq => Ref.set(oldest, seq + 1)),
      hold: Effect.asVoid(subscribing.close),
      release: Effect.asVoid(subscribing.open),
    }
    const handlers = EngineRpcs.toLayer({
      'engine.connect': hello =>
        Effect.gen(function* () {
          yield* Ref.update(hellos, all => [...all, hello])
          const at = yield* Ref.get(version)
          return yield* Result.match(
            negotiate({ client: hello.protocol, engine: at }),
            {
              onFailure: mismatch => Effect.fail(mismatch),
              onSuccess: speaks =>
                Effect.succeed(
                  new EngineHello({
                    protocol: speaks,
                    engine: EngineId.make('e-1'),
                    release: '0.1.0',
                  }),
                ),
            },
          )
        }),
      'engine.version': () =>
        Effect.map(Ref.get(version), at => {
          const [current, ...older] = supportedVersions(at)
          return new EngineVersion({
            release: '0.1.0',
            protocol: at,
            supported: [current ?? at, ...older],
          })
        }),
      'engine.status': () =>
        Effect.map(Ref.get(log), statuses => statuses.at(-1) ?? statusWith(0)),
      'engine.settings': () => Effect.die('not served'),
      'engine.stop': () => Effect.die('not served'),
      'engine.update': () => Effect.die('not served'),
      'engine.watchStatus': ({ resume }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* subscribing.await
            yield* Ref.update(resumes, all => [...all, resume])
            const subscription = yield* PubSub.subscribe(patches)
            const statuses = yield* Ref.get(log)
            const last = statuses.length - 1
            const plan = planResume({
              resume,
              epoch,
              oldest: yield* Ref.get(oldest),
              latest: last,
            })
            const first: ReadonlyArray<StatusItem> = ResumePlan.$match(plan, {
              Snapshot: (): ReadonlyArray<StatusItem> => [
                {
                  _tag: 'snapshot',
                  epoch,
                  seq: last,
                  value: statuses[last] ?? statusWith(0),
                },
              ],
              PatchesAfter: ({ after }): ReadonlyArray<StatusItem> =>
                statuses.slice(after + 1).map((value, index) => ({
                  _tag: 'patch',
                  seq: after + 1 + index,
                  value,
                })),
            })
            return Stream.concat(
              Stream.fromIterable(first),
              Stream.fromSubscription(subscription),
            )
          }),
        ),
      'engine.watchLoad': () => Stream.die('not served'),
    })
    return { engine, handlers }
  })

type Handlers = Effect.Success<ReturnType<typeof makeEngine>>['handlers']

/** Serves the engine on the `SocketServer` given, as the engine daemon does. */
const serve = (
  handlers: Handlers,
  server: SocketServer.SocketServer['Service'],
) =>
  Layer.build(
    RpcServer.layer(EngineRpcs).pipe(
      Layer.provide(handlers),
      Layer.provide(RpcServer.layerProtocolSocketServer),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(Layer.succeed(SocketServer.SocketServer, server)),
    ),
  )

/** A server whose open connections `drop` cuts from the engine's end. */
const droppable = (server: SocketServer.SocketServer['Service']) =>
  Effect.gen(function* () {
    const cut = yield* Ref.make(yield* Deferred.make<void>())
    const wrapped = SocketServer.SocketServer.of({
      address: server.address,
      run: handler =>
        server.run(socket =>
          Effect.flatMap(Ref.get(cut), dropped =>
            Effect.raceFirst(handler(socket), Deferred.await(dropped)),
          ),
        ),
    })
    const drop = Effect.flatMap(Deferred.make<void>(), next =>
      Effect.flatMap(Ref.getAndSet(cut, next), dropped =>
        Deferred.succeed(dropped, undefined),
      ),
    )
    return { server: wrapped, drop }
  })

/** A transport between the client and the engine, and how to drop its connections. */
interface Wired {
  readonly socket: Context.Context<Socket.Socket>
  readonly drop: Effect.Effect<void>
}

const overMemory = (handlers: Handlers) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(layerMemory)
    yield* serve(handlers, Context.get(context, SocketServer.SocketServer))
    return {
      socket: context,
      drop: Context.get(context, MemoryTransport).drop,
    } satisfies Wired
  })

/** The engine on a Unix socket in a temp folder: its path and the drop. */
const onUnixSocket = (handlers: Handlers) =>
  Effect.gen(function* () {
    const folder = yield* tempFolder('client')
    const path = join(folder, 'engine.sock')
    const listening = yield* NodeSocketServer.make({ path })
    const { server, drop } = yield* droppable(listening)
    yield* serve(handlers, server)
    return { folder, path, drop }
  })

const overUnixSocket = (handlers: Handlers) =>
  Effect.gen(function* () {
    const { path, drop } = yield* onUnixSocket(handlers)
    const socket = yield* Layer.build(layerUnixSocket(path))
    return { socket, drop } satisfies Wired
  })

// What `fabrica bridge` does: copies its stdio to the engine's socket and back, and exits as the
// socket closes.
const bridgeScript = `
const net = process.getBuiltinModule('node:net')
const socket = net.connect(process.argv[1])
process.stdin.pipe(socket)
socket.pipe(process.stdout)
socket.on('close', () => process.exit(0))
socket.on('error', () => process.exit(1))
`

const overBridge = (handlers: Handlers) =>
  Effect.gen(function* () {
    const { folder, path, drop } = yield* onUnixSocket(handlers)
    const socket = yield* Layer.build(
      layerBridge({
        command: process.execPath,
        args: ['-e', bridgeScript, path],
        env: airtightEnv({ path: dirname(process.execPath), home: folder }),
      }),
    )
    return { socket, drop } satisfies Wired
  })

const transports = [
  { name: 'in memory', wire: overMemory },
  { name: 'over a Unix socket', wire: overUnixSocket },
  { name: 'over a bridge child’s stdio', wire: overBridge },
] as const

const clientOptions = (protocol: ProtocolVersion): ClientOptions => ({
  name: 'test client',
  kind: 'cli',
  release: '0.1.0',
  protocol,
  reconnect: Schedule.spaced('10 millis'),
})

/** The client's status stream, its items taken into a queue as they come. */
const watchStatus = (client: EngineClientShape) =>
  Effect.gen(function* () {
    const items = yield* Queue.unbounded<StatusItem>()
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

const describeItem = (item: StatusItem) =>
  Match.valueTags(item, {
    snapshot: ({ seq, value }) => `snapshot ${seq}: ${value.clients}`,
    patch: ({ seq, value }) => `patch ${seq}: ${value.clients}`,
  })

const takeItems = (take: Effect.Effect<StatusItem>, count: number) =>
  Effect.map(Effect.replicateEffect(take, count), items =>
    items.map(describeItem),
  )

const resumeOf = (resume: Option.Option<Resume>) =>
  Option.match(resume, {
    onNone: () => 'none',
    onSome: ({ epoch: at, after }) => `${at} after ${after}`,
  })

/** The link once it is up on a connection after `connection`. */
const upAfter = (client: EngineClientShape, connection: number) =>
  client.links.pipe(
    Stream.filter(link => Link.$is('Up')(link) && link.connection > connection),
    Stream.runHead,
  )

describe('the engine client', () => {
  for (const { name, wire } of transports) {
    describe(name, () => {
      it.live('says hello, then calls the engine', () =>
        Effect.gen(function* () {
          const { engine, handlers } = yield* makeEngine(1)
          const { socket } = yield* wire(handlers)
          const client = yield* make(clientOptions(1)).pipe(
            Effect.provide(socket),
          )
          const link = yield* client.link
          expect(Link.$is('Up')(link) && link.hello.protocol).toBe(1)
          const hellos = yield* Ref.get(engine.hellos)
          expect(hellos.map(hello => [hello.name, hello.protocol])).toEqual([
            ['test client', 1],
          ])
          const answers = yield* Effect.all(
            [
              client.rpc['engine.version'](),
              client.rpc['engine.status'](),
              client.rpc['engine.version'](),
            ],
            { concurrency: 'unbounded' },
          )
          expect(answers[0].protocol).toBe(1)
          expect(answers[1].clients).toBe(1)
        }),
      )

      it.live(
        'resumes a stream from its sequence number after a dropped connection',
        () =>
          Effect.gen(function* () {
            const { engine, handlers } = yield* makeEngine(1)
            const { socket, drop } = yield* wire(handlers)
            const client = yield* make(clientOptions(1)).pipe(
              Effect.provide(socket),
            )
            const { take } = yield* watchStatus(client)
            expect(yield* takeItems(take, 1)).toEqual(['snapshot 0: 1'])
            yield* engine.publish(2)
            yield* engine.publish(3)
            expect(yield* takeItems(take, 2)).toEqual([
              'patch 1: 2',
              'patch 2: 3',
            ])

            const before = yield* client.link
            yield* drop
            yield* engine.publish(4)
            yield* engine.publish(5)
            expect(yield* takeItems(take, 2)).toEqual([
              'patch 3: 4',
              'patch 4: 5',
            ])
            yield* upAfter(client, before.connection)
            const resumes = yield* Ref.get(engine.resumes)
            expect(resumes.map(resumeOf)).toEqual(['none', 'epoch-1 after 2'])
            // The new connection said hello again before the stream resumed.
            expect((yield* Ref.get(engine.hellos)).length).toBe(2)

            yield* engine.publish(6)
            expect(yield* takeItems(take, 1)).toEqual(['patch 5: 6'])
          }),
      )
    })
  }

  it.live(
    'takes a new snapshot when the engine no longer has its patches',
    () =>
      Effect.gen(function* () {
        const { engine, handlers } = yield* makeEngine(1)
        const { socket, drop } = yield* overMemory(handlers)
        const client = yield* make(clientOptions(1)).pipe(
          Effect.provide(socket),
        )
        const { take } = yield* watchStatus(client)
        expect(yield* takeItems(take, 1)).toEqual(['snapshot 0: 1'])
        yield* engine.publish(2)
        expect(yield* takeItems(take, 1)).toEqual(['patch 1: 2'])
        yield* engine.hold
        yield* drop
        yield* engine.publish(3)
        yield* engine.publish(4)
        yield* engine.forget
        yield* engine.release
        expect(yield* takeItems(take, 1)).toEqual(['snapshot 3: 4'])
        expect((yield* Ref.get(engine.resumes)).map(resumeOf)).toEqual([
          'none',
          'epoch-1 after 1',
        ])
        yield* engine.publish(5)
        expect(yield* takeItems(take, 1)).toEqual(['patch 4: 5'])
      }),
  )

  it.live('subscribes afresh when a patch skips a sequence number', () =>
    Effect.gen(function* () {
      const { engine, handlers } = yield* makeEngine(1)
      const { socket } = yield* overMemory(handlers)
      const client = yield* make(clientOptions(1)).pipe(Effect.provide(socket))
      const { take } = yield* watchStatus(client)
      expect(yield* takeItems(take, 1)).toEqual(['snapshot 0: 1'])
      yield* engine.skip(2)
      expect(yield* takeItems(take, 1)).toEqual(['snapshot 2: 2'])
      expect((yield* Ref.get(engine.resumes)).map(resumeOf)).toEqual([
        'none',
        'none',
      ])
    }),
  )

  it.live('reports a client too old for the engine', () =>
    Effect.gen(function* () {
      const { handlers } = yield* makeEngine(3)
      const { socket } = yield* overMemory(handlers)
      const error = yield* Effect.flip(
        make(clientOptions(1)).pipe(Effect.provide(socket)),
      )
      expect(error).toStrictEqual(
        new VersionMismatch({ client: 1, engine: 3, update: 'client' }),
      )
    }),
  )

  it.live('reports an engine too old for the client', () =>
    Effect.gen(function* () {
      const { handlers } = yield* makeEngine(1)
      const { socket } = yield* overMemory(handlers)
      const error = yield* Effect.flip(
        make(clientOptions(3)).pipe(Effect.provide(socket)),
      )
      expect(error).toStrictEqual(
        new VersionMismatch({ client: 3, engine: 1, update: 'engine' }),
      )
    }),
  )

  it.live('speaks to an engine one version ahead', () =>
    Effect.gen(function* () {
      const { handlers } = yield* makeEngine(2)
      const { socket } = yield* overMemory(handlers)
      const client = yield* make(clientOptions(1)).pipe(Effect.provide(socket))
      const link = yield* client.link
      expect(Link.$is('Up')(link) && link.hello.protocol).toBe(1)
    }),
  )

  it.live(
    'ends a stream when the engine it reconnects to refuses its version',
    () =>
      Effect.gen(function* () {
        const { engine, handlers } = yield* makeEngine(1)
        const { socket, drop } = yield* overMemory(handlers)
        const client = yield* make(clientOptions(1)).pipe(
          Effect.provide(socket),
        )
        const { take, ended } = yield* watchStatus(client)
        expect(yield* takeItems(take, 1)).toEqual(['snapshot 0: 1'])
        yield* Ref.set(engine.version, 3)
        yield* drop
        expect(yield* ended).toStrictEqual(
          Exit.fail(
            new VersionMismatch({ client: 1, engine: 3, update: 'client' }),
          ),
        )
        const link = yield* client.link
        expect(Link.$is('Refused')(link)).toBe(true)
      }),
  )

  it.live('fails to start when no engine listens on the socket', () =>
    Effect.gen(function* () {
      const folder = yield* tempFolder('client')
      const socket = yield* Layer.build(
        layerUnixSocket(join(folder, 'engine.sock')),
      )
      const error = yield* Effect.flip(
        make(clientOptions(1)).pipe(Effect.provide(socket)),
      )
      expect(error).toBeInstanceOf(RpcClientError.RpcClientError)
    }),
  )
})

describe('a stream’s sequence', () => {
  const snapshot: StatusItem = {
    _tag: 'snapshot',
    epoch,
    seq: 4,
    value: statusWith(1),
  }
  const patch = (seq: number): StatusItem => ({
    _tag: 'patch',
    seq,
    value: statusWith(seq),
  })

  it('starts at a snapshot', () => {
    const at = advance(Option.none(), snapshot)
    expect(Result.map(at, ({ after }) => after)).toStrictEqual(
      Result.succeed(4),
    )
  })

  it('takes the patch after the last, and no other', () => {
    const at = Result.getOrThrow(advance(Option.none(), snapshot))
    expect(
      Result.map(advance(Option.some(at), patch(5)), ({ after }) => after),
    ).toStrictEqual(Result.succeed(5))
    expect(Result.isFailure(advance(Option.some(at), patch(6)))).toBe(true)
    expect(Result.isFailure(advance(Option.some(at), patch(4)))).toBe(true)
    expect(Result.isFailure(advance(Option.none(), patch(5)))).toBe(true)
  })
})
