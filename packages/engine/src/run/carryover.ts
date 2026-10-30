import { Effect } from 'effect'

import type { TicketId } from '@fabrica/contracts'

// The carry-over (spec §13.10): the workers and tickets a stopped or crashed run left, resumed into
// slots as the run starts. A no-op the loop calls until stops, drains and carry-over fill it
// (fab-mgi.4.9): a run carries nothing over.

/** A ticket an earlier run left, with the session to resume. */
export interface Carried {
  readonly ticket: TicketId
  readonly session: string
}

/** What earlier runs of the project left to resume. */
export const carriedOver = (_input: {
  readonly checkout: string
}): Effect.Effect<ReadonlyArray<Carried>> => Effect.succeed([])
