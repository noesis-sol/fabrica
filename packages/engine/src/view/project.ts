import { type DateTime, Option } from 'effect'

import {
  type AttentionRequest,
  Banner,
  type Counts,
  type CountsAs,
  EngineStep,
  type Hold,
  type HostLoad,
  MergeQueue,
  type Phase,
  type Priority,
  type RunHeader,
  type RunView,
  type TicketId,
  TicketRow,
  type TicketType,
  type Tokens,
  Totals,
  WorkerRow,
  attentionKey,
  factsOf,
} from '@fabrica/contracts'

import { noTokens } from '../cost'
import type { WorkerLive } from './desk'

// The run view's projection (spec §8.3, §18.3): the console's parts of a run made from the plain values
// read for one write, and the view before. Every part, and every row of a list, that says what it said
// before is the value it was, so a patch names only what changed and a client redraws only that
// (tutti spec §3.5). A ticket's row says since when it is in its phase, when the run first dispatched it,
// and how many times it was handed back, which the view keeps from one write to the next.

/** What a ticket's row says of it beside its phase, as the work graph has it. */
export interface TicketFacts {
  readonly type: TicketType
  readonly priority: Priority
  readonly solo: boolean
}

/** A ticket the run has taken up, as its state has it. */
export interface TicketTaken {
  readonly ticket: TicketId
  readonly title: string
  readonly phase: Phase
  /** It has been dispatched. */
  readonly dispatched: boolean
}

/** The merge queue's line as the queue has it. */
export interface LineInput {
  readonly merging: Option.Option<TicketId>
  readonly waiting: ReadonlyArray<TicketId>
}

/** Everything one write of the view reads, each read once. */
export interface ViewInputs {
  readonly header: RunHeader
  readonly now: DateTime.Utc
  readonly tickets: ReadonlyArray<TicketTaken>
  readonly facts: ReadonlyMap<TicketId, TicketFacts>
  /** The run's slots: `concurrent`; 0 until the start's checks pass. */
  readonly slots: number
  readonly line: LineInput
  /** Why the ticket merging waits: `MERGES_WAIT: <checkout> has uncommitted changes to …` (H72). */
  readonly mergesWait: Option.Option<string>
  readonly workers: ReadonlyArray<WorkerLive>
  readonly steps: ReadonlyArray<EngineStep>
  readonly doneToday: number
  /** What each ticket's sessions spent in the run, as the model proxy counted their calls. */
  readonly spent: ReadonlyMap<TicketId, Tokens>
  /** What the run's workers spent, as the model proxy counted their calls. */
  readonly tokens: Tokens
  readonly holds: ReadonlyArray<Hold>
  readonly attention: ReadonlyArray<AttentionRequest>
  readonly load: Option.Option<HostLoad>
}

/** A ticket's facts where the work graph's aren't known: a task at the middle priority. */
const unknownFacts: TicketFacts = { type: 'task', priority: 2, solo: false }

/** Whether two values say the same, as they cross. */
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/** `next`, or `before` where it says the same. */
const kept = <A>(before: Option.Option<A>, next: A): A =>
  Option.isSome(before) && same(before.value, next) ? before.value : next

/** `next`, or `before` where every item is the same value as before, in the same order. */
const keptList = <A>(
  before: Option.Option<ReadonlyArray<A>>,
  next: ReadonlyArray<A>,
): ReadonlyArray<A> =>
  Option.isSome(before) &&
  before.value.length === next.length &&
  before.value.every((item, n) => item === next[n])
    ? before.value
    : next

/** Each row of `next` the row before with its key where they say the same. */
const keptRows = <A>(
  before: Option.Option<ReadonlyArray<A>>,
  next: ReadonlyArray<A>,
  keyOf: (row: A) => string,
): ReadonlyArray<A> => {
  const earlier = new Map(
    Option.getOrElse(before, (): ReadonlyArray<A> => []).map(row => [
      keyOf(row),
      row,
    ]),
  )
  return keptList(
    before,
    next.map(row => kept(Option.fromUndefinedOr(earlier.get(keyOf(row))), row)),
  )
}

const zeroCounts: Counts = {
  in_queue: 0,
  working: 0,
  waiting_to_merge: 0,
  needs_you: 0,
  set_aside: 0,
  carried_over: 0,
  done: 0,
}

/** How many tickets count as each of `CountsAs`. */
const countsOf = (tickets: ReadonlyArray<TicketTaken>): Counts => {
  const counts: Record<CountsAs, number> = { ...zeroCounts }
  for (const { phase } of tickets) counts[factsOf(phase).counts] += 1
  return counts
}

/** The ticket's row, its times and hand-backs kept from its row before. */
const rowOf = (
  taken: TicketTaken,
  facts: TicketFacts,
  before: Option.Option<TicketRow>,
  now: DateTime.Utc,
): TicketRow => {
  const earlier = Option.getOrUndefined(before)
  const samePhase = earlier !== undefined && same(earlier.phase, taken.phase)
  const attempt = (tag: 'resolving' | 'fixing', was: number) =>
    taken.phase._tag === tag ? Math.max(was, taken.phase.attempt) : was
  return new TicketRow({
    ticket: taken.ticket,
    title: taken.title,
    type: facts.type,
    priority: facts.priority,
    phase: taken.phase,
    since: samePhase ? earlier.since : now,
    startedAt: Option.orElse(
      Option.flatMap(before, row => row.startedAt),
      () => (taken.dispatched ? Option.some(now) : Option.none()),
    ),
    solo: facts.solo,
    handBacks: {
      resolve: attempt('resolving', earlier?.handBacks.resolve ?? 0),
      fix: attempt('fixing', earlier?.handBacks.fix ?? 0),
    },
  })
}

/**
 * The banners a run's state puts over its stats row: a hold's, a drain's or a stop's, and a warning
 * while its merges wait on Base's checkout.
 */
const bannersOf = (
  header: RunHeader,
  holds: ReadonlyArray<Hold>,
  mergesWait: Option.Option<string>,
): ReadonlyArray<Banner> => [
  ...holds.map(
    hold => new Banner({ tone: 'hold', text: hold.reason, lifts: hold.lifts }),
  ),
  ...(header.state === 'draining'
    ? [
        new Banner({
          tone: 'stop',
          text: 'Draining: no new tickets; the running ones finish and merge',
          lifts: Option.none(),
        }),
      ]
    : header.state === 'stopping'
      ? [
          new Banner({
            tone: 'stop',
            text: 'Stopping: the workers are closing',
            lifts: Option.none(),
          }),
        ]
      : []),
  ...Option.match(mergesWait, {
    onNone: () => [],
    onSome: text => [
      new Banner({ tone: 'warning', text, lifts: Option.none() }),
    ],
  }),
]

/** The view of `inputs`, every part that says what it said in `before` kept as it was. */
export const projectView = (
  inputs: ViewInputs,
  before: Option.Option<RunView>,
): RunView => {
  const part = <K extends keyof RunView>(key: K) =>
    Option.map(before, view => view[key])
  const earlierRows = new Map(
    Option.getOrElse(part('tickets'), (): ReadonlyArray<TicketRow> => []).map(
      row => [row.ticket, row],
    ),
  )
  const tickets = keptRows(
    part('tickets'),
    inputs.tickets.map(taken =>
      rowOf(
        taken,
        inputs.facts.get(taken.ticket) ?? unknownFacts,
        Option.fromUndefinedOr(earlierRows.get(taken.ticket)),
        inputs.now,
      ),
    ),
    row => row.ticket,
  )
  // A merge check is a step of the merge queue's, under way since its ticket took the step.
  const steps = [
    ...inputs.steps,
    ...tickets.flatMap(row =>
      row.phase._tag === 'merging' && row.phase.step === 'check'
        ? [
            new EngineStep({
              step: 'merge_check',
              ticket: Option.some(row.ticket),
              startedAt: row.since,
            }),
          ]
        : [],
    ),
  ]
  const earlierSteps = Option.getOrElse(
    part('steps'),
    (): ReadonlyArray<EngineStep> => [],
  )
  // A worker is on the view while its ticket is in progress (its part in the run can't end there).
  const inProgress = new Set(
    inputs.tickets
      .filter(({ phase }) => Option.isNone(factsOf(phase).ends))
      .map(({ ticket }) => ticket),
  )
  const workers = inputs.workers
    .filter(({ ticket }) => inProgress.has(ticket))
    .map(
      worker =>
        new WorkerRow({
          ticket: worker.ticket,
          session: worker.session,
          model: worker.model,
          startedAt: worker.startedAt,
          action: worker.action,
          context: Option.none(),
          tokens: inputs.spent.get(worker.ticket) ?? noTokens,
          steered: worker.steered,
        }),
    )
  const live = inputs.tickets.filter(
    ({ phase }) => factsOf(phase).takesSlot,
  ).length
  return {
    header: kept(part('header'), inputs.header),
    totals: kept(
      part('totals'),
      new Totals({
        live,
        slots: inputs.slots,
        counts: countsOf(inputs.tickets),
        doneToday: inputs.doneToday,
        tokens: inputs.tokens,
        costUsd: Option.none(),
      }),
    ),
    tickets,
    workers: keptRows(part('workers'), workers, row => row.ticket),
    queue: kept(
      part('queue'),
      new MergeQueue({
        merging: inputs.line.merging,
        train: Option.none(),
        waiting: inputs.line.waiting,
      }),
    ),
    holds: keptRows(part('holds'), inputs.holds, hold => hold.kind),
    banners: kept(
      part('banners'),
      bannersOf(inputs.header, inputs.holds, inputs.mergesWait),
    ),
    attention: keptRows(part('attention'), inputs.attention, attentionKey),
    load: kept(part('load'), inputs.load),
    steps: keptList(
      part('steps'),
      steps.map(step =>
        kept(
          Option.fromUndefinedOr(
            earlierSteps.find(earlier => same(earlier, step)),
          ),
          step,
        ),
      ),
    ),
  }
}
