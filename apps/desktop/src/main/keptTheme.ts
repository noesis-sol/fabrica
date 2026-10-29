import { Data, Effect, Option, Schema, Semaphore } from 'effect'

import { readFileText, writeFileWhole } from '@fabrica/engine/files'
import { Theme } from '@fabrica/ui/theme'

// The theme main makes the window in (spec §18.2). The page keeps the install's theme in its own
// storage and tells main once it starts; main keeps the last it was told in the app's data folder, so
// the next start's window opens in it rather than recolouring from the default a moment later.

/** The file main keeps the theme in, in the app's data folder. */
export const themeFileName = 'theme.json'

/** The most the theme file may hold. */
const themeFileMaxBytes = 4 * 1024

const ThemeJson = Schema.fromJsonString(Schema.Struct({ theme: Theme }))
const decodeThemeFile = Schema.decodeUnknownEffect(ThemeJson)
const encodeThemeFile = Schema.encodeEffect(ThemeJson)

/** The theme couldn't be kept. */
export class ThemeKeepFailed extends Data.TaggedError('ThemeKeepFailed')<{
  readonly reason: string
}> {}

/** The theme kept in `folder`: none where none is kept, and none, warned of, where the file isn't one. */
export const keptTheme = Effect.fn('KeptTheme.read')(function* (
  folder: string,
) {
  return yield* readFileText(
    { root: folder, path: themeFileName },
    { maxBytes: themeFileMaxBytes },
  ).pipe(
    Effect.flatMap(text => decodeThemeFile(text)),
    Effect.map(({ theme }) => Option.some(theme)),
    Effect.catchTag('FileMissing', () => Effect.succeedNone),
    Effect.catch(failure =>
      Effect.logWarning(`the kept theme: ${failure.message}`).pipe(
        Effect.as(Option.none<Theme>()),
      ),
    ),
  )
})

/** Keeps `theme` in `folder`, for the window of the app's next start. */
export const keepTheme = Effect.fn('KeptTheme.keep')(function* ({
  folder,
  theme,
}: {
  readonly folder: string
  readonly theme: Theme
}) {
  yield* encodeThemeFile({ theme }).pipe(
    Effect.flatMap(text =>
      writeFileWhole({ root: folder, path: themeFileName }, text),
    ),
    Effect.mapError(
      failure => new ThemeKeepFailed({ reason: failure.message }),
    ),
  )
})

/** Keeps a theme in a data folder: each keep made after the one before, the theme it writes the last told. */
export interface ThemeKeeper {
  /** Keeps `theme`, unless a theme told after it is kept instead. */
  readonly keep: (theme: Theme) => Effect.Effect<void, ThemeKeepFailed>
}

/** A ThemeKeeper of `folder`: themes told one after another are kept in that order, the last one left. */
export const makeThemeKeeper = (folder: string): ThemeKeeper => {
  const lock = Semaphore.makeUnsafe(1)
  let told: Option.Option<Theme> = Option.none()
  return {
    keep: theme =>
      Effect.sync(() => {
        told = Option.some(theme)
      }).pipe(
        Effect.andThen(
          lock.withPermits(1)(
            Effect.suspend(() =>
              keepTheme({ folder, theme: Option.getOrElse(told, () => theme) }),
            ),
          ),
        ),
      ),
  }
}
