import { Effect, Schema } from 'effect'

import { Theme } from '@fabrica/ui/theme'

import { channels } from '../../preload/api'
import type { MainContext } from '../context'
import type { IpcRegistrar } from '../ipc'
import { makeThemeKeeper } from '../keptTheme'

// The theme the page shows (spec §18.2): the window coloured in it, and a new one kept in the app's
// data folder for the next start's window.

/** What main does with the page's theme. */
export interface ThemeActions {
  readonly setTheme: (theme: Theme) => void
}

const decodeTheme = Schema.decodeUnknownOption(Schema.Tuple([Theme]))

/** Registers the theme's channel on `ipc`, acted on by `actions`. */
export const themeChannels = (ipc: IpcRegistrar, actions: ThemeActions): void =>
  ipc.onSend(channels.setTheme, decodeTheme, ([theme]) =>
    actions.setTheme(theme),
  )

/** Registers the theme on `ipc`, for the app's window and its data folder. */
export const registerTheme = (
  ipc: IpcRegistrar,
  { appWindow, userData }: MainContext,
): void => {
  const themeKeeper = makeThemeKeeper(userData)
  themeChannels(ipc, {
    setTheme: theme => {
      if (theme === appWindow.theme()) {
        return
      }
      appWindow.setTheme(theme)
      void Effect.runPromise(
        themeKeeper
          .keep(theme)
          .pipe(
            Effect.catch(error =>
              Effect.logWarning(`keeping the theme: ${error.reason}`),
            ),
          ),
      )
    },
  })
}
