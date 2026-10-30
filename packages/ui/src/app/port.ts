import { Option, Schema } from 'effect'

import { EngineAddress } from '@fabrica/client'

// The renderer's end of the connection process's relay (spec §8.2): main brokers a MessagePort at each
// load of the page and again each time the connection process is started anew, the preload hands it
// to the page with a window message, and the connection process copies the RPC's
// NDJSON frames between it and the engine's transport. The port becomes a `Socket` through the client
// package's MessagePort transport (`portSocket`), so the engine client runs over it as it runs over
// the local socket, every frame decoded with the contracts. A known engine on another host (§9.1) has
// a connection of its own: the page asks main for its port at each attempt, numbering the request, and
// the preload hands it over with a window message carrying that number.

/** The window message's `type` with which the preload hands the page the engine port. */
export const enginePortMessage = 'fabrica:engine-port'

/** Calls `listener` with each engine port a window message hands the page; the function returned stops it. */
export const onEnginePorts = (
  target: Window,
  listener: (port: MessagePort) => void,
): (() => void) => {
  const onMessage = (event: MessageEvent<unknown>) => {
    const [port] = event.ports
    if (
      port !== undefined &&
      typeof event.data === 'object' &&
      event.data !== null &&
      'type' in event.data &&
      event.data.type === enginePortMessage
    ) {
      listener(port)
    }
  }
  target.addEventListener('message', onMessage)
  return () => target.removeEventListener('message', onMessage)
}

/** The window message's `type` with which the preload hands the page a known engine's port. */
export const remoteEnginePortMessage = 'fabrica:remote-engine-port'

/** The page's request for a port to a known engine: its number, which the port's message carries, and the engine's address. */
export const EnginePortRequest = Schema.Struct({
  request: Schema.Int,
  address: EngineAddress,
})
export type EnginePortRequest = typeof EnginePortRequest.Type

const decodeRequestNumber = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal(remoteEnginePortMessage),
    request: Schema.Int,
  }),
)

/**
 * Calls `listener` with each known engine's port a window message hands the page, and the number of
 * the request it answers; the function returned stops it.
 */
export const onRemoteEnginePorts = (
  target: Window,
  listener: (request: number, port: MessagePort) => void,
): (() => void) => {
  const onMessage = (event: MessageEvent<unknown>) => {
    const [port] = event.ports
    if (port !== undefined) {
      Option.map(decodeRequestNumber(event.data), ({ request }) =>
        listener(request, port),
      )
    }
  }
  target.addEventListener('message', onMessage)
  return () => target.removeEventListener('message', onMessage)
}
