import {
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Predicate,
  type Scope,
} from 'effect'
import { Socket } from 'effect/socket'

import { ConnectionFailed, ConnectionRefused } from '@fabrica/client'
import {
  SshPrompting,
  type SshPrompts,
  layerSsh,
  layerTls,
  layerUnixSocket,
  layerWsl,
  sshFailed,
  tlsRefused,
  wslFailed,
} from '@fabrica/client/node'

import { definedOf } from './env'
import { LocalEngineReach } from './local-engine'
import type { Said } from './relay'
import { ConnectionTarget } from './target'

// The connection process's transports (spec §8.2, §9.1, §7.6): how it reaches the engine a target
// names, one new connection (a socket connection, or an `ssh` or `wsl.exe` child) for each connection
// the page opens. Before each connection to the local socket main is asked to make sure the engine
// answers there, starting it where none does (§7.1); why it couldn't is said to the page, whose client
// tries again later. Over TLS, a WebSocket to the engine's listener, its certificate checked against the
// fingerprint pinned at pairing and its token presented. Its ssh's prompts (an unknown host's key, a passphrase, a password) are relayed to the
// app through `SSH_ASKPASS`, by a helper the Node main names runs; where main names none (Windows, until
// the app ships a helper of its own), ssh asks nothing (`BatchMode`): it reaches hosts `known_hosts`
// knows with keys ssh-agent holds. A failure trying again won't mend (a changed host key, a refused
// sign-in, no fabrica on the host, a TLS engine's changed certificate or refused token) is a refusal,
// which the relay says to the page.

/** A socket to the engine, made anew for each connection the page opens, and closed with its scope. */
export type EngineSocket = Effect.Effect<Socket.Socket, never, Scope.Scope>

/** What the transports take from the connection process's host. */
export interface TransportHost {
  /** The connection process's environment, the user's: ssh's, for their agent and config, and wsl.exe's. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Asks main to make sure the local engine answers, starting it where none does. */
  readonly localEngine: Effect.Effect<LocalEngineReach>
  /** How ssh's prompts reach the user: none asks nothing. */
  readonly askpass: Option.Option<{
    /** The Node the `SSH_ASKPASS` helper runs on. */
    readonly node: string
    /** Where each connection's private folder for the helper is made. */
    readonly folder: string
    readonly prompts: SshPrompts
  }>
}

/** A target main refused: no connection is tried. */
class TargetRefused extends Data.TaggedError('TargetRefused')<{
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

/** The local engine couldn't be started: no connection is tried. */
class LocalEngineDown extends Data.TaggedError('LocalEngineDown')<{
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

/** A socket whose every open fails with `cause`. */
const failing = (cause: Error): EngineSocket =>
  Socket.fromTransformStream(
    Effect.fail(
      new Socket.SocketError({
        reason: new Socket.SocketOpenError({ kind: 'Unknown', cause }),
      }),
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
    LocalSocket: ({ path }) =>
      Effect.flatMap(
        host.localEngine,
        LocalEngineReach.match({
          Reached: () => socketOf(layerUnixSocket(path)),
          Failed: ({ reason }) => failing(new LocalEngineDown({ reason })),
        }),
      ),
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
    Tls: engine => socketOf(layerTls(engine)),
    Unavailable: ({ reason }) => failing(new Error(reason)),
    Refused: ({ reason }) => failing(new TargetRefused({ reason })),
  })

/** The cause a connection's error carries, where it is one of main's: a refused target, a local engine down. */
const mainsCause = <Cause>(
  error: Socket.SocketError,
  is: (cause: unknown) => cause is Cause,
): Option.Option<Cause> => {
  const { reason } = error
  return Predicate.hasProperty(reason, 'cause') && is(reason.cause)
    ? Option.some(reason.cause)
    : Option.none()
}

/**
 * A connection's failure in words, where it is one trying again won't mend: ssh's or wsl.exe's
 * refusal, a TLS engine's (its certificate changed since pairing, its token refused), or main's.
 */
export const refusalOf = (error: Socket.SocketError): Option.Option<string> =>
  Option.firstSomeOf([
    Option.map(
      Option.filter(sshFailed(error), failed => failed.refused),
      failed => failed.message,
    ),
    Option.map(
      Option.filter(wslFailed(error), failed => failed.refused),
      failed => failed.message,
    ),
    Option.map(tlsRefused(error), refused => refused.message),
    Option.map(
      mainsCause(error, cause => cause instanceof TargetRefused),
      refused => refused.reason,
    ),
  ])

/**
 * What the relay says of a connection's failure: a refusal (`refusalOf`), or why the local engine
 * couldn't be started, which a later connection may mend; nothing for any other.
 */
export const saidOf: Said = error =>
  Option.firstSomeOf([
    Option.map(refusalOf(error), reason => new ConnectionRefused({ reason })),
    Option.map(
      mainsCause(error, cause => cause instanceof LocalEngineDown),
      ({ reason }) => new ConnectionFailed({ reason }),
    ),
  ])
