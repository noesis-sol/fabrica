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
import {
  CredentialInfo,
  CredentialValue,
  EngineId,
  EngineStatus,
  ProjectId,
  ProjectInfo,
  ProjectSource,
  ProjectStatus,
  StreamEpoch,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { ServiceInstall } from '../src/app/host'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Engines from '../src/screens/engines'

// The Engines and projects screen (spec §18.4, §10.1, §20.3, §7.1): adding a project by its path on
// the engine's host or by a git URL, and setting it up where it isn't; the engine's status asked as
// the screen opens; credentials set by name, their keys redacted, and removed; and the local engine
// installed as a login service when the user chooses. The sidebar's "+ Add project" opens the flow.

const opened = Engines.openAddProject(Engines.init(), localEngineName)

const project = ProjectId.make('p-2')

/** The project just added, named with this machine's engine, which holds it. */
const onLocal: EngineProject = { engine: localEngineName, project }

const addedInfo = (setUp: boolean, origin: 'registered' | 'cloned') =>
  ProjectInfo.make({
    id: project,
    name: 'app',
    path:
      origin === 'registered'
        ? '/Users/me/src/app'
        : '/data/fabrica/projects/p-2/repo',
    origin,
    url:
      origin === 'cloned'
        ? Option.some('git@github.com:me/app.git')
        : Option.none(),
    base: 'main',
    setUp,
    trusted: false,
  })

const editingForm = (shown: Engines.Model): Engines.AddForm =>
  Engines.AddFlow.match(shown.addProject, {
    Closed: () => expect.unreachable('the form is closed'),
    Editing: ({ form }) => form,
    Adding: () => expect.unreachable('the form was sent'),
  })

describe('adding a project', () => {
  test('by its path on the engine’s host: sent to the engine, then offered its setting up', () => {
    story(
      Engines.update,
      given(opened),
      model(shown => {
        expect(editingForm(shown).kind).toBe('path')
      }),
      message(
        Engines.Message.ChangedProjectPath({ path: '  /Users/me/src/app ' }),
      ),
      message(Engines.Message.SubmittedAddProject()),
      Command.expectExact(
        Engines.AddProject({
          engine: localEngineName,
          source: ProjectSource.cases.path.make({ path: '/Users/me/src/app' }),
          name: Option.none(),
        }),
      ),
      model(shown => {
        expect(Engines.AddFlow.guards.Adding(shown.addProject)).toBe(true)
      }),
      // Typing while it is sent changes nothing: the form stays as it went.
      model(shown => {
        const typed = Engines.update(
          shown,
          Engines.Message.ChangedProjectPath({ path: '/elsewhere' }),
        )
        expect(typed.model).toBe(shown)
        expect(typed.commands).toBeUndefined()
      }),
      Command.resolve(
        Engines.AddProject,
        Engines.Message.SucceededAddProject({
          engine: localEngineName,
          project: addedInfo(false, 'registered'),
        }),
      ),
      model(shown => {
        expect(shown.addProject).toEqual(Engines.AddFlow.Closed())
        const added = Option.getOrThrow(shown.added)
        expect(added.project.path).toBe('/Users/me/src/app')
        expect(added.setup).toEqual(Engines.Setup.NotAsked())
      }),
      message(Engines.Message.RequestedSetUp({ project: onLocal })),
      Command.expectExact(Engines.SetUpProject({ project: onLocal })),
      Command.resolve(
        Engines.SetUpProject,
        Engines.Message.SucceededSetUp({
          project: onLocal,
          written: ['.fabrica/settings.json', '.fabrica/worker-rules.md'],
        }),
      ),
      model(shown => {
        expect(Option.getOrThrow(shown.added).setup).toEqual(
          Engines.Setup.Done({
            written: ['.fabrica/settings.json', '.fabrica/worker-rules.md'],
          }),
        )
      }),
    )
  })

  test('by a git URL, with a name: sent to be cloned; a refusal comes back on the form, kept', () => {
    story(
      Engines.update,
      given(opened),
      message(Engines.Message.ChoseSource({ kind: 'url' })),
      message(
        Engines.Message.ChangedProjectUrl({ url: 'git@github.com:me/app.git' }),
      ),
      message(Engines.Message.ChangedProjectName({ name: 'app' })),
      message(Engines.Message.SubmittedAddProject()),
      Command.expectExact(
        Engines.AddProject({
          engine: localEngineName,
          source: ProjectSource.cases.url.make({
            url: 'git@github.com:me/app.git',
          }),
          name: Option.some('app'),
        }),
      ),
      Command.resolve(
        Engines.AddProject,
        Engines.Message.FailedAddProject({
          reason: 'git clone failed: Permission denied (publickey)',
        }),
      ),
      model(shown => {
        expect(shown.addProject).toEqual(
          Engines.AddFlow.Editing({
            form: {
              engine: localEngineName,
              kind: 'url',
              path: '',
              url: 'git@github.com:me/app.git',
              name: 'app',
            },
            problem: Option.some(
              'git clone failed: Permission denied (publickey)',
            ),
          }),
        )
      }),
      // Sent again, it goes as it was typed.
      message(Engines.Message.SubmittedAddProject()),
      Command.resolve(
        Engines.AddProject,
        Engines.Message.SucceededAddProject({
          engine: localEngineName,
          project: addedInfo(true, 'cloned'),
        }),
      ),
      model(shown => {
        expect(Option.getOrThrow(shown.added).project.origin).toBe('cloned')
        expect(shown.addProject).toEqual(Engines.AddFlow.Closed())
      }),
    )
  })

  test('with nothing to add from, says what is missing and sends nothing', () => {
    story(
      Engines.update,
      given(opened),
      message(Engines.Message.ChangedProjectPath({ path: '   ' })),
      message(Engines.Message.SubmittedAddProject()),
      Command.expectNone(),
      model(shown => {
        expect(shown.addProject).toEqual(
          Engines.AddFlow.Editing({
            form: {
              engine: localEngineName,
              kind: 'path',
              path: '   ',
              url: '',
              name: '',
            },
            problem: Option.some(
              "Give the checkout's folder on the engine's host.",
            ),
          }),
        )
      }),
      message(Engines.Message.CancelledAddProject()),
      model(shown => {
        expect(shown.addProject).toEqual(Engines.AddFlow.Closed())
      }),
    )
  })

  test('a failed setting up says what it had written', () => {
    story(
      Engines.update,
      given({
        ...Engines.init(),
        added: Option.some({
          engine: localEngineName,
          project: addedInfo(false, 'registered'),
          setup: Engines.Setup.NotAsked(),
        }),
      }),
      message(Engines.Message.RequestedSetUp({ project: onLocal })),
      Command.resolve(
        Engines.SetUpProject,
        Engines.Message.FailedSetUp({
          project: onLocal,
          reason: 'the scout found no check',
          written: ['.fabrica/settings.json'],
        }),
      ),
      model(shown => {
        expect(Option.getOrThrow(shown.added).setup).toEqual(
          Engines.Setup.Failed({
            reason: 'the scout found no check',
            written: ['.fabrica/settings.json'],
          }),
        )
      }),
    )
  })
})

const flags = { platform: 'darwin' as const, release: '0.0.0' }

const engine = EngineId.make('e-1')

const connected: Model = {
  ...initialModel(flags),
  connection: Connection.Up({
    engine,
    release: '0.1.0',
    protocol: protocolVersion,
  }),
}

const status = Schema.decodeUnknownSync(EngineStatus)({
  id: 'e-1',
  release: '0.1.0',
  startedAt: 1_793_268_900_000,
  host: { platform: 'darwin', arch: 'arm64', hostname: 'laptop', cores: 8 },
  listening: null,
  projects: 1,
  runs: 0,
  liveWorkers: 0,
  machineWorkers: 4,
  clients: 1,
  stopping: false,
})

describe('the screen in the app', () => {
  test('the sidebar’s + Add project opens the screen with the flow open, asking for the engine’s status and credentials', () => {
    story(
      update,
      given(connected),
      message(Message.RequestedAddProject()),
      Command.expectExact(Engines.LoadEngineStatus, Engines.LoadCredentials),
      model(shown => {
        expect(shown.screen).toEqual(Screen.Engines())
        expect(
          Engines.AddFlow.guards.Editing(shown.screens.engines.addProject),
        ).toBe(true)
      }),
      Command.resolve(
        Engines.LoadEngineStatus,
        Engines.Message.SucceededLoadStatus({
          engine: localEngineName,
          status,
        }),
      ),
      Command.resolve(
        Engines.LoadCredentials,
        Engines.Message.FailedLoadCredentials({
          engine: localEngineName,
          reason: 'credentials.list is not implemented yet',
        }),
      ),
      model(shown => {
        expect(shown.screens.engines.status[localEngineName]?._tag).toBe(
          'Success',
        )
        expect(shown.screens.engines.credentials).toEqual({
          [localEngineName]: {
            _tag: 'Failure',
            error: 'credentials.list is not implemented yet',
          },
        })
      }),
      // Asked again from the screen itself, the flow stays as it is and nothing is asked again.
      message(Message.RequestedAddProject()),
      Command.expectNone(),
    )
  })

  test('adding by path from the screen, as the user types it', () => {
    const sidebarRows = Schema.decodeUnknownSync(ProjectStatus)({
      project: 'p-1',
      name: 'fabrica',
      base: 'main',
      setUp: true,
      trusted: false,
      run: { _tag: 'idle' },
      ready: 0,
    })
    const withProjects = update(
      connected,
      Message.ReceivedProjects({
        engine,
        name: 'local',
        items: [
          {
            _tag: 'snapshot',
            epoch: StreamEpoch.make('epoch-1'),
            seq: 0,
            value: [sidebarRows],
          },
        ],
      }),
    ).model
    scene(
      { update, view },
      givenScene({ ...withProjects, screen: Screen.Engines() }),
      expectScene(
        role('heading', { name: 'Engines and projects', level: 1 }),
      ).toExist(),
      expectScene(
        within(role('article', { name: 'Engine local' }), text('Connected')),
      ).toExist(),
      expectScene(
        within(role('region', { name: 'Projects on local' }), text('fabrica')),
      ).toExist(),
      click(role('button', { name: '+ Add project' })),
      expectScene(role('form', { name: 'Add project' })).toExist(),
      type(label('Its folder on local'), '/Users/me/src/app'),
      click(role('button', { name: 'Add' })),
      SceneCommand.expectExact(
        Engines.AddProject({
          engine: localEngineName,
          source: ProjectSource.cases.path.make({ path: '/Users/me/src/app' }),
          name: Option.none(),
        }),
      ),
      expectScene(role('button', { name: 'Adding…' })).toBeDisabled(),
      SceneCommand.resolve(
        Engines.AddProject,
        Engines.Message.SucceededAddProject({
          engine: localEngineName,
          project: addedInfo(false, 'registered'),
        }),
      ),
      expectScene(role('form', { name: 'Add project' })).toBeAbsent(),
      expectScene(
        within(role('status', { name: 'Added project' }), text(/Added app/u)),
      ).toExist(),
      expectScene(role('button', { name: 'Set it up' })).toExist(),
    )
  })

  test('the URL flow from the screen', () => {
    scene(
      { update, view },
      givenScene({
        ...connected,
        screen: Screen.Engines(),
        screens: {
          ...connected.screens,
          engines: Engines.openAddProject(
            connected.screens.engines,
            localEngineName,
          ),
        },
      }),
      click(role('button', { name: 'A git URL to clone' })),
      expectScene(role('button', { name: 'A git URL to clone' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
      type(label('Its git URL'), 'https://github.com/me/app.git'),
      type(label('Name (optional)'), 'app'),
      click(role('button', { name: 'Add' })),
      SceneCommand.expectExact(
        Engines.AddProject({
          engine: localEngineName,
          source: ProjectSource.cases.url.make({
            url: 'https://github.com/me/app.git',
          }),
          name: Option.some('app'),
        }),
      ),
      expectScene(role('button', { name: 'Cloning…' })).toBeDisabled(),
      SceneCommand.resolve(
        Engines.AddProject,
        Engines.Message.FailedAddProject({ reason: 'not a git repository' }),
      ),
      expectScene(role('alert')).toHaveText('not a git repository'),
      expectScene(label('Its git URL')).toHaveValue(
        'https://github.com/me/app.git',
      ),
    )
  })
})

describe('credentials', () => {
  const anthropic = CredentialInfo.make({
    name: 'anthropic',
    kind: 'key',
    provider: Option.some('anthropic'),
  })

  test('a key set by name, redacted on its way, then the list asked again', () => {
    story(
      Engines.update,
      given({
        ...Engines.init(),
        credentials: { [localEngineName]: { _tag: 'Success', data: [] } },
      }),
      message(Engines.Message.ChangedCredentialName({ name: 'anthropic' })),
      message(
        Engines.Message.ChangedCredentialKey({
          key: Redacted.make('sk-ant-secret'),
        }),
      ),
      message(
        Engines.Message.ChangedCredentialProvider({ provider: 'anthropic' }),
      ),
      model(shown => {
        expect(String(shown.credentialForm.key)).not.toContain('sk-ant')
      }),
      message(Engines.Message.SubmittedCredential()),
      Command.expectHas(Engines.SetCredential),
      Command.resolve(
        Engines.SetCredential,
        Engines.Message.SucceededSetCredential({
          credential: { engine: localEngineName, name: 'anthropic' },
        }),
      ),
      Command.expectExact(Engines.LoadCredentials),
      model(shown => {
        expect(Redacted.value(shown.credentialForm.key)).toBe('')
        expect(shown.credentialForm.name).toBe('')
        expect(shown.credentials[localEngineName]?._tag).toBe('Refreshing')
      }),
      Command.resolve(
        Engines.LoadCredentials,
        Engines.Message.SucceededLoadCredentials({
          engine: localEngineName,
          credentials: [anthropic],
        }),
      ),
      model(shown => {
        expect(shown.credentials).toEqual({
          [localEngineName]: { _tag: 'Success', data: [anthropic] },
        })
      }),
    )
  })

  test('what the form sends: the key as a redacted value, or a command', () => {
    const keyed = Option.getOrThrow(
      Engines.credentialOf({
        engine: localEngineName,
        name: ' anthropic ',
        kind: 'key',
        key: Redacted.make('sk-ant-secret'),
        command: '',
        provider: '',
      }),
    )
    expect(keyed.name).toBe('anthropic')
    expect(keyed.provider).toEqual(Option.none())
    expect(
      CredentialValue.match(keyed.value, {
        key: ({ key }) => Redacted.value(key),
        command: () => 'a command',
      }),
    ).toBe('sk-ant-secret')

    const commanded = Option.getOrThrow(
      Engines.credentialOf({
        engine: localEngineName,
        name: 'openai',
        kind: 'command',
        key: Redacted.make(''),
        command: 'op read op://dev/openai/key',
        provider: 'openai',
      }),
    )
    expect(commanded.value).toEqual(
      CredentialValue.cases.command.make({
        command: 'op read op://dev/openai/key',
      }),
    )
    expect(commanded.provider).toEqual(Option.some('openai'))
  })

  test('a credential without a name or a key is not sent', () => {
    story(
      Engines.update,
      given(Engines.init()),
      message(Engines.Message.ChangedCredentialName({ name: 'has space' })),
      message(Engines.Message.SubmittedCredential()),
      Command.expectNone(),
      model(shown => {
        expect(shown.credentialSave).toEqual(
          Engines.CredentialSave.Editing({
            problem: Option.some('Give the credential a name, without spaces.'),
          }),
        )
      }),
      message(Engines.Message.ChangedCredentialName({ name: 'anthropic' })),
      message(Engines.Message.SubmittedCredential()),
      Command.expectNone(),
      model(shown => {
        expect(shown.credentialSave).toEqual(
          Engines.CredentialSave.Editing({
            problem: Option.some('Give the key.'),
          }),
        )
      }),
    )
  })

  test('removed by name, one at a time; a failure says so', () => {
    story(
      Engines.update,
      given({
        ...Engines.init(),
        credentials: {
          [localEngineName]: { _tag: 'Success', data: [anthropic] },
        },
      }),
      message(
        Engines.Message.RequestedRemoveCredential({
          credential: { engine: localEngineName, name: 'anthropic' },
        }),
      ),
      Command.expectExact(
        Engines.RemoveCredential({
          credential: { engine: localEngineName, name: 'anthropic' },
        }),
      ),
      model(shown => {
        const another = Engines.update(
          shown,
          Engines.Message.RequestedRemoveCredential({
            credential: { engine: localEngineName, name: 'openai' },
          }),
        )
        expect(another.model).toBe(shown)
        expect(another.commands).toBeUndefined()
      }),
      Command.resolve(
        Engines.RemoveCredential,
        Engines.Message.FailedRemoveCredential({
          credential: { engine: localEngineName, name: 'anthropic' },
          reason: 'CredentialNotFound',
        }),
      ),
      model(shown => {
        expect(shown.removing).toEqual(Option.none())
        expect(shown.removeProblem).toEqual(
          Option.some({
            engine: localEngineName,
            text: "Couldn't remove anthropic: CredentialNotFound",
          }),
        )
      }),
      message(
        Engines.Message.RequestedRemoveCredential({
          credential: { engine: localEngineName, name: 'anthropic' },
        }),
      ),
      Command.resolve(
        Engines.RemoveCredential,
        Engines.Message.SucceededRemoveCredential({
          credential: { engine: localEngineName, name: 'anthropic' },
        }),
      ),
      Command.resolve(
        Engines.LoadCredentials,
        Engines.Message.SucceededLoadCredentials({
          engine: localEngineName,
          credentials: [],
        }),
      ),
      model(shown => {
        expect(shown.credentials).toEqual({
          [localEngineName]: { _tag: 'Success', data: [] },
        })
        expect(shown.removeProblem).toEqual(Option.none())
      }),
    )
  })
})

describe('the login service', () => {
  test('installed when the user chooses, once at a time, saying how it went', () => {
    story(
      Engines.update,
      given(Engines.init()),
      message(Engines.Message.RequestedLoginService()),
      Command.expectExact(Engines.InstallLoginService),
      model(shown => {
        const again = Engines.update(
          shown,
          Engines.Message.RequestedLoginService(),
        )
        expect(again.model).toBe(shown)
        expect(again.commands).toBeUndefined()
      }),
      Command.resolve(
        Engines.InstallLoginService,
        Engines.Message.CompletedLoginService({
          outcome: ServiceInstall.cases.Failed.make({
            reason: 'service is not implemented yet',
          }),
        }),
      ),
      model(shown => {
        expect(shown.loginService).toEqual(
          Engines.LoginService.Failed({
            reason: 'service is not implemented yet',
          }),
        )
      }),
      message(Engines.Message.RequestedLoginService()),
      Command.resolve(
        Engines.InstallLoginService,
        Engines.Message.CompletedLoginService({
          outcome: ServiceInstall.cases.Installed.make({}),
        }),
      ),
      model(shown => {
        expect(shown.loginService).toEqual(Engines.LoginService.Installed())
      }),
    )
  })
})
