import { Effect, Option, Result } from 'effect'

import {
  EventLine,
  type RunEvent,
  type RunId,
  decodeEventLine,
} from '@fabrica/contracts'

import { readFileText } from '../files'
import { eventsPath } from './run-log'

// Reading the event stream (spec §13.12): for the reviewer, `fabrica follow` and the `run events`
// stream's past records. Kinds and fields may be added, never renamed, so a record of a kind this
// version doesn't know, or of another format version, is skipped; a line that isn't a record (one an
// earlier crash or a full disk cut short) is counted and passed over, never stopping the read.

/** What a read of the event stream found. */
export interface EventsRead {
  /** The records of the kinds this version knows, in the stream's order. */
  readonly events: ReadonlyArray<RunEvent>
  /** Records of kinds this version doesn't know, or of another format version. */
  readonly skipped: number
  /** Lines that aren't records: cut short, or not JSON a record decodes from. */
  readonly unreadable: number
}

/** The records in `text`, the stream's lines; with `run`, that run's alone. */
export const decodeEvents = Effect.fn('RunLog.decodeEvents')(function* (
  text: string,
  run: Option.Option<RunId>,
) {
  const events: Array<RunEvent> = []
  let skipped = 0
  let unreadable = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const decoded = yield* Effect.result(decodeEventLine(line))
    if (Result.isFailure(decoded)) {
      unreadable += 1
      continue
    }
    EventLine.$match(decoded.success, {
      Known: ({ event }) => {
        if (
          Option.match(run, {
            onNone: () => true,
            onSome: id => event.run === id,
          })
        )
          events.push(event)
      },
      Skipped: () => {
        skipped += 1
      },
    })
  }
  return { events, skipped, unreadable } satisfies EventsRead
})

/** The event stream of the checkout at `root`, decoded; with `run`, that run's records alone. */
export const readEvents = Effect.fn('RunLog.readEvents')(function* (options: {
  readonly root: string
  readonly run: Option.Option<RunId>
}) {
  const text = yield* readFileText({
    root: options.root,
    path: eventsPath,
  }).pipe(
    // A project that has never run has no stream: no records.
    Effect.catchTag('FileMissing', () => Effect.succeed('')),
  )
  return yield* decodeEvents(text, options.run)
})
