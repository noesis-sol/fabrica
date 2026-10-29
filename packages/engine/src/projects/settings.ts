import { Array, Effect, Option, Schema } from 'effect'

import { ProjectSettings, decodeProjectSettings } from '@fabrica/contracts'

import { writeFileWhole } from '../files'
import {
  ProjectSettingsFile,
  SettingSource,
  SettingsProblems,
  editSettingsText,
  projectSettingsPath,
  readProjectSettingsFile,
} from '../settings'
import { issuesOf } from '../settings/sources'
import { isJsonObject, parseJson } from '../settings/values'

// A project's settings over RPC (spec §8.1, §13.13): `.fabrica/settings.json` read and decoded, and
// written from the settings a client sends. A write changes only the settings that differ from the
// file's, each where it stands, so the rest of the file keeps the maintainer's formatting, and a key
// that is no setting is removed. The text is decoded again before it is written; text that wouldn't
// decode is refused with every problem, the file left as it was.

const source = SettingSource.ProjectFile({ file: projectSettingsPath })

/** `document`, a parsed settings file, decoded; every problem in it where it doesn't decode. */
const decodeDocument = (document: unknown) =>
  decodeProjectSettings(document).pipe(
    Effect.mapError(
      error =>
        new SettingsProblems({
          problems: Array.match(issuesOf(error), {
            onEmpty: () =>
              Array.of({ source, path: '', message: error.message }),
            onNonEmpty: Array.map(issue => ({
              source,
              path: issue.segments.join('.'),
              message: issue.message,
            })),
          }),
        }),
    ),
  )

/** A file that couldn't be read, as its one problem. */
const unreadable = (reason: string) =>
  new SettingsProblems({
    problems: [
      {
        source,
        path: '',
        message: `The project's settings couldn't be read: ${reason}`,
      },
    ],
  })

/** Whether the checkout's settings file exists (§10.1: the project is set up). */
export const settingsExist = (checkout: string) =>
  Effect.map(
    readProjectSettingsFile(checkout),
    file => !ProjectSettingsFile.$is('Missing')(file),
  )

/** The checkout's settings, every one not in its file at its default. */
export const readSettings = Effect.fn('Projects.readSettings')(function* (
  checkout: string,
) {
  const file = yield* readProjectSettingsFile(checkout)
  return yield* ProjectSettingsFile.$match(file, {
    Missing: () => decodeDocument({}),
    Read: ({ value }) => decodeDocument(value),
    Unreadable: ({ reason }) => Effect.fail(unreadable(reason)),
  })
})

const encodeSettings = Schema.encodeEffect(ProjectSettings)

/** One change to a settings file: the setting at `path` set to its value, or removed where it has none. */
interface Change {
  readonly path: string
  readonly value: Option.Option<unknown>
}

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/**
 * The changes that take a file written as `before` to `after`: an object's settings compared one by
 * one, where none of its keys holds a dot (a path's separator), and any other value whole.
 */
const changesBetween = (
  before: unknown,
  after: unknown,
  at: ReadonlyArray<string>,
): ReadonlyArray<Change> => {
  if (same(before, after)) return []
  if (isJsonObject(before) && isJsonObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    if (at.length === 0 || keys.every(key => !key.includes('.')))
      return keys.flatMap(key =>
        Object.hasOwn(after, key)
          ? changesBetween(
              Object.hasOwn(before, key) ? before[key] : undefined,
              after[key],
              [...at, key],
            )
          : [{ path: [...at, key].join('.'), value: Option.none() }],
      )
  }
  return [{ path: at.join('.'), value: Option.some(after) }]
}

/** `value` over `under`: an object's keys from both, each value `value`'s where it has one. */
const over = (under: unknown, value: unknown): unknown =>
  isJsonObject(under) && isJsonObject(value)
    ? Object.fromEntries(
        [...new Set([...Object.keys(under), ...Object.keys(value)])].map(
          key => [
            key,
            Object.hasOwn(value, key)
              ? over(under[key], value[key])
              : under[key],
          ],
        ),
      )
    : value

/** Writes `settings` as the checkout's settings, changing only what differs from the file's. */
export const writeSettings = Effect.fn('Projects.writeSettings')(function* ({
  checkout,
  settings,
}: {
  readonly checkout: string
  readonly settings: ProjectSettings
}) {
  const file = yield* readProjectSettingsFile(checkout)
  const { text, before } = yield* ProjectSettingsFile.$match(file, {
    Missing: () => Effect.succeed({ text: '', before: Option.none<unknown>() }),
    Read: ({ text, value }) =>
      Effect.succeed(
        isJsonObject(value)
          ? { text, before: Option.some<unknown>(value) }
          : // A file that isn't an object of settings is replaced whole.
            { text: '', before: Option.none<unknown>() },
      ),
    Unreadable: ({ reason }) => Effect.fail(unreadable(reason)),
  })
  // The file's settings as the encoder writes them, so a setting written another way that means the
  // same ("30m" and "30 minutes") is no change; a file that doesn't decode is compared as written,
  // over the defaults, so its settings that aren't any are removed and its defaults stay unwritten.
  const defaults = yield* Effect.flatMap(decodeDocument({}), current =>
    Effect.orDie(encodeSettings(current)),
  )
  const written = yield* Option.match(before, {
    onNone: () => Effect.succeed(defaults),
    onSome: value =>
      decodeDocument(value).pipe(
        Effect.flatMap(current => Effect.orDie(encodeSettings(current))),
        Effect.catchTag('SettingsProblems', () =>
          Effect.succeed(over(defaults, value)),
        ),
      ),
  })
  const wanted = yield* Effect.orDie(encodeSettings(settings))
  const edited = yield* Effect.reduce(
    changesBetween(written, wanted, []),
    () => text,
    (current, change) =>
      editSettingsText({ text: current, ...change }).pipe(Effect.orDie),
  )
  if (edited === text) return
  const document = Option.getOrElse(parseJson(edited), () => ({}))
  yield* decodeDocument(document)
  yield* writeFileWhole({ root: checkout, path: projectSettingsPath }, edited)
})
