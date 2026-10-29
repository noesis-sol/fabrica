import { Effect, Layer } from 'effect'
import { Socket } from 'effect/socket'
import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

import { NodeSocket } from '@effect/platform-node'

// The Node transports (spec §8.2): the engine's local socket, and a child process's stdio, the shape
// the SSH and WSL2 bridges take (`ssh <destination> fabrica bridge`, `wsl.exe -d <distro> -- fabrica
// bridge`), whose commands their own tickets give. Each is a `Socket` whose every open is a new
// connection: a new socket connection, or a new child, ended as the connection closes. A child that
// exits ends its connection, and the client reconnects by running the command again.

/** The engine's local socket at `path`. */
export const layerUnixSocket = (path: string): Layer.Layer<Socket.Socket> =>
  Layer.effect(Socket.Socket, NodeSocket.makeNet({ path }))

/** A command whose stdin and stdout carry the protocol: a bridge to an engine. */
export interface BridgeCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
  /** The command's whole environment: nothing is inherited. */
  readonly env: Readonly<Record<string, string>>
}

type Bridge = ChildProcessByStdio<Writable, Readable, null>

const openFailed = (cause: unknown) =>
  new Socket.SocketError({
    reason: new Socket.SocketOpenError({ kind: 'Unknown', cause }),
  })

/** Runs the bridge, its stderr the client's own; it is stopped as its connection closes. */
const runBridge = (bridge: BridgeCommand) =>
  Effect.acquireRelease(
    Effect.callback<Bridge, Socket.SocketError>(resume => {
      const child = spawn(bridge.command, [...bridge.args], {
        env: bridge.env,
        stdio: ['pipe', 'pipe', 'inherit'],
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

/** A bridge's stdio: each connection runs the command anew. */
export const layerBridge = (
  bridge: BridgeCommand,
): Layer.Layer<Socket.Socket> =>
  Layer.effect(
    Socket.Socket,
    Socket.fromTransformStream(
      Effect.map(runBridge(bridge), child => ({
        readable: Readable.toWeb(child.stdout),
        writable: Writable.toWeb(child.stdin),
      })),
    ),
  )
