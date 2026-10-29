// The renderer's end of the connection process's relay (spec §8.2): main brokers a MessagePort at each
// load of the page and again each time the connection process is started anew, the preload hands it
// to the page with a window message, and the connection process copies the RPC's
// NDJSON frames between it and the engine's transport. The port becomes a `Socket` through the client
// package's MessagePort transport (`portSocket`), so the engine client runs over it as it runs over
// the local socket, every frame decoded with the contracts.

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
