import { Effect, Layer, Option, Schedule, type Scope } from 'effect'
import { Socket } from 'effect/socket'
import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { PassThrough, Readable, Writable } from 'node:stream'

// A bridge (spec §8.2): a child process whose stdin and stdout carry the protocol, the shape the SSH
// and WSL2 bridges take (`ssh <destination> fabrica bridge`, `wsl.exe -d <distro> -- fabrica bridge`).
// Each connection runs the command anew, and the child is stopped as its connection closes; a child
// that exits ends its connection, failing it with the cause its command's `ended` reads from its exit.

/** How a bridge ended: its exit code or the signal that stopped it, and the end of its stderr. */
export interface BridgeEnd {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
}

/** A command whose stdin and stdout carry the protocol: a bridge to an engine. */
export interface BridgeCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
  /** The command's whole environment: nothing is inherited. */
  readonly env: Readonly<Record<string, string>>
  /**
   * What the bridge's end says: the cause its connection fails with, or none for a connection that
   * just closed. Where it is given, the bridge's stderr is kept for it, its last `stderrTailBytes`;
   * where it isn't, the bridge's stderr is the client's own.
   */
  readonly ended?: (end: BridgeEnd) => Option.Option<Error>
}

/** Effect's own back-off for a lost bridge: 0.5 s, growing, up to 5 s. */
export const bridgeBackOff = Schedule.min([
  Schedule.exponential(500, 1.5),
  Schedule.spaced(5000),
])

/** How much of a bridge's stderr is kept for its `ended`. */
export const stderrTailBytes = 16 * 1024

type Bridge = ChildProcessByStdio<Writable, Readable, Readable | null>

const openFailed = (cause: unknown) =>
  new Socket.SocketError({
    reason: new Socket.SocketOpenError({ kind: 'Unknown', cause }),
  })

/** Runs the bridge; it is stopped as its connection closes. */
const runBridge = (bridge: BridgeCommand) =>
  Effect.acquireRelease(
    Effect.callback<Bridge, Socket.SocketError>(resume => {
      const child: Bridge =
        bridge.ended === undefined
          ? spawn(bridge.command, [...bridge.args], {
              env: bridge.env,
              stdio: ['pipe', 'pipe', 'inherit'],
            })
          : spawn(bridge.command, [...bridge.args], {
              env: bridge.env,
              stdio: ['pipe', 'pipe', 'pipe'],
            })
      // A command that can't start reports an error and no spawn; a later error is its streams'.
      let started = false
      child.on('error', cause => {
        if (!started) {
          started = true
          resume(Effect.fail(openFailed(cause)))
        }
      })
      child.once('spawn', () => {
        if (!started) {
          started = true
          resume(Effect.succeed(child))
        }
      })
    }),
    child =>
      Effect.sync(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM')
        }
      }),
  )

/** The last `stderrTailBytes` of `stream`, as it is when asked. */
const keepTail = (stream: Readable) => {
  let tail = Buffer.alloc(0)
  stream.on('data', (chunk: Buffer) => {
    const joined = Buffer.concat([tail, chunk])
    tail = joined.subarray(Math.max(0, joined.length - stderrTailBytes))
  })
  return () => tail.toString('utf8')
}

/**
 * `stream` as a web stream, typed as the global `ReadableStream`, which `Readable.toWeb`'s is in Node:
 * `node:stream/web`'s type isn't the DOM lib's, which the app's main is checked with.
 */
const webReadable = (stream: Readable): ReadableStream<Uint8Array> => {
  const web = Readable.toWeb(stream)
  if (web instanceof ReadableStream) {
    return web
  }
  throw new TypeError("Node's Readable.toWeb gave no ReadableStream")
}

/**
 * The bridge's stdout, which ends as the bridge does: once its stdout has ended and it has exited, an
 * end `ended` gives a cause for fails the stream with that cause, so the connection fails with it.
 */
const readableOf = (child: Bridge, ended: BridgeCommand['ended']) => {
  if (ended === undefined || child.stderr === null) {
    return webReadable(child.stdout)
  }
  const stderr = keepTail(child.stderr)
  const exited = new Promise<BridgeEnd>(resolve =>
    child.once('close', (code, signal) =>
      resolve({ code, signal, stderr: stderr() }),
    ),
  )
  const out = new PassThrough()
  child.stdout.pipe(out, { end: false })
  child.stdout.once('end', () => {
    void exited.then(end =>
      Option.match(ended(end), {
        onNone: () => out.end(),
        onSome: cause => out.destroy(cause),
      }),
    )
  })
  return webReadable(out)
}

/** A bridge's stdio, its command made anew for each connection, in the connection's scope. */
export const bridgeSocket = (
  open: Effect.Effect<BridgeCommand, Socket.SocketError, Scope.Scope>,
): Effect.Effect<Socket.Socket> =>
  Socket.fromTransformStream(
    Effect.flatMap(open, bridge =>
      Effect.map(runBridge(bridge), (child): Socket.InputTransformStream => ({
        readable: readableOf(child, bridge.ended),
        writable: Writable.toWeb(child.stdin),
      })),
    ),
  )

/** A bridge's stdio: each connection runs the command anew. */
export const layerBridge = (
  bridge: BridgeCommand,
): Layer.Layer<Socket.Socket> =>
  Layer.effect(Socket.Socket, bridgeSocket(Effect.succeed(bridge)))
