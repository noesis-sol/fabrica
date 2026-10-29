import { Context, Effect, Layer, Option, type Scope } from 'effect'
import { Socket } from 'effect/socket'

import {
  SshPrompting,
  type SshPrompts,
  layerSsh,
  layerUnixSocket,
  layerWsl,
  sshFailed,
  wslFailed,
} from '@fabrica/client/node'

import { definedOf } from './env'
import { ConnectionTarget } from './target'

// The connection process's transports (spec §8.2, §9.1, §7.6): how it reaches the engine a target
// names, one new connection (a socket connection, or an `ssh` or `wsl.exe` child) for each connection
// the page opens. Its ssh's prompts (an unknown host's key, a passphrase, a password) are relayed to the
// app through `SSH_ASKPASS`, by a helper the Node main names runs; where main names none (Windows, until
// the app ships a helper of its own), ssh asks nothing (`BatchMode`): it reaches hosts `known_hosts`
// knows with keys ssh-agent holds. A failure trying again won't mend (a changed host key, a refused
// sign-in, no fabrica on the host) is a refusal, which the relay says to the page.

/** A socket to the engine, made anew for each connection the page opens, and closed with its scope. */
export type EngineSocket = Effect.Effect<Socket.Socket, never, Scope.Scope>

/** What the transports take from the connection process's host. */
export interface TransportHost {
  /** The connection process's environment, the user's: ssh's, for their agent and config, and wsl.exe's. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** How ssh's prompts reach the user: none asks nothing. */
  readonly askpass: Option.Option<{
    /** The Node the `SSH_ASKPASS` helper runs on. */
    readonly node: string
    /** Where each connection's private folder for the helper is made. */
    readonly folder: string
    readonly prompts: SshPrompts
  }>
}

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
          prompting: Option.match(host.askpass, {
            onNone: () => SshPrompting.None(),
            onSome: askpass => SshPrompting.Relay(askpass),
          }),
        }),
      ),
    Wsl: ({ distro }) =>
      socketOf(layerWsl({ distro, env: definedOf(host.env) })),
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

/** A connection's failure in words, where it is one trying again won't mend: ssh's or wsl.exe's refusal. */
export const refusalOf = (error: Socket.SocketError): Option.Option<string> =>
  Option.orElse(
    Option.map(
      Option.filter(sshFailed(error), failed => failed.refused),
      failed => failed.message,
    ),
    () =>
      Option.map(
        Option.filter(wslFailed(error), failed => failed.refused),
        failed => failed.message,
      ),
  )
