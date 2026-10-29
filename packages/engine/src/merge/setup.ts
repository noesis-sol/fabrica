import { Context, Data, Effect, Layer, Option } from 'effect'
import { basename, matchesGlob } from 'node:path'

import type { CommitHash, TicketId } from '@fabrica/contracts'

import type { Leftovers } from '../checks'
import type { CantTell, GitFailed, GitShape } from '../git'
import { recordingWrites } from './hygiene'
import { dropRecord, readRecord, writeRecord } from './records'

// The setup a merge's rebase calls for (spec §13.7 step 4, §13.8): whether a rebase changed a setup
// file, the setup a worktree still waits for, and the port the queue runs the setup through. The port
// does nothing until the run's setup fills it.

/**
 * Whether `path` (from the repository's root) is a setup file: it, or its file name for a pattern
 * without a `/`, matches one of `patterns`, the project's `setup_files` (globs, as `requirements*.txt`).
 */
export const isSetupFile = (
  path: string,
  patterns: ReadonlyArray<string>,
): boolean =>
  patterns.some(pattern =>
    matchesGlob(pattern.includes('/') ? path : basename(path), pattern),
  )

/**
 * The setup files a rebase onto `onto` brought into the worktree from Base: those changed from `since`,
 * the branch's merge base before it, to `onto`; none without a merge base.
 */
export const setupFilesBrought = (
  git: GitShape,
  {
    worktree,
    onto,
    since,
    patterns,
  }: {
    readonly worktree: string
    readonly onto: CommitHash
    readonly since: Option.Option<CommitHash>
    readonly patterns: ReadonlyArray<string>
  },
): Effect.Effect<ReadonlyArray<string>, CantTell> =>
  Option.match(since, {
    onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
    onSome: from =>
      Effect.map(
        git.changedFiles({ repo: worktree, branch: onto, base: from }),
        files => files.filter(file => isSetupFile(file, patterns)),
      ),
  })

/** The record, in a worktree's own git folder, of the setup files it waits to be set up for. */
const PENDING_SETUP = 'fabrica-setup'

/**
 * The setup files a worktree waits to be set up for (spec §13.8, §13.10): those of a setup that didn't
 * pass, or of a ride a stop put back before setting it up again; none where none is recorded.
 */
export const pendingSetup = (
  git: GitShape,
  { worktree }: { readonly worktree: string },
): Effect.Effect<ReadonlyArray<string>, CantTell> =>
  readRecord(git, { worktree, name: PENDING_SETUP })

/** Records that the worktree waits to be set up for `files`, until a setup there passes. */
export const recordSetup = (
  git: GitShape,
  {
    worktree,
    files,
  }: { readonly worktree: string; readonly files: ReadonlyArray<string> },
): Effect.Effect<void, CantTell | GitFailed> =>
  writeRecord(git, { worktree, name: PENDING_SETUP, files })

/** What a merge's setup came to. */
export type SetupOutcome = Data.TaggedEnum<{
  /** It ran and passed, or there was nothing to run. */
  Ready: {}
  /** It failed: the ticket waits for a merge or a probe (`SETUP_FAILED`). */
  Failed: { readonly detail: string }
}>
export const SetupOutcome = Data.taggedEnum<SetupOutcome>()

export interface MergeSetupShape {
  /** Runs the project's setup in the ticket's worktree, whose rebase changed the setup files `files`. */
  readonly run: (input: {
    readonly ticket: TicketId
    readonly worktree: string
    readonly files: ReadonlyArray<string>
  }) => Effect.Effect<SetupOutcome>
}

/**
 * Runs the setup for `files` in the ticket's worktree, recorded as waited for until it passes: a setup
 * that fails or is cut short is run again at the ticket's next merge (spec §13.8). The untracked files
 * it writes are recorded as the queue's; with its outcome, what it left.
 */
export const setUpRecorded = (
  git: GitShape,
  setup: MergeSetupShape,
  input: {
    readonly ticket: TicketId
    readonly worktree: string
    readonly files: ReadonlyArray<string>
  },
): Effect.Effect<
  { readonly ready: SetupOutcome; readonly left: Leftovers },
  CantTell | GitFailed
> =>
  Effect.gen(function* () {
    yield* recordSetup(git, input)
    const { value: ready, left } = yield* recordingWrites(
      git,
      input.worktree,
      setup.run(input),
    )
    if (SetupOutcome.$is('Ready')(ready))
      yield* dropRecord(git, { worktree: input.worktree, name: PENDING_SETUP })
    return { ready, left }
  })

export class MergeSetup extends Context.Service<MergeSetup, MergeSetupShape>()(
  '@fabrica/engine/MergeSetup',
) {}

/** The port before the run's setup fills it: nothing runs, and the worktree is ready. */
export const noSetup: Layer.Layer<MergeSetup> = Layer.succeed(
  MergeSetup,
  MergeSetup.of({ run: () => Effect.succeed(SetupOutcome.Ready()) }),
)
