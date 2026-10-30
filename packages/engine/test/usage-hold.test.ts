import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Fiber,
  Option,
  PubSub,
  Queue,
  Ref,
  Stream,
} from 'effect'
import { TestClock } from 'effect/testing'

import { describe, expect, it } from '@effect/vitest'
import {
  type ModelName,
  type ProviderName,
  type RunEvent,
  RunId,
  SessionId,
  TicketId,
  exitCodeOf,
} from '@fabrica/contracts'

import {
  type HoldKey,
  anyOn,
  banners,
  clockHeld,
  knownReset,
  makeHolds,
  makeUsageHold,
  modelOn,
  nextProbe,
  stopping,
  usageHeld,
} from '../src/holds'
import {
  type Caller,
  ProbeOutcome,
  ProxyEvent,
  type Refusal,
  classify,
  makePermits,
} from '../src/proxy'
import { makeRunLog } from '../src/runlog'
import { anthropicUsageLimit } from './proxy-streams'

// The usage-limit hold (spec §14.2, H20, H60): a call refused for a quota with a reset holds the whole
// run for its provider, whose calls the proxy's permits hold back; at the reset the proxy probes once
// and the hold lifts when the probe goes through; a reset at or before now is unknown, probed every
// `usage_limit_retry`; two lifts are at least `usage_limit_retry` apart; past `usage_limit_wait` the
// run stops `USAGE_LIMIT`, exit 8. The refusals are Anthropic's recorded 429, read as the proxy reads
// it; the clock is the TestClock.

const run = RunId.make('run-usage')
const one = TicketId.make('fa-u1')
const anthropic: ProviderName = 'anthropic'
const key: HoldKey = { hold: 'USAGE_LIMIT', provider: anthropic }
const RETRY = Duration.minutes(15)
const WAIT = Duration.hours(6)
const minutes = (n: number) => n * 60_000

/** The recorded window's reset, in epoch milliseconds: Thu 30 Oct 2025 16:00 UTC. */
const resetMs = anthropicUsageLimit.reset * 1000

/** Anthropic's recorded 429 past a five-hour window resetting at `reset` (epoch seconds), as the proxy reads it. */
const recorded429 = (reset: number = anthropicUsageLimit.reset): Refusal =>
  Option.getOrThrow(
    classify({
      status: 429,
      headers: {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-reset': String(reset),
      },
      wentThrough: true,
      account: Option.none(),
    }),
  )

const worker: Caller = {
  run,
  ticket: Option.some(one),
  session: Option.some(SessionId.make('s-u1')),
  model: 'anthropic/claude-opus-5-5',
}

/** A line stream that keeps nothing: the records are read from the log's subscription. */
const nowhere = (path: string) => ({ path, append: () => Effect.void })

const isOn = (snapshot: { readonly on: ReadonlyArray<unknown> }) =>
  snapshot.on.length > 0

/**
 * The usage hold over a run log in memory, the proxy's events and its permits, its probes answering
 * `answers` in turn, the last again and again.
 */
const usageHold = (answers: ReadonlyArray<ProbeOutcome>) =>
  Effect.gen(function* () {
    const log = yield* makeRunLog({
      run,
      events: nowhere('events.jsonl'),
      log: nowhere('run.log'),
    })
    const written = yield* log.subscribe
    const holds = yield* makeHolds({ log, running: Effect.succeed(1) })
    const proxy = yield* PubSub.unbounded<ProxyEvent>()
    const events = Stream.fromSubscription(yield* PubSub.subscribe(proxy))
    const left = yield* Ref.make(answers)
    const probes = yield* Queue.unbounded<{
      readonly at: number
      readonly model: ModelName
    }>()
    const usage = yield* makeUsageHold({
      holds,
      log,
      run,
      retry: RETRY,
      wait: WAIT,
      events,
      probe: ({ model }) =>
        Effect.gen(function* () {
          yield* Queue.offer(probes, {
            at: yield* Clock.currentTimeMillis,
            model,
          })
          return yield* Ref.modify(
            left,
            ([
              next = ProbeOutcome.Failed({ reason: 'no answer scripted' }),
              ...rest
            ]) => [next, rest.length === 0 ? [next] : rest],
          )
        }),
      modelFor: () => Option.some('claude-sonnet-5-5'),
    })
    const permits = yield* makePermits
    yield* permits.hold({
      run,
      held: holds.changes.pipe(Stream.map(usageHeld)),
    })
    const raised = holds.changes.pipe(
      Stream.filter(snapshot => anyOn(snapshot, 'USAGE_LIMIT')),
      Stream.runHead,
    )
    return {
      holds,
      usage,
      permits,
      probes,
      raised,
      refuse: (refusal: Refusal, caller: Caller = worker) =>
        Effect.andThen(
          PubSub.publish(
            proxy,
            ProxyEvent.Refused({ provider: anthropic, caller, refusal }),
          ),
          raised,
        ),
      wentThrough: PubSub.publish(
        proxy,
        ProxyEvent.Used({
          provider: anthropic,
          caller: worker,
          tokens: { input: 11, output: 1, cache_write: 0, cache_read: 0 },
          latency: Duration.seconds(1),
          firstToken: Option.none(),
        }),
      ),
      records: Effect.map(
        PubSub.takeUpTo(written, 1_000),
        (taken): ReadonlyArray<RunEvent> => taken,
      ),
    }
  })

const texts = (records: ReadonlyArray<RunEvent>) =>
  records.flatMap(event =>
    event.kind === 'hold' ||
    event.kind === 'usage_limit' ||
    event.kind === 'usage_limit_lifted' ||
    event.kind === 'info'
      ? [event.text]
      : [],
  )

const zone = DateTime.layerCurrentZoneOffset(0)

describe("the usage hold's rules", () => {
  it('takes a reset at or before now as unknown', () => {
    const now = DateTime.makeUnsafe(resetMs)
    const later = DateTime.makeUnsafe(resetMs + minutes(1))
    expect(knownReset(later, now)).toEqual(Option.some(later))
    expect(knownReset(now, now)).toEqual(Option.none())
    expect(knownReset(now, later)).toEqual(Option.none())
  })

  it('probes at the reset, else every retry, and never sooner than retry after a lift', () => {
    const reset = Option.some(DateTime.makeUnsafe(resetMs))
    expect(
      nextProbe({ from: 0, reset, retry: RETRY, lastLift: Option.none() }),
    ).toBe(resetMs)
    expect(
      nextProbe({
        from: 1_000,
        reset: Option.none(),
        retry: RETRY,
        lastLift: Option.none(),
      }),
    ).toBe(1_000 + minutes(15))
    expect(
      nextProbe({
        from: 0,
        reset,
        retry: RETRY,
        lastLift: Option.some(resetMs - minutes(5)),
      }),
    ).toBe(resetMs + minutes(10))
  })

  it("probes the refused call's model, as its provider names it", () => {
    expect(modelOn(anthropic, 'anthropic/claude-opus-5-5')).toEqual(
      Option.some('claude-opus-5-5'),
    )
    expect(modelOn(anthropic, 'claude-opus-5-5')).toEqual(
      Option.some('claude-opus-5-5'),
    )
    expect(modelOn(anthropic, 'openai/gpt-5')).toEqual(Option.none())
    expect(modelOn(anthropic, 'none')).toEqual(Option.none())
  })
})

describe('the usage-limit hold', () => {
  it.effect(
    "holds the run and the provider's calls until the probe at the reset goes through",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(resetMs - minutes(120))
        const kit = yield* usageHold([ProbeOutcome.Passed()])
        yield* kit.refuse(recorded429())
        const held = yield* kit.holds.current
        expect(clockHeld(held)).toBe(true)
        expect(banners(held)).toEqual([
          "HOLD: USAGE_LIMIT (anthropic): anthropic's usage limit, until its reset at 16:00, when the model proxy probes anthropic",
        ])
        // The provider's calls of the run wait for their permit; another provider's, another run's, go on.
        const call = yield* Effect.forkChild(
          Effect.scoped(
            kit.permits.take({ provider: anthropic, caller: worker }),
          ),
        )
        yield* Effect.scoped(
          kit.permits.take({ provider: 'openai', caller: worker }),
        )
        yield* Effect.scoped(
          kit.permits.take({
            provider: anthropic,
            caller: { ...worker, run: RunId.make('run-other') },
          }),
        )
        const waiting = yield* Effect.forkChild(
          kit.usage.waitOut({
            ticket: one,
            provider: anthropic,
            resetAt: DateTime.makeUnsafe(resetMs),
          }),
        )
        yield* TestClock.adjust('119 minutes')
        expect(yield* Queue.size(kit.probes)).toBe(0)
        expect(call.pollUnsafe()).toBeUndefined()
        expect(waiting.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust('1 minute')
        expect(yield* Queue.take(kit.probes)).toEqual({
          at: resetMs,
          model: 'claude-opus-5-5',
        })
        yield* kit.holds.lifted(key)
        yield* Fiber.join(call)
        yield* Fiber.join(waiting)
        expect(clockHeld(yield* kit.holds.current)).toBe(false)
        // A worker whose turn ended on the same refusal carries on: its hold has lifted.
        yield* kit.usage.waitOut({
          ticket: one,
          provider: anthropic,
          resetAt: DateTime.makeUnsafe(resetMs),
        })
        expect((yield* kit.holds.current).on).toEqual([])
        const records = yield* kit.records
        expect(texts(records)).toEqual([
          "HOLD: USAGE_LIMIT: anthropic's usage limit, until its reset at 16:00, when the model proxy probes anthropic; no new tickets while the 1 running finish",
          "USAGE_LIMIT: anthropic refused a call of fa-u1's for its usage limit; it resets at 16:00",
          "anthropic's usage limit lifted: anthropic answered the model proxy's probe",
          "USAGE_LIMIT lifted: anthropic answered the model proxy's probe",
        ])
        expect(
          records.flatMap(event =>
            event.kind === 'usage_limit'
              ? [{ ticket: event.ticket, reset: event.reset }]
              : [],
          ),
        ).toEqual([{ ticket: one, reset: '2025-10-30T16:00:00.000+00:00' }])
      }).pipe(Effect.scoped, Effect.provide(zone)),
  )

  it.effect('says a reset with its day when it is not today', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(resetMs - minutes(20 * 60))
      const kit = yield* usageHold([ProbeOutcome.Passed()])
      yield* kit.refuse(recorded429())
      expect(banners(yield* kit.holds.current)).toEqual([
        "HOLD: USAGE_LIMIT (anthropic): anthropic's usage limit, until its reset at Thu 30 Oct 16:00, when the model proxy probes anthropic",
      ])
    }).pipe(Effect.scoped, Effect.provide(zone)),
  )

  it.effect(
    'takes a reset at or before now as unknown, probing every usage_limit_retry',
    () =>
      Effect.gen(function* () {
        const start = resetMs + minutes(1)
        yield* TestClock.setTime(start)
        const kit = yield* usageHold([
          ProbeOutcome.Refused({ refusal: recorded429() }),
          ProbeOutcome.Passed(),
        ])
        // An organ's call: no ticket, the run's own model probed.
        yield* kit.refuse(recorded429(), {
          ...worker,
          ticket: Option.none(),
          session: Option.none(),
          model: 'none',
        })
        yield* TestClock.adjust('14 minutes')
        expect(yield* Queue.size(kit.probes)).toBe(0)
        yield* TestClock.adjust('1 minute')
        expect(yield* Queue.take(kit.probes)).toEqual({
          at: start + minutes(15),
          model: 'claude-sonnet-5-5',
        })
        yield* TestClock.adjust('15 minutes')
        expect((yield* Queue.take(kit.probes)).at).toBe(start + minutes(30))
        yield* kit.holds.lifted(key)
        const records = yield* kit.records
        expect(texts(records)).toEqual([
          "HOLD: USAGE_LIMIT: anthropic's usage limit, its reset unknown; the model proxy probes anthropic every 15m; no new tickets while the 1 running finish",
          'USAGE_LIMIT: anthropic refused a call of the run for its usage limit; its reset unknown',
          "USAGE_LIMIT: the model proxy's probe of anthropic was refused for its usage limit; probing again in 15m, its reset unknown",
          "anthropic's usage limit lifted: anthropic answered the model proxy's probe",
          "USAGE_LIMIT lifted: anthropic answered the model proxy's probe",
        ])
        expect(
          records.flatMap(event =>
            event.kind === 'usage_limit' ? [event.reset] : [],
          ),
        ).toEqual([undefined])
      }).pipe(Effect.scoped, Effect.provide(zone)),
  )

  it.effect('keeps two lifts at least usage_limit_retry apart', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(resetMs - minutes(10))
      const kit = yield* usageHold([ProbeOutcome.Passed()])
      yield* kit.refuse(recorded429())
      yield* TestClock.adjust('10 minutes')
      expect((yield* Queue.take(kit.probes)).at).toBe(resetMs)
      yield* kit.holds.lifted(key)
      // A misread reset two minutes on: the probe waits for usage_limit_retry after the lift.
      yield* TestClock.adjust('1 minute')
      yield* kit.refuse(recorded429(anthropicUsageLimit.reset + 3 * 60))
      yield* TestClock.adjust('2 minutes')
      expect(yield* Queue.size(kit.probes)).toBe(0)
      yield* TestClock.adjust('12 minutes')
      expect((yield* Queue.take(kit.probes)).at).toBe(resetMs + minutes(15))
      yield* kit.holds.lifted(key)
      // With no reset known, a call that goes through lifts it, again no sooner than retry after.
      yield* TestClock.adjust('1 minute')
      yield* kit.refuse(recorded429(anthropicUsageLimit.reset))
      yield* TestClock.adjust('2 minutes')
      yield* kit.wentThrough
      yield* TestClock.adjust('11 minutes')
      expect(isOn(yield* kit.holds.current)).toBe(true)
      yield* TestClock.adjust('1 minute')
      yield* kit.holds.lifted(key)
      expect(yield* Clock.currentTimeMillis).toBe(resetMs + minutes(30))
      expect(yield* Queue.size(kit.probes)).toBe(0)
      const lifts = (yield* kit.records).flatMap(event =>
        event.kind === 'usage_limit_lifted' ? [event.text] : [],
      )
      expect(lifts).toEqual([
        "anthropic's usage limit lifted: anthropic answered the model proxy's probe",
        "anthropic's usage limit lifted: anthropic answered the model proxy's probe",
        "anthropic's usage limit lifted: a call to anthropic went through",
      ])
    }).pipe(Effect.scoped, Effect.provide(zone)),
  )

  it.effect(
    'gives up past usage_limit_wait: the run stops USAGE_LIMIT, exit 8',
    () =>
      Effect.gen(function* () {
        const start = resetMs + minutes(1)
        yield* TestClock.setTime(start)
        const kit = yield* usageHold([
          ProbeOutcome.Refused({ refusal: recorded429() }),
        ])
        yield* kit.refuse(recorded429())
        // Probes every 15 minutes, the last before the wait is out.
        for (let n = 1; n < 24; n++) {
          yield* TestClock.adjust('15 minutes')
          expect((yield* Queue.take(kit.probes)).at).toBe(
            start + minutes(15 * n),
          )
        }
        yield* TestClock.adjust('15 minutes')
        yield* kit.holds.lifted(key)
        expect(yield* Queue.size(kit.probes)).toBe(0)
        const held = yield* kit.holds.current
        const gaveUp = Option.getOrThrow(stopping(held))
        expect(gaveUp.kind).toBe('USAGE_LIMIT')
        expect(gaveUp.ticket).toEqual(Option.some(one))
        expect(gaveUp.detail).toBe(
          "anthropic's usage limit held the run past usage_limit_wait, 6h",
        )
        expect(exitCodeOf(gaveUp.kind)).toBe(8)
        // It stays on: the run ends holding, its workers kept for the carry-over.
        expect(held.on.map(({ hold }) => hold)).toEqual(['USAGE_LIMIT'])
      }).pipe(Effect.scoped, Effect.provide(zone)),
  )
})
