import { DateTime, Effect, Layer, Option } from 'effect'
import { SqlClient } from 'effect/sql'

import {
  Diff,
  NoBranch,
  NoReport,
  NoRun,
  type ProjectId,
  ProjectNotFound,
  Report,
  ReviewRpcs,
  RunEvent,
  type RunId,
  RunNotFound,
  type TicketId,
} from '@fabrica/contracts'

import { findProject } from '../engine/database'
import { readFileTail, readFileTextWritten } from '../files'
import { Git, layer as gitLayer, ticketBranch } from '../git'
import { layerAwake, layerHost } from '../process'
import { logPath, readEvents, reportPath } from '../runlog'
import { layerWake, sleepCausesFor } from '../time'

// The Review group's handlers (spec §8.1, §18.4): a ticket's branch diff against its merge base with
// Base, a run's merged diff on Base, a run's report and the human log's last lines. The project is
// read from engine.db; the diffs through the Git service, the report, the log and the event stream
// through the safe reader, so a link, a pipe or a folder planted in the checkout's .fabrica/ is
// refused, never followed (§20.2, H62). A run is known by its records in the event stream: its start
// record names Base's commit as it started, its `closed` records each merge's commit on Base. What
// the engine can't read (git can't tell, a file refused) answers as a defect, which the server keeps
// to its own request.

/** The most of a report `report.get` reads: past it, the file is refused rather than cut. */
const reportMaxBytes = 16 * 1024 * 1024

/** A branch by its full ref, so a tag of the same name is never taken for it. */
const branchRef = (branch: string): string => `refs/heads/${branch}`

/** The Review group's handlers on the Git service and engine.db in context. */
export const makeReviewHandlers = Effect.gen(function* () {
  const git = yield* Git
  const sql = yield* SqlClient.SqlClient

  const projectOf = (project: ProjectId) =>
    findProject(project).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.orDie,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ProjectNotFound({ project })),
          onSome: Effect.succeed,
        }),
      ),
    )

  const diffOf = (repo: string, range: Pick<Diff, 'base' | 'head'>) =>
    git
      .diff({ repo, from: range.base, to: range.head })
      .pipe(Effect.map(files => new Diff({ ...range, files })))

  const diffTicket = Effect.fn('Review.diffTicket')(
    function* ({
      project,
      ticket,
    }: {
      readonly project: ProjectId
      readonly ticket: TicketId
    }) {
      const { path, base } = yield* projectOf(project)
      const branch = ticketBranch(ticket)
      const head = yield* git.commitHash({
        repo: path,
        revision: branchRef(branch),
      })
      if (Option.isNone(head)) return yield* new NoBranch({ project, ticket })
      const from = yield* git.mergeBase({
        repo: path,
        branch: head.value,
        base: branchRef(base),
      })
      if (Option.isNone(from))
        return yield* Effect.die(
          new Error(`${branch} shares no history with ${base}`),
        )
      return yield* diffOf(path, { base: from.value, head: head.value })
    },
    Effect.catchTag('CantTell', Effect.die),
  )

  const diffRun = Effect.fn('Review.diffRun')(
    function* ({
      project,
      run,
    }: {
      readonly project: ProjectId
      readonly run: RunId
    }) {
      const { path } = yield* projectOf(project)
      const { events } = yield* readEvents({
        root: path,
        run: Option.some(run),
      }).pipe(Effect.orDie)
      const start = events.find(RunEvent.guards.start)
      if (start === undefined) return yield* new RunNotFound({ project, run })
      // Base after the run's last merge; where it merged nothing, where it started.
      const merged = events
        .filter(RunEvent.guards.closed)
        .flatMap(({ commit }) => (commit === undefined ? [] : [commit]))
      return yield* diffOf(path, {
        base: start.commit,
        head: merged.at(-1) ?? start.commit,
      })
    },
    Effect.catchTag('CantTell', Effect.die),
  )

  const reportGet = Effect.fn('Review.reportGet')(function* ({
    project,
    run,
  }: {
    readonly project: ProjectId
    readonly run: Option.Option<RunId>
  }) {
    const { path } = yield* projectOf(project)
    const started = yield* Effect.orDie(
      readEvents({ root: path, run: Option.none() }),
    ).pipe(
      Effect.map(({ events }) =>
        events.filter(RunEvent.guards.start).map(({ run }) => run),
      ),
    )
    const named = yield* Option.match(run, {
      // Only a run the stream started, its report a file of its own in the reports folder: a name the
      // client gives never reaches another file of the checkout.
      onSome: named =>
        started.includes(named) && !named.includes('/')
          ? Effect.succeed(named)
          : Effect.fail(new RunNotFound({ project, run: named })),
      // The last run's: the last to start.
      onNone: () =>
        Option.match(Option.fromUndefinedOr(started.at(-1)), {
          onNone: () => Effect.fail(new NoRun({ project })),
          onSome: last =>
            last.includes('/')
              ? Effect.fail(new RunNotFound({ project, run: last }))
              : Effect.succeed(last),
        }),
    })
    const written = yield* readFileTextWritten(
      { root: path, path: reportPath(named) },
      { maxBytes: reportMaxBytes },
    ).pipe(
      Effect.catch(error =>
        error._tag === 'FileMissing'
          ? Effect.fail(new NoReport({ project, run: named }))
          : Effect.die(error),
      ),
    )
    return new Report({
      run: named,
      markdown: written.text,
      writtenAt: DateTime.makeUnsafe(written.writtenAt),
    })
  })

  const logTail = Effect.fn('Review.logTail')(function* ({
    project,
    lines,
  }: {
    readonly project: ProjectId
    readonly lines: number
  }) {
    const { path } = yield* projectOf(project)
    const tail = yield* readFileTail({ root: path, path: logPath }, lines).pipe(
      Effect.catch(error =>
        // A project that has never run has no log: no lines.
        error._tag === 'FileMissing'
          ? Effect.succeed<ReadonlyArray<string>>([])
          : Effect.die(error),
      ),
    )
    return { lines: tail }
  })

  return ReviewRpcs.of({
    'diff.ticket': diffTicket,
    'diff.run': diffRun,
    'report.get': reportGet,
    'log.tail': logTail,
  })
})

/** The Review group's handlers on the Git service and engine.db in context. */
export const reviewHandlersOn = ReviewRpcs.toLayer(makeReviewHandlers)

/** Git on the engine's host, each command's time limit counted in time awake (§7.7). */
const hostGit = gitLayer().pipe(
  Layer.provide(layerHost),
  Layer.provide(layerAwake),
  Layer.provide(layerWake),
  Layer.provide(Layer.suspend(() => sleepCausesFor(process.platform))),
)

/** The Review group's handlers, their git run on the engine's host. */
export const reviewHandlers = reviewHandlersOn.pipe(Layer.provide(hostGit))
