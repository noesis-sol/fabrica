import {
  Data,
  Duration,
  Effect,
  Option,
  Schema,
} from 'effect'
import { RpcClientError } from 'effect/rpc'
import { Socket } from 'effect/socket'
import { ManagedResource } from 'foldkit'
import { defineTaggedUnion } from 'foldkit/schema'

import {
  type ClientOptions,
  type EngineClientShape,
  Link,
  clientErrorWords,
  connectionRefused,
  isDefect,
  make as makeClient,
  portReconnect,
  portSocket,
  webPortEnd,
} from '@fabrica/client'
import {
  EngineId,
  ProtocolVersion,
  ReleaseVersion,
  UpdateSide,
  VersionMismatch,
} from '@fabrica/contracts'

// The connection to the engine (spec §8.2, §18.1): a ManagedResource, the engine client over the
// connection process's MessagePort, held while the Model wants it. Its first hello says whether the
// engine takes the app; after that the client's link, Up, Down while it reconnects, Lost where it has
// stopped reconnecting, or Refused by an engine that was updated meanwhile, comes in as Messages
// through a subscription. An attempt that fails is tried again after a pause; a refused one waits for
// an update, since retrying can't help; one the connection process refused (ssh refused the engine's
// host: its key changed, the sign-in failed) stops, saying why, until the user tries again. The
// client's reconnects stop at such a refusal too, and the attempt after says it.

/** The connection, as the app shows it. */
export const Connection = defineTaggedUnion({
  /** Acquiring the client: waiting for the port, then for the engine's hello. */
  Connecting: {},
  /** The engine took the app's hello. */
  Up: { engine: EngineId, release: ReleaseVersion, protocol: ProtocolVersion },
  /** The link was lost; the client is reconnecting. */
  Down: {},
  /** The engine couldn't be reached; another attempt follows. */
  Failed: { reason: Schema.String },
  /** The connection was refused in a way trying again won't mend: tried again when the user asks. */
  Stopped: { reason: Schema.String },
  /** The app and the engine share no protocol version: `update` names the one to update. */
  Refused: {
    client: ProtocolVersion,
    engine: ProtocolVersion,
    update: UpdateSide,
  },
})
export type Connection = typeof Connection.Type

/** Whether the client is held: its requests and streams may be called. */
export const isLive = (connection: Connection): boolean =>
  Connection.match(connection, {
    Connecting: () => false,
    Up: () => true,
    Down: () => true,
    Failed: () => false,
    Stopped: () => false,
    Refused: () => false,
  })

/** How the app names itself in its hello. */
export const clientName = 'Fabrica'

/** How long a failed attempt waits before the next. */
export const retryAfter = Duration.seconds(2)

/** The client the resource holds, with the hello its engine answered first. */
export interface EngineSession {
  readonly client: EngineClientShape
  readonly hello: {
    readonly engine: EngineId
    readonly release: ReleaseVersion
    readonly protocol: ProtocolVersion
  }
}

/** The client's first link wasn't up, which `make` rules out: kept typed rather than assumed. */
export class NotLinked extends Data.TaggedError('NotLinked')<{}> {}

/** What the connection needs from its host: the port, once the preload has handed it over, and the hello's facts. */
export interface ConnectionEnvironment {
  readonly enginePort: Effect.Effect<MessagePort>
  readonly client: ClientOptions
}

/** The engine client over the port, its first hello said; closed with the resource's scope. */
export const connect = Effect.fn('EngineConnection.connect')(function* (
  environment: ConnectionEnvironment,
) {
  const port = yield* environment.enginePort
  const socket = yield* portSocket(webPortEnd(port))
  const client = yield* makeClient({
    reconnect: portReconnect(),
    ...environment.client,
  }).pipe(Effect.provideService(Socket.Socket, socket))
  const link = yield* client.link
  return yield* Link.$match(link, {
    Up: ({ hello }): Effect.Effect<EngineSession, NotLinked> =>
      Effect.succeed({
        client,
        hello: {
          engine: hello.engine,
          release: hello.release,
          protocol: hello.protocol,
        },
      }),
    Down: () => Effect.fail(new NotLinked()),
    Lost: () => Effect.fail(new NotLinked()),
    Refused: ({ mismatch }) => Effect.fail(mismatch),
  })
})

/** The connection's resource: its value is the engine session. */
export const EngineConnection =
  ManagedResource.tag<EngineSession>()('EngineConnection')

/** The connection's ManagedResource services, which commands and subscriptions calling it require. */
export type EngineConnectionService = ManagedResource.ServiceOf<
  typeof EngineConnection
>

/**
 * The name of the engine the connection reaches, this machine's, as the sidebar says it; the known
 * engines on other hosts are reached through connections of their own, under their names (§9.1).
 */
export const localEngineName = 'local'

/**
 * What a failed attempt says: the version refusal kept whole, the connection process's refusal and
 * anything else as their words.
 */
export type AttemptFailure = Data.TaggedEnum<{
  Refused: { readonly mismatch: VersionMismatch }
  Stopped: { readonly reason: string }
  Unreachable: { readonly reason: string }
}>
export const AttemptFailure = Data.taggedEnum<AttemptFailure>()

const isMismatch = Schema.is(VersionMismatch)

/**
 * A failure in words: its `reason` where it gives one, else its message, else its tag, else `fallback`;
 * the engine's defect in the client's words.
 */
export const failureText = (error: unknown, fallback: string): string => {
  if (typeof error === 'string') return error === '' ? fallback : error
  if (typeof error !== 'object' || error === null) return fallback
  if (error instanceof RpcClientError.RpcClientError && isDefect(error)) {
    return clientErrorWords(error)
  }
  const reason: unknown = Reflect.get(error, 'reason')
  if (typeof reason === 'string' && reason !== '') return reason
  if (error instanceof Error && error.message !== '') return error.message
  const tag: unknown = Reflect.get(error, '_tag')
  return typeof tag === 'string' ? tag : fallback
}

/** The connection process's refusal an attempt's error carries, in its words. */
const refusalOf = (error: unknown): Option.Option<string> =>
  error instanceof RpcClientError.RpcClientError ||
  error instanceof Socket.SocketError
    ? Option.map(connectionRefused(error), ({ reason }) => reason)
    : Option.none()

export const attemptFailure = (error: unknown): AttemptFailure =>
  isMismatch(error)
    ? AttemptFailure.Refused({ mismatch: error })
    : Option.match(refusalOf(error), {
        onSome: reason => AttemptFailure.Stopped({ reason }),
        onNone: () =>
          AttemptFailure.Unreachable({
            reason: failureText(error, 'the engine could not be reached'),
          }),
      })

/** What a request says while no engine is connected. */
export const notConnected = 'the engine is not connected'

/** The requirements the resource is held under: the attempt, so a new attempt acquires afresh, and the release. */
export const ConnectionRequirements = Schema.Option(
  Schema.Struct({ attempt: Schema.Int, release: ReleaseVersion }),
)

/** Requirements for the Model's attempt and connection, with the release its hello says: none once refused or stopped. */
export const connectionRequirements = (model: {
  readonly attempt: number
  readonly release: ReleaseVersion
  readonly connection: Connection
}): typeof ConnectionRequirements.Type =>
  Connection.guards.Refused(model.connection) ||
  Connection.guards.Stopped(model.connection)
    ? Option.none()
    : Option.some({ attempt: model.attempt, release: model.release })
