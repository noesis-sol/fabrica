import {
  Array,
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
} from 'effect'
import { execFile } from 'node:child_process'

// Why the host slept, where the OS logs it (spec §7.7, H66): on macOS, `pmset -g log`'s
// `Entering Sleep state due to '<reason>'` lines; elsewhere nothing is looked up.

/** Why the host slept. */
export type SleepCause = Data.TaggedEnum<{
  LidClosed: {}
  BatteryLow: {}
  Idle: {}
  /** Something asked the host to sleep: the menu, a key, a program. */
  Asked: {}
  /** A reason the OS gave that none of the others names, as it gave it. */
  Other: { readonly reason: string }
}>
export const SleepCause = Data.taggedEnum<SleepCause>()

/** A cause as the `SLEPT` line and the `slept` event say it. */
export const describeSleepCause = SleepCause.$match({
  LidClosed: () => 'lid closed',
  BatteryLow: () => 'battery low',
  Idle: () => 'idle',
  Asked: () => 'asked to sleep',
  Other: ({ reason }) => reason,
})

/** A sleep's span: when the host was last seen awake, and when it was seen again. */
export interface SleepSpan {
  readonly from: DateTime.Utc
  readonly to: DateTime.Utc
}

/** pmset's reason as a cause. */
const causeOfReason = (reason: string): SleepCause => {
  if (/clamshell/i.test(reason)) return SleepCause.LidClosed()
  if (/low power|battery/i.test(reason)) return SleepCause.BatteryLow()
  if (/idle/i.test(reason)) return SleepCause.Idle()
  if (/software|button|user/i.test(reason)) return SleepCause.Asked()
  return SleepCause.Other({ reason })
}

// `2026-10-22 20:00:12 +0300 Sleep  \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=…`
const sleepLine =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2}) Sleep\s+Entering Sleep state due to '([^']+)'/

/**
 * How long before the host was last seen awake its sleep may have been logged: the wake service reads
 * the clock once a second, and the host takes a few seconds to go to sleep once it has logged it.
 */
const loggedBefore = Duration.seconds(30)

/**
 * The cause of the sleep over `span` in `log`, `pmset -g log`'s output: the first sleep logged in the
 * span, since a long sleep is broken by dark wakes that log a sleep of their own (`Maintenance Sleep`,
 * `Sleep Service Back to Sleep`) after it.
 */
export const parsePmsetLog = (
  log: string,
  span: SleepSpan,
): Option.Option<SleepCause> => {
  const from =
    DateTime.toEpochMillis(span.from) - Duration.toMillis(loggedBefore)
  const to = DateTime.toEpochMillis(span.to)
  return Array.findFirst(log.split('\n'), line => {
    const match = sleepLine.exec(line)
    if (match === null) return Option.none()
    const [, day, time, hours, minutes, reason] = match
    const at = Date.parse(`${day}T${time}${hours}:${minutes}`)
    return at >= from && at <= to && reason !== undefined
      ? Option.some(causeOfReason(reason))
      : Option.none()
  })
}

/** Looks up why the host slept. */
export class SleepCauses extends Context.Service<
  SleepCauses,
  {
    /** The cause of the sleep over `span`, where the OS logged one; none where it can't be read. */
    readonly causeOf: (
      span: SleepSpan,
    ) => Effect.Effect<Option.Option<SleepCause>>
  }
>()('SleepCauses') {}

/** No causes: for a host whose OS logs none. */
export const noSleepCauses: Layer.Layer<SleepCauses> = Layer.succeed(
  SleepCauses,
  SleepCauses.of({ causeOf: () => Effect.succeedNone }),
)

/** `pmset -g log`'s output: several megabytes on a Mac that has run for weeks. */
const readPmsetLog = Effect.callback<string, Error>((resume, signal) => {
  execFile(
    '/usr/bin/pmset',
    ['-g', 'log'],
    { maxBuffer: 256 * 1024 * 1024, signal },
    (error, stdout) =>
      resume(error === null ? Effect.succeed(stdout) : Effect.fail(error)),
  )
})

/** Causes from `pmset -g log`, macOS's power log. A log that can't be read gives none. */
export const pmsetSleepCauses: Layer.Layer<SleepCauses> = Layer.succeed(
  SleepCauses,
  SleepCauses.of({
    causeOf: Effect.fn('SleepCauses.causeOf')(function* (span: SleepSpan) {
      const log = yield* readPmsetLog.pipe(
        Effect.timeoutOption(Duration.seconds(10)),
        Effect.catch(error =>
          Effect.as(
            Effect.logDebug('pmset -g log failed', error),
            Option.none<string>(),
          ),
        ),
      )
      return Option.flatMap(log, text => parsePmsetLog(text, span))
    }),
  }),
)

/** The causes `platform` logs: pmset's on macOS, none elsewhere. */
export const sleepCausesFor = (
  platform: NodeJS.Platform,
): Layer.Layer<SleepCauses> =>
  platform === 'darwin' ? pmsetSleepCauses : noSleepCauses
