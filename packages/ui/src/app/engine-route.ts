import {
  Array,
  Cause,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
  type Scope,
  Stream,
} from 'effect'

import type { EngineClientShape } from '@fabrica/client'
import { ProjectId, type TalkId } from '@fabrica/contracts'

import * as Sidebar from '../console/sidebar'
import {
  EngineConnection,
  type EngineConnectionService,
  type EngineSession,
  failureText,
  localEngineName,
  notConnected,
} from './connection'

// Which engine a request or a stream goes to (spec §9.1, §18.1): the one whose sidebar row holds its
// project, through that engine's own connection. This machine's engine is the app's connection's, the
// EngineConnection resource; a known engine on another host is reached through its own (remote-engines.ts),
// its session kept here by its name while it is connected. The engine of each project, as the sidebar's
// rows say it, is kept here too, so a Command given a project reaches its engine; a project no row
// holds is this machine's, as is every request with no project.

/** The engine a request was sent to isn't connected: its session isn't held. */
export class EngineNotConnected extends Data.TaggedError('EngineNotConnected')<{
  readonly engine: string
}> {}

/** A project and the name of the engine whose sidebar row holds it. */
export const ProjectRoute = Schema.Struct({
  project: ProjectId,
  engine: Schema.String,
})
export type ProjectRoute = typeof ProjectRoute.Type

/** Each project's engine, as the sidebar's rows say it: the first row holding a project names its engine. */
export const routes = (sidebar: Sidebar.Model): ReadonlyArray<ProjectRoute> =>
  Array.dedupeWith(
    Sidebar.rows(sidebar).map(row => ({
      project: row.status.project,
      engine: row.engine.name,
    })),
    (first, second) => first.project === second.project,
  )

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
  /** The name of the engine holding `project`: this machine's where no row holds it. */
  readonly projectEngine: (project: ProjectId) => Effect.Effect<string>
  /** The projects' engines, as the sidebar's rows now say them. */
  readonly route: (routes: ReadonlyArray<ProjectRoute>) => Effect.Effect<void>
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
  let projects: ReadonlyMap<ProjectId, string> = new Map()
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
    projectEngine: project =>
      Effect.sync(() => projects.get(project) ?? localEngineName),
    route: next =>
      Effect.sync(() => {
        projects = new Map(next.map(({ project, engine }) => [project, engine]))
      }),
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

/** The session of the engine whose sidebar row holds `project`. */
export const sessionFor = (
  project: ProjectId,
): Effect.Effect<EngineSession, EngineNotConnected, EngineServices> =>
  Effect.flatMap(EngineSessions, sessions =>
    sessions.projectEngine(project),
  ).pipe(Effect.flatMap(sessionOn))

/** The session of the scope's engine: its project's, or this machine's under All projects. */
export const sessionForScope = (
  scope: Option.Option<ProjectId>,
): Effect.Effect<EngineSession, EngineNotConnected, EngineServices> =>
  Option.match(scope, {
    onNone: () => sessionOn(localEngineName),
    onSome: sessionFor,
  })

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

/** A request about `project`, to the engine whose sidebar row holds it. */
export const requestProject = <A, E, R>(
  project: ProjectId,
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

/** Opens a talk on `project` through `open`, on the engine whose sidebar row holds it, kept as that engine's. */
export const openTalkOn = <A extends { readonly talk: TalkId }, E, R>(
  project: ProjectId,
  open: (client: EngineClientShape) => Effect.Effect<A, E, R>,
): Effect.Effect<A, string, R | EngineServices> =>
  Effect.gen(function* () {
    const sessions = yield* EngineSessions
    const engine = yield* sessions.projectEngine(project)
    const opened = yield* requestEngine(engine, open)
    yield* sessions.openedTalk(opened.talk, engine)
    return opened
  })

/** A request about the scope, to its project's engine, or this machine's under All projects. */
export const requestScope = <A, E, R>(
  scope: Option.Option<ProjectId>,
  use: (client: EngineClientShape) => Effect.Effect<A, E, R>,
): Effect.Effect<A, string, R | EngineServices> =>
  requestThrough(sessionForScope(scope))(use)

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

/** The name of the engine whose sidebar row holds `project`: this machine's where no row holds it. */
export const engineOf = (sidebar: Sidebar.Model, project: ProjectId): string =>
  Option.getOrElse(Sidebar.engineName(sidebar, project), () => localEngineName)

/** The name of the scope's engine: its project's, or this machine's under All projects. */
export const scopeEngine = (
  sidebar: Sidebar.Model,
  scope: Option.Option<ProjectId>,
): string =>
  Option.match(scope, {
    onNone: () => localEngineName,
    onSome: project => engineOf(sidebar, project),
  })
