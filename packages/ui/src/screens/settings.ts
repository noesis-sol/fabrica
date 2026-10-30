import { Array, Effect, Option, Predicate, Schema, SchemaAST } from 'effect'
import { Command, type Update } from 'foldkit'
import * as AsyncData from 'foldkit/asyncData'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { EngineSettings, ProjectId, ProjectSettings } from '@fabrica/contracts'

import { localEngineName } from '../app/connection'
import {
  type EngineServices,
  requestEngine,
  requestProject,
} from '../app/engine-route'
import { type Theme, defaultTheme, themeTitle, themes } from '../theme/theme'

// The Settings screen (spec §18.4, §13.13, §18.2): the project's, the engine's and the app's settings,
// each with its source. The project's are the scoped project's `.fabrica/settings.json`, the engine's
// its own settings, both asked of the engine as the screen opens; a setting its file leaves out, or
// writes as its default, shows as the default's. The app's is the theme, a setting of each install (H68), switched here and applied at
// once. A setting is listed by its path in its file (`verifier.rounds`), every one its schema names.

/** Where a setting's value comes from. */
export const SettingSource = Schema.Literals([
  'project',
  'engine',
  'app',
  'default',
])
export type SettingSource = typeof SettingSource.Type

/** A source, as the screen says it. */
export const sourceTitle = (source: SettingSource): string =>
  ({
    project: '.fabrica/settings.json',
    engine: "the engine's settings",
    app: 'this app install',
    default: 'default',
  })[source]

/** A setting as the screen lists it: its path, its value in words, and its source. */
export interface SettingRow {
  readonly name: string
  readonly value: string
  readonly source: SettingSource
}

export const Model = Schema.Struct({
  /** The project whose settings are shown: the scope's as the screen opened; none for every project. */
  project: Schema.Option(ProjectId),
  projectSettings: AsyncData.Schema(ProjectSettings, Schema.String).schema,
  engineSettings: AsyncData.Schema(EngineSettings, Schema.String).schema,
})
export type Model = typeof Model.Type

export const init = (): Model => ({
  project: Option.none(),
  projectSettings: AsyncData.Idle(),
  engineSettings: AsyncData.Idle(),
})

export const Message = defineMessageUnion({
  SucceededLoadProjectSettings: {
    project: ProjectId,
    settings: ProjectSettings,
  },
  FailedLoadProjectSettings: { project: ProjectId, reason: Schema.String },
  SucceededLoadEngineSettings: { settings: EngineSettings },
  FailedLoadEngineSettings: { reason: Schema.String },
})
export type Message = typeof Message.Type

// Commands: each a request to the engine, its failure in words.

export const LoadProjectSettings = Command.define('LoadProjectSettings', {
  args: { project: ProjectId },
  messages: [
    Message.SucceededLoadProjectSettings,
    Message.FailedLoadProjectSettings,
  ],
  execute: ({ project }) =>
    requestProject(project, client =>
      client.rpc['projects.settings.get']({ project }),
    ).pipe(
      Effect.map(settings =>
        Message.SucceededLoadProjectSettings({ project, settings }),
      ),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedLoadProjectSettings({ project, reason })),
      ),
    ),
})

export const LoadEngineSettings = Command.define('LoadEngineSettings', {
  messages: [
    Message.SucceededLoadEngineSettings,
    Message.FailedLoadEngineSettings,
  ],
  execute: requestEngine(localEngineName, client =>
    client.rpc['engine.settings'](),
  ).pipe(
    Effect.map(settings => Message.SucceededLoadEngineSettings({ settings })),
    Effect.catch(reason =>
      Effect.succeed(Message.FailedLoadEngineSettings({ reason })),
    ),
  ),
})

/** What the screen's Commands need: the engines' connections. */
export type Requires = EngineServices

type Return = Update.Return<Model, Message, Requires>

const sameScope = Schema.toEquivalence(Schema.Option(ProjectId))

/**
 * As the screen opens, or its scope changes while it is shown: the engine's settings and `scope`'s
 * asked again, what was shown of them kept meanwhile; another project's are asked afresh.
 */
export const opened = (
  model: Model,
  scope: Option.Option<ProjectId>,
): Return => {
  const engine = AsyncData.revalidateOrLoad(model.engineSettings)
  const sameProject = sameScope(model.project, scope)
  const project = Option.isNone(scope)
    ? Option.some(AsyncData.Idle())
    : sameProject
      ? AsyncData.revalidateOrLoad(model.projectSettings)
      : Option.some(AsyncData.Loading())
  return {
    model: modifyFields(model, {
      project: () => scope,
      projectSettings: current => Option.getOrElse(project, () => current),
      engineSettings: current => Option.getOrElse(engine, () => current),
    }),
    commands: [
      ...(Option.isSome(engine) ? [LoadEngineSettings()] : []),
      ...Option.match(
        Option.filter(scope, () => Option.exists(project, AsyncData.isPending)),
        {
          onNone: () => [],
          onSome: id => [LoadProjectSettings({ project: id })],
        },
      ),
    ],
  }
}

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    SucceededLoadProjectSettings: ({ project, settings }) => ({
      model: Option.contains(model.project, project)
        ? modifyFields(model, {
            projectSettings: () => AsyncData.succeed(settings),
          })
        : model,
    }),
    FailedLoadProjectSettings: ({ project, reason }) => ({
      model: Option.contains(model.project, project)
        ? modifyFields(model, {
            projectSettings: () => AsyncData.fail(reason),
          })
        : model,
    }),
    SucceededLoadEngineSettings: ({ settings }) => ({
      model: modifyFields(model, {
        engineSettings: () => AsyncData.succeed(settings),
      }),
    }),
    FailedLoadEngineSettings: ({ reason }) => ({
      model: modifyFields(model, {
        engineSettings: () => AsyncData.fail(reason),
      }),
    }),
  })

// The rows: every setting the schema names, by its path, read from the settings as they encode (the
// file's own form), and their default the settings decoded from an empty file.

/** Every setting's path in a settings schema's encoded form; a struct's settings by their own paths. */
const settingPaths = (
  ast: SchemaAST.AST,
  prefix: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> =>
  SchemaAST.isObjects(ast) && ast.propertySignatures.length > 0
    ? ast.propertySignatures.flatMap(property =>
        typeof property.name !== 'string' ||
        property.name === '$schema' ||
        SchemaAST.isNever(property.type)
          ? []
          : settingPaths(property.type, [...prefix, property.name]),
      )
    : [prefix]

/** The value at `path` in an encoded settings object; none where it writes none. */
const valueAt = (
  encoded: unknown,
  path: ReadonlyArray<string>,
): Option.Option<unknown> =>
  Array.reduce(path, Option.some(encoded), (value, key) =>
    Option.flatMap(value, current =>
      Predicate.isObject(current)
        ? Option.fromUndefinedOr(current[key])
        : Option.none(),
    ),
  )

/** An encoded value in words: lists and objects their items, an empty one "none". */
const words = (value: unknown): string =>
  Array.isArray(value)
    ? value.length === 0
      ? 'none'
      : value.map(words).join(', ')
    : Predicate.isObject(value)
      ? Object.keys(value).length === 0
        ? 'none'
        : Object.entries(value)
            .map(([key, item]) => `${key}: ${words(item)}`)
            .join(', ')
      : String(value)

/** What a setting written nowhere comes to, where "none" alone doesn't say (spec §13.13). */
const noneMeans = (path: ReadonlyArray<string>): string => {
  const name = path.join('.')
  return name === 'model'
    ? 'none: the run asks for one'
    : name === 'push'
      ? "none: the project's origin decides it"
      : name === 'container'
        ? 'none: a worktree per worker on the host'
        : name === 'ticket_limit'
          ? 'none: no limit'
          : name === 'machine_workers'
            ? "none: half the host's cores, at least 2"
            : name === 'verifier.model'
              ? "none: another provider's model, where one is configured"
              : path[0] === 'organs' && path[2] === 'model'
                ? "none: the project's model"
                : 'none'
}

/** The setting `path` is listed as: a struct the settings leave out (a container) once, by its own name. */
const shownPath = (
  encoded: unknown,
  path: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  Option.getOrElse(
    Array.findFirst(
      Array.makeBy(path.length, length => path.slice(0, length + 1)),
      prefix => Option.isNone(valueAt(encoded, prefix)),
    ),
    () => path,
  )

const sameEncoded = (a: Option.Option<unknown>, b: Option.Option<unknown>) =>
  JSON.stringify(Option.getOrNull(a)) === JSON.stringify(Option.getOrNull(b))

/**
 * The rows of `settings`, decoded with `schema`, from `source`: a setting the same as its default is
 * the default's, since the settings come decoded, defaults filled in.
 */
export const settingRows = <T, E>(
  schema: Schema.Codec<T, E>,
  settings: T,
  source: SettingSource,
): ReadonlyArray<SettingRow> => {
  const encode = Schema.encodeSync(schema)
  const written: unknown = encode(settings)
  const defaults: unknown = encode(Schema.decodeUnknownSync(schema)({}))
  const paths = Array.dedupeWith(
    settingPaths(Schema.toEncoded(schema).ast, []).map(path =>
      shownPath(written, path),
    ),
    (a, b) => a.join('.') === b.join('.'),
  )
  return paths.map(path => {
    const value = valueAt(written, path)
    return {
      name: path.join('.'),
      value: Option.match(value, {
        onNone: () => noneMeans(path),
        onSome: words,
      }),
      source: sameEncoded(value, valueAt(defaults, path)) ? 'default' : source,
    }
  })
}

/** The app's settings: the theme, from this install where it chose one. */
export const appRows = (
  theme: Option.Option<Theme>,
): ReadonlyArray<SettingRow> => [
  {
    name: 'theme',
    value: themeTitle(Option.getOrElse(theme, () => defaultTheme)),
    source: Option.isSome(theme) ? 'app' : 'default',
  },
]

// The view.

/** What the screen draws beside its own Model: the scope's name, the theme and choosing one. */
export interface ViewInputs<ParentMessage> {
  /** The scoped project's name; none for every project. */
  readonly projectName: Option.Option<string>
  /** The theme this install chose; none: the default. */
  readonly theme: Option.Option<Theme>
  readonly chooseTheme: (theme: Theme) => ParentMessage
}

const card = 'flex flex-col gap-10 rounded-card border border-line bg-panel'
const cardStyle = { padding: '12px 16px' }

const problemLine = <ParentMessage>(
  text: string,
  h: HtmlBuilder<ParentMessage>,
): Html => h.p([h.Role('alert'), h.Class('text-xs text-c3')], [text])

const quiet = <ParentMessage>(
  text: string,
  h: HtmlBuilder<ParentMessage>,
): Html => h.p([h.Class('text-xs text-muted')], [text])

/** A list of settings, each its path, its value and its source. */
const rowsView = <ParentMessage>(
  label: string,
  rows: ReadonlyArray<SettingRow>,
  h: HtmlBuilder<ParentMessage>,
): Html =>
  h.ul(
    [h.AriaLabel(label), h.Class('flex flex-col')],
    rows.map(row =>
      h.keyed('li')(
        row.name,
        [
          h.AriaLabel(row.name),
          h.DataAttribute('source', row.source),
          h.Class('grid items-baseline gap-12 border-b border-line py-4'),
          h.Style({ gridTemplateColumns: '220px minmax(0,1fr) 180px' }),
        ],
        [
          h.span([h.Class('font-mono text-xs')], [row.name]),
          h.span([h.Class('font-mono text-xs break-words')], [row.value]),
          h.span(
            [
              h.Class(
                row.source === 'default'
                  ? 'text-xs text-muted'
                  : 'text-xs font-bold text-fg',
              ),
            ],
            [sourceTitle(row.source)],
          ),
        ],
      ),
    ),
  )

const section = <ParentMessage>(
  label: string,
  title: string,
  body: ReadonlyArray<Html>,
  h: HtmlBuilder<ParentMessage>,
): Html =>
  h.section(
    [h.AriaLabel(label), h.Class(card), h.Style(cardStyle)],
    [h.h2([h.Class('text-sm font-extrabold')], [title]), ...body],
  )

const projectView = <ParentMessage>(
  model: Model,
  inputs: ViewInputs<ParentMessage>,
  h: HtmlBuilder<ParentMessage>,
): Html =>
  section(
    'Project settings',
    Option.match(inputs.projectName, {
      onNone: () => 'Project',
      onSome: name => `Project · ${name}`,
    }),
    [
      Option.isNone(model.project)
        ? quiet('Choose a project in the sidebar to see its settings.', h)
        : AsyncData.matchData(model.projectSettings, {
            onEmpty: () => quiet('Asking the engine for its settings…', h),
            onFailure: reason =>
              problemLine(`Its settings couldn't be read: ${reason}`, h),
            onData: settings =>
              rowsView(
                'The project’s settings',
                settingRows(ProjectSettings, settings, 'project'),
                h,
              ),
          }),
    ],
    h,
  )

const engineView = <ParentMessage>(
  model: Model,
  h: HtmlBuilder<ParentMessage>,
): Html =>
  section(
    'Engine settings',
    `Engine · ${localEngineName}`,
    [
      AsyncData.matchData(model.engineSettings, {
        onEmpty: () => quiet('Asking the engine for its settings…', h),
        onFailure: reason =>
          problemLine(`Its settings couldn't be read: ${reason}`, h),
        onData: settings =>
          rowsView(
            'The engine’s settings',
            settingRows(EngineSettings, settings, 'engine'),
            h,
          ),
      }),
    ],
    h,
  )

/** The theme switch: one button per theme, the one shown pressed; a choice applies at once. */
const themeSwitch = <ParentMessage>(
  inputs: ViewInputs<ParentMessage>,
  h: HtmlBuilder<ParentMessage>,
): Html => {
  const shown = Option.getOrElse(inputs.theme, () => defaultTheme)
  return h.div(
    [h.Role('group'), h.AriaLabel('Theme'), h.Class('flex gap-8')],
    themes.map(theme =>
      h.keyed('button')(
        theme,
        [
          h.Type('button'),
          h.AriaPressed(theme === shown ? 'true' : 'false'),
          h.OnClick(inputs.chooseTheme(theme)),
          h.Class(
            theme === shown
              ? 'rounded-button border border-c1 px-10 py-4 text-xs font-bold text-fg'
              : 'rounded-button border border-line px-10 py-4 text-xs text-muted',
          ),
        ],
        [themeTitle(theme)],
      ),
    ),
  )
}

const appView = <ParentMessage>(
  inputs: ViewInputs<ParentMessage>,
  h: HtmlBuilder<ParentMessage>,
): Html =>
  section(
    'App settings',
    'App',
    [
      themeSwitch(inputs, h),
      rowsView('The app’s settings', appRows(inputs.theme), h),
    ],
    h,
  )

export const view = <ParentMessage>(
  model: Model,
  inputs: ViewInputs<ParentMessage>,
  h: HtmlBuilder<ParentMessage>,
): Html =>
  h.div(
    [h.Class('flex min-h-0 flex-1 flex-col gap-16 overflow-auto')],
    [appView(inputs, h), projectView(model, inputs, h), engineView(model, h)],
  )
