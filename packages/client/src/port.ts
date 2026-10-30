import {
  type Cause,
  Data,
  Effect,
  Exit,
  Option,
  Predicate,
  Queue,
  Schedule,
  Schema,
  Stream,
} from 'effect'
import { NetAddress } from 'effect/net'
import type { RpcClientError } from 'effect/rpc'
import { Socket, SocketServer } from 'effect/socket'

// The MessagePort transport (spec §8.2): in the app, the page's engine client and the connection
// process's relay share a port, which main brokers at each load of the page and again when the
// connection process starts anew, the page taking the newest. The page's end is a `Socket`, the relay's
// a `SocketServer`, so the RPC runs over the port as it does over the local socket. The RPC's NDJSON
// frames cross as they are, bytes or text; beside them a few signals, each naming the connection it
// is about: the page opens a connection and closes it; the relay says it took one, whose frames
// follow, and that one ended, or was refused (ssh refused the engine's host, say) in a way another
// connection wouldn't mend, which the page's client stops reconnecting at. Each open of the page's socket is a new connection, so a connection the
// engine dropped reaches the page's client, which reconnects and resumes its streams as over any
// other transport; and a connection never reads frames its predecessor was sent.

/** What the page says on the port: it opens connection `connection`, or closes it. */
export const PageSignal = Schema.TaggedUnion({
  Open: { connection: Schema.Int },
  Close: { connection: Schema.Int },
})
export type PageSignal = typeof PageSignal.Type

/**
 * What the relay says on the port: it took connection `connection`, whose frames follow; or that
 * connection ended, or was refused, in `reason`'s words.
 */
export const RelaySignal = Schema.TaggedUnion({
  Opened: { connection: Schema.Int },
  Closed: { connection: Schema.Int },
  Refused: { connection: Schema.Int, reason: Schema.String },
})
export type RelaySignal = typeof RelaySignal.Type

/**
 * A connection the relay's engine refused, in a way trying again would end the same: the failure a
 * relay's handler ends with to say so, and the cause of the page's socket error for it.
 */
export class ConnectionRefused extends Data.TaggedError('ConnectionRefused')<{
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

/** The ConnectionRefused a connection's error carries, if the relay refused it. */
export const connectionRefused = (
  error: Socket.SocketError | RpcClientError.RpcClientError,
): Option.Option<ConnectionRefused> => {
  const { reason } = error
  return Predicate.hasProperty(reason, 'cause') &&
    reason.cause instanceof ConnectionRefused
    ? Option.some(reason.cause)
    : Option.none()
}

/** Effect's own back-off between reconnects, the client's unless it is given another. */
export const reconnectBackOff = Schedule.min([
  Schedule.exponential(500, 1.5),
  Schedule.spaced(5000),
])

/** The page's reconnect schedule over the port: `base` until the relay refuses a connection. */
export const portReconnect = (
  base: Schedule.Schedule<unknown, Socket.SocketError> = reconnectBackOff,
): Schedule.Schedule<unknown, Socket.SocketError> =>
  Schedule.while(base, ({ input }) => Option.isNone(connectionRefused(input)))

const decodePageSignal = Schema.decodeUnknownOption(PageSignal)
const decodeRelaySignal = Schema.decodeUnknownOption(RelaySignal)

/** One end of a message port, as its runtime has it: a web `MessagePort` (the page's, Node's) or Electron's `MessagePortMain`. */
export interface PortEnd {
  readonly post: (message: unknown) => void
  /**
   * Calls `onMessage` with each message's data from now on, and `onClose` once the port has closed;
   * the function returned stops both.
   */
  readonly listen: (listener: {
    readonly onMessage: (data: unknown) => void
    readonly onClose: () => void
  }) => () => void
}

/** A web `MessagePort`, as much of it as the transport uses. */
export interface WebMessagePort {
  postMessage(message: unknown): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void
  addEventListener(type: 'close', listener: () => void): void
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void
  removeEventListener(type: 'close', listener: () => void): void
  start(): void
}

/** A web `MessagePort` as a `PortEnd`. */
export const webPortEnd = (port: WebMessagePort): PortEnd => ({
  post: message => port.postMessage(message),
  listen: ({ onMessage, onClose }) => {
    const message = (event: MessageEvent) => onMessage(event.data)
    port.addEventListener('message', message)
    port.addEventListener('close', onClose)
    port.start()
    return () => {
      port.removeEventListener('message', message)
      port.removeEventListener('close', onClose)
    }
  },
})

/** Waits until `port` has closed. */
export const portClosed = (port: PortEnd): Effect.Effect<void> =>
  Effect.callback<void>(resume => {
    const stop = port.listen({
      onMessage: () => {},
      onClose: () => resume(Effect.void),
    })
    return Effect.sync(stop)
  })

type Frame = Uint8Array | string

/** A frame as the port carries it: bytes or text. */
const frameOf = (data: unknown): Option.Option<Frame> =>
  data instanceof Uint8Array || typeof data === 'string'
    ? Option.some(data)
    : data instanceof ArrayBuffer
      ? Option.some(new Uint8Array(data))
      : Option.none()

/** A connection's incoming frames: a stream to read them from, fed until it is ended or its reader cancels it. */
const inbox = () => {
  let ended = false
  const feed = {
    push: (_frame: Frame) => {},
    end: () => {},
    fail: (_error: ConnectionRefused) => {},
  }
  // A stream's start runs as it is made, so `feed` holds its controller's ends from here on.
  const readable = new ReadableStream<Frame>({
    start: controller => {
      feed.push = frame => {
        if (!ended) {
          controller.enqueue(frame)
        }
      }
      feed.end = () => {
        if (!ended) {
          ended = true
          controller.close()
        }
      }
      feed.fail = error => {
        if (!ended) {
          ended = true
          controller.error(error)
        }
      }
    },
    // A stream its reader cancelled is closed already.
    cancel: () => {
      ended = true
    },
  })
  return { readable, push: feed.push, end: feed.end, fail: feed.fail }
}

/**
 * The page's end: each open is a new connection, whose frames are read from the relay's `Opened` for
 * it until its `Closed` (or the port's closing), and written to the port; a `Refused` fails its reads
 * with the relay's ConnectionRefused. Closing the open tells the relay. The port itself stays open: it is the page's for its life.
 */
export const portSocket = (port: PortEnd): Effect.Effect<Socket.Socket> => {
  let opened = 0
  return Socket.fromTransformStream(
    Effect.gen(function* () {
      opened += 1
      const connection = opened
      const frames = inbox()
      let taken = false
      const stop = port.listen({
        onMessage: data =>
          Option.match(decodeRelaySignal(data), {
            onSome: RelaySignal.match({
              Opened: signal => {
                taken = taken || signal.connection === connection
              },
              Closed: signal => {
                if (signal.connection === connection) {
                  frames.end()
                }
              },
              Refused: signal => {
                if (signal.connection === connection) {
                  frames.fail(new ConnectionRefused({ reason: signal.reason }))
                }
              },
            }),
            onNone: () => {
              if (taken) {
                Option.map(frameOf(data), frames.push)
              }
            },
          }),
        onClose: frames.end,
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stop()
          frames.end()
          port.post(PageSignal.cases.Close.make({ connection }))
        }),
      )
      port.post(PageSignal.cases.Open.make({ connection }))
      return {
        readable: frames.readable,
        writable: new WritableStream<Uint8Array>({
          write: chunk => port.post(chunk),
        }),
      }
    }),
  )
}

/** What the relay's end reads from the port, in the order it came. */
type Arrival = Data.TaggedEnum<{
  Signal: { readonly signal: PageSignal }
  Frame: { readonly frame: Frame }
}>
const Arrival = Data.taggedEnum<Arrival>()

/** A connection the relay took: its frames' inbox, fed and posted to while the page keeps it. */
interface Taken {
  readonly connection: number
  readonly frames: ReturnType<typeof inbox>
  live: boolean
}

/** The page no longer keeps `taken`: nothing more is posted for it, and its reads end. */
const release = (taken: Taken): void => {
  taken.live = false
  taken.frames.end()
}

/**
 * The relay's end: each connection the page opens is a `Socket` the handler gets, its frames the
 * page's, its writes posted to the page while the page keeps it. A connection the page closes, or
 * replaces with a new one, ends its socket's reads; one whose handler ends is `Closed` to the page,
 * or `Refused` where the handler failed with a ConnectionRefused.
 * Once the port has closed, every connection's reads end and `run` waits on (`portClosed` says when).
 */
export const portServer = (
  port: PortEnd,
): SocketServer.SocketServer['Service'] =>
  SocketServer.SocketServer.of({
    address: NetAddress.unixPathAddress('fabrica-port'),
    run: handler =>
      Effect.gen(function* () {
        const arrivals = yield* Queue.unbounded<Arrival, Cause.Done>()
        const stop = port.listen({
          onMessage: data =>
            Option.match(decodePageSignal(data), {
              onSome: signal =>
                Queue.offerUnsafe(arrivals, Arrival.Signal({ signal })),
              onNone: () =>
                Option.map(frameOf(data), frame =>
                  Queue.offerUnsafe(arrivals, Arrival.Frame({ frame })),
                ),
            }),
          onClose: () => Queue.endUnsafe(arrivals),
        })
        yield* Effect.addFinalizer(() => Effect.sync(stop))

        let current: Option.Option<Taken> = Option.none()
        const open = Effect.fn('PortServer.open')(function* (
          connection: number,
        ) {
          Option.map(current, release)
          const taken: Taken = { connection, frames: inbox(), live: true }
          current = Option.some(taken)
          const socket = yield* Socket.fromTransformStream(
            Effect.succeed({
              readable: taken.frames.readable,
              writable: new WritableStream<Uint8Array>({
                write: chunk => {
                  if (taken.live) {
                    port.post(chunk)
                  }
                },
              }),
            }),
          )
          port.post(RelaySignal.cases.Opened.make({ connection }))
          yield* handler(socket).pipe(
            Effect.onExit(exit =>
              Effect.sync(() => {
                if (taken.live) {
                  release(taken)
                  port.post(
                    Option.match(
                      Option.filter(
                        Exit.findErrorOption(exit),
                        error => error instanceof ConnectionRefused,
                      ),
                      {
                        onNone: () =>
                          RelaySignal.cases.Closed.make({ connection }),
                        onSome: ({ reason }) =>
                          RelaySignal.cases.Refused.make({
                            connection,
                            reason,
                          }),
                      },
                    ),
                  )
                }
              }),
            ),
            Effect.ignoreCause,
            Effect.forkScoped,
          )
        })
        const arrive = Arrival.$match({
          Signal: ({ signal }) =>
            PageSignal.match(signal, {
              Open: ({ connection }) => open(connection),
              Close: ({ connection }) =>
                Effect.sync(() =>
                  Option.map(
                    Option.filter(
                      current,
                      taken => taken.connection === connection,
                    ),
                    release,
                  ),
                ),
            }),
          Frame: ({ frame }) =>
            Effect.sync(() =>
              Option.map(
                Option.filter(current, taken => taken.live),
                taken => taken.frames.push(frame),
              ),
            ),
        })
        yield* Stream.runForEach(Stream.fromQueue(arrivals), arrive)
        Option.map(current, release)
        return yield* Effect.never
      }).pipe(Effect.scoped),
  })
