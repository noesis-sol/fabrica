import { Context, Data, Effect, Layer } from 'effect'
import { basename, matchesGlob } from 'node:path'

import type { TicketId } from '@fabrica/contracts'

// The setup a merge's rebase calls for (spec §13.7 step 4, §13.8): whether a rebase changed a setup
// file, and the port the queue runs the setup through. The port does nothing until the run's setup
// fills it.

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

export class MergeSetup extends Context.Service<MergeSetup, MergeSetupShape>()(
  '@fabrica/engine/MergeSetup',
) {}

/** The port before the run's setup fills it: nothing runs, and the worktree is ready. */
export const noSetup: Layer.Layer<MergeSetup> = Layer.succeed(
  MergeSetup,
  MergeSetup.of({ run: () => Effect.succeed(SetupOutcome.Ready()) }),
)
