import { Array, Context, Data, Effect, Layer, Option } from 'effect'
import { join, resolve } from 'node:path'

import { type CommitHash, TicketId } from '@fabrica/contracts'

import type { CantTell, GitFailed } from './errors'
import type { RebaseOutcome } from './outcomes'
import type { WorktreeEntry } from './parse'
import { Git } from './service'

// Tickets' worktrees (spec §10.2, §13.6): the one rule for where a ticket's worktree is and what its
// branch is called, and the Worktrees service that makes, reuses, removes and lists them through Git.

/** Where a project's worktrees go: beside a registered checkout, or a folder of the engine's for a cloned one. */
export interface WorktreeHome {
  /** The project's checkout, whose repository the worktrees belong to. */
  readonly checkout: string
  /** The folder holding one worktree per ticket. */
  readonly folder: string
}

/** A registered checkout's worktrees: `<checkout>-worktrees/<ticket>`, orchestra's layout. */
export const besideCheckout = (checkout: string): WorktreeHome => {
  const absolute = resolve(checkout)
  return { checkout: absolute, folder: `${absolute}-worktrees` }
}

/** A cloned project's worktrees, in a folder of the engine's (`<data>/projects/<id>/worktrees`). */
export const inFolder = ({
  checkout,
  folder,
}: {
  readonly checkout: string
  readonly folder: string
}): WorktreeHome => ({ checkout: resolve(checkout), folder: resolve(folder) })

const BRANCH_PREFIX = 'fabrica/'

/** A ticket's branch: `fabrica/<ticket>`. */
export const ticketBranch = (ticket: TicketId): string =>
  `${BRANCH_PREFIX}${ticket}`

/** The ticket whose branch `branch` is, none for any other branch. */
export const branchTicket = (branch: string): Option.Option<TicketId> =>
  branch.startsWith(BRANCH_PREFIX)
    ? TicketId.makeOption(branch.slice(BRANCH_PREFIX.length))
    : Option.none()

/** Where a ticket's worktree is made. */
export const worktreePath = ({
  home,
  ticket,
}: {
  readonly home: WorktreeHome
  readonly ticket: TicketId
}): string => join(home.folder, ticket)

/** A ticket's worktree. */
export interface Worktree {
  readonly ticket: TicketId
  readonly path: string
  readonly branch: string
}

/** A ticket's worktree as `Worktrees.list` finds it: its HEAD as git listed it. */
export interface TicketWorktree extends Worktree {
  readonly head: Option.Option<CommitHash>
}

/** What `Worktrees.prepare` did. */
export type Prepared = Data.TaggedEnum<{
  /** A new worktree on a new branch, at the given Base commit. */
  Created: { readonly worktree: Worktree }
  /** The ticket's branch was there (with its worktree, or made one again), and was rebased onto the Base commit. */
  Reused: { readonly worktree: Worktree; readonly rebase: RebaseOutcome }
}>
export const Prepared = Data.taggedEnum<Prepared>()

export interface WorktreesShape {
  /**
   * The ticket's worktree from the Base commit `base`: made on a new branch `fabrica/<ticket>`, or,
   * when the branch is there, its worktree reused (made again where its folder is gone) and rebased.
   */
  readonly prepare: (input: {
    readonly home: WorktreeHome
    readonly ticket: TicketId
    readonly base: CommitHash
  }) => Effect.Effect<Prepared, CantTell | GitFailed>
  /** Removes the ticket's worktree, whatever its files, and its branch; nothing when neither is there. */
  readonly remove: (input: {
    readonly home: WorktreeHome
    readonly ticket: TicketId
  }) => Effect.Effect<void, CantTell | GitFailed>
  /** The repository's tickets' worktrees: those on a `fabrica/<ticket>` branch whose folders are there. */
  readonly list: (input: {
    readonly home: WorktreeHome
  }) => Effect.Effect<ReadonlyArray<TicketWorktree>, CantTell>
}

export class Worktrees extends Context.Service<Worktrees, WorktreesShape>()(
  '@fabrica/engine/Worktrees',
) {}

/** The listed worktree on `branch`, if any. */
const onBranch = (
  entries: ReadonlyArray<WorktreeEntry>,
  branch: string,
): Option.Option<WorktreeEntry> =>
  Array.findFirst(entries, entry => Option.contains(entry.branch, branch))

export const make = Effect.fn('Worktrees.make')(function* () {
  const git = yield* Git

  const prepare = Effect.fn('Worktrees.prepare')(function* ({
    home,
    ticket,
    base,
  }: {
    readonly home: WorktreeHome
    readonly ticket: TicketId
    readonly base: CommitHash
  }) {
    const repo = home.checkout
    const branch = ticketBranch(ticket)
    const [entries, existing] = yield* Effect.all(
      [
        git.worktrees({ repo }),
        git.commitHash({ repo, revision: `refs/heads/${branch}` }),
      ],
      { concurrency: 'unbounded' },
    )
    const listed = onBranch(entries, branch)
    const reuse = (path: string) =>
      Effect.map(git.rebase({ worktree: path, onto: base }), rebase =>
        Prepared.Reused({ worktree: { ticket, path, branch }, rebase }),
      )
    if (Option.isSome(listed) && !listed.value.prunable) {
      return yield* reuse(listed.value.path)
    }
    if (Option.isSome(listed)) yield* git.pruneWorktrees({ repo })
    const path = worktreePath({ home, ticket })
    if (Option.isSome(existing)) {
      yield* git.addWorktreeOn({ repo, path, branch })
      return yield* reuse(path)
    }
    yield* git.addWorktree({ repo, path, branch, from: base })
    return Prepared.Created({ worktree: { ticket, path, branch } })
  })

  const remove = Effect.fn('Worktrees.remove')(function* ({
    home,
    ticket,
  }: {
    readonly home: WorktreeHome
    readonly ticket: TicketId
  }) {
    const repo = home.checkout
    const branch = ticketBranch(ticket)
    const [entries, existing] = yield* Effect.all(
      [
        git.worktrees({ repo }),
        git.commitHash({ repo, revision: `refs/heads/${branch}` }),
      ],
      { concurrency: 'unbounded' },
    )
    const listed = onBranch(entries, branch)
    if (Option.isSome(listed)) {
      yield* listed.value.prunable
        ? git.pruneWorktrees({ repo })
        : git.removeWorktree({ repo, path: listed.value.path })
    }
    if (Option.isSome(existing)) yield* git.deleteBranch({ repo, branch })
  })

  const list = Effect.fn('Worktrees.list')(function* ({
    home,
  }: {
    readonly home: WorktreeHome
  }) {
    const entries = yield* git.worktrees({ repo: home.checkout })
    return entries.flatMap(entry =>
      entry.prunable
        ? []
        : Option.toArray(
            Option.flatMap(entry.branch, branch =>
              Option.map(branchTicket(branch), ticket => ({
                ticket,
                path: entry.path,
                branch,
                head: entry.head,
              })),
            ),
          ),
    )
  })

  return Worktrees.of({ prepare, remove, list })
})

/** The worktrees service over the git service. */
export const layer: Layer.Layer<Worktrees, never, Git> = Layer.effect(
  Worktrees,
  make(),
)
