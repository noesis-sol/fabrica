import { Context, Effect, Layer, Option } from 'effect'
import { Command } from 'foldkit'

import { Theme, applyTheme, keepTheme, keptTheme } from '../theme/theme'
import { Message } from './message'

// Where the renderer shows and keeps its theme (spec §18.2): a setting of each app install, switched
// in Settings and the palette and applied at once, by data-theme on the document's root and, in the
// desktop app, the native window coloured to match through the preload's `window.setTheme`. The
// install keeps its choice in the window's storage for its next start.

export interface ThemeHostShape {
  /** The theme this install chose; none where it never chose one, or its storage can't be read. */
  readonly kept: Effect.Effect<Option.Option<Theme>>
  /** Shows `theme` at once: on the document's root, and on the native window where there is one. */
  readonly show: (theme: Theme) => Effect.Effect<void>
  /** Keeps `theme` as this install's choice; a storage that refuses it keeps the one before. */
  readonly keep: (theme: Theme) => Effect.Effect<void>
}

export class ThemeHost extends Context.Service<ThemeHost, ThemeHostShape>()(
  '@fabrica/ui/ThemeHost',
) {}

/** What of a window the theme needs: its document's root and its storage. */
export interface ThemeWindow {
  readonly document: { readonly documentElement: Element }
  readonly localStorage: Pick<Storage, 'getItem' | 'setItem'>
}

/** The preload's `window.setTheme`, where the desktop app exposes it as `window.fabrica`. */
const nativeSetTheme = (
  target: object,
): Option.Option<(theme: Theme) => void> => {
  const api: unknown = Reflect.get(target, 'fabrica')
  const windowApi: unknown =
    typeof api === 'object' && api !== null
      ? Reflect.get(api, 'window')
      : undefined
  const setTheme: unknown =
    typeof windowApi === 'object' && windowApi !== null
      ? Reflect.get(windowApi, 'setTheme')
      : undefined
  return typeof setTheme === 'function'
    ? Option.some(theme => {
        Reflect.apply(setTheme, windowApi, [theme])
      })
    : Option.none()
}

/** The theme host of `target`, the window the renderer runs in. */
export const themeHostOf = (target: ThemeWindow): ThemeHostShape => {
  const setNative = nativeSetTheme(target)
  return {
    kept: Effect.try(() => keptTheme(target.localStorage)).pipe(
      Effect.orElseSucceed(() => Option.none()),
    ),
    show: theme =>
      Effect.sync(() => {
        applyTheme(target.document.documentElement, theme)
        Option.map(setNative, setTheme => setTheme(theme))
      }),
    keep: theme =>
      Effect.try(() => keepTheme(target.localStorage, theme)).pipe(
        Effect.ignore,
      ),
  }
}

export const layerThemeHost = (host: ThemeHostShape): Layer.Layer<ThemeHost> =>
  Layer.succeed(ThemeHost, ThemeHost.of(host))

/** Shows the theme chosen at once, and keeps it as the install's choice. */
export const ShowTheme = Command.define('ShowTheme', {
  args: { theme: Theme },
  messages: [Message.CompletedShowTheme],
  execute: ({ theme }) =>
    Effect.gen(function* () {
      const host = yield* ThemeHost
      yield* host.show(theme)
      yield* host.keep(theme)
      return Message.CompletedShowTheme()
    }),
})
