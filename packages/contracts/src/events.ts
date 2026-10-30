import { Data, DateTime, Effect, Schema } from 'effect'

import { CommitHash, EngineId, RunId, SessionId, TicketId } from './ids'
import {
  HoldBack,
  PhaseSeconds,
  PhaseTag,
  Seconds,
  SetAsideReason,
  TicketOutcome,
} from './phases'
import { OrganName } from './ticket'

// The event stream (spec §13.12): `.fabrica/run/events.jsonl` and the `run events` RPC stream, one
// JSON object a line. orchestra's record kinds keep their names and fields (its `docs/events.md`), and
// its analysis fields theirs (H65: `check`, `phases`, `hand_backs`, `carried`, `tokens`, `organs`), so
// one set of queries reads orchestra's, tutti's and Fabrica's streams; `model`, `tokens`, `cost_usd`
// and `engine` are added, and the records since. `cost_usd` is money, the API-key calls priced at
// their model's price; `equivalent_usd` a subscription's calls, counted in tokens, at the API price
// they would have cost, shown as such (§14.4). A field without a value is left out, never `null`.
// Kinds and fields may be added, never renamed: a reader decodes the kinds it knows and skips the rest
// (`decodeEventLine`).

/** Text with something in it besides whitespace. */
const Text = Schema.String.check(Schema.isPattern(/\S/))

/** A count: a whole number, 0 or more. */
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Money, in US dollars, never negative. */
const Usd = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

/** A share, from 0 to 1. */
export const Utilization = Schema.Finite.check(
  Schema.isBetween({ minimum: 0, maximum: 1 }),
)

const optional = Schema.optionalKey

/** The record format this module writes. A record of another version is skipped, as an unknown kind is. */
export const eventVersion = 1

/**
 * A time as the stream records it: local, to the millisecond, with its UTC offset
 * (`2026-10-29T10:15:00.000+02:00`), so an engine's records compare as strings and a client in
 * another zone can show them in its own (§7.7, §13.12).
 */
export const LocalTime = Schema.String.check(
  Schema.isPattern(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/,
  ),
).pipe(Schema.brand('LocalTime'))
export type LocalTime = typeof LocalTime.Type

const twoDigits = (n: number): string => String(n).padStart(2, '0')

/** `time` as a `LocalTime`, in its own zone's offset at that moment. */
export const formatLocalTime = (time: DateTime.Zoned): LocalTime => {
  const offsetMinutes = Math.round(DateTime.zonedOffset(time) / 60_000)
  const local = new Date(
    DateTime.toEpochMillis(time) + offsetMinutes * 60_000,
  ).toISOString()
  const sign = offsetMinutes < 0 ? '-' : '+'
  const minutes = Math.abs(offsetMinutes)
  return LocalTime.make(
    `${local.slice(0, 23)}${sign}${twoDigits(Math.floor(minutes / 60))}:${twoDigits(minutes % 60)}`,
  )
}

/**
 * A model, as `<provider>/<model>` or as the provider names it. Wider than a ticket's `ModelOverride`
 * (`./ticket`), which every value of is, since orchestra's and tutti's streams, and a provider's usage
 * keyed in `tokens`, name a model without its provider (`claude-opus-5-5`) (H65).
 */
export const ModelName = Schema.String.check(Schema.isPattern(/^\S+$/))
export type ModelName = typeof ModelName.Type

/** A model provider, as Pi names it (`anthropic`, `openai`, …). */
export const ProviderName = Schema.String.check(Schema.isPattern(/^\S+$/))
export type ProviderName = typeof ProviderName.Type

/**
 * Tokens, orchestra's four (H65): `input` neither written to the prompt cache nor read from it,
 * `cache_write` written to it, `cache_read` read from it, `output` with thinking; each given, 0 included.
 */
export const Tokens = Schema.Struct({
  input: Count,
  output: Count,
  cache_write: Count,
  cache_read: Count,
})
export type Tokens = typeof Tokens.Type

/** Tokens by model. */
export const TokensByModel = Schema.Record(ModelName, Tokens)
export type TokensByModel = typeof TokensByModel.Type

/** A ticket's hand-backs in the run, both given, 0 included. */
export const HandBacks = Schema.Struct({ resolve: Count, fix: Count })
export type HandBacks = typeof HandBacks.Type

/** What the run's organ calls cost, on `end`. */
export const OrganTotals = Schema.Struct({
  calls: Count,
  turns: Count,
  cost_usd: optional(Usd),
})
export type OrganTotals = typeof OrganTotals.Type

/** How many ready tickets each reason holds back (`held_by`): a hold-back, or a setup that failed. */
export const HeldBy = Schema.Struct({
  overlap: optional(Count),
  parent: optional(Count),
  merge: optional(Count),
  solo: optional(Count),
  setup: optional(Count),
} satisfies { readonly [K in HoldBack | 'setup']: unknown })
export type HeldBy = typeof HeldBy.Type

/** The solo ticket running, or next (`next: true`). */
export const SoloTicket = Schema.Struct({
  ticket: TicketId,
  next: optional(Schema.Literal(true)),
})
export type SoloTicket = typeof SoloTicket.Type

// ---- Holds, stops and exit codes ----------------------------------------------------------------

/** A reason the run takes no new tickets (§14, §2.1 Hold), as its `HOLD:` line names it. */
export const HoldKind = Schema.Literals([
  'ENVIRONMENT',
  'USAGE_LIMIT',
  'CREDENTIALS',
  'MACHINE',
  'BUDGET',
  'DRAIN',
  'STOP',
])
export type HoldKind = typeof HoldKind.Type

/** How a run that ended by itself ended (§13.9). */
export const DoneKind = Schema.Literals([
  'READY_EMPTY',
  'LIMIT_REACHED',
  'DRAINED',
])
export type DoneKind = typeof DoneKind.Type

/** Why a run stopped (§13.11). */
export const StopKind = Schema.Literals([
  /** A start check failed (§13.1). */
  'SETUP',
  /** An overnight run's pre-flight refused it (§15.6). */
  'PREFLIGHT_FAILED',
  /** The requirements list doesn't pass (§17). */
  'REQUIREMENTS_MISSING',
  /** Another engine holds the run lease (§11.5). */
  'PROJECT_LEASED',
  /** The remote couldn't be reached, without `--offline` (§11.5). */
  'REMOTE_UNREACHABLE',
  /** A credential still refused past `credentials_wait` (§14.6). */
  'CREDENTIALS',
  'GIT_FAILED',
  'TRACKER_FAILED',
  /** A defect in the engine. */
  'PANIC',
  /** The checkout went off its branch during the run (§13.11). */
  'OFF_BRANCH',
  /** A branch that doesn't fast-forward (§13.7). */
  'MERGE_FAILED',
  /** The environment hold gave up (§14.1). */
  'ENVIRONMENT',
  /** The usage limit outlasted `usage_limit_wait` (§14.2). */
  'USAGE_LIMIT',
  /** Stopped (`fabrica run stop`, the app's Stop). */
  'INTERRUPTED',
])
export type StopKind = typeof StopKind.Type

/** How a run ended, as its end line starts. */
export const EndKind = Schema.Union([DoneKind, StopKind])
export type EndKind = typeof EndKind.Type

/**
 * The CLI's exit codes, orchestra's (§13.11). 3 is reserved: orchestra's stop for a stuck worker,
 * whose ticket Fabrica sets aside instead (§14.5), so the others keep orchestra's numbers.
 */
export const ExitCode = Schema.Literals([0, 2, 3, 4, 5, 6, 7, 8, 130])
export type ExitCode = typeof ExitCode.Type

/** Each end's exit code. */
export const exitCodes: { readonly [K in EndKind]: Exclude<ExitCode, 3> } = {
  READY_EMPTY: 0,
  LIMIT_REACHED: 0,
  DRAINED: 0,
  SETUP: 2,
  PREFLIGHT_FAILED: 2,
  REQUIREMENTS_MISSING: 2,
  PROJECT_LEASED: 2,
  REMOTE_UNREACHABLE: 2,
  CREDENTIALS: 2,
  GIT_FAILED: 4,
  TRACKER_FAILED: 4,
  PANIC: 4,
  OFF_BRANCH: 5,
  MERGE_FAILED: 6,
  ENVIRONMENT: 7,
  USAGE_LIMIT: 8,
  INTERRUPTED: 130,
}

/** The exit code a run that ended as `kind` exits with. */
export const exitCodeOf = (kind: EndKind): ExitCode => exitCodes[kind]

// ---- The records --------------------------------------------------------------------------------

/** What a ticket spent from when the run first took it up, on the records that end its part in it. */
const spent = {
  phases: optional(PhaseSeconds),
  hand_backs: optional(HandBacks),
  carried: optional(Schema.Literal(true)),
  tokens: optional(TokensByModel),
  cost_usd: optional(Usd),
  equivalent_usd: optional(Usd),
}

/** What the queue holds, on `queue` and `dispatch`. */
const inQueue = {
  queued: Count,
  held: optional(Count),
  held_by: optional(HeldBy),
  unclosed: optional(Count),
  solo: optional(SoloTicket),
  machine_full: optional(Schema.Literal(true)),
}

/**
 * One kind of record: every record has `v`, `time` (when it was written), `run` (the run's ID, the
 * same in each of its records) and `kind`. `v` and `kind` are filled in by `make`.
 */
const record = <
  const Kind extends string,
  const Fields extends Schema.Struct.Fields,
>(
  kind: Kind,
  fields: Fields,
) =>
  Schema.Struct({
    v: Schema.tag(eventVersion),
    time: LocalTime,
    run: RunId,
    kind: Schema.tag(kind),
    ...fields,
  })

// The run.

/** The run's first record, once its start checks pass and it knows its work. */
export const StartEvent = record('start', {
  version: Text,
  engine: EngineId,
  /** The project's checkout. */
  repo: Text,
  /** Base: where finished tickets land. */
  branch: Text,
  /** Base's commit as the run started: where the run's merged diff starts (§8.1). */
  commit: CommitHash,
  /** The ticket of a `--ticket` or feature run, or a spec run's root epic. */
  scope: optional(TicketId),
  feature: optional(Text),
  /** A spec run's spec, its path in the repository. */
  spec: optional(Text),
  /** The URL a spec was fetched from, without its query and fragment (§15.5). */
  spec_source: optional(Text),
  concurrency: Count,
  limit: optional(Count),
  /** The project's model (§12.5). */
  model: optional(ModelName),
  permissions: optional(Text),
  /** `--auto-answer`'s wait, in ms; 0 for at once (§15.2). */
  auto_answer: optional(Count),
  overnight: optional(Schema.Literal(true)),
  /** The lease wasn't checked: started with `--offline` (§11.5). */
  offline: optional(Schema.Literal(true)),
})

/** Progress about the run or a ticket. */
export const InfoEvent = record('info', {
  ticket: optional(TicketId),
  text: Text,
})

/**
 * Something to review while the run goes on (`CHECKS_FAILED`, `LIKELY_CONFLICT`, …); `aside: true`
 * when its ticket is set aside, with `reason`, `detail` and what it spent.
 */
export const WarnEvent = record('warn', {
  ticket: optional(TicketId),
  aside: optional(Schema.Literal(true)),
  reason: optional(SetAsideReason),
  detail: optional(Text),
  text: Text,
  ...spent,
})

/** A hold starts, or with `lifted: true` ends (§14). */
export const HoldEvent = record('hold', {
  hold: HoldKind,
  lifted: optional(Schema.Literal(true)),
  ticket: optional(TicketId),
  provider: optional(ProviderName),
  text: Text,
})

/** The run was asked to drain: no new tickets, the running ones finish and merge (§13.10). */
export const DrainEvent = record('drain', { text: optional(Text) })

/** A drain was taken back. */
export const ResumeEvent = record('resume', { text: optional(Text) })

/** The environment probe passed: tickets start again (§14.1, `PROBE_OK`). */
export const ProbedEvent = record('probed', { text: Text })

/**
 * A model call was refused for a quota with a reset (§14.2): the run holds; once a hold. `reset`
 * when the provider said, and it is after now.
 */
export const UsageLimitEvent = record('usage_limit', {
  provider: ProviderName,
  ticket: optional(TicketId),
  detail: Text,
  reset: optional(LocalTime),
  text: Text,
})

/** The usage-limit hold lifted on evidence: the proxy's probe call went through (§14.2). */
export const UsageLimitLiftedEvent = record('usage_limit_lifted', {
  provider: ProviderName,
  text: Text,
})

/** One of a subscription's usage windows changed, as the provider reports it (§12.9, H90). */
export const UsageWindowEvent = record('usage_window', {
  provider: ProviderName,
  account: optional(Text),
  /** `five_hour`, `seven_day`, … as the provider names it. */
  window: Text,
  utilization: Utilization,
  resets_at: optional(LocalTime),
})

/** A provider refused its credential mid-run: the run holds for it (§14.6). */
export const CredentialsHoldEvent = record('credentials_hold', {
  provider: ProviderName,
  account: optional(Text),
  ticket: optional(TicketId),
  /** What was refused and why, as the provider or the refresh said. */
  detail: Text,
  text: Text,
})

/** The credentials hold lifted: the proxy's probe went through after a new sign-in or key (§14.6). */
export const CredentialsLiftedEvent = record('credentials_lifted', {
  provider: ProviderName,
  text: Text,
})

/** The host slept; limits don't count the time (§7.7). */
export const SleptEvent = record('slept', {
  /** When it was last seen awake. */
  from: LocalTime,
  /** When it woke. */
  to: LocalTime,
  seconds: Seconds,
  /** The cause, where the OS logs one. */
  cause: optional(Text),
  text: Text,
})

/** The host is on battery: as the run starts, and at 20% and 10% while discharging (§7.7). */
export const BatteryEvent = record('battery', {
  /** The percent read. */
  level: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  threshold: optional(Schema.Literals([20, 10])),
  text: Text,
})

/** The run stopped (§13.10, §13.11). */
export const StopEvent = record('stop', {
  detail: StopKind,
  ticket: optional(TicketId),
  /** Why that ticket can't merge until the maintainer acts. */
  blocked: optional(Text),
  text: Text,
})

/** The run ended by itself (§13.9): `READY_EMPTY after 12 tickets`, … */
export const DoneEvent = record('done', {
  detail: DoneKind,
  text: Text,
})

/** Which check or setup ran. */
export const CheckSuite = Schema.Literals([
  /** A worker's own check of its change. */
  'own',
  /** A ticket's merge check (`check_fast`), the train's included. */
  'merge',
  /** The merge check once more, of a ticket set aside for it once Base moved. */
  'recheck',
  /** The check of a fix its worker made for a failed merge check. */
  'fix',
  /** The full check (`check_full`). */
  'full',
  /** An overnight pre-flight's merge check of Base. */
  'base',
  /** The project's setup, in a ticket's worktree or before the full check. */
  'setup',
])
export type CheckSuite = typeof CheckSuite.Type

export const CheckResult = Schema.Literals([
  'passed',
  'failed',
  'timed_out',
  'cut_short',
  'not_run',
])
export type CheckResult = typeof CheckResult.Type

/** A check or a setup ended (orchestra's `check`, H65). */
export const CheckEvent = record('check', {
  suite: CheckSuite,
  ticket: optional(TicketId),
  command: Text,
  commit: optional(CommitHash),
  seconds: Seconds,
  result: CheckResult,
  /** Where its whole output is, when it didn't pass. */
  output: optional(Text),
  /** It ran ahead of its ticket's turn, in the merge train. */
  train: optional(Schema.Literal(true)),
})

/** The full check after a run that ended by itself and merged something (§13.9). */
export const FullCheckEvent = record('full_check', {
  /** orchestra's words; `not run` is `FULL_CHECK_NOT_RUN`. */
  detail: Schema.Literals([
    'passed',
    'failed',
    'timed out',
    'skipped',
    'not run',
  ]),
  suite: optional(Text),
  output: optional(Text),
  /** The ticket filed for the failing suite, or the one open for it already. */
  ticket: optional(TicketId),
  commit: optional(CommitHash),
  seconds: optional(Seconds),
  result: optional(CheckResult),
  text: Text,
})

/** An organ call ended (§16). */
export const OrganEvent = record('organ', {
  organ: OrganName,
  ticket: optional(TicketId),
  outcome: Schema.Literals(['answered', 'no_result']),
  model: optional(ModelName),
  tokens: optional(TokensByModel),
  cost_usd: optional(Usd),
  turns: optional(Count),
  session: optional(SessionId),
  duration_ms: Count,
})

/** The run's last record (§13.11). */
export const EndEvent = record('end', {
  code: ExitCode,
  /** Its workers' tokens, by model. */
  tokens: optional(TokensByModel),
  cost_usd: optional(Usd),
  equivalent_usd: optional(Usd),
  organs: optional(OrganTotals),
})

// Tickets.

/** A ticket moved from one phase to another; `from` is absent as it enters the run, `to` as it leaves. */
export const PhaseEvent = record('phase', {
  ticket: TicketId,
  from: optional(PhaseTag),
  to: optional(PhaseTag),
  cause: Text,
})

/** The number of ready tickets waiting for a slot or held back changed. */
export const QueueEvent = record('queue', inQueue)

/** A ticket was picked up: `[n/limit]`. */
export const DispatchEvent = record('dispatch', {
  ticket: TicketId,
  title: Text,
  n: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  limit: optional(Count),
  model: optional(ModelName),
  text: Text,
  ...inQueue,
})

/** How a worker's turn left its ticket: through an outcome tool, or with none (§12.3). */
export const SettledOutcome = Schema.Literals([
  'finish',
  'defer',
  'wait_for',
  'ask_question',
  'none',
])
export type SettledOutcome = typeof SettledOutcome.Type

/** A worker settled. */
export const SettledEvent = record('settled', {
  ticket: TicketId,
  outcome: SettledOutcome,
  text: Text,
})

/** A ticket merged (`detail`: `ffd6ce4 merged into main`), or closed with no change to merge. */
export const ClosedEvent = record('closed', {
  ticket: TicketId,
  title: Text,
  commit: optional(CommitHash),
  detail: Text,
  text: Text,
  ...spent,
})

/** A ticket was set aside, deferred. */
export const DeferredEvent = record('deferred', {
  ticket: TicketId,
  title: Text,
  reason: optional(SetAsideReason),
  detail: Text,
  text: Text,
  ...spent,
})

/** A ticket waits on a question for the maintainer. */
export const AskedEvent = record('asked', {
  ticket: TicketId,
  title: Text,
  question: TicketId,
  /** The question's ID and title. */
  detail: Text,
  text: Text,
})

/** Its question was answered: it comes back. */
export const AnsweredEvent = record('answered', {
  ticket: TicketId,
  title: Text,
  question: optional(TicketId),
  detail: Text,
  text: Text,
})

/** The engine answered a question with its recommended option, by `--auto-answer` (§15.2). */
export const AutoAnsweredEvent = record('auto_answered', {
  /** The ticket waiting on it. */
  ticket: TicketId,
  question: TicketId,
  /** The question's title. */
  title: Text,
  /** The option chosen. */
  option: Text,
  text: Text,
})

/** Its worker found it needs tickets not merged yet: back in the queue until they merge (`WAITS_FOR_MERGE`). */
export const WaitsEvent = record('waits', {
  ticket: TicketId,
  title: Text,
  waits_for: Schema.NonEmptyArray(TicketId),
  detail: Text,
  text: Text,
})

/** A ticket set aside for failing at once was put back in the queue by an environment hold. */
export const ReopenedEvent = record('reopened', {
  ticket: TicketId,
  detail: Text,
  text: Text,
})

/** A ticket was put back in the queue, whatever put it there. */
export const RequeuedEvent = record('requeued', {
  ticket: TicketId,
  detail: Text,
})

/** Triage's verdict on a ticket set aside (§16). */
export const TriageEvent = record('triage', {
  ticket: TicketId,
  /** The verdict's summary. */
  title: Text,
  /** As in `environment · high`. */
  detail: Text,
  text: Text,
})

/** A rebase stopped on conflicts in `files` (§13.7). */
export const MergeConflictEvent = record('merge_conflict', {
  ticket: TicketId,
  files: Schema.NonEmptyArray(Text),
  /** The resolve hand-back it went to; absent when it was set aside instead. */
  attempt: optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  text: Text,
})

/**
 * A ticket's part in the run ended: merged, closed with no change, set aside, waiting on the
 * maintainer, stopped, or left queued as the run ended; again each time it comes back and ends again.
 */
export const TicketEndEvent = record('ticket_end', {
  ticket: TicketId,
  outcome: TicketOutcome,
  /** The phase it ended in. */
  phase: PhaseTag,
  /** Why, as that phase gives it: a set-aside reason, the question's ID, what it waits for, … */
  why: optional(Text),
  /** From when the run first took it up. */
  seconds: Seconds,
  /** Its workers' model round-trips. */
  turns: optional(Count),
  ...spent,
})

// Workers.

/** A worker's session was resumed: carried over, answered, handed back, or undeferred (§13.2). */
export const ResumedEvent = record('resumed', {
  ticket: TicketId,
  session: SessionId,
  why: Schema.Literals(['carried_over', 'answered', 'hand_back', 'undeferred']),
  text: optional(Text),
})

/** A worker's session was saved for the next run as this one stopped (§13.10). */
export const SuspendedEvent = record('suspended', {
  ticket: TicketId,
  session: SessionId,
  why: Text,
})

/** An agent's turn ended, with its share of the session's totals. */
export const TurnEvent = record('turn', {
  /** The worker's ticket; absent for a talk's or the probe's session. */
  ticket: optional(TicketId),
  session: SessionId,
  model: ModelName,
  tokens: optional(TokensByModel),
  cost_usd: optional(Usd),
  equivalent_usd: optional(Usd),
  /** Its model round-trips. */
  turns: Count,
  duration_ms: Count,
  /** It ended on an error. */
  error: optional(Text),
})

/** Every record of the stream, told apart by `kind`. */
export const RunEvent = Schema.Union([
  StartEvent,
  InfoEvent,
  WarnEvent,
  HoldEvent,
  DrainEvent,
  ResumeEvent,
  ProbedEvent,
  UsageLimitEvent,
  UsageLimitLiftedEvent,
  UsageWindowEvent,
  CredentialsHoldEvent,
  CredentialsLiftedEvent,
  SleptEvent,
  BatteryEvent,
  StopEvent,
  DoneEvent,
  CheckEvent,
  FullCheckEvent,
  OrganEvent,
  EndEvent,
  PhaseEvent,
  QueueEvent,
  DispatchEvent,
  SettledEvent,
  ClosedEvent,
  DeferredEvent,
  AskedEvent,
  AnsweredEvent,
  AutoAnsweredEvent,
  WaitsEvent,
  ReopenedEvent,
  RequeuedEvent,
  TriageEvent,
  MergeConflictEvent,
  TicketEndEvent,
  ResumedEvent,
  SuspendedEvent,
  TurnEvent,
]).pipe(Schema.toTaggedUnion('kind'))
export type RunEvent = typeof RunEvent.Type
export type EventKind = RunEvent['kind']

/** A record as one line of the stream: its JSON, without the newline. */
export const RunEventFromJson = Schema.fromJsonString(RunEvent)

/** `event` as a line of the stream, without the newline. */
export const encodeEventLine = Schema.encodeSync(RunEventFromJson)

/** A line read from the stream: a record of a kind this version knows, or one it skips. */
export type EventLine = Data.TaggedEnum<{
  Known: { readonly event: RunEvent }
  /** A kind added after this version, or a record of another format version. */
  Skipped: { readonly kind: string; readonly v: number }
}>
export const EventLine = Data.taggedEnum<EventLine>()

/** What every record has, read before its kind is known. */
const Envelope = Schema.fromJsonString(
  Schema.Struct({ v: Schema.Number, kind: Schema.String }),
)

const kinds: ReadonlySet<string> = new Set(RunEvent.discriminants)

const decodeEnvelope = Schema.decodeUnknownEffect(Envelope)
const decodeEvent = Schema.decodeUnknownEffect(RunEventFromJson)

/**
 * Reads one line of the stream. A record of a kind this version doesn't know, or of another format
 * version, is `Skipped`; a known kind that doesn't decode, or a line that isn't a record, fails.
 */
export const decodeEventLine = Effect.fn('Events.decodeEventLine')(function* (
  line: string,
) {
  const { v, kind } = yield* decodeEnvelope(line)
  if (v !== eventVersion || !kinds.has(kind)) {
    return EventLine.Skipped({ kind, v })
  }
  return EventLine.Known({ event: yield* decodeEvent(line) })
})
