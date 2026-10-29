import { Layer } from 'effect'
import { Socket } from 'effect/socket'

import { NodeSocket } from '@effect/platform-node'

// The Node transports (spec §8.2): the engine's local socket, a child process's stdio (`transports/
// bridge.ts`), and the SSH stdio bridge over it (`transports/ssh.ts`); the WSL2 bridge joins them in its
// own module. Each is a `Socket` whose every open is a new connection: a new socket connection, or a new
// child, ended as the connection closes. A child that exits ends its connection, and the client
// reconnects by running the command again.

export * from './transports/bridge'
export * from './transports/ssh'

/** The engine's local socket at `path`. */
export const layerUnixSocket = (path: string): Layer.Layer<Socket.Socket> =>
  Layer.effect(Socket.Socket, NodeSocket.makeNet({ path }))
