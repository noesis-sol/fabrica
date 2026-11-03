import { DateTime, Duration, Effect, Option, Ref, Scope, Stream } from 'effect'

import {
  type AttentionRequest,
  type Phase,
  type ProjectNotFound,
  type Resume,
  type ReviewRequest,
  type RunHeader,
  type Ticket,
  type TicketId,
  applyAttentionPatch,
  factsOf,
} from '@fabrica/contracts'

import type { AttentionItem } from '../attention/service'
import { type Spent, noTokens, tokensOf } from '../cost'
import type { MergeLine } from '../merge'
import { type RunStateShape, slotsTaken } from '../run/state'
import { type WorkGraphShape, doneToday } from '../workgraph'
import { type WorkerDesk, makeWorkerDesk } from './desk'
import { type RunViewItem, makeViewFeed } from './feed'
import {
  type TicketFacts,
  type ViewInputs,
  needsYouOf,
  projectView,
  reviewsOf,
} from './project'
import { type Steps, makeSteps } from './steps'

// A run's view (spec §8.3, H40, H80): what the run writes into it (its state, merge line and cost
// account once its start checks pass, the work graph's facts of the tickets it reads, its steps, its
// workers), and the fiber that writes the view from them: each `view_interval`, it reads every input
// once, projects the view keeping each part that says what it said, and publishes only a view that
// changed. Done today is read from the work graph as the view starts, on each change of the work
// graph, and again as the host's day changes, under its zone. The project's open attention requests
// are followed as they change, and each write reads them as they are; the tickets it shows set aside
// are told as review requests, for the attention service to list. The view lives in the scope it is
// made in, and ends with it.

/** What a run writes into its view. */
export interface RunViewSources {
  readonly steps: Steps
  readonly workers: WorkerDesk
  /**
   * The run's state, its merge queue's line, why the ticket merging waits (`MERGES_WAIT`), its slots
   * and what its tickets spent (its cost account's), once its start checks pass.
   */
  readonly attach: (parts: Attached) => Effect.Effect<void>
  /** The work graph's facts of tickets the run reads: their type, priority and whether solo. */
  readonly seen: (
    tickets: ReadonlyArray<Ticket>,
    solo: (ticket: Ticket) => boolean,
  ) => Effect.Effect<void>
  /** Whether the ticket is in the merge queue's line, merging or waiting; false before the run has one. */
  readonly inLine: (ticket: TicketId) => Effect.Effect<boolean>
  /** Whether the ticket is the run's and in progress: its part in the run can't end where it is. */
  readonly inProgress: (ticket: TicketId) => Effect.Effect<boolean>
  /** The slots the run's tickets take, as its scheduler counts them (§13.4): its live workers; none before it has a state. */
  readonly slotsTaken: Effect.Effect<number>
}

/** A run's view: what its run writes into, and its stream. */
export interface RunViewHandle {
  readonly sources: RunViewSources
  readonly watch: (resume: Option.Option<Resume>) => Stream.Stream<RunViewItem>
}

interface Attached {
  readonly state: RunStateShape
  readonly line: Effect.Effect<MergeLine>
  readonly mergesWait: Effect.Effect<Option.Option<string>>
  readonly slots: number
  readonly spent: Effect.Effect<Spent>
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

    const taken = Effect.flatMap(
      Ref.get(attached),
      Option.match({
        onNone: () => Effect.succeed(0),
        onSome: ({ state, slots }) =>
          Effect.map(state.current, snapshot => slotsTaken(snapshot, slots)),
      }),
    )

    const sources: RunViewSources = {
      steps,
      workers,
      attach: parts => Ref.set(attached, Option.some(parts)),
      seen,
      inLine,
      inProgress,
      slotsTaken: taken,
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
 * (`view_interval`), Done today read from `graph`, the open attention requests followed from
 * `attention` (the project's, as a snapshot then patches), transcripts crossing once per `flush`;
 * `needsYou` is told how many things wait on the maintainer as that changes (the project's row, §18.3),
 * and `reviews` the tickets set aside, as review requests, as its tickets change.
 */
export const makeRunView = Effect.fn('RunView.make')(function* (options: {
  readonly header: Effect.Effect<RunHeader>
  readonly interval: Duration.Duration
  readonly flush: Duration.Duration
  readonly graph: Pick<WorkGraphShape, 'doneSince' | 'changes'>
  readonly attention: Stream.Stream<AttentionItem, ProjectNotFound>
  readonly needsYou: (count: number) => Effect.Effect<void>
  readonly reviews: (
    requests: ReadonlyArray<ReviewRequest>,
  ) => Effect.Effect<void>
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

  // The project's open attention requests, as the attention service has them.
  const requests = yield* Ref.make<ReadonlyArray<AttentionRequest>>([])
  yield* Effect.forkIn(
    options.attention.pipe(
      Stream.runForEach(item =>
        Ref.update(requests, now =>
          item._tag === 'snapshot'
            ? item.value
            : applyAttentionPatch(now, item.value),
        ),
      ),
      Effect.catch(error =>
        Effect.logWarning(
          `The run view won't follow the attention requests: no project ${error.project}`,
        ),
      ),
    ),
    options.scope,
  )

  /** Every input of one write, each read once, side by side. */
  const inputs: Effect.Effect<ViewInputs> = Effect.gen(function* () {
    const parts = yield* Ref.get(attached)
    const [
      header,
      now,
      snapshot,
      line,
      mergesWait,
      workers,
      steps,
      doneNow,
      known,
      spent,
      attention,
    ] = yield* Effect.all(
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
        Option.match(parts, {
          onNone: () => Effect.succeed(Option.none<string>()),
          onSome: ({ mergesWait: read }) => read,
        }),
        sources.workers.current,
        sources.steps.current,
        Ref.get(done),
        Ref.get(facts),
        Option.match(parts, {
          onNone: () => Effect.succeed(Option.none<Spent>()),
          onSome: ({ spent: read }) => Effect.map(read, Option.some),
        }),
        Ref.get(requests),
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
      mergesWait,
      workers,
      steps,
      doneToday: doneNow,
      // Nothing is spent before the start checks pass: no session is granted a token before.
      spent: Option.match(spent, {
        onNone: () => new Map(),
        onSome: ({ tickets }) =>
          new Map([...tickets].map(([ticket, of]) => [ticket, tokensOf(of)])),
      }),
      tokens: Option.match(spent, {
        onNone: () => noTokens,
        onSome: ({ run }) => tokensOf(run.workers),
      }),
      // The holds as one state and the host's load come with their services.
      holds: [],
      attention,
      load: Option.none(),
    } satisfies ViewInputs
  })

  const feed = yield* makeViewFeed(projectView(yield* inputs, Option.none()))
  // What waits on the maintainer, told as its count changes.
  const told = yield* Ref.make(0)
  // The tickets set aside, told as the rows change: a part that says what it said keeps its identity.
  const rowsTold = yield* Ref.make((yield* feed.current).tickets)
  const tell = Effect.gen(function* () {
    const view = yield* feed.current
    const count = needsYouOf(view)
    if ((yield* Ref.getAndSet(told, count)) !== count)
      yield* options.needsYou(count)
    if ((yield* Ref.getAndSet(rowsTold, view.tickets)) !== view.tickets)
      yield* options.reviews(reviewsOf(view))
  })
  yield* tell
  yield* Effect.forkIn(
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(options.interval)
        const read = yield* inputs
        const changed = yield* feed.publish(
          projectView(read, Option.some(yield* feed.current)),
        )
        if (changed) yield* tell
      }),
    ),
    options.scope,
  )
  yield* Scope.addFinalizer(options.scope, feed.end)

  return { sources, watch: feed.watch } satisfies RunViewHandle
})
