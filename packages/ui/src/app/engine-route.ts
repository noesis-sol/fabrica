import {
  Cause,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Predicate,
  type Scope,
  Stream,
} from 'effect'

import type { EngineClientShape } from '@fabrica/client'
import type { TalkId } from '@fabrica/contracts'

import {
  EngineConnection,
  type EngineConnectionService,
  type EngineSession,
  failureText,
  localEngineName,
  notConnected,
} from './connection'
import type { EngineProject } from './engine-project'

// Which engine a request or a stream goes to (spec §9.1, §18.1): the one holding its project, which the
// project names (engine-project.ts), through that engine's own connection. This machine's engine is the
// app's connection's, the EngineConnection resource; a known engine on another host is reached through
// its own (remote-engines.ts), its session kept here by its name while it is connected. Every request
// with no project goes to this machine's engine.

/** The engine a request was sent to isn't connected: its session isn't held. */
export class EngineNotConnected extends Data.TaggedError('EngineNotConnected')<{
  readonly engine: string
}> {}

export interface EngineSessionsShape {
  /** The session of the known engine named `engine`, while it is connected. */
  readonly session: (
    engine: string,
  ) => Effect.Effect<Option.Option<EngineSession>>
  /** Holds `session` as the engine named `engine`'s until the scope closes. */
  readonly keep: (
    engine: string,
    session: EngineSession,
  ) => Effect.Effect<void, never, Scope.Scope>
  /** The name of the engine `talk` was opened on: this machine's where none was. */
  readonly talkEngine: (talk: TalkId) => Effect.Effect<string>
  /** Keeps `talk` as opened on the engine named `engine`, for what is sent to it. */
  readonly openedTalk: (talk: TalkId, engine: string) => Effect.Effect<void>
}

export class EngineSessions extends Context.Service<
  EngineSessions,
  EngineSessionsShape
>()('@fabrica/ui/EngineSessions') {}

export const makeEngineSessions = Effect.sync(() => {
  const sessions = new Map<string, EngineSession>()
  const talks = new Map<TalkId, string>()
  return EngineSessions.of({
    session: engine =>
      Effect.sync(() => Option.fromUndefinedOr(sessions.get(engine))),
    keep: (engine, session) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          sessions.set(engine, session)
        }),
        () =>
          Effect.sync(() => {
            if (sessions.get(engine) === session) sessions.delete(engine)
          }),
      ),
    talkEngine: talk => Effect.sync(() => talks.get(talk) ?? localEngineName),
    openedTalk: (talk, engine) =>
      Effect.sync(() => {
        talks.set(talk, engine)
      }),
  })
})

export const layerEngineSessions = Layer.effect(
  EngineSessions,
  makeEngineSessions,
)

/** The services a request or stream routed to an engine needs: the app's connection and the known engines' sessions. */
export type EngineServices = EngineConnectionService | EngineSessions

/** The session of the engine named `engine`: this machine's, the app's connection's; another's, its own. */
export const sessionOn = (
  engine: string,
): Effect.Effect<EngineSession, EngineNotConnected, EngineServices> =>
  engine === localEngineName
    ? EngineConnection.get.pipe(
        Effect.catchTag('ResourceNotAvailable', () =>
          Effect.fail(new EngineNotConnected({ engine })),
        ),
      )
    : Effect.flatMap(EngineSessions, sessions => sessions.session(engine)).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new EngineNotConnected({ engine })),
            onSome: Effect.succeed,
          }),
        ),
      )

/** The session of the engine holding `project`. */
export const sessionFor = ({
  engine,
}: EngineProject): Effect.Effect<
  EngineSession,
  EngineNotConnected,
  EngineServices
> => sessionOn(engine)

/**
 * A request through `session`'s client: its answer, or its failure in words, the engine's refusal, a
 * request it doesn't serve yet, and no connection included (§8.1).
 */
const requestThrough =
  <R0>(session: Effect.Effect<EngineSession, EngineNotConnected, R0>) =>
  <A, E, R>(
    use: (client: EngineClientShape) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, string, R | R0> =>
    session.pipe(
      Effect.flatMap(({ client }) => use(client)),
      Effect.catchCause(cause =>
        Effect.fail(
          Cause.hasInterruptsOnly(cause)
            ? 'the request was interrupted'
            : failureText(
                Option.getOrElse(
                  Option.map(Cause.findErrorOption(cause), error =>
                    Predicate.isTagged(error, 'EngineNotConnected')
                      ? notConnected
                      : error,
                  ),
                  () => Cause.squash(cause),
                ),
                'the engine gave no reason',
              ),
        ),
      ),
    )

/** A request to the engine named `engine`. */
export const requestEngine = <A, E, R>(
  engine: string,
  use: (client: EngineClientShape) => Effect.Effect<A, E, R>,
): Effect.Effect<A, string, R | EngineServices> =>
  requestThrough(sessionOn(engine))(use)

/** A request about `project`, to the engine holding it. */
export const requestProject = <A, E, R>(
  project: EngineProject,
  use: (client: EngineClientShape) => Effect.Effect<A, E, R>,
): Effect.Effect<A, string, R | EngineServices> =>
  requestThrough(sessionFor(project))(use)

/** A request to `talk`, to the engine it was opened on. */
export const requestTalk = <A, E, R>(
  talk: TalkId,
  use: (client: EngineClientShape) => Effect.Effect<A, E, R>,
): Effect.Effect<A, string, R | EngineServices> =>
  Effect.flatMap(EngineSessions, sessions => sessions.talkEngine(talk)).pipe(
    Effect.flatMap(engine => requestEngine(engine, use)),
  )

/** Opens a talk on `project` through `open`, on the engine holding it, kept as that engine's. */
export const openTalkOn = <A extends { readonly talk: TalkId }, E, R>(
  { engine }: EngineProject,
  open: (client: EngineClientShape) => Effect.Effect<A, E, R>,
): Effect.Effect<A, string, R | EngineServices> =>
  Effect.gen(function* () {
    const sessions = yield* EngineSessions
    const opened = yield* requestEngine(engine, open)
    yield* sessions.openedTalk(opened.talk, engine)
    return opened
  })

/** A request about the scope, to its project's engine, or this machine's under All projects. */
export const requestScope = <A, E, R>(
  scope: Option.Option<EngineProject>,
  use: (client: EngineClientShape) => Effect.Effect<A, E, R>,
): Effect.Effect<A, string, R | EngineServices> =>
  requestEngine(scopeEngine(scope), use)

/** A stream through the engine named `engine`'s session, or nothing while it isn't connected. */
export const withEngineSession = <A, E, R>(
  engine: string,
  use: (session: EngineSession) => Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R | EngineServices> =>
  Stream.unwrap(
    sessionOn(engine).pipe(
      Effect.map(use),
      Effect.catchTag('EngineNotConnected', () => Effect.succeed(Stream.empty)),
    ),
  )

/** A stream through the engine named `engine`'s client, or nothing while it isn't connected. */
export const withEngineClient = <A, E, R>(
  engine: string,
  use: (client: EngineClientShape) => Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R | EngineServices> =>
  withEngineSession(engine, ({ client }) => use(client))

/** The name of the scope's engine: its project's, or this machine's under All projects. */
export const scopeEngine = (scope: Option.Option<EngineProject>): string =>
  Option.match(scope, {
    onNone: () => localEngineName,
    onSome: ({ engine }) => engine,
  })
