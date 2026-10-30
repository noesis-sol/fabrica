import { Effect } from 'effect'

import type { EventDraft, RunLog } from '../runlog'

// Writing the run's records and lines (spec §13.12, H84): a record a short write cut is lost alone, as
// the writer promises, and the run goes on; a record its schema refuses is the engine's defect.

/** Writes `draft`'s record and its lines through `log`; a cut record is logged and the run goes on. */
export const record = (
  log: RunLog['Service'],
  draft: EventDraft,
  details: ReadonlyArray<string> = [],
): Effect.Effect<void> =>
  log.emit(draft, details).pipe(
    Effect.asVoid,
    Effect.catchTag('RecordCut', error =>
      Effect.logWarning(`a ${draft.kind} record was lost: ${error.message}`),
    ),
    Effect.catchTag('RecordInvalid', Effect.die),
  )

/** Writes `lines` to the human log alone; lines a short write cut are logged and the run goes on. */
export const say = (
  log: RunLog['Service'],
  lines: ReadonlyArray<string>,
): Effect.Effect<void> =>
  log
    .say(lines)
    .pipe(
      Effect.catchTag('RecordCut', error =>
        Effect.logWarning(`log lines were lost: ${error.message}`),
      ),
    )
