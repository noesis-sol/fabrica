import { Effect, Option, Schema } from 'effect'
import {
  Command as SceneCommand,
  click,
  expect as expectScene,
  given as givenScene,
  role,
  scene,
  text,
  within,
} from 'foldkit/scene'
import { given, message, model, story } from 'foldkit/story'

import { describe, expect, it, test } from '@effect/vitest'
import {
  EngineId,
  EngineSettings,
  ProjectId,
  ProjectSettings,
  ProjectStatus,
  StreamEpoch,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import {
  ShowTheme,
  type ThemeWindow,
  layerThemeHost,
  themeHostOf,
} from '../src/app/theme-host'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Settings from '../src/screens/settings'
import { type Theme, themeAttribute, themeStorageKey } from '../src/theme/theme'

// The Settings screen (spec §18.4, §13.13, §18.2): the project's, the engine's and the app's settings,
// each with its source, and the theme, an app install's setting, switched there and applied at once:
// data-theme on the root, the native window told, and the choice kept for the install's next start.

const project = ProjectId.make('p-1')
const other = ProjectId.make('p-2')
const engine = EngineId.make('e-1')
const flags = { platform: 'darwin' as const, release: '0.0.0' }

const projectSettings = (written: object): ProjectSettings =>
  Schema.decodeUnknownSync(ProjectSettings)(written)
const engineSettings = (written: object): EngineSettings =>
  Schema.decodeUnknownSync(EngineSettings)(written)

const row = Schema.decodeUnknownSync(ProjectStatus)({
  project: 'p-1',
  name: 'fabrica',
  base: 'main',
  setUp: true,
  trusted: true,
  run: { _tag: 'idle' },
  ready: 0,
})

/** The app connected to its local engine, the one project `fabrica` in the sidebar, scoped to it. */
const connected = (): Model => {
  const up: Model = {
    ...initialModel(flags),
    connection: Connection.Up({
      engine,
      release: '0.1.0',
      protocol: protocolVersion,
    }),
  }
  const withProject = update(
    up,
    Message.ReceivedProjects({
      engine,
      name: 'local',
      items: [
        {
          _tag: 'snapshot',
          epoch: StreamEpoch.make('epoch-1'),
          seq: 0,
          value: [row],
        },
      ],
    }),
  ).model
  return update(
    withProject,
    Message.SelectedScope({ project: Option.some(project) }),
  ).model
}

const settingsMessage = (message: Settings.Message): Message =>
  Message.GotSettingsMessage({ message })

/** The app on the Settings screen, the scoped project's and the engine's settings as given. */
const onScreen = (
  written: { readonly project: object; readonly engine: object },
  start: Model = connected(),
): Model => {
  const opened = update(
    start,
    Message.RequestedScreen({ screen: Screen.Settings() }),
  ).model
  const withProject = update(
    opened,
    settingsMessage(
      Settings.Message.SucceededLoadProjectSettings({
        project,
        settings: projectSettings(written.project),
      }),
    ),
  ).model
  return update(
    withProject,
    settingsMessage(
      Settings.Message.SucceededLoadEngineSettings({
        settings: engineSettings(written.engine),
      }),
    ),
  ).model
}

/** Commands by their names and arguments, which compare where the Commands' effects don't. */
const namesAndArgs = (
  commands: ReadonlyArray<{
    readonly name: string
    readonly args?: unknown
  }> = [],
) => commands.map(command => [command.name, command.args])

describe('the settings asked of the engine', () => {
  test("as the screen opens: the engine's and the scoped project's; a reply for another project is dropped", () => {
    story(
      Settings.update,
      given(Settings.opened(Settings.init(), Option.some(project)).model),
      model(shown => {
        expect(shown.project).toStrictEqual(Option.some(project))
      }),
      message(
        Settings.Message.SucceededLoadProjectSettings({
          project: other,
          settings: projectSettings({ concurrent: 9 }),
        }),
      ),
      model(shown => {
        expect(shown.projectSettings._tag).toBe('Loading')
      }),
      message(
        Settings.Message.FailedLoadProjectSettings({
          project,
          reason: 'the engine has no project p-1',
        }),
      ),
      model(shown => {
        expect(shown.projectSettings._tag).toBe('Failure')
      }),
    )
    const opened = Settings.opened(Settings.init(), Option.some(project))
    expect(namesAndArgs(opened.commands)).toStrictEqual([
      ['LoadEngineSettings', undefined],
      ['LoadProjectSettings', { project }],
    ])
  })

  test('with every project in scope, only the engine’s; the screen entered from the root asks for both', () => {
    const everyProject = Settings.opened(Settings.init(), Option.none())
    expect(namesAndArgs(everyProject.commands)).toStrictEqual([
      ['LoadEngineSettings', undefined],
    ])
    const entered = update(
      connected(),
      Message.RequestedScreen({ screen: Screen.Settings() }),
    )
    expect(entered.commands?.map(command => command.name)).toStrictEqual([
      'LoadEngineSettings',
      'LoadProjectSettings',
    ])
  })

  test('another project chosen while the screen is shown: its settings asked afresh', () => {
    const shown = onScreen({ project: {}, engine: {} })
    const rescoped = update(
      shown,
      Message.SelectedScope({ project: Option.some(other) }),
    )
    expect(rescoped.model.screens.settings.project).toStrictEqual(
      Option.some(other),
    )
    expect(rescoped.model.screens.settings.projectSettings._tag).toBe('Loading')
    expect(
      rescoped.commands?.flatMap(command =>
        command.name === 'LoadProjectSettings' ? [command.args] : [],
      ),
    ).toStrictEqual([{ project: other }])
  })
})

describe("a setting's source", () => {
  test('the value the file writes is its source’s; one it leaves out is the default', () => {
    const rows = Settings.settingRows(
      ProjectSettings,
      projectSettings({
        concurrent: 4,
        verifier: { rounds: 2 },
        organs: { scout: { model: 'anthropic/claude-opus-5-5' } },
      }),
      'project',
    )
    const byName = new Map(rows.map(shown => [shown.name, shown]))
    expect(byName.get('concurrent')).toStrictEqual({
      name: 'concurrent',
      value: '4',
      source: 'project',
    })
    expect(byName.get('permissions')).toStrictEqual({
      name: 'permissions',
      value: 'workspace',
      source: 'default',
    })
    expect(byName.get('verifier.rounds')?.source).toBe('project')
    expect(byName.get('verifier.enabled')?.source).toBe('default')
    expect(byName.get('organs.scout.model')).toStrictEqual({
      name: 'organs.scout.model',
      value: 'anthropic/claude-opus-5-5',
      source: 'project',
    })
    expect(byName.get('organs.triage.model')?.value).toBe(
      "none: the project's model",
    )
    // A struct left out is listed once, by its own name; the machine's settings never.
    expect(byName.get('container')?.value).toBe(
      'none: a worktree per worker on the host',
    )
    expect(rows.some(shown => shown.name.startsWith('container.'))).toBe(false)
    expect(rows.some(shown => shown.name === 'theme')).toBe(false)
    expect(rows.some(shown => shown.name === '$schema')).toBe(false)
  })

  test('shown beside each setting on the screen: the project’s file, the engine’s settings, or the default', () => {
    const projectList = role('list', { name: 'The project’s settings' })
    const engineList = role('list', { name: 'The engine’s settings' })
    scene(
      { update, view },
      givenScene(
        onScreen({ project: { concurrent: 4 }, engine: { worker_nice: 5 } }),
      ),
      expectScene(role('region', { name: 'Project settings' })).toContainText(
        'Project · fabrica',
      ),
      expectScene(
        within(projectList, role('listitem', { name: 'concurrent' })),
      ).toHaveText('concurrent4.fabrica/settings.json'),
      expectScene(
        within(projectList, role('listitem', { name: 'permissions' })),
      ).toHaveText('permissionsworkspacedefault'),
      expectScene(
        within(engineList, role('listitem', { name: 'worker_nice' })),
      ).toHaveText("worker_nice5the engine's settings"),
      expectScene(
        within(engineList, role('listitem', { name: 'keep_awake' })),
      ).toHaveText('keep_awaketruedefault'),
      expectScene(
        within(engineList, role('listitem', { name: 'machine_workers' })),
      ).toContainText("half the host's cores"),
    )
  })

  test('with every project in scope, the screen asks for one; a failure to read is shown', () => {
    const everyProject = update(
      update(
        connected(),
        Message.RequestedScreen({ screen: Screen.Settings() }),
      ).model,
      Message.SelectedScope({ project: Option.none() }),
    ).model
    scene(
      { update, view },
      givenScene(everyProject),
      expectScene(
        within(
          role('region', { name: 'Project settings' }),
          text('Choose a project in the sidebar to see its settings.'),
        ),
      ).toExist(),
    )
    const failed = update(
      everyProject,
      settingsMessage(
        Settings.Message.FailedLoadEngineSettings({
          reason: 'not connected to the engine',
        }),
      ),
    ).model
    scene(
      { update, view },
      givenScene(failed),
      expectScene(
        within(role('region', { name: 'Engine settings' }), role('alert')),
      ).toHaveText(
        "Its settings couldn't be read: not connected to the engine",
      ),
    )
  })
})

/** A window for the theme host: a root element, a storage in memory, and the preload's setTheme. */
const fakeWindow = (kept: Option.Option<string> = Option.none()) => {
  const root = document.createElement('html')
  const stored = new Map<string, string>(
    Option.match(kept, {
      onNone: () => [],
      onSome: value => [[themeStorageKey, value]],
    }),
  )
  const told: Array<Theme> = []
  const target: ThemeWindow & { readonly fabrica: object } = {
    document: { documentElement: root },
    localStorage: {
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => {
        stored.set(key, value)
      },
    },
    fabrica: {
      window: {
        setTheme: (theme: Theme) => {
          told.push(theme)
        },
      },
    },
  }
  return { root, stored, told, target }
}

describe('the theme switch', () => {
  test('a theme chosen on the screen shows pressed, its source this install, and is shown at once', () => {
    const app = role('region', { name: 'App settings' })
    scene(
      { update, view },
      givenScene(onScreen({ project: {}, engine: {} })),
      expectScene(within(app, role('listitem', { name: 'theme' }))).toHaveText(
        'themeLichen Brightdefault',
      ),
      expectScene(role('button', { name: 'Lichen Bright' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
      click(role('button', { name: 'Neon Grid' })),
      SceneCommand.expectExact(ShowTheme({ theme: 'neon-grid' })),
      expectScene(role('button', { name: 'Neon Grid' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
      expectScene(role('button', { name: 'Lichen Bright' })).toHaveAttr(
        'aria-pressed',
        'false',
      ),
      expectScene(within(app, role('listitem', { name: 'theme' }))).toHaveText(
        'themeNeon Gridthis app install',
      ),
      SceneCommand.resolve(ShowTheme, Message.CompletedShowTheme()),
    )
  })

  it.effect(
    'the switch sets data-theme on the root, tells the native window and keeps the choice',
    () =>
      Effect.gen(function* () {
        const { root, stored, told, target } = fakeWindow()
        const chosen = update(
          onScreen({ project: {}, engine: {} }),
          Message.ChoseTheme({ theme: 'classic' }),
        )
        expect(chosen.model.theme).toStrictEqual(Option.some('classic'))
        expect(namesAndArgs(chosen.commands)).toStrictEqual([
          ['ShowTheme', { theme: 'classic' }],
        ])
        yield* ShowTheme({ theme: 'classic' }).effect.pipe(
          Effect.provide(layerThemeHost(themeHostOf(target))),
        )
        expect(root.getAttribute(themeAttribute)).toBe('classic')
        expect(told).toStrictEqual(['classic'])
        expect(stored.get(themeStorageKey)).toBe('classic')
      }),
  )

  it.effect(
    'the install starts on the theme it kept; nothing kept, or something not a theme, is none',
    () =>
      Effect.gen(function* () {
        expect(
          yield* themeHostOf(fakeWindow(Option.some('neon-grid')).target).kept,
        ).toStrictEqual(Option.some('neon-grid'))
        expect(yield* themeHostOf(fakeWindow().target).kept).toStrictEqual(
          Option.none(),
        )
        expect(
          yield* themeHostOf(fakeWindow(Option.some('solarized')).target).kept,
        ).toStrictEqual(Option.none())
        const kept = initialModel({ ...flags, theme: 'neon-grid' })
        expect(kept.theme).toStrictEqual(Option.some('neon-grid'))
        expect(initialModel(flags).theme).toStrictEqual(Option.none())
      }),
  )

  it.effect('a storage that refuses is no theme kept, and no failure', () =>
    Effect.gen(function* () {
      const root = document.createElement('html')
      const host = themeHostOf({
        document: { documentElement: root },
        localStorage: {
          getItem: () => {
            throw new Error('SecurityError')
          },
          setItem: () => {
            throw new Error('QuotaExceededError')
          },
        },
      })
      expect(yield* host.kept).toStrictEqual(Option.none())
      yield* host.keep('classic')
      yield* host.show('classic')
      expect(root.getAttribute(themeAttribute)).toBe('classic')
    }),
  )
})
