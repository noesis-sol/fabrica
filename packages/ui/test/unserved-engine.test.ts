import {
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { SocketServer } from 'effect/socket'
import { Runtime } from 'foldkit'

import { describe, expect, it } from '@effect/vitest'
import { portServer, webPortEnd } from '@fabrica/client'
import {
  AttentionRpcs,
  EngineHello,
  EngineId,
  EngineRpcs,
  HostLoad,
  ProjectId,
  RunRpcs,
  StreamEpoch,
  protocolVersion,
} from '@fabrica/contracts'

import { localEngineName } from '../src/app/connection'
import { nextAnimationFrame } from '../src/app/frame'
import { noAppHost } from '../src/app/host'
import type { Pressed } from '../src/app/keys'
import type { Message } from '../src/app/message'
import { type Flags, initialModel } from '../src/app/model'
import { silentNotifier } from '../src/app/notifier'
import { program } from '../src/app/program'
import { noSshPromptHost } from '../src/app/ssh-prompts'
import { themeHostOf } from '../src/app/theme-host'
import { update } from '../src/app/update'

// The console against an engine that serves little yet (fab-mgi.87): the engine answers every request
// and stream it doesn't serve with a defect, `NotImplemented` (packages/engine/src/rpc/not-implemented.ts),
// and a request of a group it doesn't serve at all the same way. The whole program runs, its
// subscriptions and Commands included, over a port to the engine; the console stays drawn, each
// stream ended and each request failed in words, rather than Foldkit's crash view.

const flags: Flags = { platform: 'darwin', release: '0.0.0' }

const project = ProjectId.make('p-1')

/** What the engine's unserved handlers die with. */
class NotImplemented extends Error {
  override readonly name = 'NotImplemented'
  constructor(readonly rpc: string) {
    super(`${rpc} is not implemented yet`)
  }
}

const notImplemented = (rpc: string) => () =>
  Effect.die(new NotImplemented(rpc))

const load = Schema.decodeUnknownSync(Schema.toCodecJson(HostLoad))({
  sampledAt: 1_793_268_900_000,
  memory: { used: 1_000_000, total: 8_000_000, pressure: 'normal' },
  swapping: false,
  load1: 1.5,
  cores: 8,
  busyCores: 2,
  workers: [],
  mergeCheck: null,
})

const served = EngineRpcs.merge(AttentionRpcs, RunRpcs)

/**
 * The engine's handlers: hello, and `NotImplemented` for the rest but the host's load, which it sends
 * once the console's two attention streams were answered, so the console has their answers first.
 */
const handlersOf = (attentionAnswered: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    const attentionWatches = yield* Ref.make(0)
    return served.toLayer({
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
      'engine.watchLoad': () =>
        Stream.unwrap(
          Effect.as(
            Deferred.await(attentionAnswered),
            Stream.concat(
              Stream.make({
                _tag: 'snapshot' as const,
                epoch: StreamEpoch.make('epoch-1'),
                seq: 0,
                value: load,
              }),
              Stream.never,
            ),
          ),
        ),
      'attention.list': notImplemented('attention.list'),
      'attention.answer': notImplemented('attention.answer'),
      'attention.watch': () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const watches = yield* Ref.updateAndGet(
              attentionWatches,
              n => n + 1,
            )
            if (watches === 2) {
              yield* Deferred.succeed(attentionAnswered, undefined)
            }
            return Stream.die(new NotImplemented('attention.watch'))
          }),
        ),
      'run.start': notImplemented('run.start'),
      'run.stop': notImplemented('run.stop'),
      'run.drain': notImplemented('run.drain'),
      'run.undrain': notImplemented('run.undrain'),
      'run.status': notImplemented('run.status'),
      'run.preflight': notImplemented('run.preflight'),
      'run.watchView': notImplemented('run.watchView'),
      'run.watchEvents': notImplemented('run.watchEvents'),
    })
  })

const pressed = (key: string, mod: boolean): Pressed => ({
  key,
  mod,
  alt: false,
  inField: false,
})

describe('the console against an engine that serves little yet', () => {
  it.live(
    'stays drawn as its streams and requests are answered NotImplemented',
    () =>
      Effect.gen(function* () {
        const channel = new MessageChannel()
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            channel.port1.close()
            channel.port2.close()
          }),
        )
        const attentionAnswered = yield* Deferred.make<void>()
        yield* Layer.build(
          // As the engine's server does, a defect answers its own request.
          RpcServer.layer(served, { disableFatalDefects: true }).pipe(
            Layer.provide(yield* handlersOf(attentionAnswered)),
            Layer.provide(RpcServer.layerProtocolSocketServer),
            Layer.provide(RpcSerialization.layerNdjson),
            Layer.provide(
              Layer.succeed(
                SocketServer.SocketServer,
                portServer(webPortEnd(channel.port2)),
              ),
            ),
          ),
        )

        const keys = yield* Queue.unbounded<Pressed>()
        const seen = yield* SubscriptionRef.make<ReadonlyArray<Message>>([])
        const crashed = yield* Deferred.make<Error>()
        const {
          Flags: _flags,
          init: _init,
          ...app
        } = program({
          enginePort: Effect.succeed(channel.port1),
          nextFrame: Effect.void,
          keys: Stream.fromQueue(keys),
          ticks: Stream.never,
          replacedEnginePorts: Stream.never,
          notifier: silentNotifier,
          host: noAppHost,
          sshPrompts: noSshPromptHost,
          themeHost: themeHostOf(window),
        })
        const container = document.createElement('div')
        container.id = 'root'
        document.body.append(container)
        const handle = Runtime.embed(
          Runtime.makeApplication({
            ...app,
            init: () => ({
              model: {
                ...initialModel(flags),
                scope: Option.some({ engine: localEngineName, project }),
              },
            }),
            update: (model, message) => {
              Effect.runSync(
                SubscriptionRef.update(seen, all => [...all, message]),
              )
              return update(model, message)
            },
            container,
            crash: {
              report: ({ error }) => {
                Deferred.doneUnsafe(crashed, Effect.succeed(error))
              },
            },
          }),
        )
        yield* Effect.addFinalizer(() => Effect.sync(handle.dispose))

        /** Waits for a Message `found` takes, failing with the crash where the console crashes first. */
        const awaitMessage = (found: (message: Message) => boolean) =>
          Effect.raceFirst(
            SubscriptionRef.changes(seen).pipe(
              Stream.filter(all => all.some(found)),
              Stream.runHead,
              Effect.asVoid,
            ),
            Effect.flatMap(Deferred.await(crashed), error =>
              Effect.fail(error),
            ),
          )

        yield* awaitMessage(message => message._tag === 'ConnectedToEngine')
        // Mod+6 opens the Engines screen, which asks for the engine's credentials (the Secrets group).
        yield* Queue.offer(keys, pressed('6', true))
        yield* awaitMessage(
          message =>
            message._tag === 'GotEnginesMessage' &&
            message.message._tag === 'FailedLoadCredentials',
        )
        yield* awaitMessage(
          message =>
            message._tag === 'EndedRunView' &&
            message.project.project === project,
        )
        yield* awaitMessage(message => message._tag === 'ReceivedLoad')

        // The view is drawn at the next animation frame after the Model changes.
        yield* nextAnimationFrame
        expect(yield* Deferred.isDone(crashed)).toBe(false)
        const shown = container.ownerDocument.body.textContent
        expect(shown).toContain('Engines and projects')
        expect(shown).toContain(
          "The credentials couldn't be listed: credentials.list failed:",
        )
        expect(shown).toContain('CORES2/8')
      }),
  )
})
