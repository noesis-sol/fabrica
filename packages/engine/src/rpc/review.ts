import { DateTime, Effect, Option } from 'effect'

import {
  Diff,
  NoBranch,
  NoReport,
  NoRun,
  type ProjectId,
  Report,
  ReviewRpcs,
  RunEntry,
  RunEvent,
  type RunId,
  RunNotFound,
  type TicketId,
  TicketNotFound,
} from '@fabrica/contracts'

import { readFileTail, readFileTextWritten } from '../files'
import { Git, ticketBranch } from '../git'
import { Projects } from '../projects/service'
import { logPath, readEvents, reportPath } from '../runlog'

// The Review group's handlers (spec §8.1, §18.4): a ticket's branch diff against its merge base with
// Base, a run's merged diff on Base, the project's runs, a run's report and the human log's last lines. The project is
// read through the Projects service, and a ticket's diff asks its work graph first: a ticket it
// doesn't have is `TicketNotFound`, one it has without a branch `NoBranch`. The diffs are read
// through the Git service, the report, the log and the event stream through the safe reader, so a link, a pipe or a folder planted in the checkout's .fabrica/ is
// refused, never followed (§20.2, H62). A run is known by its records in the event stream: its start
// record names Base's commit as it started, its `closed` records each merge's commit on Base. What
// the engine can't read (git can't tell, a file refused) answers as a defect, which the server keeps
// to its own request.

/** The most of a report `report.get` reads: past it, the file is refused rather than cut. */
const reportMaxBytes = 16 * 1024 * 1024

/**
 * Whether `run`'s report can be read: a file of its own in the reports folder, so a name the stream or
 * a client gives never reaches another file of the checkout.
 */
const reportable = (run: RunId): boolean => !run.includes('/')

/** A branch by its full ref, so a tag of the same name is never taken for it. */
const branchRef = (branch: string): string => `refs/heads/${branch}`

/** The Review group's handlers on the Git and Projects services in context. */
export const makeReviewHandlers = Effect.gen(function* () {
  const git = yield* Git
  const projects = yield* Projects

  /** Fails `TicketNotFound` where the project's work graph doesn't have `ticket`. */
  const known = (project: ProjectId, ticket: TicketId) =>
    projects.workGraph(project).pipe(
      Effect.catchTag('WorkGraphUnopened', Effect.die),
      Effect.flatMap(graph => graph.show(ticket)),
      Effect.catchTags({
        TicketNotFound: () =>
          Effect.fail(new TicketNotFound({ project, ticket })),
        StoreFailed: Effect.die,
      }),
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
      const [{ path, base }] = yield* Effect.all(
        [projects.find(project), known(project, ticket)],
        { concurrency: 'unbounded' },
      )
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
      const { path } = yield* projects.find(project)
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

  /** The runs the checkout's stream started, in the stream's order: each the first start record of its run. */
  const startsIn = (root: string) =>
    Effect.orDie(readEvents({ root, run: Option.none() })).pipe(
      Effect.map(({ events }) =>
        events
          .filter(RunEvent.guards.start)
          .filter(
            (start, index, starts) =>
              starts.findIndex(({ run }) => run === start.run) === index,
          ),
      ),
    )

  const reportList = Effect.fn('Review.reportList')(function* ({
    project,
  }: {
    readonly project: ProjectId
  }) {
    const { path } = yield* projects.find(project)
    const starts = yield* startsIn(path)
    return starts
      .filter(({ run }) => reportable(run))
      .flatMap(({ run, time }) =>
        Option.match(DateTime.make(time), {
          onNone: () => [],
          onSome: startedAt => [
            new RunEntry({ run, startedAt: DateTime.toUtc(startedAt) }),
          ],
        }),
      )
      .reverse()
  })

  const reportGet = Effect.fn('Review.reportGet')(function* ({
    project,
    run,
  }: {
    readonly project: ProjectId
    readonly run: Option.Option<RunId>
  }) {
    const { path } = yield* projects.find(project)
    const started = yield* startsIn(path).pipe(
      Effect.map(starts => starts.map(({ run }) => run)),
    )
    const named = yield* Option.match(run, {
      // Only a run the stream started whose report is a file of its own.
      onSome: named =>
        started.includes(named) && reportable(named)
          ? Effect.succeed(named)
          : Effect.fail(new RunNotFound({ project, run: named })),
      // The last run's: the last to start.
      onNone: () =>
        Option.match(Option.fromUndefinedOr(started.at(-1)), {
          onNone: () => Effect.fail(new NoRun({ project })),
          onSome: last =>
            reportable(last)
              ? Effect.succeed(last)
              : Effect.fail(new RunNotFound({ project, run: last })),
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
    const { path } = yield* projects.find(project)
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
    'report.list': reportList,
    'report.get': reportGet,
    'log.tail': logTail,
  })
})

/** The Review group's handlers on the Git and Projects services in context. */
export const reviewHandlersOn = ReviewRpcs.toLayer(makeReviewHandlers)

/** The Review group's handlers, their git the daemon's (§7.7: on the engine's host, in time awake). */
export const reviewHandlers = reviewHandlersOn
