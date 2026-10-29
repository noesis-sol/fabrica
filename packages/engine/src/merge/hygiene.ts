import { Data, Effect, Match, Option } from 'effect'

import type { SetAsideReason } from '@fabrica/contracts'

import {
  type CantTell,
  type FastForwardOutcome,
  type GitFailed,
  Worktrees,
} from '../git'
import type { MergeStopKind } from './outcome'
import type { MergeTurn } from './turn'

// Merge hygiene (spec §13.7, H71, H72): a refused fast-forward diagnosed, a merge turn's budgets, what
// a check leaves, merged worktrees cleaned up out of the queue, merges waiting on a dirty checkout.
// Until it is built: a turn goes round as often as its branch or Base moves, what a check leaves is
// let be, a fast-forward that didn't happen is diagnosed from its outcome alone, a merged worktree is
// removed in the queue, and a fast-forward never waits.

/** Why a ticket is set aside, and its detail in words. */
export interface Aside {
  readonly reason: SetAsideReason
  readonly detail: string
}

/** What a fast-forward that didn't happen comes to. */
export type Diagnosis = Data.TaggedEnum<{
  /** Base moved on: the ticket is rebased and checked again. */
  Again: {}
  /** The ticket is set aside. */
  SetAside: Aside
  /** Merging stops. */
  Stop: { readonly kind: MergeStopKind; readonly detail: string }
}>
export const Diagnosis = Data.taggedEnum<Diagnosis>()

/** Whether the turn may go round again, its branch or Base having moved during its `rounds` checks so far. */
export const mayGoRound = (_input: {
  readonly turn: MergeTurn
  readonly rounds: number
}): Effect.Effect<boolean> => Effect.succeed(true)

/** What the merge check left in the worktree, read from git's status: a reason to set the ticket aside, or none. */
export const afterCheck = (_input: {
  readonly turn: MergeTurn
  readonly changed: ReadonlyArray<string>
  readonly wrote: ReadonlyArray<string>
}): Effect.Effect<Option.Option<Aside>> => Effect.succeedNone

/** Waits until Base's checkout can be fast-forwarded. */
export const checkoutReady = (_turn: MergeTurn): Effect.Effect<void> =>
  Effect.void

/** A fast-forward of Base to the checked commit that didn't happen. */
export const diagnose = ({
  turn,
  outcome,
}: {
  readonly turn: MergeTurn
  readonly outcome: Exclude<
    FastForwardOutcome,
    { readonly _tag: 'FastForwarded' }
  >
}): Effect.Effect<Diagnosis> =>
  Effect.succeed(
    Match.valueTags(outcome, {
      NotFastForward: ({ base }) =>
        Diagnosis.Stop({
          kind: 'MERGE_FAILED',
          detail: `MERGE_FAILED: ${turn.worktree.branch} doesn't fast-forward ${turn.config.base} at ${base}`,
        }),
      OffBranch: ({ branch }) =>
        Diagnosis.Stop({
          kind: 'OFF_BRANCH',
          detail: `OFF_BRANCH: ${turn.config.home.checkout} is on ${Option.getOrElse(branch, () => 'a detached HEAD')}, not ${turn.config.base}`,
        }),
      Refused: ({ message }) =>
        Diagnosis.SetAside({
          reason: 'GIT_FAILED',
          detail: `GIT_FAILED: git refused to fast-forward ${turn.config.base}: ${message}`,
        }),
    }),
  )

/** Removes a merged or unchanged ticket's worktree and its branch. */
export const cleanUp = (
  turn: MergeTurn,
): Effect.Effect<void, CantTell | GitFailed, Worktrees> =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees
    yield* worktrees.remove({
      home: turn.config.home,
      ticket: turn.worktree.ticket,
    })
  })
