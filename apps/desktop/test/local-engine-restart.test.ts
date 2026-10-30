import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream,
} from 'effect'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { Socket, SocketServer } from 'effect/socket'
import { join } from 'node:path'

import { NodeSocketServer } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import {
  Link,
  connectionFailed,
  make,
  portReconnect,
  portSocket,
  webPortEnd,
} from '@fabrica/client'
import { EngineHello, EngineId, EngineRpcs } from '@fabrica/contracts'
import { tempFolder } from '@fabrica/testkit'

import {
  LocalEngineAnswer,
  LocalEngineReach,
  LocalEngineRequest,
  makeLocalEngineAsks,
} from '../src/connection/local-engine'
import { relay } from '../src/connection/relay'
import { ConnectionTarget } from '../src/connection/target'
import { engineSocket, saidOf } from '../src/connection/transports'
import { NoBundledEngine, makeLocalEngineDesk } from '../src/main/local-engine'

// The local engine started again when it stops answering (spec §7.1): before each connection to the
// local socket the connection process asks main to make sure the engine answers, and main runs one
// ensure for every ask made meanwhile; an engine that stopped while the app runs is started again at the
// page's reconnect, and one that couldn't be started fails the page's connection in its words.

const reached = LocalEngineReach.cases.Reached.make({})

/** A minimal engine on the Unix socket at `path`: its hello, nothing else; served until its scope closes. */
const serveEngine = (path: string) =>
  Effect.gen(function* () {
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
  })

/**
 * The local engine at `path`, as main makes sure of it: `ensure` starts it where it isn't running,
 * counting each ensure; `stop` stops it, as a crash or `fabrica engine stop` does.
 */
const localEngineAt = (path: string) =>
  Effect.gen(function* () {
    const running = yield* Ref.make(Option.none<Scope.Closeable>())
    const ensures = yield* Ref.make(0)
    const ensure = Effect.gen(function* () {
      yield* Ref.update(ensures, count => count + 1)
      if (Option.isNone(yield* Ref.get(running))) {
        const scope = yield* Scope.make()
        yield* Scope.provide(serveEngine(path), scope)
        yield* Ref.set(running, Option.some(scope))
      }
    })
    const stop = Effect.flatMap(
      Ref.getAndSet(running, Option.none()),
      Option.match({
        onNone: () => Effect.void,
        onSome: scope => Scope.close(scope, Exit.void),
      }),
    )
    yield* Effect.addFinalizer(() => stop)
    return { ensure, stop, ensures: Ref.get(ensures) }
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

/** The page's engine client through the relay to the local socket at `path`, main answering through `localEngine`. */
const pageThroughRelay = (
  path: string,
  localEngine: Effect.Effect<LocalEngineReach>,
) =>
  Effect.gen(function* () {
    const channel = yield* portPair
    yield* Effect.forkScoped(
      relay({
        port: webPortEnd(channel.port2),
        engine: engineSocket(
          ConnectionTarget.cases.LocalSocket.make({ path }),
          {
            env: {},
            localEngine,
            askpass: Option.none(),
          },
        ),
        said: saidOf,
      }),
    )
    const socket = yield* portSocket(webPortEnd(channel.port1))
    return make({
      name: 'test app',
      kind: 'app',
      release: '0.1.0',
      reconnect: portReconnect(Schedule.spaced('10 millis')),
    }).pipe(Effect.provideService(Socket.Socket, socket))
  })

/** The first link `client` reports that `is` holds for. */
const linkWhere = (
  client: { readonly links: Stream.Stream<Link> },
  is: (link: Link) => boolean,
) => Stream.runHead(Stream.filter(client.links, is))

describe('the local engine, as main makes sure of it', () => {
  it.effect(
    'runs one ensure for the asks made while it runs, and again after',
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const runs = yield* Ref.make(0)
        const desk = makeLocalEngineDesk(
          Effect.andThen(
            Ref.update(runs, count => count + 1),
            Deferred.await(gate),
          ),
        )
        const first = yield* Effect.forkChild(desk.reach)
        const second = yield* Effect.forkChild(desk.reach)
        yield* Effect.yieldNow
        yield* Deferred.succeed(gate, undefined)
        expect(yield* Fiber.join(first)).toEqual(reached)
        expect(yield* Fiber.join(second)).toEqual(reached)
        expect(yield* Ref.get(runs)).toBe(1)
        expect(yield* desk.reach).toEqual(reached)
        expect(yield* Ref.get(runs)).toBe(2)
      }),
  )

  it.effect('answers why the engine could not be started', () =>
    Effect.gen(function* () {
      const socket = '/home/u/.local/state/fabrica/engine.sock'
      const desk = makeLocalEngineDesk(
        Effect.fail(new NoBundledEngine({ socket })),
      )
      expect(yield* desk.reach).toEqual(
        LocalEngineReach.cases.Failed.make({
          reason: new NoBundledEngine({ socket }).message,
        }),
      )
    }),
  )

  it.effect(
    'answers an ask to the connection process that made it, by its number',
    () =>
      Effect.gen(function* () {
        const desk = makeLocalEngineDesk(Effect.void)
        const replies = yield* Deferred.make<unknown>()
        const asks = makeLocalEngineAsks(request =>
          desk.fromConnection(request, answer =>
            Deferred.doneUnsafe(replies, Effect.succeed(answer)),
          ),
        )
        const asking = yield* Effect.forkChild(asks.reach)
        const answer = Schema.decodeUnknownSync(LocalEngineAnswer)(
          yield* Deferred.await(replies),
        )
        expect(answer).toEqual(
          LocalEngineAnswer.make({ id: 1, answer: reached }),
        )
        asks.answered(answer)
        expect(yield* Fiber.join(asking)).toEqual(reached)
      }),
  )

  it('drops what is not an ask, and an answer no ask waits on', () => {
    const replied: Array<unknown> = []
    const desk = makeLocalEngineDesk(Effect.void)
    desk.fromConnection({ _tag: 'SshPromptAnswer', id: 1 }, answer =>
      replied.push(answer),
    )
    expect(replied).toEqual([])
    const posted: Array<unknown> = []
    const asks = makeLocalEngineAsks(request => posted.push(request))
    asks.answered(LocalEngineAnswer.make({ id: 7, answer: reached }))
    expect(posted).toEqual([])
    expect(
      Schema.decodeUnknownSync(LocalEngineRequest)({
        _tag: 'LocalEngineRequest',
        id: 1,
      }),
    ).toEqual(LocalEngineRequest.make({ id: 1 }))
  })
})

describe('the page’s connection to the local engine', () => {
  it.live(
    'starts the engine where none answers, and again when it stops while the app runs',
    () =>
      Effect.gen(function* () {
        const path = join(
          yield* tempFolder('local-engine-restart'),
          'engine.sock',
        )
        const engine = yield* localEngineAt(path)
        const desk = makeLocalEngineDesk(engine.ensure)
        const client = yield* Effect.flatten(pageThroughRelay(path, desk.reach))
        const link = yield* client.link
        expect(Link.$is('Up')(link) && link.connection).toBe(1)
        expect(yield* engine.ensures).toBe(1)

        yield* engine.stop
        const again = yield* linkWhere(
          client,
          link => Link.$is('Up')(link) && link.connection === 2,
        )
        expect(Option.isSome(again)).toBe(true)
        expect(yield* engine.ensures).toBe(2)
      }).pipe(Effect.scoped),
  )

  it.live(
    'fails in the words main answered where the engine could not be started',
    () =>
      Effect.gen(function* () {
        const path = join(
          yield* tempFolder('local-engine-failed'),
          'engine.sock',
        )
        const reason = new NoBundledEngine({ socket: path }).message
        const asks = yield* Ref.make(0)
        const starting = yield* pageThroughRelay(
          path,
          Effect.as(
            Ref.update(asks, count => count + 1),
            LocalEngineReach.cases.Failed.make({ reason }),
          ),
        )
        const failed = yield* Effect.flip(starting)
        expect(
          Option.map(
            failed._tag === 'RpcClientError'
              ? connectionFailed(failed)
              : Option.none(),
            ({ reason: said }) => said,
          ),
        ).toEqual(Option.some(reason))
        // The client's reconnects stop at the failure: its next attempt asks again.
        expect(yield* Ref.get(asks)).toBe(1)
      }).pipe(Effect.scoped),
  )
})
