import type {
  DesktopNotification,
  NotificationTarget,
} from '@fabrica/ui/notify'

import { channels } from '../preload/api'

// System notifications (spec §18.5): the page decides what to tell and asks through the preload's
// validated `notify`; main shows it while the app's window doesn't have focus (a window in front
// already shows the request), and a click brings the window forward, made again if it was closed, and
// hands its page the notification's target, once the page has loaded, for the console to focus.

/** The part of Electron's `Notification` class main uses. */
export interface NotificationClass {
  readonly isSupported: () => boolean
  new (options: { readonly title: string; readonly body: string }): {
    on(event: 'click', listener: () => void): unknown
    on(event: 'close', listener: () => void): unknown
    show(): void
  }
}

/** The page a click goes to: the app window's web contents. */
export interface NotifiedPage {
  readonly isLoading: () => boolean
  readonly once: (event: 'did-finish-load', listener: () => void) => unknown
  readonly send: (channel: string, value: NotificationTarget) => void
}

/** The app's window, as notifications need it. */
export interface NotifiedWindow {
  /** Whether the app's window is shown and has focus. */
  readonly hasFocus: () => boolean
  /** Shows the app's window and focuses it, made again if it was closed; its page. */
  readonly reveal: () => NotifiedPage | undefined
}

/** What main does with the page's notifications. */
export interface Notifications {
  readonly notify: (notification: DesktopNotification) => void
}

/** Hands `page` the clicked `target`, once it has loaded. */
const sendClick = (page: NotifiedPage, target: NotificationTarget): void => {
  const send = () => page.send(channels.notificationClicked, target)
  if (page.isLoading()) {
    page.once('did-finish-load', send)
  } else {
    send()
  }
}

/** Notifications shown with `system`, for the app's `window`. */
export const makeNotifications = ({
  system,
  window,
}: {
  readonly system: NotificationClass
  readonly window: NotifiedWindow
}): Notifications => {
  // A notification nothing refers to may be collected, and its click lost: each shown is kept until
  // it is clicked or closed.
  const shown = new Set<unknown>()
  return {
    notify: ({ title, body, target }) => {
      if (!system.isSupported() || window.hasFocus()) {
        return
      }
      const notification = new system({ title, body })
      shown.add(notification)
      notification.on('click', () => {
        shown.delete(notification)
        const page = window.reveal()
        if (page !== undefined) {
          sendClick(page, target)
        }
      })
      notification.on('close', () => {
        shown.delete(notification)
      })
      notification.show()
    },
  }
}
