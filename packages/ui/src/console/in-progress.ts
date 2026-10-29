import { Array, type DateTime, Option, Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import {
  BarSegment,
  type EngineStep,
  type MergeQueue,
  type MergeStep,
  Phase,
  type TicketId,
  type TicketRow,
  type WorkerAction,
  type WorkerRow,
  factsOf,
} from '@fabrica/contracts'

import { sayElapsed } from '../app/clock'
import type { Role } from './sidebar'
import { stepWords } from './stats'

// The console's In progress column (spec §18.3, H45, H80; Appendix A.2): the run's Current (working,
// verifying, waiting to merge, merging, a hand-back) as the handoff's cards. Each card has its ID and
// title; the phase bar, a segment for each of working, verifying, waiting to merge and merging, those
// passed filled, the current one in its project's colour, a hand-back striped on merging; and the step
// with the elapsed time on the right: the engine's step for the ticket, else its worker's latest action
// (the tool and its main argument), else its place in the queue, else its phase in words. No
// percentage: Fabrica has no honest one. Every card is one height, whether or not its worker has an
// action yet, so the column doesn't jump (tutti-pgl6). Clicking a card opens its worker view.

export const Model = Schema.Struct({})
export type Model = typeof Model.Type

export const init = (): Model => ({})

/** The run's parts the column draws, each its own slice of the run view. */
export interface Slices {
  readonly tickets: ReadonlyArray<TicketRow>
  readonly workers: ReadonlyArray<WorkerRow>
  readonly queue: MergeQueue
  readonly steps: ReadonlyArray<EngineStep>
}

/** What the frame gives the column: the run's slices, the time now, the colour and the open Message. */
export interface Config<Message> extends Slices {
  readonly now: Option.Option<DateTime.Zoned>
  /** The run's project's colour, its sidebar chip's (§18.3). */
  readonly role: Role
  /** Opens a ticket's worker view: made once, so the frame's memo of the column holds. */
  readonly open: (ticket: TicketId) => Message
}

/** A card's height: its three rows and padding, whether or not its worker has an action (H80). */
export const cardHeight = '84px'

/** A ticket on the phase bar: the segment it is in, and whether it was handed back to its worker. */
export interface OnBar {
  readonly segment: BarSegment
  readonly handBack: boolean
}

/** Where `phase` puts its ticket on the phase bar: none for a phase that isn't in progress. */
export const onBar = (phase: Phase): Option.Option<OnBar> => {
  const facts = factsOf(phase)
  return Option.map(facts.bar, segment => ({
    segment,
    handBack: facts.handBack,
  }))
}

/** A segment against the ticket's own: passed, the current one, or still ahead. */
export type SegmentState = 'passed' | 'current' | 'ahead'

export const segmentState = (
  segment: BarSegment,
  current: BarSegment,
): SegmentState => {
  const at = BarSegment.literals.indexOf(segment)
  const now = BarSegment.literals.indexOf(current)
  return at < now ? 'passed' : at === now ? 'current' : 'ahead'
}

const segmentTitle: Record<BarSegment, string> = {
  working: 'Working',
  verifying: 'Verifying',
  waiting_to_merge: 'Waiting to merge',
  merging: 'Merging',
}

/** What a tool does, said as the start of the step: `bash` runs, `edit` edits. */
const toolVerbs: Record<string, string> = {
  bash: 'Running',
  edit: 'Editing',
  write: 'Writing',
  read: 'Reading',
  grep: 'Searching for',
  find: 'Finding',
  ls: 'Listing',
}

/** A worker's latest action in words: "Running scripts/check-own.sh", "Editing src/auth/refresh.ts". */
export const actionWords = (action: WorkerAction): string => {
  const verb = toolVerbs[action.tool.toLowerCase()] ?? action.tool
  return Option.match(action.argument, {
    onNone: () => verb,
    onSome: argument => `${verb} ${argument}`,
  })
}

/** A place counted from 1, as an ordinal: `1st`, `2nd`, `3rd`, `11th`, `22nd`. */
export const ordinal = (place: number): string => {
  const tens = place % 100
  const suffix =
    tens >= 11 && tens <= 13
      ? 'th'
      : place % 10 === 1
        ? 'st'
        : place % 10 === 2
          ? 'nd'
          : place % 10 === 3
            ? 'rd'
            : 'th'
  return `${place}${suffix}`
}

const mergeStepWords: Record<MergeStep, string> = {
  enter: 'Entering the merge',
  locate: 'Finding its branch',
  rebase: 'Rebasing onto Base',
  check: 'Running the merge check',
  confirm: 'Confirming the merge',
  fast_forward: 'Fast-forwarding Base',
}

/** What a ticket in `phase` is doing when nothing more is known: its place in the queue, or the phase in words. */
export const phaseWords = (
  phase: Phase,
  ticket: TicketId,
  queue: MergeQueue,
): string =>
  Phase.match(phase, {
    queued: () => 'Queued',
    held_back: ({ detail }) => detail,
    waiting: () => 'Waiting',
    working: () => 'Starting',
    verifying: ({ round }) =>
      round > 1 ? `Verifying, round ${round}` : 'Verifying',
    waiting_to_merge: ({ place }) =>
      Option.contains(queue.train, ticket)
        ? 'in the train'
        : `${ordinal(place)} to merge`,
    merging: ({ step }) => mergeStepWords[step],
    resolving: ({ attempt }) =>
      `Handed back: resolving conflicts, attempt ${attempt}`,
    fixing: ({ attempt }) =>
      `Handed back: fixing the merge check, attempt ${attempt}`,
    asked: () => 'Waiting on a question',
    set_aside: () => 'Set aside',
    stopped: () => 'Stopped',
    merged: () => 'Merged',
    no_change: () => 'No change',
  })

/** A card's step: what it says, and since when its elapsed time counts. */
export interface Step {
  readonly words: string
  readonly since: DateTime.Utc
}

/**
 * A ticket's step: the engine's step for it (its setup, its merge check) timed from its start (H80);
 * else its worker's latest action, else its place in the queue or its phase, timed from the phase's
 * start. A ticket waiting to merge says its place, whatever its worker last did.
 */
export const stepOf = ({
  row,
  worker,
  step,
  queue,
}: {
  readonly row: TicketRow
  readonly worker: Option.Option<WorkerRow>
  readonly step: Option.Option<EngineStep>
  readonly queue: MergeQueue
}): Step =>
  Option.match(step, {
    onSome: step => ({
      words: `${stepWords[step.step]}…`,
      since: step.startedAt,
    }),
    onNone: () => ({
      words: Option.match(
        Phase.guards.waiting_to_merge(row.phase)
          ? Option.none()
          : Option.flatMap(worker, ({ action }) => action),
        {
          onNone: () => phaseWords(row.phase, row.ticket, queue),
          onSome: actionWords,
        },
      ),
      since: row.since,
    }),
  })

/** A ticket in progress, as its card draws it. */
export interface Card {
  readonly row: TicketRow
  readonly bar: OnBar
  readonly step: Step
}

/** The run's Current, in the view's order, each with its place on the bar and its step. */
export const cardsOf = (config: Slices): ReadonlyArray<Card> =>
  Array.getSomes(
    config.tickets.map(row =>
      Option.map(onBar(row.phase), bar => ({
        row,
        bar,
        step: stepOf({
          row,
          worker: Array.findFirst(
            config.workers,
            worker => worker.ticket === row.ticket,
          ),
          step: Array.findFirst(config.steps, step =>
            Option.contains(step.ticket, row.ticket),
          ),
          queue: config.queue,
        }),
      })),
    ),
  )

const roleBackground: Record<Role, string> = {
  c1: 'bg-c1',
  c2: 'bg-c2',
  c3: 'bg-c3',
  c4: 'bg-c4',
  c5: 'bg-c5',
}

/** The hand-back's mark on the merging segment: stripes, so it reads without its colour (§18.2). */
const handBackStripes =
  'repeating-linear-gradient(-45deg, transparent 0 3px, var(--bg) 3px 5px)'

const segmentView = <Message>(
  segment: BarSegment,
  bar: OnBar,
  role: Role,
  h: HtmlBuilder<Message>,
): Html => {
  const state = segmentState(segment, bar.segment)
  const handBack = bar.handBack && segment === 'merging'
  return h.span([
    h.DataAttribute('segment', segment),
    h.DataAttribute('state', state),
    ...(handBack ? [h.DataAttribute('hand-back', '')] : []),
    h.Class(
      `flex-1 ${state === 'current' ? roleBackground[role] : state === 'passed' ? 'bg-muted' : 'bg-line'}`,
    ),
    h.Style(handBack ? { backgroundImage: handBackStripes } : {}),
  ])
}

const barView = <Message>(
  bar: OnBar,
  role: Role,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [
      h.Role('img'),
      h.AriaLabel(
        `Phase: ${segmentTitle[bar.segment]}${bar.handBack ? ', handed back' : ''}`,
      ),
      h.DataAttribute('phase-bar', ''),
      h.Class('flex'),
      h.Style({ height: '4px', gap: '2px' }),
    ],
    BarSegment.literals.map(segment => segmentView(segment, bar, role, h)),
  )

const cardView = <Message>(
  card: Card,
  config: Config<Message>,
  h: HtmlBuilder<Message>,
): Html => {
  const { row, bar, step } = card
  return h.keyed('button')(
    row.ticket,
    [
      h.Type('button'),
      h.DataAttribute('ticket', row.ticket),
      h.OnClick(config.open(row.ticket)),
      h.Class(
        'flex flex-none flex-col justify-between rounded-card border border-line bg-panel text-left hover:border-muted',
      ),
      h.Style({ height: cardHeight, padding: '12px 14px' }),
    ],
    [
      h.span(
        [h.Class('flex min-w-0 items-baseline gap-8')],
        [
          h.span(
            [h.Class('flex-none font-mono text-xs text-muted')],
            [row.ticket],
          ),
          h.span(
            [h.Class('truncate font-bold'), h.Style({ fontSize: '14px' })],
            [row.title],
          ),
        ],
      ),
      barView(bar, config.role, h),
      h.span(
        [h.Class('flex min-w-0 items-baseline gap-8 text-xs text-muted')],
        [
          h.span(
            [h.DataAttribute('card-step', ''), h.Class('truncate')],
            [step.words],
          ),
          h.span(
            [
              h.DataAttribute('elapsed', ''),
              h.Class('ml-auto flex-none font-mono'),
            ],
            Option.match(config.now, {
              onNone: () => [],
              onSome: now => [sayElapsed(step.since, now)],
            }),
          ),
        ],
      ),
    ],
  )
}

export const view = <Message>(
  _model: Model,
  config: Config<Message>,
  h: HtmlBuilder<Message>,
): Html => {
  const cards = cardsOf(config)
  return h.div(
    [h.Class('flex flex-col gap-8')],
    [
      h.div(
        [
          h.Class('flex items-baseline gap-8 border-b-2 border-c1'),
          h.Style({ paddingBottom: '8px' }),
        ],
        [
          h.h2(
            [h.Class('font-extrabold'), h.Style({ fontSize: '14px' })],
            ['In progress'],
          ),
          h.span(
            [
              h.DataAttribute('count', 'in-progress'),
              h.Class('text-xs text-muted'),
            ],
            [String(cards.length)],
          ),
        ],
      ),
      cards.length === 0
        ? h.p([h.Class('text-sm text-muted')], ['Nothing in progress'])
        : h.div(
            [h.Class('flex flex-col gap-8')],
            cards.map(card => cardView(card, config, h)),
          ),
    ],
  )
}
