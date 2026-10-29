import { Array, Effect, Option, Result, type Schema } from 'effect'

import {
  type EngineSettings,
  type ProjectSettings,
  decodeEngineSettings,
  decodeProjectSettings,
} from '@fabrica/contracts'

import {
  type SettingKey,
  type SettingScope,
  flagOf,
  keyHolds,
  settingKeys,
} from './keys'
import { ProjectSettingsFile, readProjectSettingsFile } from './read'
import {
  SettingSource,
  type SettingsProblem,
  SettingsProblems,
  issuesOf,
  projectSettingsPath,
} from './sources'
import { parseJson, placedAt, valueAt, withValueAt } from './values'

// Resolving a run's settings, once, into one value (spec §13.13): each key from its flag, else its
// FABRICA_ environment variable, else the project's settings (a project key) or the engine's (a
// machine key), else its default. Every problem, in every source, is listed together; a person's or
// a machine's setting in the project's file is one (H68).

/** What a run's settings are resolved from. */
export interface SettingsInputs {
  /** The settings flags given, by setting path (`concurrent`, `verifier.rounds`), as their text. */
  readonly flags: Readonly<Record<string, string>>
  /** The engine's environment, from which the FABRICA_ variables of settings are read. */
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly projectFile: ProjectSettingsFile
  /** The engine's settings as stored; `{}` where it has none. */
  readonly engineSettings: unknown
}

/** A key and where its value came from. */
export interface SettingWithSource {
  readonly key: SettingKey
  readonly source: SettingSource
}

/** A run's settings, each value once, with where each came from (for the Settings screen). */
export interface ResolvedSettings {
  readonly project: ProjectSettings
  readonly engine: EngineSettings
  readonly sources: ReadonlyArray<SettingWithSource>
}

const decoders: Record<
  SettingScope,
  (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>
> = { project: decodeProjectSettings, engine: decodeEngineSettings }

/** Whether `value` at the key's path decodes, every other key at its default. */
const decodesAlone = (key: SettingKey, value: unknown) =>
  Effect.isSuccess(decoders[key.scope](placedAt(key.segments, value)))

/**
 * The value a flag's or a variable's text gives a key: the text itself where the key takes it (a
 * command, a time, a model), else the JSON it holds (a number, a boolean, a list), else the text, to
 * be reported as the key's problem.
 */
const valueOfText = Effect.fn('Settings.valueOfText')(function* (
  key: SettingKey,
  text: string,
) {
  if (yield* decodesAlone(key, text)) return text
  return Option.getOrElse(parseJson(text), () => text)
})

/** A key's flag or variable, the flag first, where one is given. */
const givenText = (
  key: SettingKey,
  inputs: SettingsInputs,
): Option.Option<{ readonly source: SettingSource; readonly text: string }> =>
  Option.orElse(
    Option.map(Option.fromUndefinedOr(inputs.flags[key.path]), text => ({
      source: SettingSource.Flag({ flag: key.flag }),
      text,
    })),
    () =>
      Option.map(
        Option.fromUndefinedOr(inputs.environment[key.variable]),
        text => ({
          source: SettingSource.Environment({ variable: key.variable }),
          text,
        }),
      ),
  )

/** Resolves a run's settings from what it was given, or fails with every problem among them. */
export const resolveSettings = Effect.fn('Settings.resolve')(function* (
  inputs: SettingsInputs,
) {
  const fileSource: Record<SettingScope, SettingSource> = {
    project: SettingSource.ProjectFile({ file: projectSettingsPath }),
    engine: SettingSource.EngineSettings(),
  }
  const fileProblems: Array<SettingsProblem> = ProjectSettingsFile.$match(
    inputs.projectFile,
    {
      Missing: () => [],
      Read: () => [],
      Unreadable: ({ reason }) => [
        {
          source: fileSource.project,
          path: '',
          message: `The project's settings couldn't be read: ${reason}`,
        },
      ],
    },
  )
  const files: Record<SettingScope, unknown> = {
    project: ProjectSettingsFile.$match(inputs.projectFile, {
      Missing: () => ({}),
      Read: ({ value }) => value,
      Unreadable: () => ({}),
    }),
    engine: inputs.engineSettings,
  }

  const known = new Set(settingKeys.map(key => key.path))
  const flagProblems: Array<SettingsProblem> = Object.keys(inputs.flags)
    .filter(path => !known.has(path))
    .map(path => ({
      source: SettingSource.Flag({ flag: flagOf(path) }),
      path,
      message: `${path} isn't a setting`,
    }))

  const given = yield* Effect.forEach(settingKeys, key =>
    Option.match(givenText(key, inputs), {
      onNone: () => Effect.succeed(Option.none()),
      onSome: ({ source, text }) =>
        Effect.map(valueOfText(key, text), value =>
          Option.some({ key, source, value }),
        ),
    }),
  )
  const overrides = Array.getSomes(given)

  const sources: ReadonlyArray<SettingWithSource> = settingKeys.map(key => ({
    key,
    source: Option.match(
      Array.findFirst(overrides, override => override.key === key),
      {
        onSome: ({ source }) => source,
        onNone: () =>
          Option.isSome(valueAt(files[key.scope], key.segments))
            ? fileSource[key.scope]
            : SettingSource.Default(),
      },
    ),
  }))

  /** A scope's settings: its file, each key given by a flag or a variable set over it. */
  const merged = (scope: SettingScope): unknown =>
    overrides
      .filter(({ key }) => key.scope === scope)
      .reduce(
        (value, { key, value: inner }) =>
          // Where something other than an object stands on the way, the file's value is kept: its
          // problem is the one to report.
          Option.getOrElse(
            withValueAt(value, key.segments, inner),
            () => value,
          ),
        files[scope],
      )

  /** Where a problem at `segments` of a scope's settings was given: its key's flag or variable, else the file. */
  const sourceAt = (scope: SettingScope, segments: ReadonlyArray<string>) =>
    Option.match(
      Array.findFirst(
        overrides,
        ({ key }) => key.scope === scope && keyHolds(key, segments),
      ),
      { onSome: ({ source }) => source, onNone: () => fileSource[scope] },
    )

  const decoded = <A>(
    scope: SettingScope,
    decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>,
  ) =>
    Effect.map(Effect.result(decode(merged(scope))), result =>
      Result.mapError(result, error =>
        Array.match(issuesOf(error), {
          onEmpty: (): Array.NonEmptyReadonlyArray<SettingsProblem> => [
            { source: fileSource[scope], path: '', message: error.message },
          ],
          onNonEmpty: issues =>
            Array.map(issues, (issue): SettingsProblem => ({
              source: sourceAt(scope, issue.segments),
              path: issue.segments.join('.'),
              message: issue.message,
            })),
        }),
      ),
    )

  const [project, engine] = yield* Effect.all([
    decoded('project', decodeProjectSettings),
    decoded('engine', decodeEngineSettings),
  ])

  const problems = [
    ...fileProblems,
    ...flagProblems,
    ...(Result.isFailure(project) ? project.failure : []),
    ...(Result.isFailure(engine) ? engine.failure : []),
  ]
  if (Array.isReadonlyArrayNonEmpty(problems))
    return yield* new SettingsProblems({ problems })
  // A decoding that failed lists a problem at least, so with none listed both decoded.
  if (Result.isFailure(project) || Result.isFailure(engine))
    return yield* Effect.die('a settings decoding failed without a problem')
  return {
    project: project.success,
    engine: engine.success,
    sources,
  } satisfies ResolvedSettings
})

/** Reads the checkout's settings file and resolves a run's settings with it. */
export const loadSettings = Effect.fn('Settings.load')(function* (options: {
  readonly checkout: string
  readonly flags: Readonly<Record<string, string>>
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly engineSettings: unknown
}) {
  const projectFile = yield* readProjectSettingsFile(options.checkout)
  return yield* resolveSettings({
    flags: options.flags,
    environment: options.environment,
    projectFile,
    engineSettings: options.engineSettings,
  })
})

/** Where the value of the setting at `path` came from. */
export const sourceOf = (
  resolved: ResolvedSettings,
  path: string,
): Option.Option<SettingSource> =>
  Option.map(
    Array.findFirst(resolved.sources, ({ key }) => key.path === path),
    ({ source }) => source,
  )
