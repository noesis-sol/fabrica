import {
  Clock,
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  Ref,
  type Scope,
  Semaphore,
  Stream,
} from 'effect'

import { type SleepCause, SleepCauses } from './sleep-cause'

// Time awake (spec §7.7, H66). Every time limit (a command's, a ticket's, a hand-back's, an organ's,
// a question's wait, …) counts the time its host is awake, not wall time: the wake service reads the
// wall clock every second, and a gap of more than 15 s is a sleep, which puts off every limit it
// crossed and is published as a `Slept` notification (writing the `slept` event is the event log's).
// Usage-limit resets, leases and sync schedules stay on the wall clock. tutti's limits counted wall
// time, so a laptop that idle-slept 33 minutes across a merge check failed it at the wake (tutti-dhyy).
//
// Time awake runs on the monotonic clock, between readings no more than 15 s apart on the wall
// clock; a reading after a longer gap adds nothing, whether or not the monotonic clock counted the
// sleep (that depends on the runtime). A wall clock stepping back puts nothing off.
// Everything reads Effect's `Clock`, so tests drive it with `TestClock` (H55, H88).

/** How often the wake service reads the wall clock. */
export const heartbeat = Duration.seconds(1)

/** A gap between two readings of the wall clock longer than this is a sleep. */
export const sleepGap = Duration.seconds(15)

/** The host slept: a gap of more than 15 s between two readings of the wall clock. */
export class Slept extends Data.Class<{
  /** When the host was last seen awake. */
  readonly from: DateTime.Utc
  /** When it was seen awake again. */
  readonly to: DateTime.Utc
  /** The gap: how long every limit counted in time awake was put off. */
  readonly span: Duration.Duration
  /** Why it slept, where the OS logs it (macOS). */
  readonly cause: Option.Option<SleepCause>
}> {}

/** When a limit runs out. */
export type Deadline = Data.TaggedEnum<{
  /** Counted in time awake, put off by every sleep it crosses: the time awake it falls due at. */
  Awake: { readonly at: Duration.Duration }
  /** On the wall clock, whatever the host does: a usage-limit reset, a lease, a sync schedule. */
  Wall: { readonly at: DateTime.Utc }
}>
export const Deadline = Data.taggedEnum<Deadline>()

/** A deadline `limit` from now on the wall clock. */
export const wallDeadline = (limit: Duration.Input): Effect.Effect<Deadline> =>
  Effect.map(DateTime.now, now =>
    Deadline.Wall({ at: DateTime.addDuration(now, limit) }),
  )

/** The wake service: time awake, deadlines counted in it, and the sleeps it saw. */
export class Wake extends Context.Service<
  Wake,
  {
    /** The time the host has been awake since the service started. */
    readonly awake: Effect.Effect<Duration.Duration>
    /** A deadline `limit` of time awake from now. */
    readonly deadline: (limit: Duration.Input) => Effect.Effect<Deadline>
    /** What is left of `deadline`: zero once it is due. */
    readonly remaining: (deadline: Deadline) => Effect.Effect<Duration.Duration>
    /** When `deadline` falls due on the wall clock, if the host stays awake till then. */
    readonly dueAt: (deadline: Deadline) => Effect.Effect<DateTime.Utc>
    /** Waits until `deadline` is due. */
    readonly waitUntil: (deadline: Deadline) => Effect.Effect<void>
    /** `self`'s result, or none when `limit` of time awake runs out first, which interrupts it. */
    readonly timeoutOption: <A, E, R>(
      self: Effect.Effect<A, E, R>,
      limit: Duration.Input,
    ) => Effect.Effect<Option.Option<A>, E, R>
    /** Every sleep seen from the moment of subscribing, its cause looked up. */
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<Slept>,
      never,
      Scope.Scope
    >
    /** Every sleep seen while the stream runs, its cause looked up. */
    readonly slept: Stream.Stream<Slept>
  }
>()('Wake') {}

/** The last reading of the clocks, and the time awake as of it. */
interface Reading {
  readonly wallMillis: number
  readonly monotonicNanos: bigint
  readonly awakeNanos: bigint
}

const read = Effect.all({
  wallMillis: Clock.currentTimeMillis,
  monotonicNanos: Clock.monotonicTimeNanos,
})

const zero = BigInt(0)
const gapMillis = Duration.toMillis(sleepGap)

/** The wake service, reading the clock every `heartbeat` for as long as its scope is open. */
export const makeWake = Effect.gen(function* () {
  const causes = yield* SleepCauses
  const scope = yield* Effect.scope
  const first = yield* read
  const last = yield* Ref.make<Reading>({ ...first, awakeNanos: zero })
  const lock = yield* Semaphore.make(1)
  const slept = yield* PubSub.unbounded<Slept>()
  // Wakes waiters as soon as a gap is seen, before its cause is looked up.
  const woke = yield* PubSub.unbounded<void>()

  const announce = Effect.fn('Wake.announce')(function* (
    fromMillis: number,
    toMillis: number,
  ) {
    const from = DateTime.makeUnsafe(fromMillis)
    const to = DateTime.makeUnsafe(toMillis)
    const cause = yield* causes.causeOf({ from, to })
    yield* PubSub.publish(
      slept,
      new Slept({
        from,
        to,
        span: Duration.millis(toMillis - fromMillis),
        cause,
      }),
    )
  })

  /** Reads the clocks, counts the time awake since the last reading, and sees a sleep in a gap. */
  const observe = lock.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* read
      const before = yield* Ref.get(last)
      const asleep = now.wallMillis - before.wallMillis > gapMillis
      const ran = now.monotonicNanos - before.monotonicNanos
      const awakeNanos = before.awakeNanos + (asleep || ran < zero ? zero : ran)
      yield* Ref.set(last, { ...now, awakeNanos })
      if (asleep) {
        yield* PubSub.publish(woke, undefined)
        yield* Effect.forkIn(announce(before.wallMillis, now.wallMillis), scope)
      }
      return awakeNanos
    }),
  )

  yield* Effect.forkIn(Effect.forever(Effect.delay(observe, heartbeat)), scope)

  const awake = Effect.map(observe, Duration.nanos)

  const remaining = (deadline: Deadline): Effect.Effect<Duration.Duration> =>
    Deadline.$match(deadline, {
      Awake: ({ at }) =>
        Effect.map(awake, now =>
          Duration.max(Duration.subtract(at, now), Duration.zero),
        ),
      Wall: ({ at }) =>
        Effect.map(DateTime.now, now =>
          Duration.millis(
            Math.max(
              DateTime.toEpochMillis(at) - DateTime.toEpochMillis(now),
              0,
            ),
          ),
        ),
    })

  const deadline = (limit: Duration.Input): Effect.Effect<Deadline> =>
    Effect.map(awake, now =>
      Deadline.Awake({
        at: Duration.sum(now, Duration.fromInputUnsafe(limit)),
      }),
    )

  const waitUntil = (due: Deadline): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        // Subscribed before the first look, so a sleep seen after it wakes the wait: a timer may
        // not count the time the host slept, and a deadline on the wall clock does.
        const wakes = yield* PubSub.subscribe(woke)
        for (;;) {
          const left = yield* remaining(due)
          if (Duration.isZero(left)) return
          yield* Effect.raceFirst(Effect.sleep(left), PubSub.take(wakes))
        }
      }),
    )

  return Wake.of({
    awake,
    deadline,
    remaining,
    dueAt: due =>
      Effect.flatMap(remaining(due), left =>
        Effect.map(DateTime.now, now => DateTime.addDuration(now, left)),
      ),
    waitUntil,
    timeoutOption: (self, limit) =>
      Effect.flatMap(deadline(limit), due =>
        Effect.raceFirst(
          Effect.asSome(self),
          Effect.as(waitUntil(due), Option.none()),
        ),
      ),
    subscribe: PubSub.subscribe(slept),
    slept: Stream.fromPubSub(slept),
  })
})

/** The wake service, reading the clock while the layer is in use. */
export const layerWake: Layer.Layer<Wake, never, SleepCauses> = Layer.effect(
  Wake,
  makeWake,
)
