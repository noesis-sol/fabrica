import {
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect'
import { SqlClient } from 'effect/sql'

import {
  type EndKind,
  NoRun,
  type ProjectId,
  ProjectNotFound,
  ProjectRunState,
  type Resume,
  ResumePlan,
  RunEnded,
  type RunEvent,
  RunEventsItem,
  type RunFlags,
  RunGoing,
  RunHeader,
  RunId,
  RunMode as RunModeWire,
  RunNotFound,
  RunRefused,
  RunStatus,
  StreamEpoch,
  type TicketId,
  type TranscriptItem,
  WorkerNotFound,
  decodeEngineSettings,
  planResume,
} from '@fabrica/contracts'

import { AttentionRequests } from '../attention/service'
import {
  Attention,
  checkOwnPassesLayer,
  layer as controlLayer,
} from '../control'
import { storedSettingsDocument } from '../engine/database'
import { EngineScopes } from '../engine/scopes'
import { Engine } from '../engine/service'
import { Projects } from '../projects/service'
import { RunLog, layerRunLog, readEvents } from '../runlog'
import { localNow } from '../time'
import { type RunViewHandle, type RunViewItem, makeRunView } from '../view'
import { WorkGraph } from '../workgraph'
import { drawBase36 } from '../workgraph/ids'
import { type RunConfig, RunMode } from './config'
import { type RunControl, makeRunControl } from './control'
import { RunHosting, RunHostingShape } from './hosting'
import { runProject } from './loop'
import { StartChecked } from './start-checks'

// The engine's runs (spec §7.3, §8.1, §13.1, §13.10, §13.12): at most one run per project, started in
// the engine's runs scope on what the engine's run hosting gives, with a control server on its project's
// work graph (and its `check_own` passes), and stopped, drained or undrained
// through its control. A start answers once the run's start checks have: with their problems, all
// together, or with the run. Each run's records are kept as its log writes them, so its events stream
// sends those written so far, then each as it is written, and ends with the run; an earlier run's are
// read from the project's event stream. The project's row says whether a run goes. As the engine
// stops, every run is stopped and waited for before its scope closes, so each ends `INTERRUPTED`.

/** A run's records so far, and whether it has ended. */
interface Feed {
  readonly events: ReadonlyArray<RunEvent>
  readonly ended: boolean
}

/** A run going. */
interface Going {
  readonly header: Omit<RunHeader, 'state'>
  readonly control: RunControl
  readonly feed: SubscriptionRef.SubscriptionRef<Feed>
  /** Its events stream's epoch, the engine's copy of it. */
  readonly epoch: StreamEpoch
  /** The project's checkout. */
  readonly checkout: string
  /** Its view (§8.3), and its workers as the maintainer reaches them. */
  readonly view: RunViewHandle
}

/** A worker of a project's run, as the Workers group names it. */
interface WorkerAt {
  readonly project: ProjectId
  readonly ticket: TicketId
}

export interface RunsShape {
  /** Starts a run of the project; its ID once its start checks pass. */
  readonly start: (input: {
    readonly project: ProjectId
    readonly mode: RunModeWire
    readonly flags: RunFlags
  }) => Effect.Effect<RunId, ProjectNotFound | RunGoing | RunRefused>
  /** Stops the project's run now: it ends `INTERRUPTED`. */
  readonly stop: (
    project: ProjectId,
  ) => Effect.Effect<void, ProjectNotFound | NoRun>
  /** Drains the project's run: no new tickets; it ends `DRAINED`. */
  readonly drain: (
    project: ProjectId,
  ) => Effect.Effect<void, ProjectNotFound | NoRun>
  readonly undrain: (
    project: ProjectId,
  ) => Effect.Effect<void, ProjectNotFound | NoRun>
  /** The project's run, or how its last one ended. */
  readonly status: (
    project: ProjectId,
  ) => Effect.Effect<RunStatus, ProjectNotFound>
  /** The run's records: the run going, or an earlier one by its ID; ends with the run. */
  readonly watchEvents: (input: {
    readonly project: ProjectId
    readonly run: Option.Option<RunId>
    readonly resume: Option.Option<Resume>
  }) => Stream.Stream<RunEventsItem, ProjectNotFound | NoRun | RunNotFound>
  /** The view of the project's run (§8.3): a snapshot or the patches after `resume`, then each patch; ends with the run. */
  readonly watchView: (input: {
    readonly project: ProjectId
    readonly resume: Option.Option<Resume>
  }) => Stream.Stream<RunViewItem, ProjectNotFound | NoRun>
  /** Steers the worker with the maintainer's message; held while its ticket merges (H59). */
  readonly message: (
    input: WorkerAt & { readonly text: string },
  ) => Effect.Effect<void, ProjectNotFound | WorkerNotFound>
  /** Aborts the worker's running turn, and steers it. */
  readonly interrupt: (
    input: WorkerAt,
  ) => Effect.Effect<void, ProjectNotFound | WorkerNotFound>
  /** Hands a steered worker back to the engine. */
  readonly release: (
    input: WorkerAt,
  ) => Effect.Effect<void, ProjectNotFound | WorkerNotFound>
  /** The worker's transcript, sent only to a client that asks for it (§8.3). */
  readonly watchTranscript: (
    input: WorkerAt & { readonly resume: Option.Option<Resume> },
  ) => Stream.Stream<TranscriptItem, ProjectNotFound | WorkerNotFound>
}

export class Runs extends Context.Service<Runs, RunsShape>()(
  '@fabrica/engine/Runs',
) {}

/** The engine's run mode for a mode a run can be started in; none for one it can't yet. */
const modeOf: (mode: RunModeWire) => Option.Option<RunMode> = RunModeWire.match(
  {
    tickets: () => Option.some(RunMode.Tickets()),
    ticket: ({ ticket }) => Option.some(RunMode.Ticket({ ticket })),
    spec: () => Option.none(),
    feature: () => Option.none(),
    overnight: () => Option.none(),
  },
)

/** A run's events stream items, from `epoch`, after `resume`, as its records come. */
const eventItems = (epoch: StreamEpoch, resume: Option.Option<Resume>) => {
  type Step = readonly [Option.Option<number>, ReadonlyArray<RunEventsItem>]
  const patches = (after: number, events: ReadonlyArray<RunEvent>): Step => [
    Option.some(events.length),
    events
      .slice(after)
      .map((event, at) =>
        RunEventsItem.cases.patch.make({ seq: after + at + 1, value: [event] }),
      ),
  ]
  return (sent: Option.Option<number>, { events }: Feed): Step =>
    Option.match(sent, {
      onSome: after => patches(after, events),
      onNone: () =>
        ResumePlan.$match(
          planResume({ resume, epoch, oldest: 1, latest: events.length }),
          {
            Snapshot: (): Step => [
              Option.some(events.length),
              [
                RunEventsItem.cases.snapshot.make({
                  epoch,
                  seq: events.length,
                  value: events,
                }),
              ],
            ],
            PatchesAfter: ({ after }) => patches(after, events),
          },
        ),
    })
}

/** A stream epoch for a run's events. */
const drawEpoch = Effect.map(drawBase36(12), random =>
  StreamEpoch.make(`events-${random}`),
)

/** How the last run in `events` ended, where its end was written. */
const lastEnded = (
  events: ReadonlyArray<RunEvent>,
): Option.Option<RunEnded> => {
  const end = events.findLast(event => event.kind === 'end')
  if (end === undefined) return Option.none()
  const kind = events.findLast(
    (event): event is Extract<RunEvent, { readonly kind: 'done' | 'stop' }> =>
      event.run === end.run && (event.kind === 'done' || event.kind === 'stop'),
  )
  const endedAt = DateTime.make(end.time)
  if (kind === undefined || Option.isNone(endedAt)) return Option.none()
  const endKind: EndKind = kind.detail
  return Option.some(
    new RunEnded({
      run: end.run,
      end: endKind,
      endedAt: DateTime.toUtc(endedAt.value),
    }),
  )
}

/** The Runs service on the daemon's projects, engine, scopes, database and run hosting. */
export const make = Effect.gen(function* () {
  const projects = yield* Projects
  const engine = yield* Engine
  const scopes = yield* EngineScopes
  const hosting = yield* RunHosting
  const attention = yield* AttentionRequests
  const sql = yield* SqlClient.SqlClient
  const going = yield* Ref.make<ReadonlyMap<ProjectId, Going>>(new Map())
  const startLock = yield* Semaphore.make(1)

  // As the engine stops, each run is stopped and waited for; then the runs' own scope closes. The
  // finalizer is added after that scope, so it runs before it.
  const ended = yield* Ref.make<
    ReadonlyMap<ProjectId, Deferred.Deferred<void>>
  >(new Map())
  const runsScope = yield* Scope.fork(scopes.runs)
  yield* Scope.addFinalizer(
    scopes.runs,
    Effect.gen(function* () {
      const runs = [...(yield* Ref.get(going)).values()]
      yield* Effect.forEach(runs, run => run.control.stop, { discard: true })
      const waits = [...(yield* Ref.get(ended)).values()]
      yield* Effect.forEach(waits, Deferred.await, {
        concurrency: 'unbounded',
        discard: true,
      })
    }),
  )

  const goingRun = (project: ProjectId) =>
    Effect.gen(function* () {
      yield* projects.find(project)
      const run = (yield* Ref.get(going)).get(project)
      return yield* run === undefined
        ? Effect.fail(new NoRun({ project }))
        : Effect.succeed(run)
    })

  const refusedWith = (problem: string) =>
    new RunRefused({ end: 'SETUP', problems: [problem] })

  const start = Effect.fn('Runs.start')(function* (input: {
    readonly project: ProjectId
    readonly mode: RunModeWire
    readonly flags: RunFlags
  }) {
    const { project, flags } = input
    const record = yield* projects.find(project)
    const started = yield* startLock.withPermit(
      Effect.gen(function* () {
        const already = (yield* Ref.get(going)).get(project)
        if (already !== undefined)
          return yield* new RunGoing({ project, run: already.header.run })
        if (RunHostingShape.$is('Refused')(hosting))
          return yield* refusedWith(hosting.reason)
        const mode = modeOf(input.mode)
        if (Option.isNone(mode))
          return yield* refusedWith(
            `a ${input.mode._tag} run isn't in this engine yet: run the current tickets, or one ticket and its descendants`,
          )
        const graph = yield* projects
          .workGraph(project)
          .pipe(Effect.mapError(error => refusedWith(error.message)))
        const home = yield* projects.worktreeHome(project)
        const engineSettings = yield* storedSettingsDocument().pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catchTag('StoredSettingsInvalid', error =>
            Effect.fail(refusedWith(error.message)),
          ),
          Effect.orDie,
        )
        const services = hosting.services
        // A run is named by its start, local with its offset, as orchestra named its runs.
        const run = RunId.make(
          yield* localNow.pipe(Effect.provideContext(services)),
        )
        const startedAt = yield* DateTime.now
        const control = yield* makeRunControl
        const feed = yield* SubscriptionRef.make<Feed>({
          events: [],
          ended: false,
        })
        const done = yield* Deferred.make<void>()
        const epoch = yield* drawEpoch
        const header: Going['header'] = {
          run,
          project,
          engine: engine.id,
          mode: input.mode,
          startedAt,
          offline: flags.offline,
          autoAnswer:
            'auto_answer' in flags.settings &&
            flags.settings['auto_answer'] !== 'false',
        }
        // The run's view lives as long as the run: written every `view_interval`, its transcripts
        // crossing every `stream_flush` (§8.3), the engine's settings as the run starts.
        const intervals = yield* decodeEngineSettings(engineSettings).pipe(
          Effect.catch(() => decodeEngineSettings({})),
          Effect.orDie,
        )
        const viewScope = yield* Scope.fork(runsScope)
        const view = yield* makeRunView({
          header: Effect.map(
            control.state,
            state => new RunHeader({ ...header, state }),
          ),
          interval: intervals.view_interval,
          flush: intervals.stream_flush,
          graph,
          // The project's row waits on the maintainer while a ticket of the run needs them.
          needsYou: count =>
            Effect.ignore(
              projects.setRun({
                project,
                run:
                  count > 0
                    ? ProjectRunState.cases.waiting.make({
                        run,
                        overnight: input.mode._tag === 'overnight',
                        needsYou: count,
                      })
                    : ProjectRunState.cases.running.make({
                        run,
                        overnight: input.mode._tag === 'overnight',
                      }),
              }),
            ),
          scope: viewScope,
        }).pipe(Effect.provideContext(services))
        const config: RunConfig = {
          project,
          engine: engine.id,
          version: engine.version.release,
          checkout: record.path,
          home,
          sockets: hosting.sockets,
          options: {
            mode: mode.value,
            limit: flags.limit,
            concurrent: Option.none(),
          },
          settings: {
            flags: flags.settings,
            environment: hosting.environment,
            engineSettings,
          },
          cores: hosting.cores,
          nice: hosting.nice,
          projectTrusted: record.trusted,
        }

        /** The run's log, each record kept for its events stream as it is written. */
        const keptLog = Layer.effect(
          RunLog,
          Effect.map(RunLog, log =>
            RunLog.of({
              ...log,
              emit: (draft, details) =>
                Effect.tap(log.emit(draft, details), event =>
                  SubscriptionRef.update(feed, now => ({
                    ...now,
                    events: [...now.events, event],
                  })),
                ),
            }),
          ),
        ).pipe(Layer.provide(layerRunLog({ root: record.path, run })))

        const finished = Effect.gen(function* () {
          yield* SubscriptionRef.update(feed, now => ({ ...now, ended: true }))
          yield* Scope.close(viewScope, Exit.void)
          yield* Ref.update(going, map => {
            const next = new Map(map)
            if (next.get(project)?.header.run === run) next.delete(project)
            return next
          })
          yield* Ref.update(ended, map => {
            const next = new Map(map)
            next.delete(project)
            return next
          })
          yield* Effect.ignore(
            projects.setRun({
              project,
              run: ProjectRunState.cases.idle.make({}),
            }),
          )
          // A run that ended before its start checks answered (a defect): its start hears so.
          yield* Deferred.die(
            control.checked,
            new Error(`the run ${run} ended before its start checks answered`),
          )
          yield* Deferred.succeed(done, undefined)
        })

        yield* runProject(config, control, view.sources).pipe(
          Effect.provide(
            Layer.merge(
              keptLog,
              controlLayer.pipe(
                Layer.provideMerge(checkOwnPassesLayer),
                // Its own side of the attention requests: its allow-for-this-run rules end with it.
                Layer.provideMerge(Layer.effect(Attention, attention.forRun)),
              ),
            ),
          ),
          Effect.provideService(WorkGraph, graph),
          Effect.provideContext(services),
          Effect.catchCause(cause =>
            Effect.logError(`the run ${run} of ${project} failed`, cause),
          ),
          Effect.ensuring(finished),
          Effect.forkIn(runsScope),
        )
        yield* Ref.update(going, map =>
          new Map(map).set(project, {
            header,
            control,
            feed,
            epoch,
            checkout: record.path,
            view,
          }),
        )
        yield* Ref.update(ended, map => new Map(map).set(project, done))
        yield* projects.setRun({
          project,
          run: ProjectRunState.cases.running.make({
            run,
            overnight: input.mode._tag === 'overnight',
          }),
        })
        return { control, run, done }
      }),
    )
    const checked = yield* Deferred.await(started.control.checked)
    return yield* StartChecked.$match(checked, {
      Ready: () => Effect.succeed(started.run),
      // The refused run's end is written and it is gone before its start answers.
      Problems: ({ problems }) => {
        const [first, ...rest] = problems
        return Effect.andThen(
          Deferred.await(started.done),
          Effect.fail(
            new RunRefused({
              end: 'SETUP',
              problems:
                first === undefined
                  ? ["the run's start checks failed"]
                  : [first, ...rest],
            }),
          ),
        )
      },
    })
  })

  const status = Effect.fn('Runs.status')(function* (project: ProjectId) {
    const record = yield* projects.find(project)
    const run = (yield* Ref.get(going)).get(project)
    if (run !== undefined)
      return RunStatus.cases.going.make({
        header: new RunHeader({
          ...run.header,
          state: yield* run.control.state,
        }),
      })
    const read = yield* readEvents({
      root: record.path,
      run: Option.none(),
    }).pipe(
      Effect.map(({ events }) => lastEnded(events)),
      Effect.catch(error =>
        Effect.as(
          Effect.logWarning(
            `the event stream of ${project} couldn't be read: ${error.message}`,
          ),
          Option.none<RunEnded>(),
        ),
      ),
    )
    return RunStatus.cases.idle.make({ last: read })
  })

  const watchEvents = (input: {
    readonly project: ProjectId
    readonly run: Option.Option<RunId>
    readonly resume: Option.Option<Resume>
  }): Stream.Stream<RunEventsItem, ProjectNotFound | NoRun | RunNotFound> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const record = yield* projects.find(input.project)
        const run = (yield* Ref.get(going)).get(input.project)
        const live =
          run !== undefined &&
          Option.match(input.run, {
            onNone: () => true,
            onSome: id => id === run.header.run,
          })
        if (live)
          return SubscriptionRef.changes(run.feed).pipe(
            Stream.takeUntil(feed => feed.ended),
            Stream.mapAccum(
              Option.none<number>,
              eventItems(run.epoch, input.resume),
            ),
          )
        if (Option.isNone(input.run))
          return yield* new NoRun({ project: input.project })
        const asked = input.run.value
        const { events } = yield* readEvents({
          root: record.path,
          run: input.run,
        }).pipe(Effect.orDie)
        if (events.length === 0)
          return yield* new RunNotFound({ project: input.project, run: asked })
        const epoch = yield* drawEpoch
        return Stream.succeed<Feed>({ events, ended: true }).pipe(
          Stream.mapAccum(Option.none<number>, eventItems(epoch, input.resume)),
        )
      }),
    )

  const watchView = (input: {
    readonly project: ProjectId
    readonly resume: Option.Option<Resume>
  }): Stream.Stream<RunViewItem, ProjectNotFound | NoRun> =>
    Stream.unwrap(
      Effect.map(goingRun(input.project), run => run.view.watch(input.resume)),
    )

  /** The run's view's sources where the ticket's worker is in progress in the project's run. */
  const workerOf = ({ project, ticket }: WorkerAt) =>
    Effect.gen(function* () {
      yield* projects.find(project)
      const run = (yield* Ref.get(going)).get(project)
      const sources = run?.view.sources
      if (sources !== undefined && (yield* sources.inProgress(ticket)))
        return sources
      return yield* new WorkerNotFound({ project, ticket })
    })

  const found = (at: WorkerAt) => (exists: boolean) =>
    exists ? Effect.void : Effect.fail(new WorkerNotFound({ ...at }))

  const message = Effect.fn('Runs.message')(function* (
    input: WorkerAt & { readonly text: string },
  ) {
    const at: WorkerAt = { project: input.project, ticket: input.ticket }
    const sources = yield* workerOf(at)
    const merging = yield* sources.inLine(input.ticket)
    const delivered = yield* sources.workers.message({
      ticket: input.ticket,
      text: input.text,
      merging,
    })
    yield* found(at)(Option.isSome(delivered))
  })

  const interrupt = Effect.fn('Runs.interrupt')(function* (at: WorkerAt) {
    const sources = yield* workerOf(at)
    yield* Effect.flatMap(sources.workers.interrupt(at.ticket), found(at))
  })

  const release = Effect.fn('Runs.release')(function* (at: WorkerAt) {
    const sources = yield* workerOf(at)
    yield* Effect.flatMap(sources.workers.release(at.ticket), found(at))
  })

  const watchTranscript = (
    input: WorkerAt & { readonly resume: Option.Option<Resume> },
  ): Stream.Stream<TranscriptItem, ProjectNotFound | WorkerNotFound> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const at: WorkerAt = { project: input.project, ticket: input.ticket }
        const sources = yield* workerOf(at)
        const stream = yield* sources.workers.watchTranscript(
          input.ticket,
          input.resume,
        )
        return yield* Option.match(stream, {
          onNone: () => Effect.fail(new WorkerNotFound({ ...at })),
          onSome: Effect.succeed,
        })
      }),
    )

  return Runs.of({
    start,
    stop: project => Effect.flatMap(goingRun(project), run => run.control.stop),
    drain: project =>
      Effect.flatMap(goingRun(project), run => run.control.drain),
    undrain: project =>
      Effect.flatMap(goingRun(project), run => run.control.undrain),
    status,
    watchEvents,
    watchView,
    message,
    interrupt,
    release,
    watchTranscript,
  })
})

/** The Runs service, its runs in the engine's runs scope. */
export const layer = Layer.effect(Runs, make)
