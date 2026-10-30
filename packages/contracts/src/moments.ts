import { DateTime } from 'effect'

// How a moment is said to a person (spec §14.2, §18.3, H80): a time on the 24-hour clock, with its day
// when it isn't today's, in the zone of the `now` it is said against. The console says its moments so,
// and the engine its usage limits' resets.

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

const twoDigits = (value: number): string => String(value).padStart(2, '0')

/** Whether `at` falls on `now`'s day, in `now`'s zone. */
export const sameDay = (
  at: DateTime.DateTime,
  now: DateTime.Zoned,
): boolean => {
  const moment = DateTime.toParts(DateTime.setZone(at, now.zone))
  const today = DateTime.toParts(now)
  return (
    moment.year === today.year &&
    moment.month === today.month &&
    moment.day === today.day
  )
}

/**
 * `at` in `now`'s zone, as a time on the 24-hour clock, with its day when that isn't `now`'s:
 * `14:05`, or `Fri 30 Oct 02:00`.
 */
export const sayMoment = (
  at: DateTime.DateTime,
  now: DateTime.Zoned,
): string => {
  const moment = DateTime.toParts(DateTime.setZone(at, now.zone))
  const time = `${twoDigits(moment.hour)}:${twoDigits(moment.minute)}`
  return sameDay(at, now)
    ? time
    : `${weekdays[moment.weekDay]} ${moment.day} ${months[moment.month - 1]} ${time}`
}
