import { DateTime, Effect, Option, type Scope, Stream } from 'effect'

import { ProxyEvent, type UsageWindowFigure } from '../proxy'
import { toLocalTime } from '../time'
import { type EventDraft, RunLog } from './run-log'

// What the run records of its provider accounts' usage windows (spec §12.9, §13.12, H90): a
// `usage_window` record each time the model proxy sees one of them move on a response to one of the
// run's calls, its reset dated in the run's zone. It has no line: the log doesn't say each move.

/** The `usage_window` record of `figure`, its reset in `zone`. */
export const usageWindowDraft = (
  figure: UsageWindowFigure,
  zone: DateTime.TimeZone,
): Effect.Effect<EventDraft> =>
  Effect.map(
    Effect.transposeOption(Option.map(figure.resetsAt, toLocalTime)),
    resetsAt =>
      ({
        kind: 'usage_window',
        provider: figure.provider,
        ...Option.match(figure.account, {
          onNone: () => ({}),
          onSome: account => ({ account }),
        }),
        window: figure.window,
        utilization: figure.utilization,
        ...Option.match(resetsAt, {
          onNone: () => ({}),
          onSome: resets_at => ({ resets_at }),
        }),
      }) satisfies EventDraft,
  ).pipe(Effect.provideService(DateTime.CurrentTimeZone, zone))

/**
 * Writes the record of every window the proxy's `events` see move on the run's calls, until the scope
 * closes; it returns once forked. A record that can't be written is lost, the run going on.
 */
export const recordUsageWindows = (
  events: Stream.Stream<ProxyEvent>,
): Effect.Effect<void, never, RunLog | Scope.Scope> =>
  Effect.gen(function* () {
    const runLog = yield* RunLog
    const record = Effect.fn('RunLog.recordUsageWindow')(function* (
      figure: UsageWindowFigure,
    ) {
      yield* runLog.emit(yield* usageWindowDraft(figure, runLog.zone))
    })
    yield* events.pipe(
      Stream.filter(ProxyEvent.$is('Windowed')),
      Stream.filter(({ caller }) => caller.run === runLog.run),
      Stream.runForEach(({ figure }) =>
        record(figure).pipe(
          Effect.catch(error =>
            Effect.logWarning('the usage_window record was lost', error),
          ),
        ),
      ),
      Effect.forkScoped,
    )
  })
