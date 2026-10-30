import { Option, Schema } from 'effect'
import type { MessagePortMain, WebContents } from 'electron'

import { channels } from '../preload/api'

// Main's end of the preload's API (spec §20.1), the part every feature shares: the channels each
// feature under ./features registers, through a registrar that takes only the app's own page. The
// preload already decodes what the page passes, but main decodes it again: it takes nothing on trust
// from a renderer. A message that doesn't decode is dropped; a request that doesn't is refused.

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

/** Decodes a channel's values, none where they aren't what it takes. */
export type DecodeValues<A> = (
  values: ReadonlyArray<unknown>,
) => Option.Option<A>

/** Registers a feature's channels, for messages and requests from the app's page alone. */
export interface IpcRegistrar {
  /** Acts on messages on `channel` from the app's page whose values `decode` takes; drops the rest. */
  readonly onSend: <A>(
    channel: string,
    decode: DecodeValues<A>,
    act: (decoded: A) => void,
  ) => void
  /** Acts on messages on `channel` from the app's page that carry no values; drops the rest. */
  readonly onSignal: (channel: string, act: () => void) => void
  /** Answers requests on `channel` from the app's page whose values `decode` takes; refuses the rest. */
  readonly onRequest: <A>(
    channel: string,
    decode: DecodeValues<A>,
    answer: (decoded: A) => Promise<unknown>,
  ) => void
  /** Answers requests on `channel` from the app's page that carry no values; refuses the rest. */
  readonly onInvoke: (channel: string, answer: () => Promise<unknown>) => void
}

const isNoValues = Schema.is(Schema.Tuple([]))

/** Registers on `ipc` for frames whose URL `trusted` takes. */
export const makeIpcRegistrar = ({
  ipc,
  trusted,
}: {
  readonly ipc: MainIpc
  readonly trusted: (url: string) => boolean
}): IpcRegistrar => {
  const fromApp = (sender: string | undefined): boolean =>
    sender !== undefined && trusted(sender)

  const onSend = <A>(
    channel: string,
    decode: DecodeValues<A>,
    act: (decoded: A) => void,
  ): void =>
    ipc.on(channel, (sender, values) => {
      if (fromApp(sender)) {
        Option.map(decode(values), act)
      }
    })

  const onRequest = <A>(
    channel: string,
    decode: DecodeValues<A>,
    answer: (decoded: A) => Promise<unknown>,
  ): void =>
    ipc.handle(channel, (sender, values) =>
      Option.match(fromApp(sender) ? decode(values) : Option.none(), {
        onNone: () => Promise.reject(new RequestRefused(channel)),
        onSome: answer,
      }),
    )

  return {
    onSend,
    onSignal: (channel, act) =>
      ipc.on(channel, (sender, values) => {
        if (fromApp(sender) && isNoValues(values)) {
          act()
        }
      }),
    onRequest,
    onInvoke: (channel, answer) =>
      onRequest(
        channel,
        values => (isNoValues(values) ? Option.some(values) : Option.none()),
        () => answer(),
      ),
  }
}

/** Tells the page in `contents` that ssh asked something, or withdrew it, encoded as the preload decodes it. */
export const sendSshPrompt = (contents: WebContents, event: unknown): void =>
  contents.send(channels.sshPrompt, event)

/** Hands the page in `contents` an engine port, which the preload passes on as a window message. */
export const sendEnginePort = (
  contents: WebContents,
  port: MessagePortMain,
): void => contents.postMessage(channels.enginePort, null, [port])
