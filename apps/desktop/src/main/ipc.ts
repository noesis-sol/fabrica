import { Option, Schema } from 'effect'
import type { MessagePortMain, WebContents } from 'electron'

import type { ReleaseVersion } from '@fabrica/contracts'
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
  readonly pickFolder: () => Promise<FolderPick>
  readonly version: ReleaseVersion
  readonly updateStatus: () => UpdateStatus
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

  const onInvoke = (channel: string, answer: () => Promise<unknown>) =>
    ipc.handle(channel, (sender, values) =>
      fromApp(sender) && isNoValues(values)
        ? answer()
        : Promise.reject(new RequestRefused(channel)),
    )

  onInvoke(channels.pickFolder, actions.pickFolder)
  onInvoke(channels.version, () => Promise.resolve(actions.version))
  onInvoke(channels.updateStatus, () => Promise.resolve(actions.updateStatus()))
}

/** Hands the page in `contents` an engine port, which the preload passes on as a window message. */
export const sendEnginePort = (
  contents: WebContents,
  port: MessagePortMain,
): void => contents.postMessage(channels.enginePort, null, [port])
