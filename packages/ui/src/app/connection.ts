import { Data, Duration, Effect, Option, Schema, Stream } from 'effect'
import { Socket } from 'effect/socket'
import { ManagedResource } from 'foldkit'
import { defineTaggedUnion } from 'foldkit/schema'

import {
  type ClientOptions,
  type EngineClientShape,
  Link,
  make as makeClient,
} from '@fabrica/client'
import {
  EngineId,
  ProtocolVersion,
  ReleaseVersion,
  UpdateSide,
  VersionMismatch,
} from '@fabrica/contracts'

import { portSocket } from './port'

// The connection to the engine (spec §8.2, §18.1): a ManagedResource, the engine client over the
// connection process's MessagePort, held while the Model wants it. Its first hello says whether the
// engine takes the app; after that the client's link, Up, Down while it reconnects, or Refused by an
// engine that was updated meanwhile, comes in as Messages through a subscription. An attempt that
// fails is tried again after a pause; a refused one waits for an update, since retrying can't help.

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
    Refused: () => false,
  })

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
  const socket = yield* portSocket(port)
  const client = yield* makeClient(environment.client).pipe(
    Effect.provideService(Socket.Socket, socket),
  )
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

/** The client, or nothing while the resource isn't held. */
export const withClient = <A, E, R>(
  use: (client: EngineClientShape) => Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R | EngineConnectionService> =>
  Stream.unwrap(
    EngineConnection.get.pipe(
      Effect.map(({ client }) => use(client)),
      Effect.catchTag('ResourceNotAvailable', () =>
        Effect.succeed(Stream.empty),
      ),
    ),
  )

/** What a failed attempt says: the version refusal kept whole, anything else as its message. */
export type AttemptFailure = Data.TaggedEnum<{
  Refused: { readonly mismatch: VersionMismatch }
  Unreachable: { readonly reason: string }
}>
export const AttemptFailure = Data.taggedEnum<AttemptFailure>()

const isMismatch = Schema.is(VersionMismatch)

export const attemptFailure = (error: unknown): AttemptFailure =>
  isMismatch(error)
    ? AttemptFailure.Refused({ mismatch: error })
    : AttemptFailure.Unreachable({
        reason:
          error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : 'the engine could not be reached',
      })

/** The requirements the resource is held under: the attempt, so a new attempt acquires afresh, and the release. */
export const ConnectionRequirements = Schema.Option(
  Schema.Struct({ attempt: Schema.Int, release: ReleaseVersion }),
)

/** Requirements for the Model's attempt and connection, with the release its hello says: none once refused. */
export const connectionRequirements = (model: {
  readonly attempt: number
  readonly release: ReleaseVersion
  readonly connection: Connection
}): typeof ConnectionRequirements.Type =>
  Connection.guards.Refused(model.connection)
    ? Option.none()
    : Option.some({ attempt: model.attempt, release: model.release })
