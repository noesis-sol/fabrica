import {
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Match,
  Option,
  Result,
} from 'effect'
import { existsSync, watch } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { CommitHash, SetAsideReason } from '@fabrica/contracts'

import { Leftovers, leftovers } from '../checks'
import {
  type CantTell,
  type FastForwardOutcome,
  Git,
  type GitFailed,
  type GitShape,
  type WorktreeHome,
  Worktrees,
} from '../git'
import { checkoutWaitText } from '../runlog'
import { type LeftBy, type MergeStopKind, MergeUpdate } from './outcome'
import { dropRecord, readRecord, writeRecord } from './records'
import type { MergeTurn } from './turn'

// Merge hygiene (spec §13.7, H71, H72): a refused fast-forward diagnosed and tried again, a merge
// turn's budget of rechecks, what a setup or check leaves in the worktree and the record of the files
// it wrote and changed, merged worktrees cleaned up out of the queue, and fast-forwards waiting on a
// dirty checkout or untracked files in their way.

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

/** The record, in a worktree's own git folder, of the untracked files the queue's setups and checks wrote there. */
const WROTE = 'fabrica-wrote'

/** The record, in a worktree's own git folder, of the tracked files the queue's setups and checks changed there. */
const CHANGED = 'fabrica-changed'

/** The untracked files the queue's setups and checks wrote in the worktree, as it recorded them. */
export const wroteRecorded = (
  git: GitShape,
  { worktree }: { readonly worktree: string },
): Effect.Effect<ReadonlyArray<string>, CantTell> =>
  readRecord(git, { worktree, name: WROTE })

/** The tracked files the queue's setups and checks changed in the worktree, as it recorded them. */
export const changedRecorded = (
  git: GitShape,
  { worktree }: { readonly worktree: string },
): Effect.Effect<ReadonlyArray<string>, CantTell> =>
  readRecord(git, { worktree, name: CHANGED })

/** Adds `files` to the worktree's record `name`. */
const addToRecord = (
  git: GitShape,
  {
    worktree,
    name,
    files,
  }: {
    readonly worktree: string
    readonly name: string
    readonly files: ReadonlyArray<string>
  },
): Effect.Effect<void, CantTell | GitFailed> =>
  files.length === 0
    ? Effect.void
    : Effect.gen(function* () {
        const recorded = yield* readRecord(git, { worktree, name })
        const all = [...new Set([...recorded, ...files])]
        if (all.length > recorded.length)
          yield* writeRecord(git, { worktree, name, files: all })
      })

/**
 * Runs `effect`, a setup or a check the queue runs in `worktree`, and records the untracked files it
 * wrote there, and the tracked files it changed, however it ends, one cut short or failed too, as git's
 * status before and after it shows them; with its value, what it left. A status that can't be read
 * records nothing.
 */
export const recordingWrites = <A, E, R>(
  git: GitShape,
  worktree: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  { readonly value: A; readonly left: Leftovers },
  E | CantTell | GitFailed,
  R
> =>
  Effect.gen(function* () {
    const before = yield* Effect.result(git.status({ worktree }))
    const seen = Effect.map(Effect.result(git.status({ worktree })), after =>
      Result.isFailure(before)
        ? Leftovers.CantTell({ reason: before.failure.reason })
        : Result.isFailure(after)
          ? Leftovers.CantTell({ reason: after.failure.reason })
          : leftovers(before.success, after.success),
    )
    const record = (left: Leftovers) =>
      Leftovers.$match(left, {
        Seen: ({ wrote, changed }) =>
          Effect.andThen(
            addToRecord(git, { worktree, name: WROTE, files: wrote }),
            addToRecord(git, { worktree, name: CHANGED, files: changed }),
          ),
        CantTell: () => Effect.void,
      })
    const value = yield* Effect.onExit(effect, exit =>
      Exit.isSuccess(exit)
        ? Effect.void
        : seen.pipe(
            Effect.flatMap(record),
            Effect.catch(error =>
              Effect.logWarning(
                `Couldn't record the files written in ${worktree}`,
                error,
              ),
            ),
          ),
    )
    const left = yield* seen
    yield* record(left)
    return { value, left }
  })

/**
 * Removes the untracked files the queue's setups and checks wrote in the worktree, and their record: a
 * ticket set aside goes back with its worker's own files only, which `enter` and `finish` would
 * otherwise refuse as its worker's. Tracked files are never removed.
 */
export const removeWrote = Effect.fn('MergeQueue.removeWrote')(function* (
  git: GitShape,
  { worktree }: { readonly worktree: string },
) {
  if (!existsSync(worktree)) return
  const recorded = yield* wroteRecorded(git, { worktree })
  if (recorded.length === 0) return
  yield* git.removeUntracked({ worktree, files: recorded })
  yield* dropRecord(git, { worktree, name: WROTE })
})

/**
 * Puts the tracked files the queue's setups and checks changed in the worktree back as its HEAD has
 * them, and drops their record: the files put back. The worktree had none of them changed before the
 * setup or check that changed them, so none holds its worker's work.
 */
export const putBackChanged = Effect.fn('MergeQueue.putBackChanged')(function* (
  git: GitShape,
  { worktree }: { readonly worktree: string },
) {
  const none: ReadonlyArray<string> = []
  if (!existsSync(worktree)) return none
  const recorded = yield* changedRecorded(git, { worktree })
  if (recorded.length === 0) return none
  yield* git.restoreTracked({ worktree, files: recorded })
  yield* dropRecord(git, { worktree, name: CHANGED })
  return recorded
})

const leaver: { readonly [L in LeftBy]: string } = {
  setup: "the merge's setup",
  check: 'the merge check',
}

/**
 * What a setup or the merge check left in the worktree, read from git's status: tracked files changed set
 * the ticket aside (`DIRTY_WORKTREE`), as it passed on files that wouldn't merge, and are put back as it is
 * set aside; untracked files it
 * wrote, recorded as it ran, are published, and go with the worktree once it merges.
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

/**
 * Watches `folders` until the scope closes: the effect it gives completes on the first change seen
 * since, and never where none of them can be watched.
 */
const watching = Effect.fnUntraced(function* (folders: ReadonlyArray<string>) {
  const seen = yield* Deferred.make<void>()
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      folders.flatMap(folder => {
        try {
          const watcher = watch(folder, () => {
            Deferred.doneUnsafe(seen, Effect.void)
          })
          // A watch that fails is left to the poll beside it.
          watcher.on('error', () => watcher.close())
          return [watcher]
        } catch {
          return []
        }
      }),
    ),
    watchers =>
      Effect.sync(() => {
        for (const watcher of watchers) watcher.close()
      }),
  )
  return Deferred.await(seen)
})

/** The folders whose changes can clean the checkout: its root, its git folder, and each named file's. */
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
 * Whether the untracked file `file` is in the way of a fast-forward that changes `path`: git won't
 * overwrite it, put a folder where it is, or remove a folder it is in to put a file there.
 */
const inTheWayOf = (file: string, path: string): boolean =>
  file === path || file.startsWith(`${path}/`) || path.startsWith(`${file}/`)

/** What holds the fast-forward: the checkout's tracked files changed, and its untracked files in the way. */
interface Holding {
  readonly files: ReadonlyArray<string>
  readonly inTheWay: ReadonlyArray<string>
}

/**
 * Waits until Base's checkout has no uncommitted changes to tracked files and no untracked files the
 * fast-forward from `onto` to `checked` would overwrite, which git refuses (H72): meanwhile the merge
 * waits, `MERGES_WAIT` naming them, watched with a poll beside the file watch, as a watch alone goes
 * silent on macOS when its folder is removed (tutti-rvzn.26). Other untracked files don't hold it.
 */
export const checkoutReady = Effect.fn('MergeQueue.checkoutReady')(function* ({
  turn,
  onto,
  checked,
}: {
  readonly turn: MergeTurn
  readonly onto: CommitHash
  readonly checked: CommitHash
}) {
  const git = yield* Git
  const { poll } = yield* MergeWaits
  const { checkout } = turn.config.home
  const changes = yield* git.changedFiles({
    repo: checkout,
    branch: checked,
    base: onto,
  })
  const holding = Effect.map(
    git.status({ worktree: checkout }),
    (status): Holding => ({
      files: status.uncommitted,
      inTheWay: status.untracked.filter(file =>
        changes.some(path => inTheWayOf(file, path)),
      ),
    }),
  )
  const held = ({ files, inTheWay }: Holding) =>
    files.length > 0 || inTheWay.length > 0
  const same = (one: Holding, other: Holding) =>
    one.files.join('\0') === other.files.join('\0') &&
    one.inTheWay.join('\0') === other.inTheWay.join('\0')
  let now = yield* holding
  let named: Holding = { files: [], inTheWay: [] }
  while (held(now)) {
    if (!same(now, named)) {
      named = now
      yield* turn.publish(
        MergeUpdate.MergesWait({
          ticket: turn.worktree.ticket,
          checkout,
          files: now.files,
          inTheWay: now.inTheWay,
          detail: `MERGES_WAIT: ${checkoutWaitText({ checkout, ...now })}`,
        }),
      )
    }
    const waited = now
    now = yield* Effect.scoped(
      Effect.gen(function* () {
        // Watched first, then read: a change made before the watch began shows in the read.
        const change = yield* watching(
          watchedFolders(checkout, [...waited.files, ...waited.inTheWay]),
        )
        const read = yield* holding
        if (!same(read, waited)) return read
        yield* Effect.raceFirst(change, poll)
        return yield* holding
      }),
    )
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
