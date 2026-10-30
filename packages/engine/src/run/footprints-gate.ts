import { Effect } from 'effect'

import type { HoldBack, Ticket, TicketId } from '@fabrica/contracts'

import type { RunSnapshot } from './state'

// The footprints gate (spec §13.4): which ready tickets may be dispatched beside those the run has,
// and why each other is held back, in words. A no-op the loop calls until the overlap holds and solo
// tickets fill it (fab-mgi.4.2): every ready ticket may go.

/** A ready ticket held back, and why in words, as the log says it (H81). */
export interface HeldBack {
  readonly ticket: TicketId
  readonly reason: HoldBack
  readonly detail: string
}

/** What the gate let through, most urgent first, and what it held back. */
export interface Gated {
  readonly take: ReadonlyArray<Ticket>
  readonly held: ReadonlyArray<HeldBack>
}

/** Gates the ready tickets against the run's state. */
export const gateReady = (input: {
  readonly ready: ReadonlyArray<Ticket>
  readonly snapshot: RunSnapshot
}): Effect.Effect<Gated> => Effect.succeed({ take: input.ready, held: [] })
