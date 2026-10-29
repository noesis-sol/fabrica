import { Data } from 'effect'

import type {
  FileFailed,
  FileMissing,
  FileRefused,
  PathOutsideRoot,
} from '../files'
import type { WorktreeStatus } from '../git'
import { type ExitStatus, StartFailure } from '../process'
import type { EventDraft } from '../runlog'

// What a check or a setup came to (spec §13.7, §13.8, §13.9, §13.12). Each is a tagged union made by
// its constructors and matched exhaustively: a caller never tells two apart by their fields.

/** A check's record in the event stream (orchestra's `check`, H65): suite, command, commit, seconds, result. */
export type CheckRecord = Extract<EventDraft, { readonly kind: 'check' }>

/** What a check left in its worktree (spec §13.7 What a check leaves), as git's status after it showed. */
export type Leftovers = Data.TaggedEnum<{
  /** Git's status before and after the check, read. */
  Seen: {
    /** Tracked files changed after it that weren't before (`DIRTY_WORKTREE`). */
    readonly changed: ReadonlyArray<string>
    /** Untracked files after it that weren't before: recorded, and removed with the worktree or as its ticket is set aside. */
    readonly wrote: ReadonlyArray<string>
  }
  /** A status read failed: what the check left can't be told, and is never taken as nothing. */
  CantTell: { readonly reason: string }
}>
export const Leftovers = Data.taggedEnum<Leftovers>()

/** What git's status after a check or a setup shows that it didn't before. */
export const leftovers = (
  before: WorktreeStatus,
  after: WorktreeStatus,
): Leftovers => {
  const newIn = (
    now: ReadonlyArray<string>,
    then: ReadonlyArray<string>,
  ): ReadonlyArray<string> => {
    const earlier = new Set(then)
    return now.filter(path => !earlier.has(path))
  }
  return Leftovers.Seen({
    changed: newIn(after.uncommitted, before.uncommitted),
    wrote: newIn(after.untracked, before.untracked),
  })
}

/** The check's log couldn't be opened or written. */
export type LogError = PathOutsideRoot | FileRefused | FileFailed | FileMissing

/** Why a check couldn't run: not a suite's failure (`FULL_CHECK_NOT_RUN`, spec §13.9). */
export type NotRun = Data.TaggedEnum<{
  /** Its command holds a newline or a control character, which would hide what runs after it. */
  CommandRefused: { readonly command: string }
  /** Its command didn't start. */
  DidNotStart: { readonly reason: StartFailure }
  /** Its output passed the size cap, and its whole tree was ended. */
  OutputCut: { readonly limit: number }
  /** Its output couldn't be kept. */
  LogNotKept: { readonly error: LogError }
}>
export const NotRun = Data.taggedEnum<NotRun>()

/** Why a check didn't run, in words, as an agent or a log line says it. */
export const notRunReason: (reason: NotRun) => string = NotRun.$match({
  CommandRefused: () =>
    'its command holds a newline or a control character, and is refused',
  DidNotStart: ({ reason }) =>
    StartFailure.$match(reason, {
      NotOnPath: ({ command, path }) =>
        `${command} isn't on the PATH it runs with (${path})`,
      SpawnFailed: ({ command, message }) =>
        `${command} didn't start: ${message}`,
    }),
  OutputCut: ({ limit }) =>
    `its output passed ${limit} bytes, and it was ended`,
  LogNotKept: ({ error }) => `its output couldn't be kept: ${error.message}`,
})

/** A check or a setup run to its end by `Checks.run`. */
export type CheckOutcome = Data.TaggedEnum<{
  /** It exited 0. */
  Passed: {
    readonly record: CheckRecord
    /** The log's full path. */
    readonly log: string
    readonly left: Leftovers
  }
  /** It exited with another code, or was ended by a signal. */
  Failed: {
    readonly record: CheckRecord
    readonly log: string
    readonly left: Leftovers
    readonly status: ExitStatus
  }
  /** Its time limit, counted in time awake, ran out, and its whole tree was ended. */
  TimedOut: {
    readonly record: CheckRecord
    readonly log: string
    readonly left: Leftovers
  }
  /** It couldn't run, or its output couldn't be kept. */
  CouldNotRun: { readonly record: CheckRecord; readonly reason: NotRun }
}>
export const CheckOutcome = Data.taggedEnum<CheckOutcome>()
