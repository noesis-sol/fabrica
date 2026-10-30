import { Data, Effect } from 'effect'

import type { Prepared } from '../git'

// The setup in a ticket's worktree before its worker starts (spec §13.8). A no-op the loop calls until
// setup in worktrees fills it (fab-mgi.4.5, `SETUP_FAILED`, `SETUP_WAITS`): every worktree is ready.

export type SetUp = Data.TaggedEnum<{
  /** The worktree is ready for its worker. */
  Ready: {}
  /** The setup failed: the ticket goes back in the queue until a merge or a probe (`SETUP_FAILED`). */
  Failed: { readonly detail: string }
}>
export const SetUp = Data.taggedEnum<SetUp>()

/** Sets up the worktree a dispatch prepared. */
export const setUpWorktree = (_input: {
  readonly prepared: Prepared
}): Effect.Effect<SetUp> => Effect.succeed(SetUp.Ready())
