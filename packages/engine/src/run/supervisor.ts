import {
  Clock,
  Data,
  DateTime,
  Deferred,
  Duration,
  Effect,
  FiberSet,
  Option,
  Pull,
  Ref,
  Schedule,
  Stream,
} from 'effect'

import {
  type ProviderName,
  type SessionId,
  type SetAsideReason,
  type TicketId,
  formatDurationMillis,
} from '@fabrica/contracts'

import type { ModelChoice, PiEvent } from '../agent'
import type { Worktree } from '../git'
import type { HandBackClockShape } from '../merge/handbacks'
import { ProxyEvent, Refusal } from '../proxy'
import { WorkerEnd, WorkerTurn } from './worker'

// Each worker's supervision (spec §12.8, §14.5, H37): every path that starts or resumes a worker runs
// it under `watch`, which applies the policies of §12.8's table to what goes wrong with it. A rate
// limit is waited out with an exponential backoff (a `Schedule`) and the session resumed; a usage
// limit or a refused credential waits on its hold (§14.2, §14.6) and resumes; an agent that gives no
// events for `stuck_after`, outside the tools known to be long, is interrupted and its session
// restarted once with a summary, then set aside; a tool's defect sets the ticket aside with a follow-up
// filed about the tool; a model that doesn't start gives way to the next of `model_fallbacks`, and once
// none is left the start failure is counted for the environment hold (§14.1); a ticket over its budget
// or past `ticket_limit` is interrupted and set aside, as is one whose worker settles twice with no
// outcome. A set-aside ticket keeps its worktree and session, and nothing stops the run for one worker.
// The run's end stops every ticket's supervision before its other steps (§13.9): from then on a
// worker's end is taken as it comes.

/** What goes wrong with a worker, as §12.8's table tells it apart. */
export type WorkerFailure = Data.TaggedEnum<{
  /** Its provider's rate limit, no reset known; `retryAfter` where the provider said how long. */
  RateLimited: {
    readonly provider: ProviderName
    readonly retryAfter: Option.Option<Duration.Duration>
  }
  /** Its provider's quota, with its reset (§14.2). */
  UsageLimited: {
    readonly provider: ProviderName
    readonly resetAt: DateTime.Utc
  }
  /** Its provider refused its credential once the run had begun (§14.6). */
  CredentialRefused: {
    readonly provider: ProviderName
    readonly reason: string
  }
  /** No events for `quiet`, outside the tools known to be long; `doing` is what its last event said. */
  AgentStuck: { readonly quiet: Duration.Duration; readonly doing: string }
  /** A tool failed in the engine under it. */
  ToolDefect: { readonly tool: string; readonly reason: string }
  /**
   * Its session didn't start: on its model (`model`: a credential missing, or refused before any call
   * to its provider went through), or Pi didn't (spawn, handshake).
   */
  StartFailed: { readonly reason: string; readonly model: boolean }
  /** It went over its budget (§14.4). */
  BudgetExceeded: { readonly detail: string }
  /** It ran past `ticket_limit` (§14.5). */
  TicketLimit: { readonly limit: Duration.Duration }
  /** It settled a second time with no outcome (§12.3). */
  Unfinished: {}
}>
export const WorkerFailure = Data.taggedEnum<WorkerFailure>()

/** What a worker's dispatch tells its supervision as it goes. */
export interface Watcher {
  /** Its worktree is ready for its agent: a restart starts there. */
  readonly prepared: (worktree: Worktree) => Effect.Effect<void>
  /** Its agent has started, with the session file a restart resumes; its quiet is counted from now. */
  readonly started: (session: Option.Option<string>) => Effect.Effect<void>
  /** One of its agent's events. */
  readonly heard: (event: PiEvent) => Effect.Effect<void>
}

/** One go at a ticket's turn, as its supervision starts it. */
export interface Attempt {
  readonly turn: WorkerTurn
  /** The model its agent starts on; none for Pi's own. */
  readonly model: Option.Option<ModelChoice>
  readonly watcher: Watcher
}

/** The holds a worker's trouble is routed to (§14.1, §14.2, §14.6). */
export interface SupervisorHolds {
  /** Its turn ended on its provider's usage limit: completes once it may carry on. */
  readonly usageLimited: (input: {
    readonly ticket: TicketId
    readonly provider: ProviderName
    readonly resetAt: DateTime.Utc
  }) => Effect.Effect<void>
  /** Its turn ended on a credential refused: completes once it may carry on. */
  readonly credentialRefused: (input: {
    readonly ticket: TicketId
    readonly provider: ProviderName
    readonly reason: string
  }) => Effect.Effect<void>
  /** Its session didn't start on any of its models: counted for the environment hold. */
  readonly startFailed: (input: {
    readonly ticket: TicketId
    readonly reason: string
  }) => Effect.Effect<void>
}

/**
 * The holds until they are one state (fab-mgi.4.11, .12, .13): a usage limit waited out to its reset,
 * one at or before now taken as unknown and waited `retry`; a refused credential waited `retry`; a
 * start failure counted nowhere.
 */
export const waitingHolds = (retry: Duration.Duration): SupervisorHolds => ({
  usageLimited: ({ resetAt }) =>
    Effect.flatMap(DateTime.now, now =>
      Effect.sleep(
        DateTime.isGreaterThan(resetAt, now)
          ? DateTime.distance(now, resetAt)
          : retry,
      ),
    ),
  credentialRefused: () => Effect.sleep(retry),
  startFailed: () => Effect.void,
})

/** No events for this long, outside the tools known to be long, is a stuck agent (§12.8). */
export const STUCK_AFTER = Duration.minutes(10)

/** The tools known to be long, each with a time limit of its own: `check_own`'s check, `ask_and_wait`'s wait. */
export const LONG_TOOLS: ReadonlySet<string> = new Set([
  'check_own',
  'ask_and_wait',
])

/** A rate limit's backoff: 30 s, doubling, six times; then the ticket is set aside. */
export const RATE_BACKOFF: Schedule.Schedule<Duration.Duration> =
  Schedule.exponential(Duration.seconds(30)).pipe(Schedule.upTo({ times: 6 }))

/** What the run's supervision works from. */
export interface SupervisionOptions {
  /** What the model proxy sees: each ticket's refusals and calls that went through. */
  readonly proxy: Stream.Stream<ProxyEvent>
  readonly holds: SupervisorHolds
  /**
   * The workers' clock, in time awake, as the hand-backs count theirs: its waits, and whether the run
   * holds for the usage limit or the machine's load, a worker's quiet not counted meanwhile.
   */
  readonly clock: HandBackClockShape
  /** `ticket_limit`: the most time a ticket's worker may take in the run; none, no limit. */
  readonly ticketLimit: Option.Option<Duration.Duration>
  /** `model_fallbacks`, in order (§12.5). */
  readonly fallbacks: ReadonlyArray<ModelChoice>
  readonly stuckAfter?: Duration.Duration
  readonly backoff?: Schedule.Schedule<Duration.Duration>
}

/** What a ticket's worker is watched for. */
export interface Watch<R> {
  readonly ticket: TicketId
  /** The session its claim and its proxy token name. */
  readonly session: SessionId
  readonly turn: WorkerTurn
  /** Its own model, the ticket's or the project's: its first turn's first try. */
  readonly model: Option.Option<ModelChoice>
  /** Runs one attempt; its end, its failures to dispatch or start included. */
  readonly run: (attempt: Attempt) => Effect.Effect<WorkerEnd, never, R>
}

export interface Supervision {
  /** Runs a ticket's worker under its supervision, to the end the run takes from it. */
  readonly watch: <R>(watch: Watch<R>) => Effect.Effect<WorkerEnd, never, R>
  /** The ticket went over its budget (§14.4): its worker is interrupted and it is set aside. */
  readonly overBudget: (input: {
    readonly ticket: TicketId
    readonly detail: string
  }) => Effect.Effect<void>
  /** Stops every ticket's supervision: the end's first step. */
  readonly stop: Effect.Effect<void>
}

/** A model as the settings write it: `anthropic/claude-…`. */
const nameOf = (model: ModelChoice) => `${model.provider}/${model.modelId}`

/** The models after `model` to try on a start failure: the fallbacks, each once, none the same as it. */
export const fallbacksAfter = (
  model: Option.Option<ModelChoice>,
  fallbacks: ReadonlyArray<ModelChoice>,
): ReadonlyArray<ModelChoice> => {
  const seen = new Set(Option.toArray(Option.map(model, nameOf)))
  return fallbacks.filter(choice => {
    const name = nameOf(choice)
    if (seen.has(name)) return false
    seen.add(name)
    return true
  })
}

/** The follow-up a tool's defect files about the tool (§12.8), linked as found on `ticket`. */
export const toolFollowUp = (input: {
  readonly ticket: TicketId
  readonly tool: string
  readonly reason: string
}) => ({
  title: `Tool ${input.tool} failed in the engine`.slice(0, 60),
  description: `${input.tool} failed in the engine under ${input.ticket}'s worker, not on its arguments: ${input.reason}. ${input.ticket} was set aside, its worktree and session kept; undeferred once the tool is fixed, it resumes them.`,
})

/** What a worker's last event says it was doing. */
const doingOf = (event: PiEvent): string => {
  switch (event.type) {
    case 'tool_execution_start': {
      const args: unknown = event.args
      const command =
        typeof args === 'object' &&
        args !== null &&
        'command' in args &&
        typeof args.command === 'string'
          ? `: ${args.command}`
          : ''
      return `running its ${event.toolName} tool${command}`
    }
    case 'tool_execution_update':
      return `running its ${event.toolName} tool`
    case 'message_start':
    case 'message_update':
      return 'writing its reply'
    case 'auto_retry_start':
      return `retrying its model call: ${event.errorMessage}`
    case 'compaction_start':
      return 'compacting its context'
    default:
      return 'waiting on its model'
  }
}

/** What a worker was last heard doing, and when. */
interface Heard {
  /** Epoch milliseconds. */
  readonly at: number
  readonly doing: string
  /** The tools it runs now, by call. */
  readonly open: ReadonlyMap<string, string>
}

const heardAfter = (heard: Heard, event: PiEvent, at: number): Heard => {
  const open = new Map(heard.open)
  if (event.type === 'tool_execution_start')
    open.set(event.toolCallId, event.toolName)
  if (event.type === 'tool_execution_end') open.delete(event.toolCallId)
  return { at, doing: doingOf(event), open }
}

/** A refusal the model proxy gave the attempt's session, with no call through since. */
interface Refused {
  readonly provider: ProviderName
  readonly refusal: Refusal
}

/** An attempt in flight, as the proxy's events and the monitors reach it. */
interface Live {
  readonly session: SessionId
  /** The failure that interrupts it, once one comes. */
  readonly failed: Deferred.Deferred<WorkerFailure>
  readonly refused: Ref.Ref<Option.Option<Refused>>
  readonly heard: Ref.Ref<Heard>
}

/** How an attempt came out. */
type Came = Data.TaggedEnum<{
  Ended: { readonly end: WorkerEnd }
  Interrupted: { readonly failure: WorkerFailure }
}>
const Came = Data.taggedEnum<Came>()

/** What a policy does next. */
type Next = Data.TaggedEnum<{
  /** Another attempt, at `turn`. */
  Again: { readonly turn: WorkerTurn }
  /** The end the run takes. */
  Ends: { readonly end: WorkerEnd }
}>
const Next = Data.taggedEnum<Next>()

/** The prompt that resumes a worker's session after its trouble, saying what happened. */
const carryOn = (what: string) =>
  `${what} Carry on from where you were, and end your turn through finish, defer, wait_for or ask_question.`

/** The run's supervision; its proxy feed and monitors live in the scope. */
export const makeSupervision = Effect.fn('Supervision.make')(function* (
  options: SupervisionOptions,
) {
  const stuckAfter = options.stuckAfter ?? STUCK_AFTER
  const backoff = options.backoff ?? RATE_BACKOFF
  const stopped = yield* Ref.make(false)
  const live = yield* Ref.make<ReadonlyMap<TicketId, Live>>(new Map())
  /** Each ticket's worker time in the run, in milliseconds, for `ticket_limit`. */
  const spent = yield* Ref.make<ReadonlyMap<TicketId, number>>(new Map())
  /** The model that wrote each ticket: its hand-backs and resumed sessions start on it (§12.5). */
  const writers = yield* Ref.make<
    ReadonlyMap<TicketId, Option.Option<ModelChoice>>
  >(new Map())
  const held = yield* Ref.make(false)

  /** Interrupts the ticket's attempt with `failure`, unless supervision has stopped. */
  const fail = (attempt: Live, failure: WorkerFailure) =>
    Effect.flatMap(Ref.get(stopped), done =>
      done
        ? Effect.void
        : Effect.asVoid(Deferred.succeed(attempt.failed, failure)),
    )

  // The proxy's events, routed to the attempt of the session they name: a start failure interrupts it,
  // another refusal is kept until a call goes through, for its turn's end to tell why it ended.
  yield* options.proxy.pipe(
    Stream.runForEach(event =>
      Effect.gen(function* () {
        const { caller } = event
        if (Option.isNone(caller.ticket)) return
        const attempt = (yield* Ref.get(live)).get(caller.ticket.value)
        if (
          attempt === undefined ||
          !Option.contains(caller.session, attempt.session)
        )
          return
        yield* ProxyEvent.$match(event, {
          Used: () => Ref.set(attempt.refused, Option.none()),
          Refused: ({ provider, refusal }) =>
            Refusal.$is('StartFailed')(refusal)
              ? fail(
                  attempt,
                  WorkerFailure.StartFailed({
                    reason: `${provider}: ${refusal.reason}`,
                    model: true,
                  }),
                )
              : Ref.set(attempt.refused, Option.some({ provider, refusal })),
        })
      }),
    ),
    Effect.forkScoped,
  )

  // While the run holds, a worker waits on its permits: its quiet counts again from the hold's lift.
  yield* options.clock.held.pipe(
    Stream.runForEach(holding =>
      Effect.gen(function* () {
        yield* Ref.set(held, holding)
        if (holding) return
        const now = yield* Clock.currentTimeMillis
        const attempts = yield* Ref.get(live)
        yield* Effect.forEach(
          attempts.values(),
          attempt =>
            Ref.update(attempt.heard, heard => ({ ...heard, at: now })),
          { discard: true },
        )
      }),
    ),
    Effect.forkScoped,
  )

  /** Fails the attempt as stuck once it gives no events for `stuckAfter`, outside the long tools. */
  const quietWatch = (attempt: Live) =>
    Effect.gen(function* () {
      const limit = Duration.toMillis(stuckAfter)
      while (true) {
        const now = yield* Clock.currentTimeMillis
        const heard = yield* Ref.get(attempt.heard)
        const inLong = [...heard.open.values()].some(tool =>
          LONG_TOOLS.has(tool),
        )
        if (inLong || (yield* Ref.get(held))) {
          yield* options.clock.sleep(stuckAfter)
          continue
        }
        const quiet = now - heard.at
        if (quiet >= limit)
          return yield* fail(
            attempt,
            WorkerFailure.AgentStuck({
              quiet: Duration.millis(quiet),
              doing: heard.doing,
            }),
          )
        yield* options.clock.sleep(Duration.millis(limit - quiet))
      }
    })

  /** Runs one attempt, racing the failures that interrupt it; the ticket's time in it counted. */
  const attemptOnce = <R>(input: {
    readonly watch: Watch<R>
    readonly turn: WorkerTurn
    readonly model: Option.Option<ModelChoice>
    /** `ticket_limit`, and the milliseconds of it the ticket has left. */
    readonly limit: Option.Option<{
      readonly most: Duration.Duration
      readonly left: number
    }>
    readonly onPrepared: (worktree: Worktree) => void
    readonly onStarted: (session: Option.Option<string>) => void
  }) =>
    Effect.gen(function* () {
      const { ticket, session } = input.watch
      const startedAt = yield* Clock.currentTimeMillis
      const attempt: Live = {
        session,
        failed: yield* Deferred.make<WorkerFailure>(),
        refused: yield* Ref.make(Option.none<Refused>()),
        heard: yield* Ref.make<Heard>({
          at: startedAt,
          doing: 'starting',
          open: new Map(),
        }),
      }
      yield* Ref.update(live, attempts =>
        new Map(attempts).set(ticket, attempt),
      )
      const monitors = yield* FiberSet.make<void>()
      yield* Option.match(input.limit, {
        onNone: () => Effect.void,
        onSome: ({ most, left }) =>
          Effect.asVoid(
            Effect.forkScoped(
              Effect.andThen(
                options.clock.sleep(Duration.millis(left)),
                fail(attempt, WorkerFailure.TicketLimit({ limit: most })),
              ),
            ),
          ),
      })
      const watcher: Watcher = {
        prepared: worktree => Effect.sync(() => input.onPrepared(worktree)),
        started: file =>
          Effect.gen(function* () {
            input.onStarted(file)
            yield* Ref.update(writers, kept =>
              new Map(kept).set(ticket, input.model),
            )
            const now = yield* Clock.currentTimeMillis
            yield* Ref.update(attempt.heard, heard => ({ ...heard, at: now }))
            yield* FiberSet.run(monitors, quietWatch(attempt))
          }),
        heard: event =>
          Effect.flatMap(Clock.currentTimeMillis, now =>
            Ref.update(attempt.heard, heard => heardAfter(heard, event, now)),
          ),
      }
      const came = yield* Effect.raceFirst(
        Effect.map(
          input.watch.run({ turn: input.turn, model: input.model, watcher }),
          end => Came.Ended({ end }),
        ),
        Effect.map(Deferred.await(attempt.failed), failure =>
          Came.Interrupted({ failure }),
        ),
      )
      const endedAt = yield* Clock.currentTimeMillis
      yield* Ref.update(spent, times =>
        new Map(times).set(
          ticket,
          (times.get(ticket) ?? 0) + (endedAt - startedAt),
        ),
      )
      yield* Ref.update(live, attempts => {
        const left = new Map(attempts)
        if (left.get(ticket) === attempt) left.delete(ticket)
        return left
      })
      return { came, refused: yield* Ref.get(attempt.refused) }
    }).pipe(Effect.scoped)

  /** The failure an attempt's end tells, from the end and the refusal its session was left with. */
  const failureOf = (
    end: WorkerEnd,
    refused: Option.Option<Refused>,
  ): Option.Option<WorkerFailure> => {
    if (WorkerEnd.$is('ToolFailed')(end))
      return Option.some(
        WorkerFailure.ToolDefect({ tool: end.tool, reason: end.reason }),
      )
    if (WorkerEnd.$is('NotStarted')(end))
      return Option.some(
        WorkerFailure.StartFailed({ reason: end.reason, model: false }),
      )
    if (!WorkerEnd.$is('Unfinished')(end)) return Option.none()
    return Option.some(
      Option.match(refused, {
        onNone: () => WorkerFailure.Unfinished(),
        onSome: ({ provider, refusal }) =>
          Refusal.$match(refusal, {
            RateLimited: ({ retryAfter }) =>
              WorkerFailure.RateLimited({ provider, retryAfter }),
            UsageLimited: ({ resetAt }) =>
              WorkerFailure.UsageLimited({ provider, resetAt }),
            CredentialRefused: ({ reason }) =>
              WorkerFailure.CredentialRefused({ provider, reason }),
            StartFailed: ({ reason }) =>
              WorkerFailure.StartFailed({
                reason: `${provider}: ${reason}`,
                model: true,
              }),
          }),
      }),
    )
  }

  const watch = <R>(input: Watch<R>): Effect.Effect<WorkerEnd, never, R> =>
    Effect.gen(function* () {
      const { ticket } = input
      const step = yield* Schedule.toStep(backoff)
      let turn = input.turn
      // A ticket's hand-backs and resumed sessions start on the model that wrote it, with no fallback.
      const first = WorkerTurn.$is('First')(turn)
      let model = first
        ? input.model
        : Option.getOrElse(
            Option.fromUndefinedOr((yield* Ref.get(writers)).get(ticket)),
            () => input.model,
          )
      let fallbacks = first ? fallbacksAfter(model, options.fallbacks) : []
      let worktree = WorkerTurn.$match(turn, {
        First: () => Option.none<Worktree>(),
        Again: ({ worktree: kept }) => Option.some(kept),
        HandBack: ({ worktree: kept }) => Option.some(kept),
        // A resume's worktree is found as it begins.
        Resume: () => Option.none<Worktree>(),
      })
      let session = WorkerTurn.$match(turn, {
        First: () => Option.none<string>(),
        Again: () => Option.none<string>(),
        HandBack: ({ session: kept }) => kept,
        Resume: ({ saved }) => Option.some(saved.session),
      })
      let restarted = false

      /** Resumes the worker's session with `prompt`; it fails where the worker has no worktree yet. */
      const resumed = (why: string, prompt: string): Next =>
        Option.match(worktree, {
          onNone: () =>
            Next.Ends({
              end: WorkerEnd.Failed({
                reason: `its worker can't be resumed after ${why}: it has no worktree yet`,
              }),
            }),
          onSome: kept =>
            Next.Again({
              turn: WorkerTurn.HandBack({ worktree: kept, session, prompt }),
            }),
        })
      const setAside = (reason: SetAsideReason, note: string): Next =>
        Next.Ends({ end: WorkerEnd.SetAside({ reason, note }) })
      const ends = (end: WorkerEnd): Next => Next.Ends({ end })
      const limitNote = (most: Duration.Duration) =>
        `its worker ran past ticket_limit, ${formatDurationMillis(Duration.toMillis(most))}: interrupted; its worktree and session are kept for review`

      while (true) {
        const used = (yield* Ref.get(spent)).get(ticket) ?? 0
        const limit = Option.map(options.ticketLimit, most => ({
          most,
          left: Math.max(0, Duration.toMillis(most) - used),
        }))
        if (Option.isSome(limit) && limit.value.left === 0)
          return WorkerEnd.SetAside({
            reason: 'TICKET_LIMIT',
            note: limitNote(limit.value.most),
          })
        const { came, refused } = yield* attemptOnce({
          watch: input,
          turn,
          model,
          limit,
          onPrepared: kept => {
            worktree = Option.some(kept)
          },
          onStarted: file => {
            session = Option.orElse(file, () => session)
          },
        })
        const failure = Came.$match(came, {
          Ended: ({ end }) => failureOf(end, refused),
          Interrupted: ({ failure: why }) => Option.some(why),
        })
        const end = Came.$match(came, {
          Ended: ({ end: came }) => came,
          Interrupted: ({ failure: why }) =>
            WorkerEnd.Failed({ reason: `interrupted: ${why._tag}` }),
        })
        if (Option.isNone(failure) || (yield* Ref.get(stopped))) return end

        // §12.8's table: what each failure does next.
        const next = yield* WorkerFailure.$match(failure.value, {
          RateLimited: ({ provider, retryAfter }) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis
              const delay = yield* step(now, undefined).pipe(
                Effect.map(([, wait]) => Option.some(wait)),
                Pull.catchDone(() => Effect.succeedNone),
              )
              if (Option.isNone(delay))
                return setAside(
                  'UNFINISHED',
                  `its worker's turns kept ending on ${provider}'s rate limit, past its backoff`,
                )
              const wait = Option.match(retryAfter, {
                onNone: () => delay.value,
                onSome: asked => Duration.max(asked, delay.value),
              })
              yield* options.clock.sleep(wait)
              return resumed(
                'a rate limit',
                carryOn(
                  `Your turn ended on ${provider}'s rate limit; the engine waited ${formatDurationMillis(Duration.toMillis(wait))} before resuming your session.`,
                ),
              )
            }),
          UsageLimited: ({ provider, resetAt }) =>
            Effect.gen(function* () {
              yield* options.holds.usageLimited({ ticket, provider, resetAt })
              return resumed(
                'a usage limit',
                carryOn(
                  `Your turn ended on ${provider}'s usage limit, which has lifted.`,
                ),
              )
            }),
          CredentialRefused: ({ provider, reason }) =>
            Effect.gen(function* () {
              yield* options.holds.credentialRefused({
                ticket,
                provider,
                reason,
              })
              return resumed(
                'a refused credential',
                carryOn(
                  `Your turn ended as ${provider} refused the engine's credential (${reason}); the credential is usable again.`,
                ),
              )
            }),
          AgentStuck: ({ quiet, doing }) =>
            Effect.sync(() => {
              const minutes = formatDurationMillis(Duration.toMillis(quiet))
              if (restarted)
                return setAside(
                  'AGENT_STUCK',
                  `its worker gave no events for ${minutes} again, ${doing}: interrupted, as it was once before and restarted`,
                )
              restarted = true
              return resumed(
                'its quiet',
                carryOn(
                  `Your session was interrupted and restarted: it gave no events for ${minutes}, ${doing}. Whatever you were waiting on won't answer; don't run it the same way again.`,
                ),
              )
            }),
          ToolDefect: () => Effect.succeed(ends(end)),
          StartFailed: ({ reason, model: onModel }) =>
            Effect.gen(function* () {
              const [fallback, ...rest] = fallbacks
              if (
                onModel &&
                fallback !== undefined &&
                Option.isSome(worktree)
              ) {
                yield* Effect.logWarning(
                  `${ticket}: its worker didn't start on ${Option.match(model, { onNone: () => "Pi's own model", onSome: nameOf })} (${reason}); it starts on ${nameOf(fallback)}`,
                )
                model = Option.some(fallback)
                fallbacks = rest
                return Next.Again({
                  turn: WorkerTurn.Again({ worktree: worktree.value }),
                })
              }
              yield* options.holds.startFailed({ ticket, reason })
              return ends(WorkerEnd.Failed({ reason }))
            }),
          BudgetExceeded: ({ detail }) =>
            Effect.succeed(
              setAside('BUDGET_EXCEEDED', `it went over its budget: ${detail}`),
            ),
          TicketLimit: ({ limit: most }) =>
            Effect.succeed(setAside('TICKET_LIMIT', limitNote(most))),
          Unfinished: () => Effect.succeed(ends(end)),
        })
        if (Next.$is('Ends')(next)) return next.end
        turn = next.turn
      }
    })

  return {
    watch,
    overBudget: ({ ticket, detail }) =>
      Effect.flatMap(Ref.get(live), attempts => {
        const attempt = attempts.get(ticket)
        return attempt === undefined
          ? Effect.void
          : fail(attempt, WorkerFailure.BudgetExceeded({ detail }))
      }),
    stop: Ref.set(stopped, true),
  } satisfies Supervision
})
