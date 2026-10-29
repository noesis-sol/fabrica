import { Data, Duration, Effect, Schedule } from 'effect'
import * as Net from 'node:net'
import type { Readable, Writable } from 'node:stream'

// The stdio bridge (spec §8.2, §7.6): `fabrica bridge`, what an SSH or WSL2 client runs on the
// engine's host. It connects to the engine's local socket, starting the engine when none answers
// there, and copies bytes both ways between the socket and its own stdin and stdout, so the RPC runs
// over them as it would over the socket. It ends when the engine closes the connection, or once its
// input has ended and the engine has closed its side.

/** No engine took the bridge's connection, even after one was started. */
export class BridgeFailed extends Data.TaggedError('BridgeFailed')<{
  readonly socket: string
  readonly reason: string
}> {
  override get message() {
    return `couldn't reach the engine at ${this.socket}: ${this.reason}`
  }
}

/** A connection to the socket failed; `noEngine` where no engine serves it: none made it, or its engine has gone. */
class ConnectRefused extends Data.TaggedError('ConnectRefused')<{
  readonly noEngine: boolean
  readonly reason: string
}> {}

export interface BridgeOptions<E> {
  readonly socket: string
  readonly input: Readable
  readonly output: Writable
  /** Starts the engine, detached, when no engine answers at the socket. */
  readonly startEngine: Effect.Effect<void, E>
  /** How long a started engine has to take the connection; 10 seconds when left out. */
  readonly startWait?: Duration.Input
}

/** The codes that mean no engine serves the socket. */
const noEngineCodes: ReadonlySet<string> = new Set(['ENOENT', 'ECONNREFUSED'])

/** Connects to the socket at `path`, failing with whether no engine serves it. */
const connect = (path: string) =>
  Effect.callback<Net.Socket, ConnectRefused>(resume => {
    const socket = Net.createConnection({ path })
    const onError = (error: NodeJS.ErrnoException) =>
      resume(
        Effect.fail(
          new ConnectRefused({
            noEngine: error.code !== undefined && noEngineCodes.has(error.code),
            reason: error.message,
          }),
        ),
      )
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.off('error', onError)
      resume(Effect.succeed(socket))
    })
    return Effect.sync(() => socket.destroy())
  })

/** Connects to the engine's socket, starting the engine and waiting for it where none answers. */
const reachEngine = Effect.fn('Bridge.reachEngine')(function* <E>(
  options: BridgeOptions<E>,
) {
  const failed = (reason: string) =>
    new BridgeFailed({ socket: options.socket, reason })
  const started = options.startEngine.pipe(
    Effect.andThen(
      connect(options.socket).pipe(
        Effect.retry({
          while: error => error.noEngine,
          schedule: Schedule.spaced('50 millis'),
        }),
        Effect.mapError(error => failed(error.reason)),
        Effect.timeoutOrElse({
          duration: options.startWait ?? Duration.seconds(10),
          orElse: () =>
            Effect.fail(
              failed('the engine was started but took no connection'),
            ),
        }),
      ),
    ),
  )
  return yield* connect(options.socket).pipe(
    Effect.catchTag('ConnectRefused', error =>
      error.noEngine ? started : Effect.fail(failed(error.reason)),
    ),
  )
})

/** Copies bytes between the socket and the bridge's input and output until the connection closes. */
const copyBothWays = (
  socket: Net.Socket,
  input: Readable,
  output: Writable,
  path: string,
) =>
  Effect.callback<void, BridgeFailed>(resume => {
    socket.once('error', error =>
      resume(
        Effect.fail(new BridgeFailed({ socket: path, reason: error.message })),
      ),
    )
    socket.once('close', () => resume(Effect.void))
    // The bridge's output outlives it (a process's stdout can't be ended), so it is never ended here.
    socket.pipe(output, { end: false })
    input.pipe(socket)
    return Effect.sync(() => {
      input.unpipe(socket)
      socket.unpipe(output)
      socket.destroy()
    })
  })

/** Runs the bridge until the engine closes the connection. */
export const runBridge = Effect.fn('Bridge.run')(function* <E>(
  options: BridgeOptions<E>,
) {
  const socket = yield* reachEngine(options)
  yield* copyBothWays(socket, options.input, options.output, options.socket)
})
