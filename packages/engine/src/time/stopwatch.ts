import { Clock, Duration, Effect } from 'effect'

// Durations (spec §7.7, H84) are measured on the monotonic clock, never as the difference of two
// wall times, so a wall clock stepping back can't make one negative and drop its record (tutti-5mlh).
// `Effect.timed` measures on the same clock.

/** A start on the monotonic clock, to measure a duration from. */
export interface Stopwatch {
  readonly startNanos: bigint
}

/** A stopwatch started now. */
export const startStopwatch: Effect.Effect<Stopwatch> = Effect.map(
  Clock.monotonicTimeNanos,
  startNanos => ({ startNanos }),
)

/** The time since `stopwatch` started, never negative. */
export const elapsed = (
  stopwatch: Stopwatch,
): Effect.Effect<Duration.Duration> =>
  Effect.map(Clock.monotonicTimeNanos, now =>
    Duration.nanos(
      now > stopwatch.startNanos ? now - stopwatch.startNanos : BigInt(0),
    ),
  )
