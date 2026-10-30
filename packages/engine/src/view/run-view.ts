import { DateTime, Duration, Effect, Option, Ref, Scope, Stream } from 'effect'

import {
  type Phase,
  type Resume,
  type RunHeader,
  type Ticket,
  type TicketId,
  factsOf,
} from '@fabrica/contracts'

import type { MergeLine } from '../merge'
import type { RunStateShape } from '../run/state'
import { type WorkGraphShape, doneToday } from '../workgraph'
import { type WorkerDesk, makeWorkerDesk } from './desk'
import { type RunViewItem, makeViewFeed } from './feed'
import { type TicketFacts, type ViewInputs, projectView } from './project'
import { type Steps, makeSteps } from './steps'

// A run's view (spec §8.3, H40, H80): what the run writes into it (its state and merge line once its
// start checks pass, the work graph's facts of the tickets it reads, its steps, its workers), and the
// fiber that writes the view from them: each `view_interval`, it reads every input once, projects the
// view keeping each part that says what it said, and publishes only a view that changed. Done today is
// read from the work graph as the view starts, on each change of the work graph, and again as the
// host's day changes, under its zone. The view lives in the scope it is made in, and ends with it.

/** What a run writes into its view. */
export interface RunViewSources {
  readonly steps: Steps
  readonly workers: WorkerDesk
  /** The run's state, its merge queue's line and its slots, once its start checks pass. */
  readonly attach: (parts: {
    readonly state: RunStateShape
    readonly line: Effect.Effect<MergeLine>
    readonly slots: number
  }) => Effect.Effect<void>
  /** The work graph's facts of tickets the run reads: their type, priority and whether solo. */
  readonly seen: (
    tickets: ReadonlyArray<Ticket>,
    solo: (ticket: Ticket) => boolean,
  ) => Effect.Effect<void>
  /** Whether the ticket is in the merge queue's line, merging or waiting; false before the run has one. */
  readonly inLine: (ticket: TicketId) => Effect.Effect<boolean>
  /** Whether the ticket is the run's and in progress: its part in the run can't end where it is. */
  readonly inProgress: (ticket: TicketId) => Effect.Effect<boolean>
}

/** A run's view: what its run writes into, and its stream. */
export interface RunViewHandle {
  readonly sources: RunViewSources
  readonly watch: (resume: Option.Option<Resume>) => Stream.Stream<RunViewItem>
}

interface Attached {
  readonly state: RunStateShape
  readonly line: Effect.Effect<MergeLine>
  readonly slots: number
}

/** Sources nothing has written into yet, their transcripts crossing once per `flush`. */
export const makeRunViewSources = Effect.fn('RunView.sources')(
  function* (options: {
    readonly flush: Duration.Duration
    readonly scope: Scope.Scope
  }) {
    const steps = yield* makeSteps
    const workers = yield* makeWorkerDesk(options)
    const attached = yield* Ref.make(Option.none<Attached>())
    const facts = yield* Ref.make<ReadonlyMap<TicketId, TicketFacts>>(new Map())

    const seen = (
      tickets: ReadonlyArray<Ticket>,
      solo: (ticket: Ticket) => boolean,
    ) =>
      Ref.update(facts, known => {
        const next = new Map(known)
        for (const ticket of tickets)
          next.set(ticket.id, {
            type: ticket.type,
            priority: ticket.priority,
            solo: solo(ticket),
          })
        return next
      })

    const inLine = (ticket: TicketId) =>
      Effect.flatMap(
        Ref.get(attached),
        Option.match({
          onNone: () => Effect.succeed(false),
          onSome: ({ line }) =>
            Effect.map(
              line,
              now =>
                Option.contains(now.merging, ticket) ||
                now.waiting.includes(ticket),
            ),
        }),
      )

    const inProgress = (ticket: TicketId) =>
      Effect.flatMap(
        Ref.get(attached),
        Option.match({
          onNone: () => Effect.succeed(false),
          onSome: ({ state }) =>
            Effect.map(state.current, snapshot => {
              const taken = snapshot.tickets.get(ticket)
              return taken !== undefined && !endsWhereItIs(taken.phase)
            }),
        }),
      )

    const sources: RunViewSources = {
      steps,
      workers,
      attach: parts => Ref.set(attached, Option.some(parts)),
      seen,
      inLine,
      inProgress,
    }
    return { sources, attached, facts }
  },
)

/** Whether a ticket's part in the run can end in its phase. */
const endsWhereItIs = (phase: Phase): boolean =>
  Option.isSome(factsOf(phase).ends)

/** The time until the host's next local midnight, in whole milliseconds, under its zone. */
const untilMidnight = Effect.map(DateTime.nowInCurrentZone, now =>
  Duration.millis(
    Math.max(
      1,
      DateTime.toEpochMillis(
        DateTime.startOf(DateTime.add(now, { days: 1 }), 'day'),
      ) - DateTime.toEpochMillis(now),
    ),
  ),
)

/**
 * The run's view, in the scope: its header read from `header`, written at most every `interval`
 * (`view_interval`), Done today read from `graph`, transcripts crossing once per `flush`.
 */
export const makeRunView = Effect.fn('RunView.make')(function* (options: {
  readonly header: Effect.Effect<RunHeader>
  readonly interval: Duration.Duration
  readonly flush: Duration.Duration
  readonly graph: Pick<WorkGraphShape, 'doneSince' | 'changes'>
  readonly scope: Scope.Scope
}) {
  const { sources, attached, facts } = yield* makeRunViewSources({
    flush: options.flush,
    scope: options.scope,
  })
  const { graph } = options

  // Done today: as the view starts, on every change of the work graph, and as the day changes.
  const done = yield* Ref.make(0)
  const readDone = doneToday(graph).pipe(
    Effect.flatMap(count => Ref.set(done, count)),
    Effect.catch(error =>
      Effect.logWarning(`Done today couldn't be read: ${error.message}`),
    ),
  )
  yield* readDone
  yield* Effect.forkIn(
    Effect.gen(function* () {
      const changes = yield* graph.changes
      yield* changes.pipe(Stream.runForEach(() => readDone))
    }).pipe(
      Effect.scoped,
      Effect.catch(error =>
        Effect.logWarning(
          `Done today won't follow the work graph's changes: ${error.message}`,
        ),
      ),
    ),
    options.scope,
  )
  yield* Effect.forkIn(
    Effect.forever(
      Effect.andThen(Effect.flatMap(untilMidnight, Effect.sleep), readDone),
    ),
    options.scope,
  )

  /** Every input of one write, each read once, side by side. */
  const inputs: Effect.Effect<ViewInputs> = Effect.gen(function* () {
    const parts = yield* Ref.get(attached)
    const [header, now, snapshot, line, workers, steps, doneNow, known] =
      yield* Effect.all(
        [
          options.header,
          DateTime.now,
          Option.match(parts, {
            onNone: () => Effect.succeed(Option.none()),
            onSome: ({ state }) => Effect.map(state.current, Option.some),
          }),
          Option.match(parts, {
            onNone: () =>
              Effect.succeed<MergeLine>({
                merging: Option.none(),
                waiting: [],
              }),
            onSome: ({ line: read }) => read,
          }),
          sources.workers.current,
          sources.steps.current,
          Ref.get(done),
          Ref.get(facts),
        ],
        { concurrency: 'unbounded' },
      )
    return {
      header,
      now,
      tickets: Option.match(snapshot, {
        onNone: () => [],
        onSome: ({ tickets }) =>
          [...tickets.values()].map(taken => ({
            ticket: taken.ticket,
            title: taken.title,
            phase: taken.phase,
            dispatched: Option.isSome(taken.n),
          })),
      }),
      facts: known,
      slots: Option.match(parts, {
        onNone: () => 0,
        onSome: ({ slots }) => slots,
      }),
      line,
      workers,
      steps,
      doneToday: doneNow,
      tokens: yield* sources.workers.tokens,
      // The holds as one state, the attention requests and the host's load come with their services.
      holds: [],
      attention: [],
      load: Option.none(),
    } satisfies ViewInputs
  })

  const feed = yield* makeViewFeed(projectView(yield* inputs, Option.none()))
  yield* Effect.forkIn(
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(options.interval)
        const read = yield* inputs
        yield* feed.publish(projectView(read, Option.some(yield* feed.current)))
      }),
    ),
    options.scope,
  )
  yield* Scope.addFinalizer(options.scope, feed.end)

  return { sources, watch: feed.watch } satisfies RunViewHandle
})
