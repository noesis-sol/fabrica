import { Option, Redacted, Schema } from 'effect'
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

import { describe, expect, test } from '@effect/vitest'
import { EngineAddress } from '@fabrica/client'
import {
  CredentialInfo,
  CredentialValue,
  EngineId,
  EngineSettings,
  EngineStatus,
  FolderListing,
  ProjectId,
  ProjectSource,
  ProjectStatus,
  StreamEpoch,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import * as RemoteEngines from '../src/app/remote-engines'
import { Screen } from '../src/app/screen'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Engines from '../src/screens/engines'
import * as Settings from '../src/screens/settings'

// A known engine on another host on the Engines and Settings screens (spec §10.1, §18.4): the Settings
// screen shows the settings of the scoped project's engine, named after it; the Engines screen asks
// this machine's engine and each connected known engine for its status and credentials, and lists
// each one's projects under its name, Add project and the folder browser asking the engine whose list
// it was opened from, a project's trust the engine holding it, and a credential set on the engine the
// form chooses.

const flags = { platform: 'darwin' as const, release: '0.0.0' }

const box = 'build-box'
const boxEngine = EngineId.make('e-build-box')
const localEngine = EngineId.make('e-local')
const site = ProjectId.make('p-site')
const home = ProjectId.make('p-home')
const siteOnBox: EngineProject = { engine: box, project: site }
const homeHere: EngineProject = { engine: localEngineName, project: home }

const status = (hostname: string) =>
  Schema.decodeUnknownSync(EngineStatus)({
    id: 'e-build-box',
    release: '0.2.0',
    startedAt: 1_793_268_900_000,
    host: { platform: 'linux', arch: 'x64', hostname, cores: 16 },
    listening: null,
    projects: 1,
    runs: 0,
    liveWorkers: 0,
    machineWorkers: 8,
    clients: 1,
    stopping: false,
  })

const row = (project: ProjectId, name: string) =>
  Schema.decodeUnknownSync(ProjectStatus)({
    project,
    name,
    base: 'main',
    setUp: true,
    trusted: false,
    run: { _tag: 'idle' },
    ready: 0,
  })

const rowsOf = (
  engine: EngineId,
  name: string,
  projects: ReadonlyArray<ProjectStatus>,
) =>
  Message.ReceivedProjects({
    engine,
    name,
    items: [
      {
        _tag: 'snapshot',
        epoch: StreamEpoch.make('epoch-1'),
        seq: 0,
        value: projects,
      },
    ],
  })

/** This machine's engine and the build-box connected, each with its one project in the sidebar. */
const connected: Model = [
  rowsOf(localEngine, localEngineName, [row(home, 'home')]),
  rowsOf(boxEngine, box, [row(site, 'site')]),
].reduce<Model>((shown, received) => update(shown, received).model, {
  ...initialModel(flags),
  connection: Connection.Up({
    engine: localEngine,
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  remotes: RemoteEngines.connected(
    RemoteEngines.added(RemoteEngines.init(), {
      name: box,
      address: EngineAddress.cases.Ssh.make({ destination: 'me@build-box' }),
    }),
    {
      name: box,
      hello: Connection.Up({
        engine: boxEngine,
        release: '0.2.0',
        protocol: protocolVersion,
      }),
    },
  ).model,
})

const engineSettings = (written: object): EngineSettings =>
  Schema.decodeUnknownSync(EngineSettings)(written)

describe('the Settings screen', () => {
  test('shows the settings of the scoped project’s engine, named after it; another engine’s reply is dropped', () => {
    story(
      Settings.update,
      given(Settings.opened(Settings.init(), Option.some(siteOnBox)).model),
      model(shown => {
        expect(shown.engine).toBe(box)
      }),
      message(
        Settings.Message.SucceededLoadEngineSettings({
          engine: localEngineName,
          settings: engineSettings({ worker_nice: 5 }),
        }),
      ),
      model(shown => {
        expect(shown.engineSettings._tag).toBe('Loading')
      }),
      message(
        Settings.Message.SucceededLoadEngineSettings({
          engine: box,
          settings: engineSettings({ worker_nice: 10 }),
        }),
      ),
      model(shown => {
        expect(shown.engineSettings._tag).toBe('Success')
      }),
    )
    const opened = Settings.opened(Settings.init(), Option.some(siteOnBox))
    expect(opened.commands?.map(command => command.args)).toStrictEqual([
      { engine: box },
      { project: siteOnBox },
    ])
    // Scoped to this machine's project, this machine's engine's are asked afresh.
    const rescoped = Settings.opened(
      Settings.update(
        opened.model,
        Settings.Message.SucceededLoadEngineSettings({
          engine: box,
          settings: engineSettings({}),
        }),
      ).model,
      Option.some(homeHere),
    )
    expect(rescoped.model.engine).toBe(localEngineName)
    expect(rescoped.model.engineSettings._tag).toBe('Loading')
    expect(rescoped.commands?.[0]?.args).toStrictEqual({
      engine: localEngineName,
    })
  })

  test('the screen names the engine whose settings it shows', () => {
    const scoped = update(
      connected,
      Message.SelectedScope({ project: Option.some(siteOnBox) }),
    ).model
    const opened = update(
      scoped,
      Message.RequestedScreen({ screen: Screen.Settings() }),
    )
    expect(
      opened.commands?.flatMap(command =>
        command.name === 'LoadEngineSettings' ? [command.args] : [],
      ),
    ).toStrictEqual([{ engine: box }])
    const shown = update(
      opened.model,
      Message.GotSettingsMessage({
        message: Settings.Message.SucceededLoadEngineSettings({
          engine: box,
          settings: engineSettings({ worker_nice: 5 }),
        }),
      }),
    ).model
    scene(
      { update, view },
      givenScene(shown),
      expectScene(role('region', { name: 'Engine settings' })).toContainText(
        `Engine · ${box}`,
      ),
      expectScene(
        within(
          role('list', { name: 'The engine’s settings' }),
          role('listitem', { name: 'worker_nice' }),
        ),
      ).toHaveText("worker_nice5the engine's settings"),
    )
  })
})

describe('the Engines screen', () => {
  test('opened, asks each connected engine for its status and credentials; one reached later is asked alone', () => {
    const opened = update(
      connected,
      Message.RequestedScreen({ screen: Screen.Engines() }),
    )
    expect(
      opened.commands?.map(command => [command.name, command.args]),
    ).toStrictEqual([
      ['LoadEngineStatus', { engine: localEngineName }],
      ['LoadCredentials', { engine: localEngineName }],
      ['LoadEngineStatus', { engine: box }],
      ['LoadCredentials', { engine: box }],
    ])
    // The build-box's answers fail; it is lost, and reached again.
    const answered = [
      Engines.Message.FailedLoadStatus({ engine: box, reason: 'lost' }),
      Engines.Message.FailedLoadCredentials({ engine: box, reason: 'lost' }),
    ].reduce(
      (shown, answer) =>
        update(shown, Message.GotEnginesMessage({ message: answer })).model,
      opened.model,
    )
    const lost = update(answered, Message.LostRemote({ name: box })).model
    const reached = update(
      lost,
      Message.ConnectedToRemote({
        name: box,
        engine: boxEngine,
        release: '0.2.0',
        protocol: protocolVersion,
      }),
    )
    expect(
      reached.commands?.map(command => [command.name, command.args]),
    ).toStrictEqual([
      ['LoadEngineStatus', { engine: box }],
      ['LoadCredentials', { engine: box }],
    ])
  })

  /** The screen shown, each engine's status and credentials as given. */
  const onScreen = (
    credentials: Readonly<Record<string, ReadonlyArray<CredentialInfo>>>,
  ): Model => ({
    ...connected,
    screen: Screen.Engines(),
    screens: {
      ...connected.screens,
      engines: {
        ...connected.screens.engines,
        status: {
          [localEngineName]: { _tag: 'Success', data: status('laptop') },
          [box]: { _tag: 'Success', data: status('build-box.lan') },
        },
        credentials: Object.fromEntries(
          Object.entries(credentials).map(([engine, data]) => [
            engine,
            { _tag: 'Success' as const, data },
          ]),
        ),
      },
    },
  })

  const boxProjects = role('region', { name: `Projects on ${box}` })

  test('the known engine’s card shows its status, and its projects are listed under its name, trusted on it', () => {
    scene(
      { update, view },
      givenScene(onScreen({ [localEngineName]: [], [box]: [] })),
      expectScene(
        within(
          role('article', { name: `Engine ${box}` }),
          text(/build-box\.lan · linux x64/u),
        ),
      ).toExist(),
      expectScene(within(boxProjects, text('site'))).toExist(),
      expectScene(
        within(role('region', { name: 'Projects on local' }), text('site')),
      ).toBeAbsent(),
      click(within(boxProjects, role('button', { name: 'Trust site' }))),
      SceneCommand.expectExact(
        Engines.SetProjectTrust({ project: siteOnBox, trusted: true }),
      ),
      SceneCommand.resolve(
        Engines.SetProjectTrust,
        Engines.Message.FailedTrust({
          project: siteOnBox,
          reason: 'the engine stopped',
        }),
      ),
      expectScene(within(boxProjects, role('alert'))).toHaveText(
        "Couldn't change the trust in p-site: the engine stopped",
      ),
    )
  })

  const listing = FolderListing.make({
    path: '/home/me',
    parent: Option.some('/home'),
    checkout: false,
    folders: [],
  })

  test('Add project from its list adds the project on it, its folders browsed on its host', () => {
    scene(
      { update, view },
      givenScene(onScreen({ [localEngineName]: [], [box]: [] })),
      click(within(boxProjects, role('button', { name: '+ Add project' }))),
      expectScene(
        within(boxProjects, role('form', { name: 'Add project' })),
      ).toExist(),
      click(role('button', { name: 'Browse…' })),
      SceneCommand.expectExact(
        Engines.LoadFolders({ engine: box, path: Option.none() }),
      ),
      SceneCommand.resolve(
        Engines.LoadFolders,
        Engines.Message.SucceededFolders({
          engine: box,
          path: Option.none(),
          listing,
        }),
      ),
      expectScene(
        within(role('region', { name: `Folders on ${box}` }), text('/home/me')),
      ).toExist(),
      click(role('button', { name: 'Choose this folder' })),
      expectScene(label(`Its folder on ${box}`)).toHaveValue('/home/me'),
      click(role('button', { name: 'Add' })),
      SceneCommand.expectExact(
        Engines.AddProject({
          engine: box,
          source: ProjectSource.cases.path.make({ path: '/home/me' }),
          name: Option.none(),
        }),
      ),
      SceneCommand.resolve(
        Engines.AddProject,
        Engines.Message.FailedAddProject({ reason: 'not a git repository' }),
      ),
    )
  })

  test('a folder listed by another engine is not shown for the one browsed', () => {
    const browsing = Engines.update(
      Engines.openAddProject(Engines.init(), box),
      Engines.Message.OpenedFolders(),
    ).model
    const fromLocal = Engines.update(
      browsing,
      Engines.Message.SucceededFolders({
        engine: localEngineName,
        path: Option.none(),
        listing,
      }),
    )
    expect(fromLocal.model).toBe(browsing)
  })

  const anthropic = CredentialInfo.make({
    name: 'anthropic',
    kind: 'key',
    provider: Option.none(),
  })

  test('each engine’s credentials listed under its name, one set on the engine the form chooses and removed from its own', () => {
    scene(
      { update, view },
      givenScene(onScreen({ [localEngineName]: [], [box]: [anthropic] })),
      expectScene(
        within(
          role('region', { name: `Credentials on ${box}` }),
          text('anthropic'),
        ),
      ).toExist(),
      expectScene(
        within(
          role('region', { name: 'Credentials on local' }),
          text('No credentials yet.'),
        ),
      ).toExist(),
      click(
        within(
          role('region', { name: `Credentials on ${box}` }),
          role('button', { name: 'Remove anthropic' }),
        ),
      ),
      SceneCommand.expectExact(
        Engines.RemoveCredential({
          credential: { engine: box, name: 'anthropic' },
        }),
      ),
      SceneCommand.resolve(
        Engines.RemoveCredential,
        Engines.Message.FailedRemoveCredential({
          credential: { engine: box, name: 'anthropic' },
          reason: 'CredentialNotFound',
        }),
      ),
      expectScene(
        within(
          role('region', { name: `Credentials on ${box}` }),
          role('alert'),
        ),
      ).toHaveText("Couldn't remove anthropic: CredentialNotFound"),
      click(
        within(
          role('group', { name: 'Set on' }),
          role('button', { name: box }),
        ),
      ),
      type(label('Name'), 'openai'),
      type(label('Key'), 'sk-secret'),
      click(role('button', { name: 'Save' })),
      SceneCommand.expectExact(
        Engines.SetCredential({
          engine: box,
          name: 'openai',
          value: CredentialValue.cases.key.make({
            key: Redacted.make('sk-secret'),
          }),
          provider: Option.none(),
        }),
      ),
      SceneCommand.resolve(
        Engines.SetCredential,
        Engines.Message.SucceededSetCredential({
          credential: { engine: box, name: 'openai' },
        }),
      ),
      // The build-box's credentials are listed again, and the form stays on it.
      SceneCommand.expectExact(Engines.LoadCredentials({ engine: box })),
      SceneCommand.resolve(
        Engines.LoadCredentials,
        Engines.Message.SucceededLoadCredentials({
          engine: box,
          credentials: [anthropic],
        }),
      ),
      expectScene(
        within(
          role('group', { name: 'Set on' }),
          role('button', { name: box }),
        ),
      ).toHaveAttr('aria-pressed', 'true'),
    )
  })

  test('with this machine’s engine alone, the form offers no choice of engine', () => {
    scene(
      { update, view },
      givenScene({
        ...onScreen({ [localEngineName]: [] }),
        remotes: RemoteEngines.init(),
      }),
      expectScene(role('group', { name: 'Set on' })).toBeAbsent(),
    )
  })
})

describe('the sidebar’s + Add project', () => {
  test('opens the flow on the scoped project’s engine', () => {
    const scoped = update(
      connected,
      Message.SelectedScope({ project: Option.some(siteOnBox) }),
    ).model
    story(
      update,
      given(scoped),
      message(Message.RequestedAddProject()),
      model(shown => {
        expect(
          Engines.AddFlow.match(shown.screens.engines.addProject, {
            Closed: () => expect.unreachable('the form is closed'),
            Editing: ({ form }) => form.engine,
            Adding: () => expect.unreachable('the form was sent'),
          }),
        ).toBe(box)
      }),
      ...[localEngineName, box].flatMap(engine => [
        Command.resolve(
          Engines.LoadEngineStatus({ engine }),
          Engines.Message.FailedLoadStatus({
            engine,
            reason: 'not this test’s',
          }),
        ),
        Command.resolve(
          Engines.LoadCredentials({ engine }),
          Engines.Message.FailedLoadCredentials({
            engine,
            reason: 'not this test’s',
          }),
        ),
      ]),
    )
  })
})
