import { DateTime, Duration, Effect, Stream } from 'effect'

import { sameDay, sayMoment } from '@fabrica/contracts'

// The app's clock (spec §18.3, H80): the time now, in the viewer's zone, about every second, and how
// the console says a moment and a time gone by. The ticks are the host's, given to the subscriptions
// (`localTicks` in the app, fixed moments in tests), so no view reads the clock itself.

/** How often the console's elapsed times and "today" are brought up to date. */
export const tickEvery = Duration.seconds(1)

/** The time now in the host's zone: at once, then every `tickEvery`. */
export const localTicks: Stream.Stream<DateTime.Zoned> = Stream.tick(
  tickEvery,
).pipe(
  Stream.mapEffect(() =>
    DateTime.nowInCurrentZone.pipe(
      Effect.provide(DateTime.layerCurrentZoneLocal),
    ),
  ),
)

const twoDigits = (value: number): string => String(value).padStart(2, '0')

// How a moment is said is the contracts' rule, which the engine says its moments by too.
export { sameDay, sayMoment }

/**
 * The start of `now`'s day, in its zone: what a part that shows moments but no elapsed time draws
 * from, so it is redrawn as the day changes rather than at every tick.
 */
export const dayOf = (now: DateTime.Zoned): DateTime.Zoned =>
  DateTime.startOf(now, 'day')

/** Whole seconds from `since` to `now`, never negative. */
export const secondsSince = (
  since: DateTime.DateTime,
  now: DateTime.DateTime,
): number =>
  Math.max(
    0,
    Math.floor(
      (DateTime.toEpochMillis(now) - DateTime.toEpochMillis(since)) / 1000,
    ),
  )

/** The time from `since` to `now`, never negative: `12s`, `3m 05s`, `1h 02m`. */
export const sayElapsed = (
  since: DateTime.DateTime,
  now: DateTime.DateTime,
): string => sayDuration(secondsSince(since, now))

/** A length of time in whole seconds, as the console says one: `12s`, `3m 05s`, `1h 02m`. */
export const sayDuration = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  return hours > 0
    ? `${hours}h ${twoDigits(minutes % 60)}m`
    : minutes > 0
      ? `${minutes}m ${twoDigits(seconds % 60)}s`
      : `${seconds}s`
}
