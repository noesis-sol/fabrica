import { Data, Effect, Option } from 'effect'

import { readFileText } from '../files'
import { projectSettingsPath } from './sources'
import { parseJson } from './values'

// Reading `.fabrica/settings.json` from a checkout, through the reader for files the engine doesn't
// own (spec §20.2, H62): a checkout's .fabrica/ holds whatever a merged ticket committed.

/** The most a settings file may hold. */
export const settingsFileMaxBytes = 1024 * 1024

/** What a checkout's settings file held. */
export type ProjectSettingsFile = Data.TaggedEnum<{
  /** No file: every setting its default. */
  Missing: {}
  Read: { readonly text: string; readonly value: unknown }
  /** A file that couldn't be read (a link, a pipe, too large) or isn't JSON. */
  Unreadable: { readonly reason: string }
}>
export const ProjectSettingsFile = Data.taggedEnum<ProjectSettingsFile>()

/** Reads the settings file of the checkout at `checkout`. */
export const readProjectSettingsFile = Effect.fn('Settings.readProjectFile')(
  function* (checkout: string) {
    return yield* readFileText(
      { root: checkout, path: projectSettingsPath },
      { maxBytes: settingsFileMaxBytes },
    ).pipe(
      Effect.map(text =>
        Option.match(parseJson(text), {
          onNone: () =>
            ProjectSettingsFile.Unreadable({ reason: "it isn't JSON" }),
          onSome: value => ProjectSettingsFile.Read({ text, value }),
        }),
      ),
      Effect.catchTag('FileMissing', () =>
        Effect.succeed(ProjectSettingsFile.Missing()),
      ),
      Effect.catch(failure =>
        Effect.succeed(
          ProjectSettingsFile.Unreadable({ reason: failure.message }),
        ),
      ),
    )
  },
)
