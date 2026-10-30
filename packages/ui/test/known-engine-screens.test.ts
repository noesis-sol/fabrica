import {
  Deferred,
  Effect,
  Layer,
  Option,
  Redacted,
  Stream,
  SubscriptionRef,
} from 'effect'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { SocketServer } from 'effect/socket'
import { Command, Runtime } from 'foldkit'

import { describe, expect, it } from '@effect/vitest'
import {
  EngineAddress,
  KnownEngine,
  KnownEnginesAnswer,
  portServer,
  webPortEnd,
} from '@fabrica/client'
import {
  AttentionRpcs,
  CredentialValue,
  EngineHello,
  EngineId,
  EngineRpcs,
  ProjectId,
  ProjectRpcs,
  ProjectSource,
  RunRpcs,
  SecretRpcs,
  protocolVersion,
} from '@fabrica/contracts'

import { isLive } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { noAppHost } from '../src/app/host'
import { Message } from '../src/app/message'
import { type Flags, initialModel } from '../src/app/model'
import { silentNotifier } from '../src/app/notifier'
import { program } from '../src/app/program'
import * as RemoteEngines from '../src/app/remote-engines'
import { Screen } from '../src/app/screen'
import { noSshPromptHost } from '../src/app/ssh-prompts'
import { themeHostOf } from '../src/app/theme-host'
import { update } from '../src/app/update'
import * as Engines from '../src/screens/engines'
import * as Settings from '../src/screens/settings'

// The Engines and Settings screens ask a known engine on another host through its own connection (spec
// §9.1, §10.1, §18.4): the whole program runs against two test engines, this machine's on the app's
// own port and `build-box` on the port main relays to it. Once both are connected, the Engines screen
// opened asks each for its status and credentials, and what the screen sends for the build-box (its
// folders browsed, a project added there, its project's trust and setting up, a credential set and
// removed there) and the Settings screen's engine settings, scoped to its project, reach the
// build-box, this machine's engine asked none of them.

const flags: Flags = { platform: 'darwin', release: '0.0.0' }

const box = 'build-box'
const boxEngine = EngineId.make('e-build-box')
const boxAddress = EngineAddress.cases.Ssh.make({ destination: 'me@build-box' })
const site = ProjectId.make('p-site')
const siteOnBox: EngineProject = { engine: box, project: site }

const served = EngineRpcs.merge(ProjectRpcs, RunRpcs, AttentionRpcs, SecretRpcs)

const notServed = () => Effect.die('not served')

/** A test engine saying hello as `engine`, keeping in `asked` the name of each request the screens make of it. */
const engineServing = ({
  engine,
  asked,
}: {
  readonly engine: EngineId
  readonly asked: SubscriptionRef.SubscriptionRef<ReadonlyArray<string>>
}) => {
  const ask = (rpc: string) => () =>
    Effect.andThen(
      SubscriptionRef.update(asked, all => [...all, rpc]),
      () => Effect.die('not served'),
    )
  return served.toLayer({
    'engine.connect': () =>
      Effect.succeed(
        new EngineHello({
          protocol: protocolVersion,
          engine,
          release: '0.0.0',
        }),
      ),
    'engine.version': notServed,
    'engine.status': ask('engine.status'),
    'engine.settings': ask('engine.settings'),
    'engine.stop': notServed,
    'engine.update': notServed,
    'engine.watchStatus': () => Stream.never,
    'engine.watchLoad': () => Stream.never,
    'projects.add': ask('projects.add'),
    'projects.folders': ask('projects.folders'),
    'projects.list': notServed,
    'projects.remove': notServed,
    'projects.trust': ask('projects.trust'),
    'projects.settings.get': notServed,
    'projects.settings.set': notServed,
    'projects.init': ask('projects.init'),
    'projects.watchStatus': () => Stream.never,
    'run.start': notServed,
    'run.stop': notServed,
    'run.drain': notServed,
    'run.undrain': notServed,
    'run.status': notServed,
    'run.preflight': notServed,
    'run.watchView': () => Stream.never,
    'run.watchEvents': () => Stream.never,
    'attention.list': notServed,
    'attention.answer': notServed,
    'attention.watch': () => Stream.never,
    'credentials.set': ask('credentials.set'),
    'credentials.list': ask('credentials.list'),
    'credentials.remove': ask('credentials.remove'),
    'credentials.login': () => Stream.never,
  })
}

/** A port pair whose far end an engine serving `handlers` answers; the page's end, closed with the scope. */
const servedPort = <E>(
  handlers: Layer.Layer<Layer.Success<ReturnType<typeof engineServing>>, E>,
) =>
  Effect.gen(function* () {
    const { port1, port2 } = yield* Effect.acquireRelease(
      Effect.sync(() => new MessageChannel()),
      ({ port1, port2 }) =>
        Effect.sync(() => {
          port1.close()
          port2.close()
        }),
    )
    yield* Layer.build(
      RpcServer.layer(served, { disableFatalDefects: true }).pipe(
        Layer.provide(handlers),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(
          Layer.succeed(
            SocketServer.SocketServer,
            portServer(webPortEnd(port2)),
          ),
        ),
      ),
    )
    return port1
  })

/** What the user sends for the build-box from the screens, as the app's Messages' Commands. */
const forTheBox = [
  Command.mapMessage(
    Engines.LoadFolders({ engine: box, path: Option.none() }),
    message => Message.GotEnginesMessage({ message }),
  ),
  Command.mapMessage(
    Engines.AddProject({
      engine: box,
      source: ProjectSource.cases.path.make({ path: '/home/me/site' }),
      name: Option.none(),
    }),
    message => Message.GotEnginesMessage({ message }),
  ),
  Command.mapMessage(
    Engines.SetProjectTrust({ project: siteOnBox, trusted: true }),
    message => Message.GotEnginesMessage({ message }),
  ),
  Command.mapMessage(Engines.SetUpProject({ project: siteOnBox }), message =>
    Message.GotEnginesMessage({ message }),
  ),
  Command.mapMessage(
    Engines.SetCredential({
      engine: box,
      name: 'anthropic',
      value: CredentialValue.cases.key.make({
        key: Redacted.make('sk-ant-secret'),
      }),
      provider: Option.none(),
    }),
    message => Message.GotEnginesMessage({ message }),
  ),
  Command.mapMessage(
    Engines.RemoveCredential({
      credential: { engine: box, name: 'openai' },
    }),
    message => Message.GotEnginesMessage({ message }),
  ),
  Command.mapMessage(Settings.LoadEngineSettings({ engine: box }), message =>
    Message.GotSettingsMessage({ message }),
  ),
]

const boxOnly = [
  'engine.settings',
  'projects.folders',
  'projects.add',
  'projects.trust',
  'projects.init',
  'credentials.set',
  'credentials.remove',
]

describe('the screens with a known engine connected', () => {
  it.live(
    'ask it for its status and credentials, and send what is for it to it alone',
    () =>
      Effect.gen(function* () {
        const localAsked = yield* SubscriptionRef.make<ReadonlyArray<string>>(
          [],
        )
        const boxAsked = yield* SubscriptionRef.make<ReadonlyArray<string>>([])
        const localPort = yield* servedPort(
          engineServing({
            engine: EngineId.make('e-local'),
            asked: localAsked,
          }),
        )
        const boxPort = yield* servedPort(
          engineServing({ engine: boxEngine, asked: boxAsked }),
        )

        const crashed = yield* Deferred.make<Error>()
        const {
          Flags: _flags,
          init: _init,
          ...app
        } = program({
          enginePort: Effect.succeed(localPort),
          nextFrame: Effect.void,
          keys: Stream.never,
          ticks: Stream.never,
          replacedEnginePorts: Stream.never,
          notifier: silentNotifier,
          host: {
            ...noAppHost,
            knownEngines: Option.some(
              Effect.succeed(
                KnownEnginesAnswer.cases.Read.make({
                  engines: [
                    KnownEngine.make({
                      name: box,
                      address: boxAddress,
                      engine: boxEngine,
                      protocol: protocolVersion,
                    }),
                  ],
                }),
              ),
            ),
            enginePort: Option.some(() => Effect.succeed(boxPort)),
          },
          sshPrompts: noSshPromptHost,
          themeHost: themeHostOf(window),
        })
        const container = document.createElement('div')
        container.id = 'root'
        document.body.append(container)
        let opened = false
        const handle = Runtime.embed(
          Runtime.makeApplication({
            ...app,
            init: () => ({
              model: initialModel(flags),
              commands: [RemoteEngines.LoadKnownEngines()],
            }),
            update: (model, message) => {
              const next = update(model, message)
              if (
                opened ||
                !isLive(next.model.connection) ||
                !RemoteEngines.isEngineLive(next.model, box)
              ) {
                return next
              }
              // Both engines connected: the user opens the Engines screen, and sends what is for the
              // build-box.
              opened = true
              const shown = update(
                next.model,
                Message.RequestedScreen({ screen: Screen.Engines() }),
              )
              return {
                model: shown.model,
                commands: [
                  ...(next.commands ?? []),
                  ...(shown.commands ?? []),
                  ...forTheBox,
                ],
              }
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

        /** Waits for `asked` to hold every one of `rpcs`, failing with the crash where the app crashes first. */
        const awaiting = (
          asked: SubscriptionRef.SubscriptionRef<ReadonlyArray<string>>,
          rpcs: ReadonlyArray<string>,
        ) =>
          Effect.raceFirst(
            SubscriptionRef.changes(asked).pipe(
              Stream.filter(all => rpcs.every(rpc => all.includes(rpc))),
              Stream.runHead,
              Effect.asVoid,
            ),
            Effect.flatMap(Deferred.await(crashed), error =>
              Effect.fail(error),
            ),
          )

        // The screen opened asks each engine for its status and credentials.
        yield* awaiting(boxAsked, ['engine.status', 'credentials.list'])
        yield* awaiting(localAsked, ['engine.status', 'credentials.list'])
        // What is for the build-box reaches it, and this machine's engine is asked none of it.
        yield* awaiting(boxAsked, boxOnly)
        expect(
          (yield* SubscriptionRef.get(localAsked)).filter(rpc =>
            boxOnly.includes(rpc),
          ),
        ).toEqual([])
        expect(yield* Deferred.isDone(crashed)).toBe(false)
      }).pipe(Effect.scoped),
  )
})
