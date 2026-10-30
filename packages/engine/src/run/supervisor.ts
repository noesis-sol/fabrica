import { Effect } from 'effect'

import type { TicketId } from '@fabrica/contracts'

// Each worker's supervision (spec §12.8, §13.2): every path that starts or resumes a worker runs it
// under the same supervision, and the run's end stops it before its other steps (§13.9). A no-op the
// loop calls until the supervisor per worker fills it (fab-mgi.4.10: failure policies, the ticket
// limit): a worker runs as it is.

export interface Supervision {
  /** Runs a ticket's worker under its supervision. */
  readonly watch: <A, E, R>(
    ticket: TicketId,
    work: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  /** Stops every ticket's supervision: the end's first step. */
  readonly stop: Effect.Effect<void>
}

/** The run's supervision. */
export const makeSupervision: Effect.Effect<Supervision> = Effect.succeed({
  watch: (_ticket, work) => work,
  stop: Effect.void,
})
