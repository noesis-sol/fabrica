import {
  Clock,
  Data,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Option,
  Ref,
  Stream,
} from 'effect'

import {
  type ModelName,
  type ProviderName,
  type RunId,
  type TicketId,
  formatDurationMillis,
  formatLocalTime,
  sayMoment,
} from '@fabrica/contracts'

import { ProbeOutcome, ProxyEvent, Refusal } from '../proxy'
import { record } from '../run/records'
import type { RunLog } from '../runlog'
import {
  type HoldKey,
  type HoldsShape,
  type HoldsSnapshot,
  isOn,
} from './state'

// The usage-limit hold (spec §14.2, H20, H60): a model call of the run refused for a quota with a reset
// (a worker's or an organ's, as the model proxy sees it first-hand) holds the whole run for its
// provider: no new tickets, no permit for that provider (`usageHeld`, for the proxy's permits), the
// running workers waiting with their hand-back clocks stopped until they are told to carry on. The
// hold lifts on evidence: at its reset the proxy makes one small probe call and the hold lifts when it
// goes through. A reset at or before now is taken as unknown; with none known the proxy probes every
// `usage_limit_retry`, and any call to the provider that goes through lifts the hold too. Two lifts for
// a provider are at least `usage_limit_retry` apart, so a misread reset can't send workers into the
// limit call after call. A worker's refusal ends with its turn: its wait is for the hold that refusal
// raised, which may have lifted already. Past `usage_limit_wait` the hold gives up and the run ends
// `USAGE_LIMIT` (exit 8), its workers kept for the carry-over. Resets are said with their day when it
// isn't today.

/** A call refused for a quota with a reset, as the hold takes it. */
export interface Limited {
  readonly provider: ProviderName
  /** The model the hold's probe calls: the refused call's, else one of the run's on its provider. */
  readonly model: Option.Option<ModelName>
  /** The ticket whose worker made the call; none for an organ's or a probe's. */
  readonly ticket: Option.Option<TicketId>
  /** The reset the refusal named. */
  readonly resetAt: DateTime.Utc
}

/**
 * The reset a refusal named, as the hold takes it: one at or before now (a clock behind the
 * provider's, a provider still refusing just after its reset) is unknown.
 */
export const knownReset = (
  resetAt: DateTime.Utc,
  now: DateTime.Utc,
): Option.Option<DateTime.Utc> =>
  DateTime.isGreaterThan(resetAt, now) ? Option.some(resetAt) : Option.none()

/**
 * When the hold probes next, in epoch milliseconds: at its reset, else `retry` after `from`, its raise
 * or its last probe; never sooner than `retry` after its provider's last lift.
 */
export const nextProbe = (input: {
  readonly from: number
  readonly reset: Option.Option<DateTime.Utc>
  readonly retry: Duration.Duration
  readonly lastLift: Option.Option<number>
}): number => {
  const retry = Duration.toMillis(input.retry)
  const at = Option.match(input.reset, {
    onNone: () => input.from + retry,
    onSome: DateTime.toEpochMillis,
  })
  return Option.match(input.lastLift, {
    onNone: () => at,
    onSome: lift => Math.max(at, lift + retry),
  })
}

/** The providers the run's usage limits hold: the proxy grants their calls no permit. */
export const usageHeld = (snapshot: HoldsSnapshot): ReadonlySet<ProviderName> =>
  new Set(
    snapshot.on.flatMap(on =>
      on.hold === 'USAGE_LIMIT' ? Option.toArray(on.provider) : [],
    ),
  )

/**
 * The model a refused call names, as the provider takes it: `anthropic/claude-…` is `claude-…` for
 * `anthropic`; none for Pi's own (`none`) or another provider's.
 */
export const modelOn = (
  provider: ProviderName,
  model: ModelName,
): Option.Option<ModelName> => {
  const prefix = `${provider}/`
  if (model.startsWith(prefix)) return Option.some(model.slice(prefix.length))
  return model === 'none' || model.includes('/')
    ? Option.none()
    : Option.some(model)
}

/** What ended one wait of the hold. */
type Woke = Data.TaggedEnum<{
  /** Its probe's time came. */
  Probe: {}
  /** A call to its provider went through, with no reset known. */
  WentThrough: {}
  /** `usage_limit_wait` passed. */
  Outlasted: {}
}>
const Woke = Data.taggedEnum<Woke>()

export interface UsageHoldShape {
  /** A call of the run refused for a quota: the run holds for its provider, its probes forked. */
  readonly refused: (limited: Limited) => Effect.Effect<void>
  /**
   * A worker's turn ended on its provider's usage limit, its reset `resetAt`: completes once it may
   * carry on, at once where the hold its refusal raised has lifted since.
   */
  readonly waitOut: (input: {
    readonly ticket: TicketId
    readonly provider: ProviderName
    readonly resetAt: DateTime.Utc
  }) => Effect.Effect<void>
}

/**
 * The run's usage-limit hold, over its holds and its records, in the scope: `events` are the model
 * proxy's, `probe` its probe of a provider's model for the run, `modelFor` the model of the run's to
 * probe a provider on where the refused call named none of it.
 */
export const makeUsageHold = Effect.fn('UsageHold.make')(function* (input: {
  readonly holds: HoldsShape
  readonly log: RunLog['Service']
  readonly run: RunId
  /** `usage_limit_retry`. */
  readonly retry: Duration.Duration
  /** `usage_limit_wait`. */
  readonly wait: Duration.Duration
  readonly events: Stream.Stream<ProxyEvent>
  readonly probe: (call: {
    readonly provider: ProviderName
    readonly model: ModelName
  }) => Effect.Effect<ProbeOutcome>
  readonly modelFor: (provider: ProviderName) => Option.Option<ModelName>
}) {
  const { holds, log } = input
  const scope = yield* Effect.scope
  const zone = yield* DateTime.CurrentTimeZone
  const retryWords = formatDurationMillis(Duration.toMillis(input.retry))
  /** When each provider's hold last lifted, in epoch milliseconds. */
  const lifts = yield* Ref.make<ReadonlyMap<ProviderName, number>>(new Map())
  /** While a provider's hold waits with no reset known: completed by a call to it going through. */
  const through = yield* Ref.make<
    ReadonlyMap<ProviderName, Deferred.Deferred<void>>
  >(new Map())

  /** `at` as the hold says it: `14:05`, or `Fri 30 Oct 02:00` when it isn't today. */
  const say = (at: DateTime.Utc, now: DateTime.Utc) =>
    sayMoment(at, DateTime.setZone(now, zone))

  const sleepUntil = (at: number) =>
    Effect.flatMap(Clock.currentTimeMillis, now =>
      Effect.sleep(Duration.millis(Math.max(0, at - now))),
    )

  const lastLift = (provider: ProviderName) =>
    Effect.map(Ref.get(lifts), lifted =>
      Option.fromUndefinedOr(lifted.get(provider)),
    )

  /** The hold lifts for `provider`, at least `retry` after its last lift. */
  const lift = (provider: ProviderName, why: string) =>
    Effect.gen(function* () {
      yield* Option.match(yield* lastLift(provider), {
        onNone: () => Effect.void,
        onSome: last => sleepUntil(last + Duration.toMillis(input.retry)),
      })
      yield* record(log, {
        kind: 'usage_limit_lifted',
        provider,
        text: `${provider}'s usage limit lifted: ${why}`,
      })
      // Its lift is kept before the hold goes, so a worker's wait never finds it off and unrecorded.
      const now = yield* Clock.currentTimeMillis
      yield* Ref.update(lifts, lifted => new Map(lifted).set(provider, now))
      yield* holds.lift({ hold: 'USAGE_LIMIT', provider, why })
    })

  /** The hold's probes, from its raise until it lifts or outlasts `usage_limit_wait`. */
  const probing = (limited: Limited, first: Option.Option<DateTime.Utc>) =>
    Effect.gen(function* () {
      const { provider } = limited
      let from = yield* Clock.currentTimeMillis
      const deadline = from + Duration.toMillis(input.wait)
      let reset = first
      while (true) {
        const at = nextProbe({
          from,
          reset,
          retry: input.retry,
          lastLift: yield* lastLift(provider),
        })
        const wentThrough = yield* Deferred.make<void>()
        yield* Ref.update(through, waiting =>
          Option.isNone(reset)
            ? new Map(waiting).set(provider, wentThrough)
            : new Map([...waiting].filter(([held]) => held !== provider)),
        )
        const woke =
          (yield* Clock.currentTimeMillis) >= deadline
            ? Woke.Outlasted()
            : yield* Effect.raceAll([
                Effect.as(sleepUntil(deadline), Woke.Outlasted()),
                ...(at < deadline
                  ? [Effect.as(sleepUntil(at), Woke.Probe())]
                  : []),
                ...(Option.isNone(reset)
                  ? [Effect.as(Deferred.await(wentThrough), Woke.WentThrough())]
                  : []),
              ])
        /** The probe came to no lift: when it probes again, as the hold says it. */
        const again = (what: string, after: DateTime.Utc) =>
          Effect.gen(function* () {
            const next = Option.match(reset, {
              onSome: at => `at its reset, ${say(at, after)}`,
              onNone: () => `in ${retryWords}, its reset unknown`,
            })
            yield* record(log, {
              kind: 'info',
              text: `USAGE_LIMIT: the model proxy's probe of ${provider} was ${what}; probing again ${next}`,
            })
            return false
          })
        const ended: boolean = yield* Woke.$match(woke, {
          Outlasted: () =>
            Effect.as(
              holds.giveUp({
                kind: 'USAGE_LIMIT',
                ticket: limited.ticket,
                detail: `${provider}'s usage limit held the run past usage_limit_wait, ${formatDurationMillis(Duration.toMillis(input.wait))}`,
              }),
              true,
            ),
          WentThrough: () =>
            Effect.as(
              lift(provider, `a call to ${provider} went through`),
              true,
            ),
          Probe: () =>
            Effect.gen(function* () {
              from = yield* Clock.currentTimeMillis
              const probed = yield* Option.match(limited.model, {
                onNone: () =>
                  Effect.succeed(
                    ProbeOutcome.Failed({
                      reason: `the run has no model on ${provider} to probe`,
                    }),
                  ),
                onSome: model => input.probe({ provider, model }),
              })
              const after = yield* DateTime.now
              return yield* ProbeOutcome.$match(probed, {
                Passed: () =>
                  Effect.as(
                    lift(
                      provider,
                      `${provider} answered the model proxy's probe`,
                    ),
                    true,
                  ),
                Refused: ({ refusal }) => {
                  reset = Refusal.$is('UsageLimited')(refusal)
                    ? knownReset(refusal.resetAt, after)
                    : Option.none()
                  return again(
                    Refusal.$is('UsageLimited')(refusal)
                      ? 'refused for its usage limit'
                      : `refused (${refusal._tag})`,
                    after,
                  )
                },
                Failed: ({ reason }) => {
                  reset = Option.none()
                  return again(`failed (${reason})`, after)
                },
              })
            }),
        })
        if (ended) break
      }
      yield* Ref.update(
        through,
        waiting => new Map([...waiting].filter(([held]) => held !== provider)),
      )
    })

  const refused: UsageHoldShape['refused'] = limited =>
    Effect.gen(function* () {
      const { provider } = limited
      const now = yield* DateTime.now
      const reset = knownReset(limited.resetAt, now)
      const why = Option.match(reset, {
        onSome: at =>
          `${provider}'s usage limit, until its reset at ${say(at, now)}, when the model proxy probes ${provider}`,
        onNone: () =>
          `${provider}'s usage limit, its reset unknown; the model proxy probes ${provider} every ${retryWords}`,
      })
      const raised = yield* holds.raise({
        hold: 'USAGE_LIMIT',
        provider,
        why,
      })
      if (!raised) return
      const by = Option.match(limited.ticket, {
        onNone: () => 'a call of the run',
        onSome: ticket => `a call of ${ticket}'s`,
      })
      yield* record(log, {
        kind: 'usage_limit',
        provider,
        ...Option.match(limited.ticket, {
          onNone: () => ({}),
          onSome: ticket => ({ ticket }),
        }),
        detail: why,
        ...Option.match(reset, {
          onNone: () => ({}),
          onSome: at => ({
            reset: formatLocalTime(DateTime.setZone(at, zone)),
          }),
        }),
        text: `USAGE_LIMIT: ${provider} refused ${by} for its usage limit; ${Option.match(
          reset,
          {
            onSome: at => `it resets at ${say(at, now)}`,
            onNone: () => 'its reset unknown',
          },
        )}`,
      })
      yield* Effect.forkIn(probing(limited, reset), scope)
    })

  // The proxy's events for the run: a quota refused holds it, a call that goes through is evidence.
  yield* input.events.pipe(
    Stream.filter(event => event.caller.run === input.run),
    Stream.runForEach(event =>
      ProxyEvent.$match(event, {
        Used: ({ provider }) =>
          Effect.flatMap(Ref.get(through), waiting =>
            Option.match(Option.fromUndefinedOr(waiting.get(provider)), {
              onNone: () => Effect.void,
              onSome: wentThrough =>
                Effect.asVoid(Deferred.succeed(wentThrough, undefined)),
            }),
          ),
        Refused: ({ provider, caller, refusal }) =>
          Refusal.$is('UsageLimited')(refusal)
            ? refused({
                provider,
                model: Option.orElse(modelOn(provider, caller.model), () =>
                  input.modelFor(provider),
                ),
                ticket: caller.ticket,
                resetAt: refusal.resetAt,
              })
            : Effect.void,
        Windowed: () => Effect.void,
      }),
    ),
    Effect.forkIn(scope),
  )

  return {
    refused,
    waitOut: ({ ticket, provider, resetAt }) =>
      Effect.gen(function* () {
        const key: HoldKey = { hold: 'USAGE_LIMIT', provider }
        if (!isOn(yield* holds.current, key)) {
          // A lift at or after the refusal's reset came after the refusal: its hold has lifted.
          const last = yield* lastLift(provider)
          if (Option.exists(last, at => at >= DateTime.toEpochMillis(resetAt)))
            return
          // The proxy's event not yet taken: the worker's refusal raises the hold.
          yield* refused({
            provider,
            model: input.modelFor(provider),
            ticket: Option.some(ticket),
            resetAt,
          })
        }
        yield* holds.lifted(key)
      }),
  } satisfies UsageHoldShape
})
