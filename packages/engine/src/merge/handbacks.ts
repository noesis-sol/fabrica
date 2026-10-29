import { Data, Effect } from 'effect'

import type { SetAsideReason } from '@fabrica/contracts'

import type { CheckOutcome } from '../checks'
import type { MergeTurn } from './turn'

// Hand-backs (spec §13.7, orchestra-nr1v.1, .2, -cgko): a merge's conflict or failed check goes back
// to the ticket's own worker, `RESOLVING` or `FIXING`, within its limits. Until they are built every
// hand-back sets the ticket aside: a conflict as `MERGE_CONFLICT`, a failed check as `CHECKS_FAILED`.

/** What a hand-back came to. */
export type HandBack = Data.TaggedEnum<{
  /** The ticket is set aside: its rebase aborted, its worktree kept. */
  SetAside: { readonly reason: SetAsideReason; readonly detail: string }
}>
export const HandBack = Data.taggedEnum<HandBack>()

/** A rebase that stopped on conflicts in `files`, the rebase still in progress in the worktree. */
export const resolveConflict = ({
  files,
}: {
  readonly turn: MergeTurn
  readonly files: ReadonlyArray<string>
}): Effect.Effect<HandBack> =>
  Effect.succeed(
    HandBack.SetAside({
      reason: 'MERGE_CONFLICT',
      detail: `MERGE_CONFLICT in ${files.join(', ') || 'the rebase'}`,
    }),
  )

/** How a failed check's detail says it ended. */
const ended = { Failed: 'failed', TimedOut: 'timed out' } as const

/** A merge check that failed or timed out on the ticket's rebased branch. */
export const fixCheck = ({
  outcome,
}: {
  readonly turn: MergeTurn
  readonly outcome: Extract<
    CheckOutcome,
    { readonly _tag: 'Failed' | 'TimedOut' }
  >
}): Effect.Effect<HandBack> =>
  Effect.succeed(
    HandBack.SetAside({
      reason: 'CHECKS_FAILED',
      detail: `CHECKS_FAILED: the merge check ${ended[outcome._tag]}; its output is in ${outcome.log}`,
    }),
  )
