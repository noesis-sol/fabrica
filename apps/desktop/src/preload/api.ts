import { Option, Schema } from 'effect'

import { ReleaseVersion } from '@fabrica/contracts'
import { ServiceInstall, installLoginServiceMethod } from '@fabrica/ui/host'
import {
  DesktopNotification,
  NotificationTarget,
  type NotificationsApi,
} from '@fabrica/ui/notify'
import { enginePortMessage } from '@fabrica/ui/port'
import { Theme } from '@fabrica/ui/theme'

// The preload's API (spec §20.1): what the page may ask of main, and no more. The renderer is treated
// as an untrusted web page, so every value crossing is decoded with these schemas on both sides: by
// the preload, from the page and from main, and by main, from the preload. The window controls, the
// folder picker, the app's version, the update status, the system notifications and their clicks
// (§18.5), installing the local engine's login service, and the engine port, which the preload hands
// to the page as a window message (contextBridge can't carry a MessagePort).

/** The IPC channels between main and the preload, each named once. */
export const channels = {
  minimize: 'fabrica:window-minimize',
  toggleMaximize: 'fabrica:window-toggle-maximize',
  close: 'fabrica:window-close',
  setTheme: 'fabrica:window-set-theme',
  pickFolder: 'fabrica:pick-folder',
  version: 'fabrica:version',
  updateStatus: 'fabrica:update-status',
  updateStatusChanged: 'fabrica:update-status-changed',
  notify: 'fabrica:notify',
  notificationClicked: 'fabrica:notification-clicked',
  installLoginService: 'fabrica:install-login-service',
  enginePort: 'fabrica:engine-port',
} as const

/** A folder the user picked, or none. */
export const FolderPick = Schema.TaggedUnion({
  Picked: { path: Schema.NonEmptyString },
  Cancelled: {},
})
export type FolderPick = typeof FolderPick.Type

/** Where the app's own update stands (spec §22.2). */
export const UpdateStatus = Schema.TaggedUnion({
  /** This build doesn't update itself: a development build, or a deb or rpm, updated by hand. */
  Unavailable: {},
  /** No check yet, or none since the last. */
  Idle: {},
  Checking: {},
  UpToDate: {},
  Downloading: {
    version: ReleaseVersion,
    percent: Schema.Number.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(100),
    ),
  },
  /** Downloaded, installed as the app restarts. */
  Ready: { version: ReleaseVersion },
  Failed: { reason: Schema.String },
})
export type UpdateStatus = typeof UpdateStatus.Type

/** What the preload exposes to the page as `window.fabrica`. */
export interface FabricaApi {
  readonly window: {
    readonly minimize: () => void
    readonly toggleMaximize: () => void
    readonly close: () => void
    /** The theme the page shows, so main colours the native title bar and window to match. */
    readonly setTheme: (theme: Theme) => void
  }
  readonly pickFolder: () => Promise<FolderPick>
  readonly version: () => Promise<ReleaseVersion>
  readonly updateStatus: () => Promise<UpdateStatus>
  /** Calls `listener` with each new update status; the function returned stops it. */
  readonly onUpdateStatus: (
    listener: (status: UpdateStatus) => void,
  ) => () => void
  /** System notifications, and the targets of those clicked. */
  readonly notifications: NotificationsApi
  /** Installs the local engine as a login service, as the user chose (spec §7.1). */
  readonly [installLoginServiceMethod]: () => Promise<ServiceInstall>
}

/** The part of `ipcRenderer` the API uses; a listener gets a message's value and the ports it carries. */
export interface PreloadIpc {
  readonly send: (channel: string, ...values: ReadonlyArray<unknown>) => void
  readonly invoke: (
    channel: string,
    ...values: ReadonlyArray<unknown>
  ) => Promise<unknown>
  readonly on: (
    channel: string,
    listener: (value: unknown, ports: ReadonlyArray<unknown>) => void,
  ) => () => void
}

// A value that doesn't decode throws: the page's call fails, or main's answer rejects its promise.
const decodeFolderPick = Schema.decodeUnknownSync(FolderPick)
const decodeVersion = Schema.decodeUnknownSync(ReleaseVersion)
const decodeUpdateStatus = Schema.decodeUnknownSync(UpdateStatus)
const decodeTheme = Schema.decodeUnknownSync(Theme)
const decodeUpdateStatusOption = Schema.decodeUnknownOption(UpdateStatus)
const decodeNotification = Schema.decodeUnknownSync(DesktopNotification)
const decodeTargetOption = Schema.decodeUnknownOption(NotificationTarget)
const decodeServiceInstall = Schema.decodeUnknownSync(ServiceInstall)

/** The API over `ipc`: what the page passes is decoded before it is sent, what main answers before the page sees it. */
export const makeApi = (ipc: PreloadIpc): FabricaApi => ({
  window: {
    minimize: () => ipc.send(channels.minimize),
    toggleMaximize: () => ipc.send(channels.toggleMaximize),
    close: () => ipc.send(channels.close),
    setTheme: theme => ipc.send(channels.setTheme, decodeTheme(theme)),
  },
  pickFolder: () => ipc.invoke(channels.pickFolder).then(decodeFolderPick),
  version: () => ipc.invoke(channels.version).then(decodeVersion),
  updateStatus: () =>
    ipc.invoke(channels.updateStatus).then(decodeUpdateStatus),
  onUpdateStatus: listener =>
    ipc.on(channels.updateStatusChanged, value => {
      Option.map(decodeUpdateStatusOption(value), listener)
    }),
  notifications: {
    notify: notification =>
      ipc.send(channels.notify, decodeNotification(notification)),
    onClick: listener =>
      ipc.on(channels.notificationClicked, value => {
        Option.map(decodeTargetOption(value), listener)
      }),
  },
  [installLoginServiceMethod]: () =>
    ipc.invoke(channels.installLoginService).then(decodeServiceInstall),
})

/** Hands the page each engine port main sends, as a window message of type `fabrica:engine-port`. */
export const forwardEnginePorts = (
  ipc: PreloadIpc,
  post: (message: { readonly type: string }, ports: [MessagePort]) => void,
): (() => void) =>
  ipc.on(channels.enginePort, (_value, ports) => {
    const [port] = ports
    if (ports.length === 1 && port instanceof MessagePort) {
      post({ type: enginePortMessage }, [port])
    }
  })
