import { Effect, Option } from 'effect'

import type { CommitHash } from '@fabrica/contracts'

import type { MergeTurn } from './turn'

// The merge train (spec §13.7, orchestra-8qk2): while one ticket's merge check runs, the next queued
// ticket is rebased onto the first's rebased head and checked beside it, so that it merges with no
// further check once the first merges as checked. Until it is built, no ticket is checked ahead of its
// turn and a merge check runs alone.

/** The head the train already checked for the ticket over the Base commit `onto`, `head` among them; none. */
export const checkedAhead = (_input: {
  readonly turn: MergeTurn
  readonly onto: CommitHash
  readonly head: CommitHash
}): Effect.Effect<Option.Option<CommitHash>> => Effect.succeedNone

/** Runs the ticket's merge check, `check`: alone, as the train checks no ticket beside it yet. */
export const besideCheck = <A, E, R>(
  _turn: MergeTurn,
  check: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => check
