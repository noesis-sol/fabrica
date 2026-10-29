import { Context, Effect, Layer, Queue } from 'effect'
import { NetAddress } from 'effect/net'
import { Socket, SocketServer } from 'effect/socket'

// The in-memory transport: a client's `Socket` and an engine's `SocketServer` joined in one process,
// with nothing but web streams between them, so the whole RPC path (NDJSON frames, the socket
// protocol, its reconnects) runs as it does over the local socket, in tests and in the browser alike.
// Each open of the client's socket is a new connection the server's handler gets; `drop` cuts every
// open connection, as a dead link does, and the client reconnects.

/** One direction of a connection, which `cut` errors at both ends. */
const pipe = () => {
  const controllers: Array<TransformStreamDefaultController<Uint8Array>> = []
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    start: controller => {
      controllers.push(controller)
    },
  })
  const cut = () => {
    for (const controller of controllers) {
      controller.error(new Error('connection dropped'))
    }
  }
  return { stream, cut }
}

export interface MemoryTransportShape {
  /** Cuts every open connection: each end's next read fails, and the client reconnects. */
  readonly drop: Effect.Effect<void>
  /** The connections opened so far. */
  readonly opened: Effect.Effect<number>
}

/** The in-memory transport's controls. */
export class MemoryTransport extends Context.Service<
  MemoryTransport,
  MemoryTransportShape
>()('@fabrica/client/MemoryTransport') {}

/** The in-memory transport: the client's `Socket`, the engine's `SocketServer` and their controls. */
export const layerMemory: Layer.Layer<
  MemoryTransport | Socket.Socket | SocketServer.SocketServer
> = Layer.effectContext(
  Effect.gen(function* () {
    const incoming = yield* Queue.unbounded<Socket.Socket>()
    const live = new Set<() => void>()
    let opened = 0

    const open = Effect.gen(function* () {
      const up = pipe()
      const down = pipe()
      const cut = () => {
        up.cut()
        down.cut()
      }
      live.add(cut)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          live.delete(cut)
          cut()
        }),
      )
      const engineEnd = yield* Socket.fromTransformStream(
        Effect.succeed({
          readable: up.stream.readable,
          writable: down.stream.writable,
        }),
      )
      opened += 1
      yield* Queue.offer(incoming, engineEnd)
      return { readable: down.stream.readable, writable: up.stream.writable }
    })

    const socket = yield* Socket.fromTransformStream(open)
    const server = SocketServer.SocketServer.of({
      address: NetAddress.unixPathAddress('fabrica-memory'),
      run: handler =>
        Effect.forever(
          Effect.flatMap(Queue.take(incoming), engineEnd =>
            Effect.forkScoped(Effect.ignoreCause(handler(engineEnd))),
          ),
        ).pipe(Effect.scoped),
    })
    const transport = MemoryTransport.of({
      drop: Effect.sync(() => {
        for (const cut of live) {
          cut()
        }
      }),
      opened: Effect.sync(() => opened),
    })
    return Context.make(MemoryTransport, transport).pipe(
      Context.add(Socket.Socket, socket),
      Context.add(SocketServer.SocketServer, server),
    )
  }),
)
