import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  PubSub,
  Schema,
  type Scope,
  Semaphore,
  Stream,
} from 'effect'

import {
  type LocalTime,
  type RunEvent,
  RunEventFromJson,
  type RunId,
  type Seconds,
  eventVersion,
} from '@fabrica/contracts'

import {
  type FileFailed,
  type FileMissing,
  type FileRefused,
  type LineStream,
  type PathOutsideRoot,
  type RecordCut,
  openLineStream,
} from '../files'
import { localNow } from '../time'
import { RecordInvalid } from './errors'
import { logStamp } from './lines'
import { oneLine } from './one-line'

// The run's log (spec §7.5, §13.12, H84): each project's event stream, `.fabrica/run/events.jsonl`,
// and its human log, `.fabrica/fabrica.log`, both written through the safe writer's append stream, so
// a line an earlier crash cut short is repaired and a short write loses only its own record. A record
// and its log line are written together or not at all: under one lock, so the log and the stream give
// happenings in one order, and uninterruptibly, so a stop landing between the two can't leave a line
// without its record (tutti-jskc). The record goes first; where it is lost, so is its line, and the
// log never says what the stream doesn't. Every record is dated once, local with its UTC offset, and
// carries the run's ID; its line is dated with the same time.

/** The event stream, below the project's checkout. */
export const eventsPath = '.fabrica/run/events.jsonl'

/** The human log, below the project's checkout. */
export const logPath = '.fabrica/fabrica.log'

type DraftOf<Event> = Event extends RunEvent
  ? Omit<Event, 'v' | 'time' | 'run'>
  : never

/** A record as the run makes it: every field but `v`, `time` and `run`, which the RunLog fills in. */
export type EventDraft = DraftOf<RunEvent>

/** A duration as a record's `seconds`: to a tenth, never negative (§7.7). */
export const toSeconds = (duration: Duration.Duration): Seconds =>
  Math.round(Math.max(Duration.toMillis(duration), 0) / 100) / 10

/** The run's log: its records and its lines. */
export class RunLog extends Context.Service<
  RunLog,
  {
    /** The run whose records these are. */
    readonly run: RunId
    /**
     * Writes `draft`'s record, dated now, and its `text`, where it has one, as its line in the log,
     * then `details`, the lines under it; all together or not at all. Where the record is cut, nothing
     * goes to the log; where a line is, the lines after it are lost too.
     */
    readonly emit: (
      draft: EventDraft,
      details?: ReadonlyArray<string>,
    ) => Effect.Effect<RunEvent, RecordInvalid | RecordCut>
    /** Writes `lines` to the log alone, dated now, together. */
    readonly say: (
      lines: ReadonlyArray<string>,
    ) => Effect.Effect<void, RecordCut>
    /** Every record written from the moment of subscribing. */
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<RunEvent>,
      never,
      Scope.Scope
    >
    /** Every record written while the stream runs: the run events stream's live part, follow's. */
    readonly events: Stream.Stream<RunEvent>
  }
>()('RunLog') {}

const encodeRecord = Schema.encodeEffect(RunEventFromJson)

/** The RunLog for `run`, writing its records to `events` and its lines to `log`. */
export const makeRunLog = Effect.fn('RunLog.make')(function* (options: {
  readonly run: RunId
  readonly events: LineStream
  readonly log: LineStream
}) {
  const { run, events, log } = options
  const zone = yield* DateTime.CurrentTimeZone
  const now = Effect.provideService(localNow, DateTime.CurrentTimeZone, zone)
  const lock = yield* Semaphore.make(1)
  const written = yield* PubSub.unbounded<RunEvent>()

  // A line holds no newline once `oneLine` has escaped its controls.
  const appendLines = (time: LocalTime, lines: ReadonlyArray<string>) =>
    Effect.forEach(
      lines,
      line =>
        log
          .append(`${logStamp(time)} ${oneLine(line)}`)
          .pipe(Effect.catchTag('NotALine', Effect.die)),
      { discard: true },
    )

  const together = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    lock.withPermits(1)(Effect.uninterruptible(effect))

  const emit = Effect.fn('RunLog.emit')(function* (
    draft: EventDraft,
    details: ReadonlyArray<string> = [],
  ) {
    const time = yield* now
    const event: RunEvent = { ...draft, v: eventVersion, time, run }
    const record = yield* encodeRecord(event).pipe(
      Effect.mapError(
        error => new RecordInvalid({ kind: draft.kind, reason: error.message }),
      ),
    )
    yield* events.append(record).pipe(Effect.catchTag('NotALine', Effect.die))
    const text = 'text' in draft ? draft.text : undefined
    // The record is out: subscribers get it once its lines are, whether or not they went too.
    yield* appendLines(
      time,
      text === undefined ? details : [text, ...details],
    ).pipe(Effect.ensuring(PubSub.publish(written, event)))
    return event
  }, together)

  const say = Effect.fn('RunLog.say')(function* (lines: ReadonlyArray<string>) {
    yield* appendLines(yield* now, lines)
  }, together)

  return RunLog.of({
    run,
    emit,
    say,
    subscribe: PubSub.subscribe(written),
    events: Stream.fromPubSub(written),
  })
})

/** Opens the event stream and the human log of the checkout at `root` for `run`, until the scope closes. */
export const openRunLog = Effect.fn('RunLog.open')(function* (options: {
  readonly root: string
  readonly run: RunId
}) {
  const events = yield* openLineStream({ root: options.root, path: eventsPath })
  const log = yield* openLineStream({ root: options.root, path: logPath })
  return yield* makeRunLog({ run: options.run, events, log })
})

/** The RunLog of the checkout at `root` for `run`, its files open while the layer is in use. */
export const layerRunLog = (options: {
  readonly root: string
  readonly run: RunId
}): Layer.Layer<
  RunLog,
  PathOutsideRoot | FileRefused | FileFailed | FileMissing,
  DateTime.CurrentTimeZone
> => Layer.effect(RunLog, openRunLog(options))
