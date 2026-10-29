import { DateTime, Effect } from 'effect'

import { type LocalTime, formatLocalTime } from '@fabrica/contracts'

// Times the engine records are local, with their UTC offset (spec §7.7, §13.12, H84), in the zone
// `DateTime.CurrentTimeZone` gives: the host's (`DateTime.layerCurrentZoneLocal`) in the engine, one
// a test names in its tests. Clients show them in the viewer's zone.

/** `time` as the engine records it: in the current zone, with its UTC offset. */
export const toLocalTime = (
  time: DateTime.DateTime,
): Effect.Effect<LocalTime, never, DateTime.CurrentTimeZone> =>
  Effect.map(DateTime.setZoneCurrent(time), formatLocalTime)

/** Now, as the engine records it, read from Effect's `Clock`. */
export const localNow: Effect.Effect<
  LocalTime,
  never,
  DateTime.CurrentTimeZone
> = Effect.map(DateTime.nowInCurrentZone, formatLocalTime)
