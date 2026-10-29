import { Option, Schema } from 'effect'
import type { MessagePortMain, WebContents } from 'electron'

import {
  type CheckAnswer,
  EngineHost,
  type InstallAnswer,
  InstallConsent,
} from '@fabrica/client'
import type { ReleaseVersion } from '@fabrica/contracts'
import type { ServiceInstall } from '@fabrica/ui/host'
import { DesktopNotification } from '@fabrica/ui/notify'
import { Theme } from '@fabrica/ui/theme'

import { type FolderPick, type UpdateStatus, channels } from '../preload/api'

// Main's end of the preload's API (spec §20.1). The preload already decodes what the page passes, but
// main decodes it again: it takes nothing on trust from a renderer, and only from the app's own page.
// A message that doesn't decode is dropped; a request that doesn't is refused.

/** What main does for the page. */
export interface MainActions {
  readonly minimize: () => void
  readonly toggleMaximize: () => void
  readonly close: () => void
  readonly setTheme: (theme: Theme) => void
  /** Shows a system notification (§18.5). */
  readonly notify: (notification: DesktopNotification) => void
  readonly pickFolder: () => Promise<FolderPick>
  readonly version: ReleaseVersion
  readonly updateStatus: () => UpdateStatus
  /** Installs the local engine's login service, from the bundled distribution (spec §7.1). */
  readonly installLoginService: () => Promise<ServiceInstall>
  /** Checks a host for an engine, and what installing the app's would do (§9.2). */
  readonly checkEngine: (host: EngineHost) => Promise<CheckAnswer>
  /** Installs or updates the engine on a host, as the user agreed. */
  readonly installEngine: (request: {
    readonly host: EngineHost
    readonly consent: InstallConsent
  }) => Promise<InstallAnswer>
}

/** The part of `ipcMain` main uses; each listener gets the sending frame's URL (none once it has gone) and the values. */
export interface MainIpc {
  readonly on: (
    channel: string,
    listener: (
      sender: string | undefined,
      values: ReadonlyArray<unknown>,
    ) => void,
  ) => void
  readonly handle: (
    channel: string,
    handler: (
      sender: string | undefined,
      values: ReadonlyArray<unknown>,
    ) => Promise<unknown>,
  ) => void
}

/** A message or request whose values aren't what its channel takes. */
export class RequestRefused extends Error {
  constructor(channel: string) {
    super(`refused ${channel}: not from the app's page, or not what it takes`)
    this.name = 'RequestRefused'
  }
}

const noValues = Schema.Tuple([])
const isNoValues = Schema.is(noValues)
const decodeTheme = Schema.decodeUnknownOption(Schema.Tuple([Theme]))
const decodeNotification = Schema.decodeUnknownOption(
  Schema.Tuple([DesktopNotification]),
)
const decodeCheck = Schema.decodeUnknownOption(Schema.Tuple([EngineHost]))
const decodeInstall = Schema.decodeUnknownOption(
  Schema.Tuple([EngineHost, InstallConsent]),
)

/** Registers `actions` on `ipc`, for messages from frames whose URL `trusted` takes. */
export const registerIpc = ({
  ipc,
  trusted,
  actions,
}: {
  readonly ipc: MainIpc
  readonly trusted: (url: string) => boolean
  readonly actions: MainActions
}): void => {
  const fromApp = (sender: string | undefined): boolean =>
    sender !== undefined && trusted(sender)

  const onSend = (
    channel: string,
    act: (values: ReadonlyArray<unknown>) => void,
  ) =>
    ipc.on(channel, (sender, values) => {
      if (fromApp(sender)) {
        act(values)
      }
    })

  const plain = (action: () => void) => (values: ReadonlyArray<unknown>) => {
    if (isNoValues(values)) {
      action()
    }
  }

  onSend(channels.minimize, plain(actions.minimize))
  onSend(channels.toggleMaximize, plain(actions.toggleMaximize))
  onSend(channels.close, plain(actions.close))
  onSend(channels.setTheme, values => {
    Option.map(decodeTheme(values), ([theme]) => actions.setTheme(theme))
  })
  onSend(channels.notify, values => {
    Option.map(decodeNotification(values), ([notification]) =>
      actions.notify(notification),
    )
  })

  /** Answers requests on `channel` from the app's page whose values `decode` takes. */
  const onRequest = <A>(
    channel: string,
    decode: (values: ReadonlyArray<unknown>) => Option.Option<A>,
    answer: (decoded: A) => Promise<unknown>,
  ) =>
    ipc.handle(channel, (sender, values) =>
      Option.match(fromApp(sender) ? decode(values) : Option.none(), {
        onNone: () => Promise.reject(new RequestRefused(channel)),
        onSome: answer,
      }),
    )

  const onInvoke = (channel: string, answer: () => Promise<unknown>) =>
    onRequest(
      channel,
      values => (isNoValues(values) ? Option.some(values) : Option.none()),
      () => answer(),
    )

  onInvoke(channels.pickFolder, actions.pickFolder)
  onInvoke(channels.version, () => Promise.resolve(actions.version))
  onInvoke(channels.updateStatus, () => Promise.resolve(actions.updateStatus()))
  onInvoke(channels.installLoginService, actions.installLoginService)
  onRequest(channels.checkEngine, decodeCheck, ([host]) =>
    actions.checkEngine(host),
  )
  onRequest(channels.installEngine, decodeInstall, ([host, consent]) =>
    actions.installEngine({ host, consent }),
  )
}

/** Hands the page in `contents` an engine port, which the preload passes on as a window message. */
export const sendEnginePort = (
  contents: WebContents,
  port: MessagePortMain,
): void => contents.postMessage(channels.enginePort, null, [port])
