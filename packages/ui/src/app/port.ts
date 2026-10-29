import { Effect } from 'effect'
import { Socket } from 'effect/socket'

// The renderer's end of the connection process's relay (spec §8.2): main brokers a MessagePort once,
// the preload hands it to the page with a window message, and the connection process copies the RPC's
// NDJSON frames between it and the engine's transport. Here the port becomes a `Socket`, so the
// engine client runs over it as it runs over the local socket, every frame decoded with the contracts.

/** The window message's `type` with which the preload hands the page the engine port. */
export const enginePortMessage = 'fabrica:engine-port'

/** The engine port, from the first window message that carries it. */
export const receiveEnginePort = (target: Window): Promise<MessagePort> =>
  new Promise(resolve => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const [port] = event.ports
      if (
        port !== undefined &&
        typeof event.data === 'object' &&
        event.data !== null &&
        'type' in event.data &&
        event.data.type === enginePortMessage
      ) {
        target.removeEventListener('message', onMessage)
        resolve(port)
      }
    }
    target.addEventListener('message', onMessage)
  })

const encoder = new TextEncoder()

/** A frame from the relay as bytes: it sends them as bytes or as text. */
const frameBytes = (data: unknown): Uint8Array | undefined => {
  if (data instanceof Uint8Array) {
    return data
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  if (typeof data === 'string') {
    return encoder.encode(data)
  }
  return undefined
}

/**
 * `port` as a `Socket`: each open reads the frames arriving on it from then and writes to it, and
 * stops reading as the open's scope closes. The port itself stays open: it is the page's for its life.
 */
export const portSocket = (port: MessagePort): Effect.Effect<Socket.Socket> =>
  Socket.fromTransformStream(
    Effect.gen(function* () {
      const stop = () => {
        port.onmessage = null
      }
      const readable = new ReadableStream<Uint8Array>({
        start: controller => {
          port.onmessage = event => {
            const bytes = frameBytes(event.data)
            if (bytes !== undefined) {
              controller.enqueue(bytes)
            }
          }
          port.start()
        },
        cancel: stop,
      })
      const writable = new WritableStream<Uint8Array>({
        write: chunk => {
          port.postMessage(chunk)
        },
      })
      yield* Effect.addFinalizer(() => Effect.sync(stop))
      return { readable, writable }
    }),
  )
