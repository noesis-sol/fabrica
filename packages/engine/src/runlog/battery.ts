import { Effect, Option, type Scope } from 'effect'

import { Battery, BatteryNotice, type Power, watchBattery } from '../time'
import { batteryLine } from './lines'
import { type EventDraft, RunLog } from './run-log'

// What the run says of the battery (spec §7.7): as it starts, a `warn` record that a closed lid still
// sleeps a host with a battery, and a `battery` record where it starts on battery; while it goes, a
// `battery` record at each threshold reached, its `threshold` the one the app notifies of at 10%.

/** The record of `notice`, its text the line. */
export const batteryDraft = (notice: BatteryNotice): EventDraft => {
  const text = batteryLine(notice)
  return BatteryNotice.$match(notice, {
    LidSleeps: (): EventDraft => ({ kind: 'warn', detail: 'LID_SLEEPS', text }),
    OnBattery: ({ level }): EventDraft => ({ kind: 'battery', level, text }),
    Low: ({ level, threshold }): EventDraft => ({
      kind: 'battery',
      level,
      threshold,
      text,
    }),
  })
}

/**
 * Writes what the run's start says of the battery, then the record and line of each threshold it
 * reaches until the scope closes; returns the start's reading. A record that can't be written is
 * lost, the run going on.
 */
export const recordBattery: Effect.Effect<
  Option.Option<Power>,
  never,
  RunLog | Battery | Scope.Scope
> = Effect.gen(function* () {
  const runLog = yield* RunLog
  return yield* watchBattery(notice =>
    runLog.emit(batteryDraft(notice)).pipe(
      Effect.asVoid,
      Effect.catch(error =>
        Effect.logWarning('the battery record was lost', error),
      ),
    ),
  )
})
