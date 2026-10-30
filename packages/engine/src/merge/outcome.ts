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
// is `merging` (`Wrote` and `MergesWait` tell more of it), the endings are `merged`, `no_change`, `set_aside`, or back to waiting;
// `HandedBack` is `resolving` or `fixing`, and `Requeued` back to `waiting_to_merge`.

/** The stops a merge can bring a run to: it stops merging, and the run ends with its kind (§13.11). */
export type MergeStopKind = Extract<
  StopKind,
  'MERGE_FAILED' | 'OFF_BRANCH' | 'TRACKER_FAILED'
>

/** What a merge hands back to a ticket's worker: its rebase's conflicts to resolve, or its failed check to fix. */
export type HandBackKind = 'resolve' | 'fix'

/** Why a ticket is back in the queue's line: its hand-back done, or a check to run again once Base moved. */
export type RequeuedFor = 'hand_back' | 'recheck'

/** What ran in a ticket's worktree during its merge: the setup its rebase called for, or the merge check. */
export type LeftBy = 'setup' | 'check'

/** What the merge queue publishes: its merges' progress, and how each ended. */
export type MergeUpdate = Data.TaggedEnum<{
  /** A ticket's merge entered `step`. */
  Step: { readonly ticket: TicketId; readonly step: MergeStep }
  /** A check of a ticket's merge ended: its record, for the event stream. */
  Check: { readonly ticket: TicketId; readonly record: CheckRecord }
  /** The merge's setup or check wrote untracked `files` in the worktree: recorded, and removed with it or as it is set aside. */
  Wrote: {
    readonly ticket: TicketId
    readonly by: LeftBy
    readonly files: ReadonlyArray<string>
  }
  /** Back in the queue's line, behind those waiting: its hand-back's work taken from git, or rechecked as Base moved (`RECHECK`). */
  Requeued: {
    readonly ticket: TicketId
    readonly for: RequeuedFor
    readonly detail: string
  }
  /**
   * The fast-forward waits on `checkout`'s uncommitted changes to `files`, and its untracked files the
   * fast-forward would overwrite, `inTheWay` (`MERGES_WAIT`, H72), until it is clear of both.
   */
  MergesWait: {
    readonly ticket: TicketId
    readonly checkout: string
    readonly files: ReadonlyArray<string>
    readonly inTheWay: ReadonlyArray<string>
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
  /** Its conflicts or failed check went back to its worker, the `attempt`th of its kind in the run (`RESOLVING`, `FIXING`). */
  HandedBack: {
    readonly ticket: TicketId
    readonly kind: HandBackKind
    readonly attempt: number
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
  { readonly _tag: 'Step' | 'Check' | 'Wrote' | 'MergesWait' | 'Requeued' }
>
export const MergeOutcome = Data.taggedEnum<MergeOutcome>()

/** Whether `update` is its turn's outcome, not its progress: a `MERGES_WAIT` it said is over with it. */
export const isOutcome = (update: MergeUpdate): update is MergeOutcome =>
  MergeUpdate.$match(update, {
    Step: () => false,
    Check: () => false,
    Wrote: () => false,
    Requeued: () => false,
    MergesWait: () => false,
    Merged: () => true,
    NoChange: () => true,
    SetAside: () => true,
    HandedBack: () => true,
    NoMergeCheck: () => true,
    SetupFailed: () => true,
    Interrupted: () => true,
    Stopped: () => true,
  })
