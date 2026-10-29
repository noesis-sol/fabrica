import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  type Scope,
} from 'effect'
import { TestClock } from 'effect/testing'

import { describe, expect, it } from '@effect/vitest'

import {
  Deadline,
  SleepCause,
  SleepCauses,
  type SleepSpan,
  Wake,
  describeSleepCause,
  elapsed,
  layerWake,
  localNow,
  noSleepCauses,
  parsePmsetLog,
  sleepCausesFor,
  startStopwatch,
  toLocalTime,
  wallDeadline,
} from '../src/time'

// 2026-10-29T12:00:00.000Z, a whole second.
const start = Date.UTC(2026, 9, 29, 12, 0, 0)

/**
 * The test's host: `TestClock`, with a wall clock that can jump while the timers stand still, as a
 * host's do while it sleeps, or step on its own, as NTP steps it. Whether the monotonic clock counts
 * a sleep depends on the runtime, so a test says which.
 */
const makeHost = Effect.gen(function* () {
  const testClock = yield* TestClock.testClockWith(Effect.succeed)
  let wallShift = BigInt(0)
  let monotonicShift = BigInt(0)
  const wallNanos = () => testClock.currentTimeNanosUnsafe() + wallShift
  const wallMillis = () => Number(wallNanos() / BigInt(1_000_000))
  const monotonicNanos = () =>
    testClock.monotonicTimeNanosUnsafe() + monotonicShift
  const clock: TestClock.TestClock = {
    ...testClock,
    currentTimeMillisUnsafe: wallMillis,
    currentTimeMillis: Effect.sync(wallMillis),
    currentTimeNanosUnsafe: wallNanos,
    currentTimeNanos: Effect.sync(wallNanos),
    monotonicTimeNanosUnsafe: monotonicNanos,
    monotonicTimeNanos: Effect.sync(monotonicNanos),
  }
  const nanos = (by: Duration.Input) =>
    Duration.toNanosUnsafe(Duration.fromInputUnsafe(by))
  return {
    clock,
    /** The host sleeps for `span`: the wall clock moves on, the monotonic clock and timers don't. */
    sleeps: (span: Duration.Input) =>
      Effect.sync(() => {
        wallShift += nanos(span)
      }),
    /** The host sleeps for `span` on a runtime whose monotonic clock counts it. */
    sleepsCounted: (span: Duration.Input) =>
      Effect.sync(() => {
        wallShift += nanos(span)
        monotonicShift += nanos(span)
      }),
    /** The wall clock steps by `by`, back where it is negative. */
    stepWall: (by: Duration.Input) =>
      Effect.sync(() => {
        wallShift += nanos(by)
      }),
  }
})

/** Runs `body` on the test's host, from `start`, with the wake service and `causes`. */
const onHost = <A, E>(
  body: (
    host: Effect.Success<typeof makeHost>,
  ) => Effect.Effect<A, E, Wake | DateTime.CurrentTimeZone | Scope.Scope>,
  causes: Layer.Layer<SleepCauses> = noSleepCauses,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(start)
    const host = yield* makeHost
    return yield* body(host).pipe(
      Effect.provide(layerWake.pipe(Layer.provide(causes))),
      Effect.provide(DateTime.layerCurrentZoneOffset(2 * 60 * 60 * 1000)),
      Effect.provideService(Clock.Clock, host.clock),
    )
  })

const minutes = (n: number) => Duration.minutes(n)

describe('time awake', () => {
  it.effect(
    'a 34-minute gap is a sleep that puts off a 30-minute deadline by its length',
    () =>
      onHost(host =>
        Effect.gen(function* () {
          const wake = yield* Wake
          const sleeps = yield* wake.subscribe
          const deadline = yield* wake.deadline(minutes(30))
          expect(DateTime.toEpochMillis(yield* wake.dueAt(deadline))).toBe(
            start + Duration.toMillis(minutes(30)),
          )
          const waiting = yield* Effect.forkChild(wake.waitUntil(deadline))

          yield* TestClock.adjust(minutes(10))
          yield* host.sleeps(minutes(34))
          yield* TestClock.adjust(Duration.seconds(1))

          const slept = yield* PubSub.take(sleeps)
          // The gap from the last reading, 10 minutes in, to the first after the wake.
          const span = Duration.sum(minutes(34), Duration.seconds(1))
          expect(Duration.toMillis(slept.span)).toBe(Duration.toMillis(span))
          expect(DateTime.toEpochMillis(slept.from)).toBe(
            start + Duration.toMillis(minutes(10)),
          )
          expect(DateTime.toEpochMillis(slept.to)).toBe(
            start + Duration.toMillis(minutes(10)) + Duration.toMillis(span),
          )
          expect(Option.isNone(slept.cause)).toBe(true)

          // The time asleep isn't counted: 20 minutes of the 30 are left, due 34m 1s later.
          expect(Duration.toMillis(yield* wake.awake)).toBe(
            Duration.toMillis(minutes(10)),
          )
          expect(Duration.toMillis(yield* wake.remaining(deadline))).toBe(
            Duration.toMillis(minutes(20)),
          )
          expect(DateTime.toEpochMillis(yield* wake.dueAt(deadline))).toBe(
            start + Duration.toMillis(minutes(30)) + Duration.toMillis(span),
          )

          yield* TestClock.adjust(
            Duration.subtract(minutes(20), Duration.millis(1)),
          )
          expect(waiting.pollUnsafe()).toBeUndefined()
          yield* TestClock.adjust(1)
          yield* Fiber.join(waiting)
          expect(Duration.isZero(yield* wake.remaining(deadline))).toBe(true)
        }),
      ),
  )

  it.effect('a sleep the monotonic clock counts is not counted either', () =>
    onHost(host =>
      Effect.gen(function* () {
        const wake = yield* Wake
        const deadline = yield* wake.deadline(minutes(30))
        yield* TestClock.adjust(minutes(10))
        yield* host.sleepsCounted(minutes(34))
        yield* TestClock.adjust(Duration.seconds(1))
        expect(Duration.toMillis(yield* wake.awake)).toBe(
          Duration.toMillis(minutes(10)),
        )
        expect(Duration.toMillis(yield* wake.remaining(deadline))).toBe(
          Duration.toMillis(minutes(20)),
        )
      }),
    ),
  )

  it.effect('a deadline on the wall clock is not put off', () =>
    onHost(host =>
      Effect.gen(function* () {
        const wake = yield* Wake
        const deadline = yield* wallDeadline(minutes(30))
        const waiting = yield* Effect.forkChild(wake.waitUntil(deadline))

        yield* TestClock.adjust(minutes(10))
        expect(Duration.toMillis(yield* wake.remaining(deadline))).toBe(
          Duration.toMillis(minutes(20)),
        )
        yield* host.sleeps(minutes(34))
        // The wait ends at the wake, though no timer would have run out yet.
        yield* TestClock.adjust(Duration.seconds(1))
        yield* Fiber.join(waiting)
        expect(Duration.isZero(yield* wake.remaining(deadline))).toBe(true)
      }),
    ),
  )

  it.effect('a gap of 15 s is not a sleep, and its time is counted', () =>
    onHost(host =>
      Effect.gen(function* () {
        const wake = yield* Wake
        const sleeps = yield* wake.subscribe
        yield* TestClock.adjust(Duration.seconds(1))
        yield* host.sleeps(Duration.seconds(14))
        yield* TestClock.adjust(Duration.seconds(1))
        expect(yield* PubSub.remaining(sleeps)).toBe(0)
        // The monotonic clock is what counts: it ran 2 s.
        expect(Duration.toMillis(yield* wake.awake)).toBe(2000)
      }),
    ),
  )

  it.effect('a limit counted in time awake ends its effect', () =>
    onHost(host =>
      Effect.gen(function* () {
        const wake = yield* Wake
        const finishes = (after: Duration.Duration) =>
          Effect.forkChild(
            wake.timeoutOption(
              Effect.as(Effect.sleep(after), 'done'),
              minutes(30),
            ),
          )

        const quick = yield* finishes(minutes(5))
        const slow = yield* finishes(minutes(45))
        yield* TestClock.adjust(minutes(10))
        expect(yield* Fiber.join(quick)).toEqual(Option.some('done'))

        // A sleep of 60 minutes past the limit's wall time doesn't end it.
        yield* host.sleeps(minutes(60))
        yield* TestClock.adjust(Duration.seconds(1))
        expect(slow.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust(minutes(20))
        expect(yield* Fiber.join(slow)).toEqual(Option.none())
      }),
    ),
  )

  it.effect('a sleep is published with its cause where the OS logs one', () =>
    onHost(
      host =>
        Effect.gen(function* () {
          const wake = yield* Wake
          const sleeps = yield* wake.subscribe
          yield* TestClock.adjust(Duration.seconds(1))
          yield* host.sleeps(minutes(34))
          yield* TestClock.adjust(Duration.seconds(1))
          const slept = yield* PubSub.take(sleeps)
          expect(slept.cause).toEqual(Option.some(SleepCause.LidClosed()))
        }),
      Layer.succeed(
        SleepCauses,
        SleepCauses.of({
          causeOf: () => Effect.succeedSome(SleepCause.LidClosed()),
        }),
      ),
    ),
  )
})

describe('clocks', () => {
  it.effect('a wall clock stepping back gives no negative duration', () =>
    onHost(host =>
      Effect.gen(function* () {
        const wake = yield* Wake
        const sleeps = yield* wake.subscribe
        const stopwatch = yield* startStopwatch
        const deadline = yield* wake.deadline(minutes(30))
        yield* TestClock.adjust(Duration.seconds(2))
        yield* host.stepWall(Duration.negate(Duration.hours(1)))
        yield* TestClock.adjust(Duration.seconds(3))

        expect(Duration.toMillis(yield* elapsed(stopwatch))).toBe(5000)
        const [took] = yield* Effect.timed(
          TestClock.adjust(Duration.seconds(1)),
        )
        expect(Duration.toMillis(took)).toBe(1000)
        // Nothing is put off or taken for a sleep.
        expect(Duration.toMillis(yield* wake.awake)).toBe(6000)
        expect(Duration.toMillis(yield* wake.remaining(deadline))).toBe(
          Duration.toMillis(minutes(30)) - 6000,
        )
        expect(yield* PubSub.remaining(sleeps)).toBe(0)
      }),
    ),
  )

  it.effect('timestamps are local with their UTC offset', () =>
    onHost(() =>
      Effect.gen(function* () {
        expect(yield* localNow).toBe('2026-10-29T14:00:00.000+02:00')
        expect(yield* toLocalTime(DateTime.makeUnsafe(start + 1234))).toBe(
          '2026-10-29T14:00:01.234+02:00',
        )
      }),
    ),
  )
})

describe('sleep causes', () => {
  // `pmset -g log`'s lines, its tabs and padding kept.
  const log = [
    "2026-10-29 13:40:00 +0200 Sleep               \tEntering Sleep state due to 'Idle Sleep':TCPKeepAlive=active Using Batt (Charge:80%) 60 secs",
    '2026-10-29 13:41:00 +0200 Wake                \tWake from Deep Idle [CDNPB] : due to UserActivity Assertion Using BATT (Charge:80%)',
    "2026-10-29 14:03:12 +0200 Sleep               \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:78%) 988 secs",
    "2026-10-29 14:20:00 +0200 Sleep               \tEntering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active Using Batt (Charge:77%) 900 secs",
    '2026-10-29 14:37:00 +0200 Wake                \tWake from Deep Idle [CDNPB] : due to EC.LidOpen/Lid Open Using BATT (Charge:76%)',
  ].join('\n')

  const span = (from: string, to: string): SleepSpan => ({
    from: DateTime.makeUnsafe(from),
    to: DateTime.makeUnsafe(to),
  })

  it('takes the first sleep logged in the span, not the dark wakes after it', () => {
    expect(
      parsePmsetLog(
        log,
        span('2026-10-29T14:03:14+02:00', '2026-10-29T14:37:01+02:00'),
      ),
    ).toEqual(Option.some(SleepCause.LidClosed()))
  })

  it('takes a sleep logged just before the host was last seen awake', () => {
    expect(
      parsePmsetLog(
        log,
        span('2026-10-29T13:40:20+02:00', '2026-10-29T13:41:01+02:00'),
      ),
    ).toEqual(Option.some(SleepCause.Idle()))
  })

  it('finds none for a span nothing was logged in', () => {
    expect(
      parsePmsetLog(
        log,
        span('2026-10-29T15:00:00+02:00', '2026-10-29T15:30:00+02:00'),
      ),
    ).toEqual(Option.none())
  })

  it.each([
    ['Clamshell Sleep', 'lid closed'],
    ['Low Power Sleep', 'battery low'],
    ['Idle Sleep', 'idle'],
    ['Software Sleep pid=153', 'asked to sleep'],
    ['Thermal Emergency Sleep', 'Thermal Emergency Sleep'],
  ])('reads %s as %s', (reason, said) => {
    const line = `2026-10-29 14:03:12 +0200 Sleep               \tEntering Sleep state due to '${reason}':TCPKeepAlive=active`
    const cause = parsePmsetLog(
      line,
      span('2026-10-29T14:03:14+02:00', '2026-10-29T14:37:01+02:00'),
    )
    expect(Option.map(cause, describeSleepCause)).toEqual(Option.some(said))
  })

  it.effect('looks nothing up on a host whose OS logs no causes', () =>
    Effect.gen(function* () {
      const causes = yield* SleepCauses
      expect(
        yield* causes.causeOf(
          span('2026-10-29T14:03:14+02:00', '2026-10-29T14:37:01+02:00'),
        ),
      ).toEqual(Option.none())
    }).pipe(Effect.provide(sleepCausesFor('linux'))),
  )
})

describe('deadlines', () => {
  it('tells a deadline in time awake from one on the wall clock', () => {
    const kind = Deadline.$match({
      Awake: () => 'awake',
      Wall: () => 'wall',
    })
    expect(kind(Deadline.Awake({ at: minutes(30) }))).toBe('awake')
    expect(kind(Deadline.Wall({ at: DateTime.makeUnsafe(start) }))).toBe('wall')
  })
})
