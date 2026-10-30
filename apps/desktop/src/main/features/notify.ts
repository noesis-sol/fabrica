import { Schema } from 'effect'

import { DesktopNotification } from '@fabrica/ui/notify'

import { channels } from '../../preload/api'
import type { MainContext } from '../context'
import type { IpcRegistrar } from '../ipc'
import { makeNotifications } from '../notifications'

// The page's system notifications (spec §18.5), shown by ../notifications while the app's window
// doesn't have focus, a click bringing it forward.

/** What main does with the page's notifications. */
export interface NotifyActions {
  /** Shows a system notification (§18.5). */
  readonly notify: (notification: DesktopNotification) => void
}

const decodeNotification = Schema.decodeUnknownOption(
  Schema.Tuple([DesktopNotification]),
)

/** Registers the notifications' channel on `ipc`, acted on by `actions`. */
export const notifyChannels = (
  ipc: IpcRegistrar,
  actions: NotifyActions,
): void =>
  ipc.onSend(channels.notify, decodeNotification, ([notification]) =>
    actions.notify(notification),
  )

/** Registers the notifications on `ipc`, shown with Electron's for the app's window. */
export const registerNotify = (
  ipc: IpcRegistrar,
  { Notification, appWindow }: MainContext,
): void =>
  notifyChannels(
    ipc,
    makeNotifications({
      system: Notification,
      window: {
        hasFocus: () => {
          const window = appWindow.current()
          return (
            window !== undefined && window.isVisible() && window.isFocused()
          )
        },
        reveal: () => {
          appWindow.show()
          return appWindow.current()?.webContents
        },
      },
    }),
  )
