import { Data } from 'effect'

import type {
  CommitHash,
  MergeStep,
  SetAsideReason,
  StopKind,
  TicketId,
} from '@fabrica/contracts'

import type { CheckRecord } from '../checks'

// What the merge queue publishes (spec §13.7, §13.12): each merge's steps, its checks' records and how
// it ended, as tagged values the run matches exhaustively. A ticket's phase follows from them: `Step`
// is `merging` (`Wrote` and `MergesWait` tell more of it), the endings are `merged`, `no_change`, `set_aside`, or back to waiting.

/** The stops a merge can bring a run to: it stops merging, and the run ends with its kind (§13.11). */
export type MergeStopKind = Extract<
  StopKind,
  'MERGE_FAILED' | 'OFF_BRANCH' | 'TRACKER_FAILED'
>

/** What ran in a ticket's worktree during its merge: the setup its rebase called for, or the merge check. */
export type LeftBy = 'setup' | 'check'

/** What the merge queue publishes: its merges' progress, and how each ended. */
export type MergeUpdate = Data.TaggedEnum<{
  /** A ticket's merge entered `step`. */
  Step: { readonly ticket: TicketId; readonly step: MergeStep }
  /** A check of a ticket's merge ended: its record, for the event stream. */
  Check: { readonly ticket: TicketId; readonly record: CheckRecord }
  /** The merge's setup or check wrote untracked `files` in the worktree: recorded, and they go with it. */
  Wrote: {
    readonly ticket: TicketId
    readonly by: LeftBy
    readonly files: ReadonlyArray<string>
  }
  /** The fast-forward waits on `checkout`'s uncommitted changes to `files` (`MERGES_WAIT`, H72), until it is clean. */
  MergesWait: {
    readonly ticket: TicketId
    readonly checkout: string
    readonly files: ReadonlyArray<string>
    readonly detail: string
  }
  /** Base was fast-forwarded to `commit`, the commit its merge check passed on; unchecked under `check_fast: none`. */
  Merged: {
    readonly ticket: TicketId
    readonly commit: CommitHash
    readonly unchecked: boolean
  }
  /** Its branch's commits change nothing: closed as `no_change`, its worktree and branch removed. */
  NoChange: { readonly ticket: TicketId }
  /** Set aside, its worktree kept: deferred with a note saying why. */
  SetAside: {
    readonly ticket: TicketId
    readonly reason: SetAsideReason
    readonly detail: string
  }
  /** The project has no `check_fast`, and doesn't say `none`: no merge, the ticket left waiting (H62). */
  NoMergeCheck: { readonly ticket: TicketId }
  /** The setup its rebase called for failed: back in the queue until a merge or a probe (`SETUP_FAILED`, §13.8). */
  SetupFailed: { readonly ticket: TicketId; readonly detail: string }
  /** The queue was stopped during `step`: the ticket is left waiting to merge, any rebase aborted. */
  Interrupted: { readonly ticket: TicketId; readonly step: MergeStep }
  /** Merging stops: the queue takes no further ticket, and the run ends with `kind`. */
  Stopped: {
    readonly ticket: TicketId
    readonly kind: MergeStopKind
    readonly detail: string
  }
}>
export const MergeUpdate = Data.taggedEnum<MergeUpdate>()

/** How a ticket's turn in the merge queue ended: every update but its progress. */
export type MergeOutcome = Exclude<
  MergeUpdate,
  { readonly _tag: 'Step' | 'Check' | 'Wrote' | 'MergesWait' }
>
export const MergeOutcome = Data.taggedEnum<MergeOutcome>()
