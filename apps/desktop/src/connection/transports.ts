import { Context, Effect, Layer, type Scope } from 'effect'
import { Socket } from 'effect/socket'

import { SshPrompting, layerSsh, layerUnixSocket } from '@fabrica/client/node'

import { ConnectionTarget } from './target'

// The connection process's transports (spec §8.2, §9.1): how it reaches the engine a target names, one
// new connection (a socket connection, or an `ssh` child) for each connection the page opens. Its ssh
// asks nothing yet (`BatchMode`): it reaches hosts `known_hosts` knows with keys ssh-agent holds, until
// its prompts are relayed to the app through `SSH_ASKPASS`.

/** A socket to the engine, made anew for each connection the page opens, and closed with its scope. */
export type EngineSocket = Effect.Effect<Socket.Socket, never, Scope.Scope>

/** What the transports take from the connection process's host. */
export interface TransportHost {
  /** The connection process's environment, the user's: ssh's, for their agent and config. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/** `env` less its unset variables. */
const definedOf = (
  env: TransportHost['env'],
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, value]],
    ),
  )

const socketOf = (layer: Layer.Layer<Socket.Socket>): EngineSocket =>
  Effect.map(Layer.build(layer), Context.get(Socket.Socket))

/** The engine's socket for `target`. */
export const engineSocket = (
  target: ConnectionTarget,
  host: TransportHost,
): EngineSocket =>
  ConnectionTarget.match(target, {
    LocalSocket: ({ path }) => socketOf(layerUnixSocket(path)),
    Ssh: ({ destination }) =>
      socketOf(
        layerSsh({
          destination,
          env: definedOf(host.env),
          prompting: SshPrompting.None(),
        }),
      ),
    Unavailable: ({ reason }) =>
      Socket.fromTransformStream(
        Effect.fail(
          new Socket.SocketError({
            reason: new Socket.SocketOpenError({
              kind: 'Unknown',
              cause: new Error(reason),
            }),
          }),
        ),
      ),
  })
