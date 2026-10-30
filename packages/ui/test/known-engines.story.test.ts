import { Effect, Layer, Option, Stream } from 'effect'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { SocketServer } from 'effect/socket'
import {
  Command as SceneCommand,
  click,
  expect as expectScene,
  given as givenScene,
  label,
  role,
  scene,
  text,
  type,
  within,
} from 'foldkit/scene'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, it, test } from '@effect/vitest'
import {
  CheckAnswer,
  ConnectionRefused,
  EngineAddress,
  EngineHost,
  type HostCheck,
  InstallAnswer,
  InstallConsent,
  InstallPlan,
  KeepAnswer,
  KnownEngine,
  KnownEnginesAnswer,
  defaultEngineName,
  portServer,
  webPortEnd,
} from '@fabrica/client'
import {
  EngineHello,
  EngineId,
  EngineRpcs,
  ProjectId,
  ProjectRpcs,
  ProjectRunState,
  ProjectStatus,
  type ProjectStatusItem,
  ProtocolVersion,
  StreamEpoch,
  VersionMismatch,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, clientName } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { init } from '../src/app/program'
import * as RemoteEngines from '../src/app/remote-engines'
import { Screen } from '../src/app/screen'
import { projectMessages } from '../src/app/subscriptions'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import { rows } from '../src/console/sidebar'
import * as Engines from '../src/screens/engines'

// The engines the app knows on other hosts (spec §9.1): read from the app's state as it starts; one Add
// engine installed, or found up to date, joins them under the name the user gave (its host's where they
// gave none) and is connected to, and kept once its first hello comes; each has its card, its project
// rows joining the sidebar's under its name; one that refuses the app at connect is offered its update
// over SSH, and one ssh refused is tried again when the user asks. Its connection, over a port of its
// own, against a test engine on the far end of a MessageChannel.

const flags = { platform: 'darwin' as const, release: '0.2.0' }
const start: Model = initialModel(flags)

const buildBox = EngineHost.cases.Ssh.make({ destination: 'me@build-box' })
const buildBoxAddress = EngineAddress.cases.Ssh.make({
  destination: 'me@build-box',
})
const serverEngine = EngineId.make('e-build-box')

const checkOf = (plan: InstallPlan): HostCheck => ({
  host: 'Linux x86_64, glibc 2.39',
  target: 'linux-x64',
  plan,
  notes: [],
})
const fresh = checkOf(InstallPlan.cases.Install.make({ to: '0.2.0' }))
const older = checkOf(
  InstallPlan.cases.Update.make({ from: '0.1.0', to: '0.2.0' }),
)
const current = checkOf(InstallPlan.cases.Current.make({ version: '0.2.0' }))
const installed = InstallAnswer.cases.Installed.make({
  installed: {
    version: '0.2.0',
    launcher: '/home/me/.local/share/fabrica/engine/0.2.0/bin/fabrica',
    service: 'installed the systemd user unit fabrica.service',
  },
})

const kept = (name: string, address: EngineAddress) =>
  KnownEngine.make({
    name,
    address,
    engine: EngineId.make(`e-${name}`),
    protocol: protocolVersion,
  })

const engines = (shown: Model) =>
  shown.remotes.engines.map(engine => ({
    name: engine.name,
    attempt: engine.attempt,
    connection: engine.connection._tag,
  }))

const engineMessage = (message: Engines.Message) =>
  Message.GotEnginesMessage({ message })

const hello = (engine: EngineId, protocol: ProtocolVersion = protocolVersion) =>
  ({ engine, release: '0.2.0', protocol }) as const

describe('the known engines', () => {
  test('are asked of the app as it starts, those on other hosts joining the app’s', () => {
    const started = init(flags)
    expect(started.commands).toEqual([RemoteEngines.LoadKnownEngines()])
    story(
      update,
      given(start),
      message(
        Message.LoadedKnownEngines({
          answer: KnownEnginesAnswer.cases.Read.make({
            engines: [
              kept('local', EngineAddress.cases.Local.make({})),
              kept('build-box', buildBoxAddress),
            ],
          }),
        }),
      ),
      model(shown => {
        // This machine's engine is the app's own connection's.
        expect(engines(shown)).toEqual([
          { name: 'build-box', attempt: 1, connection: 'Connecting' },
        ])
        expect(RemoteEngines.attempts(shown.remotes)).toEqual([
          { name: 'build-box', address: buildBoxAddress, attempt: 1 },
        ])
      }),
      message(
        Message.LoadedKnownEngines({
          answer: KnownEnginesAnswer.cases.Failed.make({
            reason: 'state.json is not the app’s',
          }),
        }),
      ),
      model(shown => {
        expect(shown.remotes.problem).toEqual(
          Option.some(
            'The app’s known engines couldn’t be read: state.json is not the app’s',
          ),
        )
      }),
    )
  })

  test('one Add engine installed joins them, connected to, and is kept once its first hello comes', () => {
    const adding: Model = { ...start, screen: Screen.Engines() }
    scene(
      { update, view },
      givenScene(adding),
      click(role('button', { name: '+ Add engine' })),
      type(label('SSH destination'), 'me@build-box'),
      click(role('button', { name: 'Check the host' })),
      SceneCommand.resolve(
        Engines.CheckEngine({ host: buildBox }),
        Engines.Message.CompletedEngineCheck({
          host: buildBox,
          answer: CheckAnswer.cases.Checked.make({ check: fresh }),
        }),
      ),
      click(role('button', { name: 'Install 0.2.0' })),
      SceneCommand.resolve(
        Engines.InstallEngine({
          host: buildBox,
          consent: InstallConsent.cases.Install.make({ to: '0.2.0' }),
        }),
        Engines.Message.CompletedEngineInstall({
          host: buildBox,
          answer: installed,
        }),
      ),
      expectScene(
        within(
          role('article', { name: 'Engine build-box' }),
          text('Connecting'),
        ),
      ).toExist(),
      expectScene(
        within(
          role('article', { name: 'Engine build-box' }),
          text('me@build-box'),
        ),
      ).toExist(),
    )

    const added = RemoteEngines.added(RemoteEngines.init(), {
      name: 'build-box',
      address: buildBoxAddress,
    })
    story(
      update,
      given({ ...start, remotes: added }),
      message(
        Message.ConnectedToRemote({
          name: 'build-box',
          ...hello(serverEngine),
        }),
      ),
      Command.resolve(
        RemoteEngines.KeepEngine({
          engine: KnownEngine.make({
            name: 'build-box',
            address: buildBoxAddress,
            engine: serverEngine,
            protocol: protocolVersion,
          }),
        }),
        Message.CompletedKeepEngine({
          name: 'build-box',
          answer: KeepAnswer.cases.Kept.make({}),
        }),
      ),
      model(shown => {
        expect(engines(shown)).toEqual([
          { name: 'build-box', attempt: 1, connection: 'Up' },
        ])
      }),
      // The link's Up again, after a reconnect: the state holds it so already.
      message(
        Message.ConnectedToRemote({
          name: 'build-box',
          ...hello(serverEngine),
        }),
      ),
      Command.expectNone(),
      message(Message.LostRemote({ name: 'build-box' })),
      model(shown => {
        expect(engines(shown)).toEqual([
          { name: 'build-box', attempt: 1, connection: 'Down' },
        ])
      }),
    )
  })

  test('one found up to date joins them as well; a host found with nothing done, or failing, does not', () => {
    const checking = (name: string): Engines.Model => ({
      ...Engines.init(),
      engineSetup: Engines.EngineSetup.Running({
        host: buildBox,
        name: Option.some(name),
        step: Engines.SetupStep.Checking(),
      }),
    })
    const after = (setup: Engines.Model, answer: CheckAnswer) =>
      update(
        { ...start, screens: { ...start.screens, engines: setup } },
        engineMessage(
          Engines.Message.CompletedEngineCheck({ host: buildBox, answer }),
        ),
      ).model
    expect(
      engines(
        after(
          checking('box'),
          CheckAnswer.cases.Checked.make({ check: current }),
        ),
      ),
    ).toEqual([{ name: 'box', attempt: 1, connection: 'Connecting' }])
    expect(
      engines(
        after(
          checking('box'),
          CheckAnswer.cases.Checked.make({ check: older }),
        ),
      ),
    ).toEqual([])
    expect(
      engines(
        after(
          checking('box'),
          CheckAnswer.cases.Checked.make({
            check: checkOf(
              InstallPlan.cases.Newer.make({
                there: '0.3.0',
                offered: '0.2.0',
              }),
            ),
          }),
        ),
      ),
    ).toEqual([])
    expect(
      engines(
        after(
          checking('box'),
          CheckAnswer.cases.Failed.make({ reason: 'ssh: no route to host' }),
        ),
      ),
    ).toEqual([])
  })

  test('the name is the one given, the host’s where none is, and never this machine’s nor another engine’s', () => {
    expect(defaultEngineName('me@build-box')).toBe('build-box')
    expect(defaultEngineName('ssh://me@build-box:2222')).toBe('build-box')
    expect(defaultEngineName('build-box')).toBe('build-box')

    const known = RemoteEngines.added(RemoteEngines.init(), {
      name: 'box',
      address: EngineAddress.cases.Ssh.make({ destination: 'me@other-box' }),
    }).engines
    const submit = (destination: string, name: string) =>
      [
        Engines.Message.OpenedAddEngine(),
        Engines.Message.ChangedEngineDestination({ destination }),
        Engines.Message.ChangedEngineName({ name }),
        Engines.Message.SubmittedAddEngine(),
      ].reduce(
        (shown, next) => Engines.update(shown, next, known).model,
        Engines.init(),
      ).engineSetup
    expect(submit('me@build-box', '')).toEqual(
      Engines.EngineSetup.Running({
        host: buildBox,
        name: Option.some('build-box'),
        step: Engines.SetupStep.Checking(),
      }),
    )
    expect(submit('me@build-box', ' ci ')).toEqual(
      Engines.EngineSetup.Running({
        host: buildBox,
        name: Option.some('ci'),
        step: Engines.SetupStep.Checking(),
      }),
    )
    expect(submit('me@local', '')).toEqual(
      Engines.EngineSetup.Editing({
        destination: 'me@local',
        name: '',
        problem: Option.some(
          'local names this machine’s engine: give the engine another name.',
        ),
      }),
    )
    expect(submit('me@build-box', 'box')).toEqual(
      Engines.EngineSetup.Editing({
        destination: 'me@build-box',
        name: 'box',
        problem: Option.some(
          'box names another of the app’s engines: give this one another name.',
        ),
      }),
    )
    // A host the app knows already keeps its engine's name.
    expect(submit('me@other-box', 'renamed')).toEqual(
      Engines.EngineSetup.Running({
        host: EngineHost.cases.Ssh.make({ destination: 'me@other-box' }),
        name: Option.some('box'),
        step: Engines.SetupStep.Checking(),
      }),
    )
  })

  test('one too old for the app is offered its update over SSH, and connected to again once updated', () => {
    const refused: Model = {
      ...start,
      screen: Screen.Engines(),
      remotes: RemoteEngines.connectionChanged(
        RemoteEngines.loaded(RemoteEngines.init(), [
          kept('build-box', buildBoxAddress),
        ]),
        'build-box',
        Connection.Refused({
          client: ProtocolVersion.make(2),
          engine: ProtocolVersion.make(1),
          update: 'engine',
        }),
      ),
    }
    const card = role('article', { name: 'Engine build-box' })
    scene(
      { update, view },
      givenScene(refused),
      expectScene(within(card, text('Needs an update'))).toExist(),
      click(within(card, role('button', { name: 'Update the engine' }))),
      SceneCommand.resolve(
        Engines.CheckEngine({ host: buildBox }),
        Engines.Message.CompletedEngineCheck({
          host: buildBox,
          answer: CheckAnswer.cases.Checked.make({ check: older }),
        }),
      ),
      click(role('button', { name: 'Update to 0.2.0' })),
      SceneCommand.resolve(
        Engines.InstallEngine({
          host: buildBox,
          consent: InstallConsent.cases.Update.make({
            from: '0.1.0',
            to: '0.2.0',
          }),
        }),
        Engines.Message.CompletedEngineInstall({
          host: buildBox,
          answer: installed,
        }),
      ),
      expectScene(within(card, text('Connecting'))).toExist(),
    )
    const updated = [
      engineMessage(
        Engines.Message.RequestedRemoteUpdate({
          name: 'build-box',
          destination: 'me@build-box',
        }),
      ),
      engineMessage(
        Engines.Message.CompletedEngineCheck({
          host: buildBox,
          answer: CheckAnswer.cases.Checked.make({ check: older }),
        }),
      ),
      engineMessage(Engines.Message.ConsentedInstall()),
      engineMessage(
        Engines.Message.CompletedEngineInstall({
          host: buildBox,
          answer: installed,
        }),
      ),
    ].reduce((shown, next) => update(shown, next).model, refused)
    expect(engines(updated)).toEqual([
      { name: 'build-box', attempt: 2, connection: 'Connecting' },
    ])
  })

  test('one too new for the app tells the user to update the app; one ssh refused is tried again when asked', () => {
    const known = RemoteEngines.loaded(RemoteEngines.init(), [
      kept('build-box', buildBoxAddress),
    ])
    const card = role('article', { name: 'Engine build-box' })
    scene(
      { update, view },
      givenScene({
        ...start,
        screen: Screen.Engines(),
        remotes: RemoteEngines.connectionChanged(
          known,
          'build-box',
          Connection.Refused({
            client: ProtocolVersion.make(2),
            engine: ProtocolVersion.make(3),
            update: 'client',
          }),
        ),
      }),
      expectScene(
        within(card, text(/newer than this app's 2: update the app/u)),
      ).toExist(),
      expectScene(
        within(card, role('button', { name: 'Update the engine' })),
      ).toBeAbsent(),
    )
    scene(
      { update, view },
      givenScene({
        ...start,
        screen: Screen.Engines(),
        remotes: RemoteEngines.connectionChanged(
          known,
          'build-box',
          Connection.Stopped({ reason: 'Host key verification failed.' }),
        ),
      }),
      expectScene(
        within(card, text('Host key verification failed.')),
      ).toExist(),
      click(within(card, role('button', { name: 'Try again' }))),
      expectScene(within(card, text('Connecting'))).toExist(),
    )
  })
})

// A test engine on the far end of a MessageChannel, as the connection process relays a known engine:
// it says hello and sends its project rows.

const served = EngineRpcs.merge(ProjectRpcs)

const notServed = () => Effect.die('not served')

const site = ProjectId.make('p-site')

const projectItems: ReadonlyArray<ProjectStatusItem> = [
  {
    _tag: 'snapshot',
    epoch: StreamEpoch.make('epoch-1'),
    seq: 0,
    value: [
      new ProjectStatus({
        project: site,
        name: 'site',
        base: 'main',
        setUp: true,
        trusted: false,
        run: ProjectRunState.cases.idle.make({}),
        ready: 0,
      }),
    ],
  },
]

/** The test engine, answering the app's hello with `answer`: its own, or its refusal. */
const engineAnswering = (answer: Effect.Effect<EngineHello, VersionMismatch>) =>
  served.toLayer({
    'engine.connect': () => answer,
    'engine.version': notServed,
    'engine.status': notServed,
    'engine.settings': notServed,
    'engine.stop': notServed,
    'engine.update': notServed,
    'engine.watchStatus': () => Stream.die('not served'),
    'engine.watchLoad': () => Stream.die('not served'),
    'projects.add': notServed,
    'projects.folders': notServed,
    'projects.list': notServed,
    'projects.remove': notServed,
    'projects.trust': notServed,
    'projects.settings.get': notServed,
    'projects.settings.set': notServed,
    'projects.init': notServed,
    'projects.watchStatus': () => Stream.fromIterable(projectItems),
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

/** The page's end of a port whose relay serves an engine answering the app's hello with `answer`. */
const servedPort = (answer: Effect.Effect<EngineHello, VersionMismatch>) =>
  Effect.gen(function* () {
    const { port1, port2 } = yield* channel
    yield* Layer.build(
      RpcServer.layer(served).pipe(
        Layer.provide(engineAnswering(answer)),
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

const connection = (port: MessagePort): RemoteEngines.RemoteConnection => ({
  name: 'build-box',
  port: Effect.succeed(port),
  client: { name: clientName, kind: 'app', release: '0.2.0' },
  streams: session => projectMessages(session, 'build-box', Effect.void),
})

describe('a known engine’s connection', () => {
  it.live(
    'says its hello, and its project rows join the sidebar’s under its name',
    () =>
      Effect.gen(function* () {
        const port = yield* servedPort(
          Effect.succeed(
            new EngineHello({
              protocol: protocolVersion,
              engine: serverEngine,
              release: '0.2.0',
            }),
          ),
        )
        const messages = yield* Stream.runCollect(
          RemoteEngines.remoteEngineMessages(connection(port)).pipe(
            Stream.filter(
              next =>
                next._tag === 'ReceivedProjects' ||
                next._tag === 'ConnectedToRemote',
            ),
            Stream.take(2),
          ),
        )
        expect(messages.map(next => next._tag).toSorted()).toEqual([
          'ConnectedToRemote',
          'ReceivedProjects',
        ])
        const shown = messages.reduce(
          (current, next) => update(current, next).model,
          {
            ...start,
            remotes: RemoteEngines.added(RemoteEngines.init(), {
              name: 'build-box',
              address: buildBoxAddress,
            }),
          },
        )
        expect(
          rows(shown.console.sidebar).map(row => [
            row.status.name,
            row.engine.name,
          ]),
        ).toEqual([['site', 'build-box']])
        expect(engines(shown)).toEqual([
          { name: 'build-box', attempt: 1, connection: 'Up' },
        ])
      }).pipe(Effect.scoped),
  )

  it.live(
    'ends where the engine refuses the app’s version, waiting for an update',
    () =>
      Effect.gen(function* () {
        const port = yield* servedPort(
          Effect.fail(
            new VersionMismatch({
              client: protocolVersion,
              engine: ProtocolVersion.make(protocolVersion + 2),
              update: 'client',
            }),
          ),
        )
        const messages = yield* Stream.runCollect(
          RemoteEngines.remoteEngineMessages(connection(port)),
        )
        expect(messages.map(next => next._tag)).toEqual(['RefusedByRemote'])
      }).pipe(Effect.scoped),
  )

  it.live(
    'ends where the relay refuses it, in its words, until the user tries again',
    () =>
      Effect.gen(function* () {
        const { port1, port2 } = yield* channel
        yield* portServer(webPortEnd(port2))
          .run(() =>
            Effect.fail(
              new ConnectionRefused({
                reason: 'Host key verification failed.',
              }),
            ),
          )
          .pipe(Effect.forkScoped)
        const messages = yield* Stream.runCollect(
          RemoteEngines.remoteEngineMessages(connection(port1)),
        )
        expect(messages).toEqual([
          Message.StoppedConnectingRemote({
            name: 'build-box',
            reason: 'Host key verification failed.',
          }),
        ])
      }).pipe(Effect.scoped),
  )
})

describe('the known engines’ connections', () => {
  it.live(
    'are each held on their own: one added, tried again or gone leaves the others’ up',
    () =>
      Effect.gen(function* () {
        const connections = yield* RemoteEngines.makeRemoteConnections
        const started: Array<string> = []
        const stopped: Array<string> = []
        const connect = (engine: RemoteEngines.Attempt) =>
          Stream.concat(
            Stream.make(
              Message.LostRemote({ name: `${engine.name}#${engine.attempt}` }),
            ),
            Stream.never,
          ).pipe(
            Stream.onStart(
              Effect.sync(() =>
                started.push(`${engine.name}#${engine.attempt}`),
              ),
            ),
            Stream.ensuring(
              Effect.sync(() =>
                stopped.push(`${engine.name}#${engine.attempt}`),
              ),
            ),
          )
        const attempt = (
          name: string,
          tries: number,
        ): RemoteEngines.Attempt => ({
          name,
          address: EngineAddress.cases.Ssh.make({ destination: `me@${name}` }),
          attempt: tries,
        })
        // Each connection's first Message, once it has started.
        const next = connections.messages.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.map(taken =>
            taken.map(message => message._tag === 'LostRemote' && message.name),
          ),
        )
        yield* connections.hold([attempt('a', 1)], connect)
        expect(yield* next).toEqual(['a#1'])
        yield* connections.hold([attempt('a', 1), attempt('b', 1)], connect)
        expect(yield* next).toEqual(['b#1'])
        yield* connections.hold([attempt('a', 1), attempt('b', 2)], connect)
        expect(yield* next).toEqual(['b#2'])
        yield* connections.hold([attempt('b', 2)], connect)
        expect(started).toEqual(['a#1', 'b#1', 'b#2'])
        expect(stopped).toEqual(['b#1', 'a#1'])
      }).pipe(Effect.scoped),
  )
})
