import { Option, Schema } from 'effect'

import { CommitHash, TicketId } from './ids'

// A ticket's phase in a run, and the one table of what each phase counts as (spec §13, State, H58).
// The console, the report, the notifications and the end line all read `phaseFacts`, so they say
// the same of a ticket; the table is keyed by every phase and each entry gives every fact, so a new
// phase doesn't compile until each of its facts is given. Tags and literals are snake_case, as the
// event stream writes them; the reasons a ticket is set aside are the log's words.

/** Text with something in it besides whitespace. */
const Text = Schema.String.check(Schema.isPattern(/\S/))

/** A place, an attempt or a round: counted from 1. */
const Ordinal = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** What holds a ready ticket back besides a free slot (§13.4). */
export const HoldBack = Schema.Literals(['overlap', 'parent', 'merge', 'solo'])
export type HoldBack = typeof HoldBack.Type

/** What a ticket back in the queue waits for before it is ready again. */
export const WaitFor = Schema.TaggedUnion({
  /** Tickets it found it needs to merge first (`wait_for`, `WAITS_FOR_MERGE`, §13.5). */
  merge: { tickets: Schema.NonEmptyArray(TicketId) },
  /** A merge or a probe: its worktree's setup failed (`SETUP_FAILED`, §13.8). */
  setup: {},
  /** The environment probe: an environment hold put it back (§14.1). */
  probe: {},
})
export type WaitFor = typeof WaitFor.Type

/** A merge's named steps, one handler each (§13.7). */
export const MergeStep = Schema.Literals([
  'enter',
  'locate',
  'rebase',
  'check',
  'confirm',
  'fast_forward',
])
export type MergeStep = typeof MergeStep.Type

/**
 * Why a ticket is set aside (§2.1, Set aside): deferred, or left for review. Its worktree and session
 * are kept; undeferred, it resumes them (H76).
 */
export const SetAsideReason = Schema.Literals([
  /** Its worker deferred it (`defer`, §13.5). */
  'DEFERRED',
  /** Its merge check failed outside its own code, to be checked again once Base moves, or its fixes ran out (§13.7). */
  'CHECKS_FAILED',
  /** Its rebase conflicts outlasted the resolve hand-backs (§13.7). */
  'MERGE_CONFLICT',
  /** It reached the queue with uncommitted or untracked files (§13.7). */
  'CLOSED_UNCOMMITTED',
  /** A setup or check left tracked files changed in its worktree (§13.7). */
  'DIRTY_WORKTREE',
  /** A git read that steers its merge still failed after its retries (§13.7, H59). */
  'GIT_FAILED',
  /** Its branch or Base moved on during every check, past the merge turn's budget (§13.7). */
  'BASE_KEPT_MOVING',
  /** Its worker ran past `ticket_limit` (§14.5). */
  'TICKET_LIMIT',
  /** Its worker settled twice with no outcome (§12.3, §14.5). */
  'UNFINISHED',
  /** Its worker gave no events for `stuck_after`, twice (§12.8). */
  'AGENT_STUCK',
  /** A tool failed under its worker (§12.8). */
  'TOOL_DEFECT',
  /** It went over its budget (§14.4). */
  'BUDGET_EXCEEDED',
  /** A hand-back waited on a request nobody answered through the night (§15.6). */
  'HAND_BACK_NOT_DONE',
])
export type SetAsideReason = typeof SetAsideReason.Type

/** A ticket's phase in the run. */
export const Phase = Schema.TaggedUnion({
  /** Ready, waiting for a free slot. */
  queued: {},
  /** Ready, waiting for something other than a slot; `detail` says why in words, as the log does (H81). */
  held_back: { reason: HoldBack, detail: Text },
  /** Back in the queue until what it waits for comes. */
  waiting: { for: WaitFor },
  /** Its worker at it. */
  working: {},
  /** The verifier checking what its worker finished (§13.6). */
  verifying: { round: Ordinal },
  /** Verified, waiting for its turn in the merge queue; place 1 is next. */
  waiting_to_merge: { place: Ordinal },
  /** Its merge under way. */
  merging: { step: MergeStep },
  /** Its rebase's conflicts handed back to its worker. */
  resolving: { attempt: Ordinal },
  /** Its failing merge check handed back to its worker. */
  fixing: { attempt: Ordinal },
  /** Waiting on a question for the maintainer. */
  asked: { question: TicketId },
  /** Set aside, out of this run until undeferred. */
  set_aside: { reason: SetAsideReason },
  /** Its worker was at it as the run stopped: saved for the next run to resume (§13.10). */
  stopped: {},
  /** Fast-forwarded onto Base at `commit`. */
  merged: { commit: CommitHash },
  /** Closed with no change of its own to merge. */
  no_change: {},
})
export type Phase = typeof Phase.Type

/** A phase's name, as the event stream's `phase` and `ticket_end` records give it. */
export const PhaseTag = Schema.Literals([
  'queued',
  'held_back',
  'waiting',
  'working',
  'verifying',
  'waiting_to_merge',
  'merging',
  'resolving',
  'fixing',
  'asked',
  'set_aside',
  'stopped',
  'merged',
  'no_change',
])
export type PhaseTag = typeof PhaseTag.Type

// The names are the phases' tags, no more and no fewer.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const _samePhaseTags: Same<PhaseTag, Phase['_tag']> = true

/** What a ticket counts as wherever tickets are counted: the console's stats row, the report, the end line. */
export const CountsAs = Schema.Literals([
  'in_queue',
  'working',
  'waiting_to_merge',
  'needs_you',
  'set_aside',
  'carried_over',
  'done',
])
export type CountsAs = typeof CountsAs.Type

/** The console's phase bar's segments (§18.3, H45); a hand-back is marked on `merging`. */
export const BarSegment = Schema.Literals([
  'working',
  'verifying',
  'waiting_to_merge',
  'merging',
])
export type BarSegment = typeof BarSegment.Type

/** The phases a ticket's time is counted in: orchestra's names (H65), `verifying` added. */
export const PhaseTime = Schema.Literals([
  'working',
  'verifying',
  'waiting',
  'merging',
  'resolving',
  'fixing',
])
export type PhaseTime = typeof PhaseTime.Type

/** How a ticket's part in the run ended, as its `ticket_end` record says (§13.12). */
export const TicketOutcome = Schema.Literals([
  'merged',
  'no_change',
  'set_aside',
  'needs_you',
  'stopped',
  'queued',
])
export type TicketOutcome = typeof TicketOutcome.Type

/** What is so of a ticket in a phase. */
export interface PhaseFacts {
  readonly counts: CountsAs
  /** Its worker, or its verifier, takes one of the run's slots. */
  readonly takesSlot: boolean
  /** Its work is done and not merged: it holds on its branch's files, at most `concurrent` such (§13.4). */
  readonly pastWork: boolean
  /** Its segment on the phase bar, while it is in progress. */
  readonly bar: Option.Option<BarSegment>
  /** Handed back to its worker, marked on the bar's merging segment. */
  readonly handBack: boolean
  /** The phase its time counts in, on `closed`, `deferred` and `ticket_end`. */
  readonly timeIn: Option.Option<PhaseTime>
  /** How its part in the run ends, if it can end in this phase; the run's end stops the others first. */
  readonly ends: Option.Option<TicketOutcome>
}

/** What each phase counts as: the one table (H58). Every entry gives every fact. */
export const phaseFacts: { readonly [T in PhaseTag]: PhaseFacts } = {
  queued: {
    counts: 'in_queue',
    takesSlot: false,
    pastWork: false,
    bar: Option.none(),
    handBack: false,
    timeIn: Option.none(),
    ends: Option.some('queued'),
  },
  held_back: {
    counts: 'in_queue',
    takesSlot: false,
    pastWork: false,
    bar: Option.none(),
    handBack: false,
    timeIn: Option.none(),
    ends: Option.some('queued'),
  },
  waiting: {
    counts: 'in_queue',
    takesSlot: false,
    pastWork: false,
    bar: Option.none(),
    handBack: false,
    timeIn: Option.none(),
    ends: Option.some('queued'),
  },
  working: {
    counts: 'working',
    takesSlot: true,
    pastWork: false,
    bar: Option.some('working'),
    handBack: false,
    timeIn: Option.some('working'),
    ends: Option.none(),
  },
  verifying: {
    counts: 'working',
    takesSlot: true,
    pastWork: false,
    bar: Option.some('verifying'),
    handBack: false,
    timeIn: Option.some('verifying'),
    ends: Option.none(),
  },
  waiting_to_merge: {
    counts: 'waiting_to_merge',
    takesSlot: false,
    pastWork: true,
    bar: Option.some('waiting_to_merge'),
    handBack: false,
    timeIn: Option.some('waiting'),
    ends: Option.none(),
  },
  merging: {
    counts: 'waiting_to_merge',
    takesSlot: false,
    pastWork: true,
    bar: Option.some('merging'),
    handBack: false,
    timeIn: Option.some('merging'),
    ends: Option.none(),
  },
  resolving: {
    counts: 'working',
    takesSlot: true,
    pastWork: true,
    bar: Option.some('merging'),
    handBack: true,
    timeIn: Option.some('resolving'),
    ends: Option.none(),
  },
  fixing: {
    counts: 'working',
    takesSlot: true,
    pastWork: true,
    bar: Option.some('merging'),
    handBack: true,
    timeIn: Option.some('fixing'),
    ends: Option.none(),
  },
  asked: {
    counts: 'needs_you',
    takesSlot: false,
    pastWork: false,
    bar: Option.none(),
    handBack: false,
    timeIn: Option.none(),
    ends: Option.some('needs_you'),
  },
  set_aside: {
    counts: 'set_aside',
    takesSlot: false,
    pastWork: false,
    bar: Option.none(),
    handBack: false,
    timeIn: Option.none(),
    ends: Option.some('set_aside'),
  },
  stopped: {
    counts: 'carried_over',
    takesSlot: false,
    pastWork: false,
    bar: Option.none(),
    handBack: false,
    timeIn: Option.none(),
    ends: Option.some('stopped'),
  },
  merged: {
    counts: 'done',
    takesSlot: false,
    pastWork: false,
    bar: Option.none(),
    handBack: false,
    timeIn: Option.none(),
    ends: Option.some('merged'),
  },
  no_change: {
    counts: 'done',
    takesSlot: false,
    pastWork: false,
    bar: Option.none(),
    handBack: false,
    timeIn: Option.none(),
    ends: Option.some('no_change'),
  },
}

/** What `phase` counts as, and the rest of its facts. */
export const factsOf = (phase: Phase): PhaseFacts => phaseFacts[phase._tag]

/** Seconds, never negative (§13.12): durations are measured on a monotonic clock (§7.7). */
export const Seconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
export type Seconds = typeof Seconds.Type

/** Seconds a ticket spent in each phase it entered, to a tenth (orchestra's `phases`, H65). */
export const PhaseSeconds = Schema.Struct({
  // A key for each `PhaseTime`, and no other.
  working: Schema.optionalKey(Seconds),
  verifying: Schema.optionalKey(Seconds),
  waiting: Schema.optionalKey(Seconds),
  merging: Schema.optionalKey(Seconds),
  resolving: Schema.optionalKey(Seconds),
  fixing: Schema.optionalKey(Seconds),
} satisfies { readonly [K in PhaseTime]: unknown })
export type PhaseSeconds = typeof PhaseSeconds.Type
