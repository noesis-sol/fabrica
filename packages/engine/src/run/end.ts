import { Effect } from 'effect'

import type { EndKind } from '@fabrica/contracts'

// The run's end steps after its end line's kind is known (spec §13.9): the full check on Base, the
// report, `push: after_run`. A no-op the loop calls until the run's end fills it (fab-mgi.4.6,
// `FULL_CHECK_NOT_RUN`): nothing runs. The end exposes the port its full check's pass calls,
// `afterFullCheck`, through which the run pushes Base where `push` is `after_run` (§10.3).

/** Runs the end's steps for a run that ended as `kind`, having merged `merged` tickets. */
export const endSteps = (_input: {
  readonly kind: EndKind
  readonly merged: number
  /** What follows the full check's pass: `push: after_run` pushes Base. */
  readonly afterFullCheck: Effect.Effect<void>
}): Effect.Effect<void> => Effect.void
