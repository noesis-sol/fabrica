import { Duration, Effect, Layer, Option, type Scope, Stream } from 'effect'
import { constVoid } from 'effect/Function'
import { RpcMessage } from 'effect/rpc'
import { Socket } from 'effect/socket'
import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { PassThrough, Readable, Writable } from 'node:stream'

import { ndjson } from '@fabrica/contracts'

import { reconnectBackOff } from '../port'

// A bridge (spec §8.2): a child process whose stdin and stdout carry the protocol, the shape the SSH
// and WSL2 bridges take (`ssh <destination> fabrica bridge`, `wsl.exe -d <distro> -- fabrica bridge`),
// each running `fabrica bridge` through `bridgeScript` on its host. Each connection runs the command anew, and the child is stopped as its connection closes; a child
// that exits ends its connection, failing it with the cause its command's `ended` reads from its exit.
//
// A connection opens once the engine is reached (H61), not as the child starts: ssh may first ask for a
// host key's acceptance, a passphrase or a security key's touch, and `fabrica bridge` may start a cold
// engine, or wsl.exe WSL2, and the RPC's pinger fails a connection whose ping goes unanswered for about
// 10 s once it opens. `fabrica bridge` says nothing until spoken to, so the open says the RPC's ping and
// waits for the first byte of the answer (the engine's pong, which the client then reads as the answer
// to a ping of its own); a child that ends first fails the open, with the cause its command's `ended`
// reads from its exit. It waits `reachLimit` at most, the time its command says it waits on a person
// left out.

/**
 * What a bridge runs on its host, by sh: `fabrica bridge`, or the engine's link `~/.local/bin/fabrica`
 * (spec §9.2) where fabrica isn't on the PATH, as on a host whose profile adds `~/.local/bin` but which
 * neither a non-interactive ssh command nor `wsl.exe` reads (Ubuntu's `~/.profile`, Debian's). With
 * neither there, it exits 127, as a shell does for a command it can't find, which both bridges read as
 * their `BridgeMissing`. It holds neither a single quote nor a backslash, so it can be single-quoted.
 */
export const bridgeScript =
  'if command -v fabrica >/dev/null 2>&1; then exec fabrica bridge; fi; ' +
  'if [ -x "$HOME/.local/bin/fabrica" ]; then exec "$HOME/.local/bin/fabrica" bridge; fi; ' +
  'echo fabrica: not found >&2; exit 127'

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
  /**
   * Whether the command waits on a person now (ssh asking for a passphrase, say), then each change of
   * it, its last word holding: the time it does is left out of `reachLimit`. Never, where it isn't given.
   */
  readonly asking?: Stream.Stream<boolean>
}

/**
 * How long a bridge has to reach the engine, from its start or a person's last answer: room for a slow
 * link, a cold engine's start (`fabrica bridge` gives one 10 s) and WSL2's.
 */
export const reachLimit = Duration.seconds(60)

/** Effect's own back-off for a lost bridge: 0.5 s, growing, up to 5 s. */
export const bridgeBackOff = reconnectBackOff

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

/**
 * `readable`'s first bytes, then `readable` as it goes on: the connection's reads once the open has
 * waited for the first. A bridge that ends first fails the open, with the cause its end gave.
 */
const firstBytes = (
  readable: ReadableStream<Uint8Array>,
): Effect.Effect<ReadableStream<Uint8Array>, Socket.SocketError> => {
  const reader = readable.getReader()
  return Effect.tryPromise({
    try: () => reader.read(),
    catch: openFailed,
  }).pipe(
    Effect.flatMap(first =>
      first.done
        ? Effect.fail(
            openFailed(
              new Error('the bridge ended before it reached the engine'),
            ),
          )
        : Effect.succeed(
            new ReadableStream<Uint8Array>({
              start: controller => controller.enqueue(first.value),
              pull: async controller => {
                const { done, value } = await reader.read()
                if (done) {
                  controller.close()
                } else {
                  controller.enqueue(value)
                }
              },
              cancel: reason => reader.cancel(reason),
            }),
          ),
    ),
  )
}

/** The RPC's ping, as its NDJSON frame: what the open says to be answered. */
const ping = (): Uint8Array => {
  const frame = ndjson.makeUnsafe().encode(RpcMessage.constPing)
  return typeof frame === 'string'
    ? new TextEncoder().encode(frame)
    : (frame ?? new Uint8Array())
}

/** Ends once `reachLimit` has passed with nobody asked, the time `asking` says somebody is left out. */
const limitPassed = (asking: Stream.Stream<boolean>): Effect.Effect<void> =>
  asking.pipe(
    Stream.concat(Stream.never),
    Stream.changes,
    Stream.switchMap(now =>
      now ? Stream.never : Stream.fromEffect(Effect.sleep(reachLimit)),
    ),
    Stream.runHead,
    Effect.asVoid,
  )

const unreached = new Socket.SocketError({
  reason: new Socket.SocketOpenError({
    kind: 'Timeout',
    cause: new Error(
      `the bridge reached no engine within ${Duration.format(reachLimit)}`,
    ),
  }),
})

/** A bridge's stdio, its command made anew for each connection, in the connection's scope. */
export const bridgeSocket = (
  open: Effect.Effect<BridgeCommand, Socket.SocketError, Scope.Scope>,
): Effect.Effect<Socket.Socket> =>
  Socket.fromTransformStream(
    Effect.gen(function* () {
      const bridge = yield* open
      const child = yield* runBridge(bridge)
      const reading = firstBytes(readableOf(child, bridge.ended))
      const writable = Writable.toWeb(child.stdin)
      const writer = writable.getWriter()
      // A child that ends before it reads the ping is its first read's to report.
      writer.write(ping()).catch(constVoid)
      writer.releaseLock()
      const readable = yield* Effect.raceFirst(
        reading,
        Effect.andThen(
          limitPassed(bridge.asking ?? Stream.make(false)),
          Effect.fail(unreached),
        ),
      )
      return { readable, writable } satisfies Socket.InputTransformStream
    }),
  )

/** A bridge's stdio: each connection runs the command anew. */
export const layerBridge = (
  bridge: BridgeCommand,
): Layer.Layer<Socket.Socket> =>
  Layer.effect(Socket.Socket, bridgeSocket(Effect.succeed(bridge)))
