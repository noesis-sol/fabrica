import { Data, type Option } from 'effect'

import type { CommitHash } from '@fabrica/contracts'

// What git's writes and checks come to (spec §13.7, §13.1, H59, H71, H85). Each is a tagged union
// made by its constructors and matched exhaustively: a refusal is an outcome of its own kind, never
// an error a caller tells apart by its message.

/** Whether the git the engine runs is one it can use: 2.38 or later (spec §13.1). */
export type GitVersion = Data.TaggedEnum<{
  /** 2.38 or later; `version` as `git version` gave it. */
  Supported: { readonly version: string }
  /** Older than 2.38: no `worktree list -z`, no `merge-tree --write-tree`. */
  TooOld: { readonly version: string; readonly minimum: string }
  /** No `git` on the PATH commands run with. */
  Missing: { readonly path: string }
  /** `git version` didn't run, or said nothing that reads as a version. */
  Unreadable: { readonly reason: string }
}>
export const GitVersion = Data.taggedEnum<GitVersion>()

/** A worktree's rebase onto a given commit. */
export type RebaseOutcome = Data.TaggedEnum<{
  /** The branch is on top of the commit: `from` its head before, `head` its head now (the same when it was already). */
  Rebased: { readonly from: CommitHash; readonly head: CommitHash }
  /** The rebase stopped on a conflict and is in progress, these files unmerged; `Git.abortRebase` puts it back. */
  Conflict: { readonly files: ReadonlyArray<string> }
  /** A rebase was already in progress in the worktree, left as it was. */
  AlreadyRebasing: {}
  /** Git refused to start it (uncommitted changes, for one), and nothing moved. */
  Refused: { readonly message: string }
}>
export const RebaseOutcome = Data.taggedEnum<RebaseOutcome>()

/** `git rebase --abort` in a worktree. */
export type AbortOutcome = Data.TaggedEnum<{
  /** A rebase was in progress, and its branch is back where it started. */
  Aborted: {}
  /** No rebase was in progress. */
  NotRebasing: {}
}>
export const AbortOutcome = Data.taggedEnum<AbortOutcome>()

/** Fast-forwarding Base, in the checkout it is checked out in, to a given commit's hash. */
export type FastForwardOutcome = Data.TaggedEnum<{
  /** Base and the checkout are at `to`; `from` is where Base was (the same when it already was). */
  FastForwarded: { readonly from: CommitHash; readonly to: CommitHash }
  /** `to` doesn't descend from Base, at `base`: the branch doesn't fast-forward. */
  NotFastForward: { readonly base: CommitHash }
  /** The checkout isn't on Base: on another branch, or none (a detached HEAD). */
  OffBranch: { readonly branch: Option.Option<string> }
  /** Git refused it (another process's `index.lock`, local changes it would overwrite): Base is to be read again. */
  Refused: { readonly message: string }
}>
export const FastForwardOutcome = Data.taggedEnum<FastForwardOutcome>()
