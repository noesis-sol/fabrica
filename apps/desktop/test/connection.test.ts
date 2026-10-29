import {
  Deferred,
  Effect,
  Fiber,
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
import { Socket, SocketServer } from 'effect/socket'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'

import { NodeSocketServer } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import {
  type ClientOptions,
  type EngineClientShape,
  Link,
  PageSignal,
  RelaySignal,
  type StreamItem,
  make,
  portServer,
  portSocket,
  webPortEnd,
} from '@fabrica/client'
import {
  type ClientHello,
  EngineHello,
  EngineId,
  EngineRpcs,
  EngineStatus,
  EngineVersion,
  type Resume,
  ResumePlan,
  StreamEpoch,
  negotiate,
  planResume,
  protocolVersion,
  supportedVersions,
} from '@fabrica/contracts'
import { tempFolder } from '@fabrica/testkit'

import { mainPortEnd } from '../src/connection/port'
import { engineSocket, relay } from '../src/connection/relay'
import { ConnectionTarget } from '../src/connection/target'
import {
  type BrokeredPage,
  type ConnectionProcess,
  localTarget,
  makeBroker,
} from '../src/main/ports'

// The connection process (spec §5, §8.2): the page's engine client over a MessagePort pair, the relay
// on the other end copying its frames to a test engine on a Unix socket, as the app's renderer and
// connection process do; a dropped engine connection reaches the page's client, which reconnects
// through the relay and resumes its stream. Then the port's protocol on its own, the Electron port
// adapter, and main's brokering.

const statusWith = (clients: number): EngineStatus =>
  Schema.decodeUnknownSync(EngineStatus)({
    id: 'e-1',
    release: '0.1.0',
    startedAt: 1_793_268_900_000,
    host: { platform: 'darwin', arch: 'arm64', hostname: 'laptop', cores: 8 },
    projects: 0,
    runs: 0,
    liveWorkers: 0,
    machineWorkers: 4,
    clients,
    stopping: false,
  })

type StatusItem = StreamItem<EngineStatus, EngineStatus>

const epoch = Schema.decodeUnknownSync(StreamEpoch)('epoch-1')

/**
 * An engine serving the Engine group's hello, version and status stream: the stream sends a snapshot,
 * then a patch for each status published, and resumes after the patch a subscription asks for. It
 * records the hellos and resume points it is given.
 */
const makeEngine = Effect.gen(function* () {
  const hellos = yield* Ref.make<ReadonlyArray<ClientHello>>([])
  const resumes = yield* Ref.make<ReadonlyArray<Option.Option<Resume>>>([])
  const log = yield* Ref.make<ReadonlyArray<EngineStatus>>([statusWith(1)])
  const patches = yield* PubSub.unbounded<StatusItem>()
  const publish = (clients: number) =>
    Effect.flatMap(
      Ref.modify(log, statuses => [
        statuses.length,
        [...statuses, statusWith(clients)],
      ]),
      seq =>
        PubSub.publish(patches, {
          _tag: 'patch',
          seq,
          value: statusWith(clients),
        }),
    )
  const handlers = EngineRpcs.toLayer({
    'engine.connect': hello =>
      Effect.flatMap(
        Ref.update(hellos, all => [...all, hello]),
        () =>
          Result.match(
            negotiate({ client: hello.protocol, engine: protocolVersion }),
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
          ),
      ),
    'engine.version': () => {
      const [current, ...older] = supportedVersions(protocolVersion)
      return Effect.succeed(
        new EngineVersion({
          release: '0.1.0',
          protocol: protocolVersion,
          supported: [current ?? protocolVersion, ...older],
        }),
      )
    },
    'engine.status': () => Effect.die('not served'),
    'engine.settings': () => Effect.die('not served'),
    'engine.stop': () => Effect.die('not served'),
    'engine.update': () => Effect.die('not served'),
    'engine.watchStatus': ({ resume }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* Ref.update(resumes, all => [...all, resume])
          const subscription = yield* PubSub.subscribe(patches)
          const statuses = yield* Ref.get(log)
          const last = statuses.length - 1
          const plan = planResume({ resume, epoch, oldest: 1, latest: last })
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
  return { hellos, resumes, publish, handlers }
})

type Handlers = Effect.Success<typeof makeEngine>['handlers']

/**
 * The engine on a Unix socket in a temp folder, as the local engine serves its socket; `drop` cuts
 * every open connection from the engine's end, as a restarted engine or a dead link does.
 */
const serveOnSocket = (handlers: Handlers) =>
  Effect.gen(function* () {
    const folder = yield* tempFolder('connection')
    const path = join(folder, 'engine.sock')
    const listening = yield* NodeSocketServer.make({ path })
    const cut = yield* Ref.make(yield* Deferred.make<void>())
    const server = SocketServer.SocketServer.of({
      address: listening.address,
      run: handler =>
        listening.run(socket =>
          Effect.flatMap(Ref.get(cut), dropped =>
            Effect.raceFirst(handler(socket), Deferred.await(dropped)),
          ),
        ),
    })
    yield* Layer.build(
      RpcServer.layer(EngineRpcs).pipe(
        Layer.provide(handlers),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(Layer.succeed(SocketServer.SocketServer, server)),
      ),
    )
    const drop = Effect.flatMap(Deferred.make<void>(), next =>
      Effect.flatMap(Ref.getAndSet(cut, next), dropped =>
        Deferred.succeed(dropped, undefined),
      ),
    )
    return { folder, path, drop }
  })

/** A port pair, closed with the test's scope. */
const portPair = Effect.acquireRelease(
  Effect.sync(() => new MessageChannel()),
  channel =>
    Effect.sync(() => {
      channel.port1.close()
      channel.port2.close()
    }),
)

/** The relay on `relayEnd`, to the engine `target` names, as the connection process runs it. */
const runRelay = (relayEnd: MessagePort, target: ConnectionTarget) =>
  Effect.forkScoped(
    relay({ port: webPortEnd(relayEnd), engine: engineSocket(target) }),
  )

const clientOptions: ClientOptions = {
  name: 'test app',
  kind: 'app',
  release: '0.1.0',
  reconnect: Schedule.spaced('10 millis'),
}

/** The page's engine client over `pageEnd`, as the renderer runs it. */
const pageClient = (pageEnd: MessagePort) =>
  Effect.flatMap(portSocket(webPortEnd(pageEnd)), socket =>
    make(clientOptions).pipe(Effect.provideService(Socket.Socket, socket)),
  )

/** The client's status stream, its items taken into a queue as they come. */
const watchStatus = (client: EngineClientShape) =>
  Effect.gen(function* () {
    const items = yield* Queue.unbounded<StatusItem>()
    yield* client
      .watch(resume => client.rpc['engine.watchStatus']({ resume }))
      .pipe(
        Stream.runForEach(item => Queue.offer(items, item)),
        Effect.forkScoped,
      )
    return Queue.take(items)
  })

const takeItems = (take: Effect.Effect<StatusItem>, count: number) =>
  Effect.map(Effect.replicateEffect(take, count), items =>
    items.map(item =>
      Match.valueTags(item, {
        snapshot: ({ seq, value }) => `snapshot ${seq}: ${value.clients}`,
        patch: ({ seq, value }) => `patch ${seq}: ${value.clients}`,
      }),
    ),
  )

const resumeOf = (resume: Option.Option<Resume>) =>
  Option.match(resume, {
    onNone: () => 'none',
    onSome: ({ epoch: at, after }) => `${at} after ${after}`,
  })

describe('the connection process’s relay', () => {
  it.live('relays the hello, a request and a stream from the engine', () =>
    Effect.gen(function* () {
      const engine = yield* makeEngine
      const { path } = yield* serveOnSocket(engine.handlers)
      const channel = yield* portPair
      yield* runRelay(
        channel.port2,
        ConnectionTarget.cases.LocalSocket.make({ path }),
      )
      const client = yield* pageClient(channel.port1)

      const link = yield* client.link
      expect(Link.$is('Up')(link) && link.hello.engine).toBe('e-1')
      expect((yield* Ref.get(engine.hellos)).map(hello => hello.name)).toEqual([
        'test app',
      ])
      const version = yield* client.rpc['engine.version']()
      expect(version.protocol).toBe(protocolVersion)

      const take = yield* watchStatus(client)
      expect(yield* takeItems(take, 1)).toEqual(['snapshot 0: 1'])
      yield* engine.publish(2)
      yield* engine.publish(3)
      expect(yield* takeItems(take, 2)).toEqual(['patch 1: 2', 'patch 2: 3'])
    }),
  )

  it.live(
    'reconnects after the engine drops its connection and resumes the stream',
    () =>
      Effect.gen(function* () {
        const engine = yield* makeEngine
        const { path, drop } = yield* serveOnSocket(engine.handlers)
        const channel = yield* portPair
        yield* runRelay(
          channel.port2,
          ConnectionTarget.cases.LocalSocket.make({ path }),
        )
        const client = yield* pageClient(channel.port1)
        const take = yield* watchStatus(client)
        expect(yield* takeItems(take, 1)).toEqual(['snapshot 0: 1'])
        yield* engine.publish(2)
        expect(yield* takeItems(take, 1)).toEqual(['patch 1: 2'])

        const before = yield* client.link
        yield* drop
        yield* engine.publish(3)
        yield* engine.publish(4)
        expect(yield* takeItems(take, 2)).toEqual(['patch 2: 3', 'patch 3: 4'])
        const after = yield* client.link
        expect(Link.$is('Up')(after)).toBe(true)
        expect(after.connection).toBeGreaterThan(before.connection)
        expect((yield* Ref.get(engine.resumes)).map(resumeOf)).toEqual([
          'none',
          'epoch-1 after 1',
        ])
        // The new connection said hello again before the stream resumed.
        expect((yield* Ref.get(engine.hellos)).length).toBe(2)

        const version = yield* client.rpc['engine.version']()
        expect(version.protocol).toBe(protocolVersion)
      }),
  )

  it.live('fails the page’s connection when the engine can’t be reached', () =>
    Effect.gen(function* () {
      const folder = yield* tempFolder('connection')
      const channel = yield* portPair
      yield* runRelay(
        channel.port2,
        ConnectionTarget.cases.LocalSocket.make({
          path: join(folder, 'engine.sock'),
        }),
      )
      const error = yield* Effect.flip(pageClient(channel.port1))
      expect(error).toBeInstanceOf(RpcClientError.RpcClientError)
    }),
  )

  it.live('fails every connection when no engine is reachable here', () =>
    Effect.gen(function* () {
      const channel = yield* portPair
      yield* runRelay(
        channel.port2,
        ConnectionTarget.cases.Unavailable.make({ reason: 'not here' }),
      )
      const error = yield* Effect.flip(pageClient(channel.port1))
      expect(error).toBeInstanceOf(RpcClientError.RpcClientError)
    }),
  )

  it.live('ends once the page’s port has closed', () =>
    Effect.gen(function* () {
      const engine = yield* makeEngine
      const { path } = yield* serveOnSocket(engine.handlers)
      const channel = new MessageChannel()
      const relaying = yield* runRelay(
        channel.port2,
        ConnectionTarget.cases.LocalSocket.make({ path }),
      )
      yield* pageClient(channel.port1)
      channel.port1.close()
      yield* Fiber.join(relaying)
    }),
  )
})

/** Collects what a raw port end is sent: frames as text, signals by their tag and connection. */
const recorder = (port: MessagePort) =>
  Effect.gen(function* () {
    const seen = yield* Queue.unbounded<string>()
    const decoder = new TextDecoder()
    const decodeRelay = Schema.decodeUnknownOption(RelaySignal)
    port.addEventListener('message', event => {
      const described = Option.match(decodeRelay(event.data), {
        onSome: signal => `${signal._tag} ${signal.connection}`,
        onNone: () =>
          event.data instanceof Uint8Array
            ? `frame ${decoder.decode(event.data)}`
            : `other ${String(event.data)}`,
      })
      Queue.offerUnsafe(seen, described)
    })
    port.start()
    return Queue.take(seen)
  })

describe('the port’s protocol', () => {
  it.live(
    'never hands a connection the frames sent for the one it replaced',
    () =>
      Effect.gen(function* () {
        const channel = yield* portPair
        const encoder = new TextEncoder()
        const late = yield* Deferred.make<void>()
        const wroteLate = yield* Deferred.make<void>()
        const handled = yield* Ref.make(0)
        // The relay's end: the first connection writes only after the page has replaced it.
        yield* portServer(webPortEnd(channel.port2))
          .run(socket =>
            Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(handled, n => n + 1)
              // A socket's writes wait for its reader, which opens its connection.
              yield* socket.reader
              const write = yield* socket.writer
              if (count === 1) {
                yield* Deferred.await(late)
                yield* write.write(encoder.encode('stale'))
                yield* Deferred.succeed(wroteLate, undefined)
              } else {
                yield* write.write(encoder.encode(`fresh ${count}`))
              }
              yield* Effect.never
            }).pipe(Effect.scoped),
          )
          .pipe(Effect.forkScoped)
        const take = yield* recorder(channel.port1)
        const post = (signal: PageSignal) => channel.port1.postMessage(signal)

        post(PageSignal.cases.Open.make({ connection: 1 }))
        expect(yield* take).toBe('Opened 1')
        post(PageSignal.cases.Close.make({ connection: 1 }))
        post(PageSignal.cases.Open.make({ connection: 2 }))
        expect(yield* take).toBe('Opened 2')
        expect(yield* take).toBe('frame fresh 2')
        yield* Deferred.succeed(late, undefined)
        yield* Deferred.await(wroteLate)
        // A new open without a close replaces the connection too.
        post(PageSignal.cases.Open.make({ connection: 3 }))
        expect(yield* take).toBe('Opened 3')
        expect(yield* take).toBe('frame fresh 3')
      }),
  )

  it.live('ends a page connection the relay closes, and opens the next', () =>
    Effect.gen(function* () {
      const channel = yield* portPair
      const encoder = new TextEncoder()
      // A handler that answers one frame and ends: the relay closes its connection to the page.
      yield* portServer(webPortEnd(channel.port2))
        .run(socket =>
          Effect.gen(function* () {
            const read = yield* socket.reader
            const write = yield* socket.writer
            const frames = yield* read.pull
            yield* write.writeAll(frames)
          }).pipe(Effect.scoped),
        )
        .pipe(Effect.forkScoped)
      const page = yield* portSocket(webPortEnd(channel.port1))
      const echo = (text: string) =>
        Effect.gen(function* () {
          const read = yield* page.reader
          const write = yield* page.writer
          yield* write.write(encoder.encode(text))
          const decoder = new TextDecoder()
          const first = yield* read.pull
          const ended = yield* Effect.flip(read.pull)
          return {
            echoed: first.map(frame =>
              typeof frame === 'string' ? frame : decoder.decode(frame),
            ),
            ended: ended.reason._tag,
          }
        }).pipe(Effect.scoped)
      expect(yield* echo('one')).toEqual({
        echoed: ['one'],
        ended: 'SocketCloseError',
      })
      expect(yield* echo('two')).toEqual({
        echoed: ['two'],
        ended: 'SocketCloseError',
      })
    }),
  )
})

/** An Electron `MessagePortMain` stand-in: an emitter whose messages are events carrying their data. */
class FakeMainPort extends EventEmitter {
  readonly posted: Array<unknown> = []
  started = false
  postMessage(message: unknown): void {
    this.posted.push(message)
  }
  start(): void {
    this.started = true
  }
}

describe('the connection process’s Electron port', () => {
  it('passes on messages’ data and the port’s closing until stopped', () => {
    const port = new FakeMainPort()
    const end = mainPortEnd(port)
    const messages: Array<unknown> = []
    let closed = 0
    const stop = end.listen({
      onMessage: data => messages.push(data),
      onClose: () => {
        closed += 1
      },
    })
    expect(port.started).toBe(true)
    port.emit('message', { data: 'a frame', ports: [] })
    port.emit('close')
    end.post('to the page')
    stop()
    port.emit('message', { data: 'after', ports: [] })
    port.emit('close')
    expect(messages).toEqual(['a frame'])
    expect(closed).toBe(1)
    expect(port.posted).toEqual(['to the page'])
    expect(port.listenerCount('message') + port.listenerCount('close')).toBe(0)
  })
})

/** A page whose loads and going a test triggers, recording the ports it is handed. */
const fakePage = () => {
  const loads: Array<() => void> = []
  const gone: Array<() => void> = []
  const received: Array<string> = []
  const page: BrokeredPage<string> = {
    onLoad: listener => loads.push(listener),
    onGone: listener => gone.push(listener),
    send: port => received.push(port),
  }
  return {
    page,
    received,
    load: () => loads.forEach(listener => listener()),
    go: () => gone.forEach(listener => listener()),
  }
}

describe('main’s brokering', () => {
  const target = ConnectionTarget.cases.LocalSocket.make({
    path: '/home/ada/.local/share/fabrica/engine.sock',
  })

  const makeHost = () => {
    let pairs = 0
    const spawned: Array<{
      readonly relayed: Array<[ConnectionTarget, string]>
      readonly exit: () => void
    }> = []
    const restarts: Array<() => void> = []
    const broker = makeBroker<string>({
      spawn: onExit => {
        const relayed: Array<[ConnectionTarget, string]> = []
        spawned.push({ relayed, exit: onExit })
        const child: ConnectionProcess<string> = {
          relay: (to, port) => relayed.push([to, port]),
        }
        return child
      },
      afterExit: restart => restarts.push(restart),
      channel: () => {
        pairs += 1
        return { page: `page-${pairs}`, relay: `relay-${pairs}` }
      },
      target,
    })
    return { broker, spawned, restarts }
  }

  it('hands each load of a page a new port, its other end to one connection process', () => {
    const { broker, spawned } = makeHost()
    const first = fakePage()
    const second = fakePage()
    broker.attach(first.page)
    broker.attach(second.page)
    expect(spawned).toEqual([])
    first.load()
    second.load()
    first.load()
    expect(first.received).toEqual(['page-1', 'page-3'])
    expect(second.received).toEqual(['page-2'])
    expect(spawned.length).toBe(1)
    expect(spawned[0]?.relayed).toEqual([
      [target, 'relay-1'],
      [target, 'relay-2'],
      [target, 'relay-3'],
    ])
  })

  it('starts the connection process again after it exits, with new ports for the pages still there', () => {
    const { broker, spawned, restarts } = makeHost()
    const staying = fakePage()
    const leaving = fakePage()
    broker.attach(staying.page)
    broker.attach(leaving.page)
    staying.load()
    leaving.load()
    leaving.go()
    spawned[0]?.exit()
    expect(spawned.length).toBe(1)
    restarts.forEach(restart => restart())
    expect(spawned.length).toBe(2)
    expect(spawned[1]?.relayed).toEqual([[target, 'relay-3']])
    expect(staying.received).toEqual(['page-1', 'page-3'])
    expect(leaving.received).toEqual(['page-2'])
  })

  it('reaches the local engine’s socket where the engine runs, and none elsewhere', () => {
    expect(
      localTarget({
        platform: 'darwin',
        home: '/Users/ada',
        environment: {},
      }),
    ).toEqual(
      ConnectionTarget.cases.LocalSocket.make({
        path: '/Users/ada/Library/Application Support/fabrica/engine.sock',
      }),
    )
    expect(
      localTarget({
        platform: 'linux',
        home: '/home/ada',
        environment: { XDG_RUNTIME_DIR: '/run/user/1000' },
      }),
    ).toEqual(
      ConnectionTarget.cases.LocalSocket.make({
        path: '/run/user/1000/fabrica/engine.sock',
      }),
    )
    expect(
      ConnectionTarget.guards.Unavailable(
        localTarget({
          platform: 'win32',
          home: 'C:\\Users\\ada',
          environment: {},
        }),
      ),
    ).toBe(true)
  })
})
