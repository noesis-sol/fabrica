import { Context, Data, Effect, Match, Option } from 'effect'
import { existsSync, watch } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { CommitHash, SetAsideReason } from '@fabrica/contracts'

import {
  type CantTell,
  type FastForwardOutcome,
  Git,
  type WorktreeHome,
  Worktrees,
} from '../git'
import { type LeftBy, type MergeStopKind, MergeUpdate } from './outcome'
import type { MergeTurn } from './turn'

// Merge hygiene (spec §13.7, H71, H72): a refused fast-forward diagnosed and tried again, a merge
// turn's budget of rechecks, what a setup or check leaves in the worktree, merged worktrees cleaned up
// out of the queue, and fast-forwards waiting on a dirty checkout.

/** Why a ticket is set aside, and its detail in words. */
export interface Aside {
  readonly reason: SetAsideReason
  readonly detail: string
}

/** What a fast-forward that didn't happen comes to. */
export type Diagnosis = Data.TaggedEnum<{
  /** Base moved on: the ticket is rebased and checked again. */
  Again: {}
  /** Base is still where the ticket was checked over: the fast-forward is tried again, its wait over. */
  Retry: {}
  /** The ticket is set aside. */
  SetAside: Aside
  /** Merging stops. */
  Stop: { readonly kind: MergeStopKind; readonly detail: string }
}>
export const Diagnosis = Data.taggedEnum<Diagnosis>()

/** How often a turn's branch or Base moving on may send it back to be checked again (tutti-5mmd). */
export const RECHECKS = 3

/** How often a refused fast-forward is tried again before the ticket is `GIT_FAILED` (H71). */
export const FAST_FORWARD_RETRIES = 3

/** How the hygiene waits: before a refused fast-forward is tried again, and between a dirty checkout's polls. */
export interface MergeWaitsShape {
  /** Before a refused fast-forward is tried again: 3 s. */
  readonly beforeRetry: Effect.Effect<void>
  /** Between two reads of a dirty checkout's status, beside its file watch. */
  readonly poll: Effect.Effect<void>
}

/** The hygiene's waits; the engine's are these defaults, and a test gives its own. */
export const MergeWaits = Context.Reference<MergeWaitsShape>(
  '@fabrica/engine/merge/MergeWaits',
  {
    defaultValue: () => ({
      beforeRetry: Effect.sleep('3 seconds'),
      poll: Effect.sleep('2 seconds'),
    }),
  },
)

/** Whether the turn may go round again, its branch or Base having moved during its `rounds` checks so far. */
export const mayGoRound = ({
  rounds,
}: {
  readonly turn: MergeTurn
  readonly rounds: number
}): Effect.Effect<boolean> => Effect.succeed(rounds <= RECHECKS)

const leaver: { readonly [L in LeftBy]: string } = {
  setup: "the merge's setup",
  check: 'the merge check',
}

/**
 * What a setup or the merge check left in the worktree, read from git's status: tracked files changed set
 * the ticket aside (`DIRTY_WORKTREE`), as it passed on files that wouldn't merge; untracked files it
 * wrote are published, and go with the worktree once it merges.
 */
export const afterCheck = Effect.fn('MergeQueue.afterCheck')(function* ({
  turn,
  by,
  changed,
  wrote,
}: {
  readonly turn: MergeTurn
  readonly by: LeftBy
  readonly changed: ReadonlyArray<string>
  readonly wrote: ReadonlyArray<string>
}) {
  const { ticket } = turn.worktree
  if (wrote.length > 0)
    yield* turn.publish(MergeUpdate.Wrote({ ticket, by, files: wrote }))
  return changed.length === 0
    ? Option.none<Aside>()
    : Option.some<Aside>({
        reason: 'DIRTY_WORKTREE',
        detail: `DIRTY_WORKTREE: ${leaver[by]} left tracked files changed: ${changed.join(', ')}`,
      })
})

/** Completes on the first change a watch of `folders` sees; never where none of them can be watched. */
const changeIn = (folders: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.callback<void>(resume => {
    const watchers = folders.flatMap(folder => {
      try {
        const watcher = watch(folder, () => resume(Effect.void))
        // A watch that fails is left to the poll beside it.
        watcher.on('error', () => watcher.close())
        return [watcher]
      } catch {
        return []
      }
    })
    return Effect.sync(() => {
      for (const watcher of watchers) watcher.close()
    })
  })

/** The folders whose changes can clean the checkout: its root, its git folder, and each changed file's. */
const watchedFolders = (
  checkout: string,
  files: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  ...new Set([
    checkout,
    join(checkout, '.git'),
    ...files.map(file => dirname(join(checkout, file))),
  ]),
]

/**
 * Waits until Base's checkout has no uncommitted changes to tracked files (H72): meanwhile the merge
 * waits, `MERGES_WAIT` naming them, watched with a poll beside the file watch, as a watch alone goes
 * silent on macOS when its folder is removed (tutti-rvzn.26). Untracked files don't hold it.
 */
export const checkoutReady = Effect.fn('MergeQueue.checkoutReady')(function* (
  turn: MergeTurn,
) {
  const git = yield* Git
  const { poll } = yield* MergeWaits
  const { checkout } = turn.config.home
  const changed = Effect.map(
    git.status({ worktree: checkout }),
    status => status.uncommitted,
  )
  let files = yield* changed
  let named: ReadonlyArray<string> = []
  while (files.length > 0) {
    if (files.join('\0') !== named.join('\0')) {
      named = files
      yield* turn.publish(
        MergeUpdate.MergesWait({
          ticket: turn.worktree.ticket,
          checkout,
          files,
          detail: `MERGES_WAIT: ${checkout} has uncommitted changes to ${files.join(', ')}`,
        }),
      )
    }
    yield* Effect.raceFirst(changeIn(watchedFolders(checkout, files)), poll)
    files = yield* changed
  }
})

/**
 * A fast-forward of Base to `checked`, over the Base commit `onto`, that didn't happen (H71). A branch
 * that doesn't fast-forward Base where it was checked stops merging; Base moved on sends the ticket
 * back to be rebased and checked. A refusal reads Base again: still where it was, the fast-forward is
 * tried again after its wait, `retries` times so far, up to `FAST_FORWARD_RETRIES`, then `GIT_FAILED`.
 */
export const diagnose = Effect.fn('MergeQueue.diagnose')(function* ({
  turn,
  onto,
  checked,
  outcome,
  retries,
  base,
}: {
  readonly turn: MergeTurn
  readonly onto: CommitHash
  readonly checked: CommitHash
  readonly outcome: Exclude<
    FastForwardOutcome,
    { readonly _tag: 'FastForwarded' }
  >
  readonly retries: number
  /** Reads Base's commit again. */
  readonly base: Effect.Effect<CommitHash, CantTell>
}) {
  const { beforeRetry } = yield* MergeWaits
  const name = turn.config.base
  return yield* Match.valueTags(outcome, {
    NotFastForward: ({ base: now }) =>
      Effect.succeed(
        now === onto
          ? Diagnosis.Stop({
              kind: 'MERGE_FAILED',
              detail: `MERGE_FAILED: ${turn.worktree.branch} doesn't fast-forward ${name} at ${now}`,
            })
          : Diagnosis.Again(),
      ),
    OffBranch: ({ branch }) =>
      Effect.succeed(
        Diagnosis.Stop({
          kind: 'OFF_BRANCH',
          detail: `OFF_BRANCH: ${turn.config.home.checkout} is on ${Option.getOrElse(branch, () => 'a detached HEAD')}, not ${name}`,
        }),
      ),
    Refused: ({ message }) =>
      Effect.gen(function* () {
        const now = yield* base
        if (now !== onto && now !== checked) return Diagnosis.Again()
        if (retries >= FAST_FORWARD_RETRIES)
          return Diagnosis.SetAside({
            reason: 'GIT_FAILED',
            detail: `GIT_FAILED: git refused to fast-forward ${name} ${retries + 1} times: ${message}`,
          })
        yield* beforeRetry
        return Diagnosis.Retry()
      }),
  })
})

/** The folder merged worktrees are moved aside into, to be deleted: beside them, so on the same disk. */
export const asideFolder = (home: WorktreeHome): string =>
  join(home.folder, '.deleting')

/** Deletes a folder moved aside; a failure is logged, and the next run's start deletes what is left. */
const deleteAside = (path: string): Effect.Effect<void> =>
  Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(
    Effect.catch(error =>
      Effect.logWarning(`Couldn't delete ${path}, moved aside`, error),
    ),
  )

/** Deletes what an earlier run moved aside and left: a run does it as it starts (tutti-ejkt.4). */
export const clearAside = Effect.fn('MergeQueue.clearAside')(function* (
  home: WorktreeHome,
) {
  const folder = asideFolder(home)
  if (!existsSync(folder)) return
  const none: ReadonlyArray<string> = []
  const entries = yield* Effect.tryPromise(() => readdir(folder)).pipe(
    Effect.catch(error =>
      Effect.as(Effect.logWarning(`Couldn't read ${folder}`, error), none),
    ),
  )
  yield* Effect.forEach(entries, entry => deleteAside(join(folder, entry)), {
    discard: true,
  })
})

/** Moves the worktree at `path` aside, by a rename: the folder it went to, or none where it couldn't. */
const moveAside = (home: WorktreeHome, path: string, ticket: string) =>
  Effect.tryPromise(async () => {
    const folder = asideFolder(home)
    await mkdir(folder, { recursive: true })
    const made = await mkdtemp(join(folder, `${ticket}-`))
    await rename(path, join(made, 'worktree'))
    return made
  }).pipe(
    Effect.map(Option.some),
    Effect.catch(error =>
      Effect.as(
        Effect.logWarning(`Couldn't move ${path} aside`, error),
        Option.none<string>(),
      ),
    ),
  )

/**
 * Removes a merged or unchanged ticket's worktree and its branch, out of the queue's way (tutti-ejkt.4):
 * with no changes but the untracked files its setups and checks wrote, the worktree is moved aside, its
 * branch deleted and its files deleted in the background. Tracked files changed since its check are
 * kept, worktree and branch, and logged. Where it can't be moved aside, it is removed in place.
 */
export const cleanUp = Effect.fn('MergeQueue.cleanUp')(function* (
  turn: MergeTurn,
) {
  const git = yield* Git
  const worktrees = yield* Worktrees
  const { home } = turn.config
  const { ticket, path } = turn.worktree
  const remove = worktrees.remove({ home, ticket })
  if (!existsSync(path)) return yield* remove
  const { uncommitted } = yield* git.status({ worktree: path })
  if (uncommitted.length > 0) {
    return yield* Effect.logWarning(
      `Kept ${ticket}'s worktree: its tracked files ${uncommitted.join(', ')} changed after its merge check`,
    )
  }
  const moved = yield* moveAside(home, path, ticket)
  yield* remove
  if (Option.isSome(moved)) yield* Effect.forkDetach(deleteAside(moved.value))
})
