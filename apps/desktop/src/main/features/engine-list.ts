import { Effect, Option, Schema } from 'effect'
import type { MessagePortMain, WebContents } from 'electron'

import {
  type KeepAnswer,
  KnownEngine,
  type KnownEnginesAnswer,
} from '@fabrica/client'
import { EnginePortRequest } from '@fabrica/ui/port'

import { channels } from '../../preload/api'
import type { MainContext } from '../context'
import type { IpcRegistrar } from '../ipc'
import { knownEnginesOf } from '../known-engines'

// The engines the app knows (spec §9.1), as the page asks for them: read from the app's state, one
// kept there, and a port to each, relayed to its target through the connection process and handed
// back with the number of the page's request.

/** What main does with the app's known engines. */
export interface EngineListActions {
  /** The engines the app knows, from its state (§9.1). */
  readonly knownEngines: () => Promise<KnownEnginesAnswer>
  /** Keeps an engine among the app's known engines. */
  readonly keepEngine: (engine: KnownEngine) => Promise<KeepAnswer>
  /** Relays a port to a known engine, handed to the page with the number of its request. */
  readonly connectEngine: (request: EnginePortRequest) => void
}

const decodeKeep = Schema.decodeUnknownOption(Schema.Tuple([KnownEngine]))
const decodePortRequest = Schema.decodeUnknownOption(
  Schema.Tuple([EnginePortRequest]),
)

/** Registers the known engines' channels on `ipc`, answered by `actions`. */
export const engineListChannels = (
  ipc: IpcRegistrar,
  actions: EngineListActions,
): void => {
  ipc.onSend(channels.connectEngine, decodePortRequest, ([request]) =>
    actions.connectEngine(request),
  )
  ipc.onInvoke(channels.knownEngines, actions.knownEngines)
  ipc.onRequest(channels.keepEngine, decodeKeep, ([engine]) =>
    actions.keepEngine(engine),
  )
}

/** Hands the page in `contents` a port to a known engine, with the number of the request it answers. */
export const sendRemoteEnginePort = (
  contents: WebContents,
  {
    request,
    port,
  }: { readonly request: number; readonly port: MessagePortMain },
): void => contents.postMessage(channels.remoteEnginePort, { request }, [port])

/** Registers the known engines on `ipc`, from the app's state and its pairings, through the broker. */
export const registerEngineList = (
  ipc: IpcRegistrar,
  { appState, pairings, broker, target, appWindow }: MainContext,
): void =>
  engineListChannels(ipc, {
    knownEngines: () => Effect.runPromise(knownEnginesOf(appState)),
    keepEngine: engine => Effect.runPromise(pairings.keep(engine)),
    connectEngine: ({ request, address }) => {
      void Effect.runPromise(pairings.target(address, target)).then(to =>
        Option.map(Option.fromUndefinedOr(appWindow.current()), window =>
          broker.connect(to, port =>
            sendRemoteEnginePort(window.webContents, { request, port }),
          ),
        ),
      )
    },
  })
