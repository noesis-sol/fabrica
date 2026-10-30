import { channels } from '../../preload/api'
import type { MainContext } from '../context'
import type { IpcRegistrar } from '../ipc'

// The window's controls the page draws in its title bar (spec §18.3): minimize, maximize or restore,
// and close.

/** What main does with the app's window for the page. */
export interface WindowControlsActions {
  readonly minimize: () => void
  readonly toggleMaximize: () => void
  readonly close: () => void
}

/** Registers the window controls' channels on `ipc`, acted on by `actions`. */
export const windowControlsChannels = (
  ipc: IpcRegistrar,
  actions: WindowControlsActions,
): void => {
  ipc.onSignal(channels.minimize, actions.minimize)
  ipc.onSignal(channels.toggleMaximize, actions.toggleMaximize)
  ipc.onSignal(channels.close, actions.close)
}

/** Registers the window controls on `ipc`, for the app's window. */
export const registerWindowControls = (
  ipc: IpcRegistrar,
  { appWindow }: MainContext,
): void =>
  windowControlsChannels(ipc, {
    minimize: () => appWindow.current()?.minimize(),
    toggleMaximize: () => {
      const window = appWindow.current()
      if (window?.isMaximized() === true) {
        window.unmaximize()
      } else {
        window?.maximize()
      }
    },
    close: () => appWindow.current()?.close(),
  })
