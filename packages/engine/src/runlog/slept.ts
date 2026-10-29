import { type DateTime, Effect, Option, PubSub, type Scope } from 'effect'

import { type Slept, Wake, describeSleepCause, toLocalTime } from '../time'
import { sleptLine } from './lines'
import { type EventDraft, RunLog, toSeconds } from './run-log'

// What the run says of the host's sleep (spec §7.7): for each sleep the wake service sees, the `slept`
// record and its `SLEPT:` line, with the time it wasn't counted and its cause where the OS logs one.

/** The `slept` record of `slept`, its text the `SLEPT:` line. */
export const sleptDraft = Effect.fn('RunLog.sleptDraft')(function* (
  slept: Slept,
) {
  const from = yield* toLocalTime(slept.from)
  const to = yield* toLocalTime(slept.to)
  const cause = Option.map(slept.cause, describeSleepCause)
  return {
    kind: 'slept',
    from,
    to,
    seconds: toSeconds(slept.span),
    ...Option.match(cause, {
      onNone: () => ({}),
      onSome: said => ({ cause: said }),
    }),
    text: sleptLine({ from, to, span: slept.span, cause }),
  } satisfies EventDraft
})

/**
 * Writes the record and line of every sleep the wake service sees from now until the scope closes;
 * it returns once subscribed. A record that can't be written is lost, the run going on.
 */
export const recordSleeps: Effect.Effect<
  void,
  never,
  RunLog | Wake | DateTime.CurrentTimeZone | Scope.Scope
> = Effect.gen(function* () {
  const runLog = yield* RunLog
  const wake = yield* Wake
  const sleeps = yield* wake.subscribe
  const record = Effect.fn('RunLog.recordSleep')(function* (slept: Slept) {
    yield* runLog.emit(yield* sleptDraft(slept))
  })
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.flatMap(PubSub.take(sleeps), slept =>
        record(slept).pipe(
          Effect.catch(error =>
            Effect.logWarning('the slept record was lost', error),
          ),
        ),
      ),
    ),
  )
})
