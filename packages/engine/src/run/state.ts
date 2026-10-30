import { Effect, Option, SynchronizedRef } from 'effect'

import {
  Phase,
  type PhaseTag,
  type TicketId,
  type TicketOutcome,
  factsOf,
} from '@fabrica/contracts'

import { type Spend, spendFields } from '../cost'
import { type RunLog, toSeconds } from '../runlog'
import { type Stopwatch, elapsed, startStopwatch } from '../time'
import { record } from './records'

// The run's state (spec §13, State, H58): each ticket's phase and the run's dispatch count, with one
// owner, changed only by atomic transitions applied to the current value. Each transition writes its
// `phase` record (and, where the ticket's part in the run ends, its `ticket_end`) while it holds the
// state, so the stream gives the phases in the order they were taken; a `ticket_end` carries what its
// ticket spent in the run so far (§14.4). What a phase counts as is `phaseFacts`', read here and
// nowhere restated. A ticket's part in the run ending where it goes (from in progress to a phase it
// can end in) is told to `left`, once the move is made: its worker's transcript stops being watched
// (§8.3).

/** A ticket the run has taken up. */
export interface TicketState {
  readonly ticket: TicketId
  readonly title: string
  readonly phase: Phase
  /** Its dispatch number, once dispatched: a dispatch after `wait_for` reuses it (§13.5). */
  readonly n: Option.Option<number>
  /** When the run first took it up. */
  readonly since: Stopwatch
}

/** The run's state as one value. */
export interface RunSnapshot {
  readonly tickets: ReadonlyMap<TicketId, TicketState>
  /** Dispatches so far, each ticket counted once. */
  readonly dispatched: number
  /** The run's end has begun: nothing more is dispatched. */
  readonly ending: boolean
}

/** The tickets whose worker, or verifier, takes one of the run's slots. */
export const slotsTaken = (snapshot: RunSnapshot): number =>
  [...snapshot.tickets.values()].filter(state => factsOf(state.phase).takesSlot)
    .length

/** Whether a ticket in `phase` is in progress: its part in the run can't end there (working, merging, …). */
const inProgressIn = (phase: Phase): boolean =>
  Option.isNone(factsOf(phase).ends)

/** The tickets in progress: their part in the run can't end where they are (working, merging, …). */
export const inProgress = (snapshot: RunSnapshot): ReadonlyArray<TicketState> =>
  [...snapshot.tickets.values()].filter(state => inProgressIn(state.phase))

/** The tickets in a phase of the tag `tag`. */
export const inPhase = (
  snapshot: RunSnapshot,
  tag: PhaseTag,
): ReadonlyArray<TicketState> =>
  [...snapshot.tickets.values()].filter(state => state.phase._tag === tag)

/**
 * The end phases a ticket's `ticket_end` is written on entering. A ticket back in the queue (queued,
 * held back, waiting) or stopped gets its `ticket_end` as the run ends, if it is still there.
 */
const endsOnEntering = (phase: Phase): Option.Option<TicketOutcome> =>
  Option.filter(
    factsOf(phase).ends,
    outcome => outcome !== 'queued' && outcome !== 'stopped',
  )

/** Why a ticket's part ended where it did, as its `ticket_end` says. */
const whyOf: (phase: Phase) => Option.Option<string> = Phase.match({
  queued: () => Option.none(),
  held_back: ({ detail }) => Option.some(detail),
  waiting: ({ for: waitsFor }) =>
    Option.some(
      waitsFor._tag === 'merge'
        ? `waits for ${waitsFor.tickets.join(', ')} to merge`
        : `waits for a ${waitsFor._tag}`,
    ),
  working: () => Option.none(),
  verifying: () => Option.none(),
  waiting_to_merge: () => Option.none(),
  merging: () => Option.none(),
  resolving: () => Option.none(),
  fixing: () => Option.none(),
  asked: ({ question }) => Option.some(question),
  set_aside: ({ reason }) => Option.some(reason),
  stopped: () => Option.none(),
  merged: ({ commit }) => Option.some(commit),
  no_change: () => Option.none(),
})

export interface RunStateShape {
  readonly current: Effect.Effect<RunSnapshot>
  /** Takes the ticket up as queued, ready; false where the run has it already. */
  readonly enter: (input: {
    readonly ticket: TicketId
    readonly title: string
  }) => Effect.Effect<boolean>
  /**
   * Dispatches the ticket: working, with its dispatch number, its earlier one where it has one. None
   * where the end has begun, the ticket is in progress already, or a new dispatch would pass `limit`.
   */
  readonly dispatch: (input: {
    readonly ticket: TicketId
    readonly title: string
    readonly limit: Option.Option<number>
  }) => Effect.Effect<Option.Option<number>>
  /** Moves a ticket the run has to `to`, for `cause`: its state before, none where the run hasn't it. */
  readonly move: (input: {
    readonly ticket: TicketId
    readonly to: Phase
    readonly cause: string
  }) => Effect.Effect<Option.Option<TicketState>>
  /** Begins the end: no further dispatch. The state as it began. */
  readonly end: Effect.Effect<RunSnapshot>
  /** Writes the `ticket_end` of every ticket left queued, waiting or stopped, as the run ends. */
  readonly endLeft: Effect.Effect<void>
}

/**
 * A run's state, empty, its records written through `log`, a ticket's spend read from `spent`, each
 * ticket whose part ends told to `left`.
 */
export const makeRunState = Effect.fn('RunState.make')(function* (
  log: RunLog['Service'],
  spent: (ticket: TicketId) => Effect.Effect<Spend>,
  left: (ticket: TicketId) => Effect.Effect<void> = () => Effect.void,
) {
  const state = yield* SynchronizedRef.make<RunSnapshot>({
    tickets: new Map(),
    dispatched: 0,
    ending: false,
  })

  const ticketEnd = (taken: TicketState, outcome: TicketOutcome) =>
    Effect.flatMap(
      Effect.all([elapsed(taken.since), spent(taken.ticket)]),
      ([span, spend]) =>
        record(log, {
          kind: 'ticket_end',
          ticket: taken.ticket,
          outcome,
          phase: taken.phase._tag,
          ...Option.match(whyOf(taken.phase), {
            onNone: () => ({}),
            onSome: why => ({ why }),
          }),
          seconds: toSeconds(span),
          ...spendFields(spend),
        }),
    )

  /** Writes the move's records: its phase, and its `ticket_end` where its part ends there. */
  const written = (
    before: Option.Option<TicketState>,
    after: TicketState,
    cause: string,
  ) =>
    Effect.gen(function* () {
      yield* record(log, {
        kind: 'phase',
        ticket: after.ticket,
        ...Option.match(before, {
          onNone: () => ({}),
          onSome: ({ phase }) => ({ from: phase._tag }),
        }),
        to: after.phase._tag,
        cause,
      })
      yield* Option.match(endsOnEntering(after.phase), {
        onNone: () => Effect.void,
        onSome: outcome => ticketEnd(after, outcome),
      })
    })

  const put = (
    current: RunSnapshot,
    after: TicketState,
    dispatched = current.dispatched,
  ): RunSnapshot => ({
    ...current,
    dispatched,
    tickets: new Map(current.tickets).set(after.ticket, after),
  })

  const enter = (input: {
    readonly ticket: TicketId
    readonly title: string
  }) =>
    SynchronizedRef.modifyEffect(state, current =>
      current.tickets.has(input.ticket)
        ? Effect.succeed([false, current] as const)
        : Effect.gen(function* () {
            const after: TicketState = {
              ticket: input.ticket,
              title: input.title,
              phase: Phase.cases.queued.make({}),
              n: Option.none(),
              since: yield* startStopwatch,
            }
            yield* written(Option.none(), after, 'ready')
            return [true, put(current, after)] as const
          }),
    )

  const dispatch = (input: {
    readonly ticket: TicketId
    readonly title: string
    readonly limit: Option.Option<number>
  }) =>
    SynchronizedRef.modifyEffect(state, current =>
      Effect.gen(function* () {
        const before = Option.fromUndefinedOr(current.tickets.get(input.ticket))
        const earlier = Option.flatMap(before, ({ n }) => n)
        const busy = Option.exists(before, ({ phase }) => inProgressIn(phase))
        const n = Option.getOrElse(earlier, () => current.dispatched + 1)
        const past =
          Option.isNone(earlier) && Option.exists(input.limit, most => n > most)
        if (current.ending || busy || past)
          return [Option.none<number>(), current] as const
        const after: TicketState = {
          ticket: input.ticket,
          title: input.title,
          phase: Phase.cases.working.make({}),
          n: Option.some(n),
          since: Option.isSome(before)
            ? before.value.since
            : yield* startStopwatch,
        }
        yield* written(before, after, 'dispatched')
        return [
          Option.some(n),
          put(current, after, Math.max(current.dispatched, n)),
        ] as const
      }),
    )

  const move = (input: {
    readonly ticket: TicketId
    readonly to: Phase
    readonly cause: string
  }) =>
    SynchronizedRef.modifyEffect(state, current =>
      Option.match(Option.fromUndefinedOr(current.tickets.get(input.ticket)), {
        onNone: () =>
          Effect.succeed([Option.none<TicketState>(), current] as const),
        onSome: before =>
          Effect.gen(function* () {
            const after: TicketState = { ...before, phase: input.to }
            yield* written(Option.some(before), after, input.cause)
            return [Option.some(before), put(current, after)] as const
          }),
      }),
    ).pipe(
      Effect.tap(before =>
        Option.exists(before, ({ phase }) => inProgressIn(phase)) &&
        !inProgressIn(input.to)
          ? left(input.ticket)
          : Effect.void,
      ),
    )

  const end = SynchronizedRef.modify(state, current => [
    current,
    { ...current, ending: true },
  ])

  const endLeft = SynchronizedRef.get(state).pipe(
    Effect.flatMap(current =>
      Effect.forEach(
        [...current.tickets.values()],
        taken =>
          Option.match(
            Option.filter(
              factsOf(taken.phase).ends,
              outcome => outcome === 'queued' || outcome === 'stopped',
            ),
            {
              onNone: () => Effect.void,
              onSome: outcome => ticketEnd(taken, outcome),
            },
          ),
        { discard: true },
      ),
    ),
  )

  return {
    current: SynchronizedRef.get(state),
    enter,
    dispatch,
    move,
    end,
    endLeft,
  } satisfies RunStateShape
})
