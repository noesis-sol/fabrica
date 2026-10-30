import { Data, Effect } from 'effect'

import type { TicketId } from '@fabrica/contracts'

import type { Worktree } from '../git'

// The verifier after `finish` (spec §13.6). A no-op the loop calls until the verifier session fills it
// (fab-mgi.4.3): every finished ticket passes, and goes to the merge queue.

export type Verdict = Data.TaggedEnum<{
  /** The change goes to the merge queue. */
  Passed: {}
}>
export const Verdict = Data.taggedEnum<Verdict>()

/** Verifies what the ticket's worker finished in its worktree. */
export const verifyFinished = (_input: {
  readonly ticket: TicketId
  readonly worktree: Worktree
}): Effect.Effect<Verdict> => Effect.succeed(Verdict.Passed())
