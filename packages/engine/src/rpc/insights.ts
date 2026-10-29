import { Context, Effect, Layer, Option, Semaphore } from 'effect'
import { SqlClient } from 'effect/sql'

import { InsightsRpcs, type ProjectId } from '@fabrica/contracts'

import { EngineFiles, type EnginePaths } from '../engine/paths'
import { Projects } from '../projects/service'
import { TelemetryDb, telemetryDbLayer } from '../telemetry/duckdb'
import {
  type Sources,
  findEventStream,
  findSessionFiles,
  projectOf,
  readSummary,
  runNamedQuery,
} from '../telemetry/queries'
import { TelemetryStore } from '../telemetry/store'

// The Insights group's handlers (spec §8.1, §21): the summary and the named queries, over the query
// layer's database, on the daemon's telemetry store (`TelemetryStore`), the one its services record
// into. The database is opened on the first request, not as the engine starts, so an engine whose
// host can't load DuckDB still runs: each Insights request then answers a defect giving the reason,
// kept to that request. A request reads the files of its project, or of every project where it names
// none: each event stream and Pi's session files, found where they lie; it refreshes the copies of the
// recorded rows and of those projects' tickets, then runs, one request at a time on the database. A
// project whose work graph won't open is queried without its tickets.

/** A project as a request reads it: its ID and its checkout. */
interface Place {
  readonly id: ProjectId
  readonly path: string
}

/** The Insights group's handlers, their database the one `database` gives, opened on the first request. */
export const insightsHandlersOn = <E, R>(
  database: (files: EnginePaths) => Layer.Layer<TelemetryDb, E, R>,
) =>
  InsightsRpcs.toLayer(
    Effect.gen(function* () {
      const projects = yield* Projects
      const files = yield* EngineFiles
      const { data } = files
      const scope = yield* Effect.scope
      const opened = yield* Effect.cached(
        Layer.buildWithScope(database(files), scope).pipe(
          Effect.map(context => Context.get(context, TelemetryDb)),
        ),
      )
      const oneAtATime = yield* Semaphore.make(1)

      const placesOf = (project: Option.Option<ProjectId>) =>
        Option.match(project, {
          onNone: () =>
            Effect.map(projects.list, (all): ReadonlyArray<Place> => all),
          onSome: id =>
            Effect.map(projects.find(id), (found): ReadonlyArray<Place> => [
              found,
            ]),
        })

      const sourcesOf = (places: ReadonlyArray<Place>) =>
        Effect.forEach(
          places,
          place =>
            Effect.all(
              [
                findEventStream(place.path),
                findSessionFiles({ data, project: place.id }),
              ],
              { concurrency: 'unbounded' },
            ),
          { concurrency: 'unbounded' },
        ).pipe(
          Effect.map((found): Sources => ({
            events: found.flatMap(([stream], index) =>
              Option.match(stream, {
                onNone: () => [],
                onSome: file => {
                  const place = places[index]
                  return place === undefined
                    ? []
                    : [{ project: place.id, file }]
                },
              }),
            ),
            sessions: found.flatMap(([, sessions]) => sessions),
          })),
        )

      const ticketsOf = (places: ReadonlyArray<Place>) =>
        Effect.forEach(
          places,
          place =>
            projects.workGraph(place.id).pipe(
              Effect.flatMap(graph => graph.list()),
              Effect.map(tickets => [{ project: place.id, tickets }]),
              Effect.catch(error =>
                Effect.as(
                  Effect.logWarning(
                    `insights: ${place.id}'s tickets weren't read: ${error.message}`,
                  ),
                  [],
                ),
              ),
            ),
          { concurrency: 'unbounded' },
        ).pipe(Effect.map(found => found.flat()))

      /** Answers `ask` over the project's files, or every project's, once the copies are fresh. */
      const answer = <A, E2>(
        project: Option.Option<ProjectId>,
        ask: (sources: Sources) => Effect.Effect<A, E2, TelemetryDb>,
      ) =>
        Effect.gen(function* () {
          const places = yield* placesOf(project)
          const [sources, tickets] = yield* Effect.all(
            [sourcesOf(places), ticketsOf(places)],
            { concurrency: 'unbounded' },
          )
          const db = yield* Effect.orDie(opened)
          return yield* oneAtATime
            .withPermits(1)(
              db.refresh(tickets).pipe(Effect.andThen(ask(sources))),
            )
            .pipe(Effect.provideService(TelemetryDb, db), Effect.orDie)
        })

      return InsightsRpcs.of({
        'insights.summary': ({ project, since }) =>
          answer(project, sources =>
            readSummary({ project, since }, sources),
          ).pipe(Effect.withSpan('Insights.summaryRequest')),
        'insights.query': ({ query }) =>
          answer(projectOf(query), sources =>
            runNamedQuery(query, sources),
          ).pipe(Effect.withSpan('Insights.queryRequest')),
      })
    }),
  )

/** The query layer's database at its place in the engine's data folder, on the daemon's telemetry store. */
export const engineQueryLayer = (files: EnginePaths) =>
  telemetryDbLayer(files.telemetryQueries).pipe(
    Layer.provide(
      Layer.effect(SqlClient.SqlClient, Effect.service(TelemetryStore)),
    ),
  )

/** The Insights group's handlers, on the engine's telemetry files and its store. */
export const insightsHandlers = insightsHandlersOn(engineQueryLayer)
