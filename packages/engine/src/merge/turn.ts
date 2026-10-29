import type { Duration, Effect } from 'effect'

import type { Actor, CommandSetting } from '@fabrica/contracts'

import type { Worktree, WorktreeHome } from '../git'
import type { MergeUpdate } from './outcome'

// What a merge works with (spec §13.7): the project's settings it reads, resolved once per run, and a
// ticket's turn in the queue.

/** The run's settings for its merges. */
export interface MergeConfig {
  /** The project's checkout, Base checked out in it, and where its worktrees are. */
  readonly home: WorktreeHome
  /** Base: the branch finished tickets land on. */
  readonly base: string
  /** The merge check; unset, nothing merges, and `none` merges unchecked (H62). */
  readonly checkFast: CommandSetting
  /** `check_timeout`. */
  readonly checkTimeout: Duration.Input
  /** The project's `setup_files`. */
  readonly setupFiles: ReadonlyArray<string>
  /** The merge check's share of the machine's cores, at least 1. */
  readonly cores: number
  /** Who the queue's changes to the work graph are made by: the engine. */
  readonly actor: Actor
}

/** A ticket's turn in the queue. */
export interface MergeTurn {
  readonly config: MergeConfig
  readonly worktree: Worktree
  /** Publishes an update on the queue's stream. */
  readonly publish: (update: MergeUpdate) => Effect.Effect<void>
}
