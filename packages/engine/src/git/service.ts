import { Context, Effect, Layer, Option } from 'effect'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import type { CommitHash, TreeHash } from '@fabrica/contracts'

import { CommandOutcome, ProcessRunner, StartFailure } from '../process'
import { type GitConfig, defaultConfig, makeCommands } from './command'
import { CantTell, GitFailed } from './errors'
import {
  AbortOutcome,
  FastForwardOutcome,
  GitVersion,
  RebaseOutcome,
} from './outcomes'
import {
  MINIMUM_GIT,
  type WorktreeEntry,
  type WorktreeStatus,
  nulList,
  parseGitVersion,
  parseHash,
  parseStatus,
  parseTreeHash,
  parseWorktrees,
  shortBranch,
} from './parse'

// The Git service (spec §13.7, §10.2, §13.1, H59, H85): the engine's one reader of each of git's
// answers, and its one way to rebase a branch and fast-forward Base. Every read is retried on a short
// schedule and is "can't tell" (`CantTell`) when it still fails; every write's refusal is an outcome.
// `repo` is any folder of the repository (its checkout or a worktree), `worktree` the worktree acted
// on; a revision is a commit's hash or a name (`main`, `fabrica/<ticket>`), never parsed as a path.

export interface GitShape {
  /** Whether the git commands run with is 2.38 or later (spec §13.1). */
  readonly version: Effect.Effect<GitVersion>
  /** The worktree's uncommitted and untracked files. */
  readonly status: (input: {
    readonly worktree: string
  }) => Effect.Effect<WorktreeStatus, CantTell>
  /** Whether `branch`'s head is in `base`'s history: the branch is on Base, merged. */
  readonly isOnBase: (input: {
    readonly repo: string
    readonly branch: string
    readonly base: string
  }) => Effect.Effect<boolean, CantTell>
  /** The best common ancestor of `branch` and `base`; none when their histories are unrelated. */
  readonly mergeBase: (input: {
    readonly repo: string
    readonly branch: string
    readonly base: string
  }) => Effect.Effect<Option.Option<CommitHash>, CantTell>
  /** The commit `revision` names; none when it names none. */
  readonly commitHash: (input: {
    readonly repo: string
    readonly revision: string
  }) => Effect.Effect<Option.Option<CommitHash>, CantTell>
  /** The tree of the commit `revision` names; none when it names none. */
  readonly treeHash: (input: {
    readonly repo: string
    readonly revision: string
  }) => Effect.Effect<Option.Option<TreeHash>, CantTell>
  /** The branch checked out in `repo`'s worktree, its short name; none for a detached HEAD. */
  readonly currentBranch: (input: {
    readonly repo: string
  }) => Effect.Effect<Option.Option<string>, CantTell>
  /** The files `branch` changed since its merge base with `base`, as paths from the repository's root. */
  readonly changedFiles: (input: {
    readonly repo: string
    readonly branch: string
    readonly base: string
  }) => Effect.Effect<ReadonlyArray<string>, CantTell>
  /** The files tracked at `revision`, as paths from the repository's root. */
  readonly trackedFiles: (input: {
    readonly repo: string
    readonly revision: string
  }) => Effect.Effect<ReadonlyArray<string>, CantTell>
  /** The repository's worktrees, its main one first. */
  readonly worktrees: (input: {
    readonly repo: string
  }) => Effect.Effect<ReadonlyArray<WorktreeEntry>, CantTell>
  /** Rebases the worktree's branch onto the commit `onto`, never moving another branch (`--no-update-refs`). */
  readonly rebase: (input: {
    readonly worktree: string
    readonly onto: CommitHash
  }) => Effect.Effect<RebaseOutcome, CantTell | GitFailed>
  /** Aborts a rebase in progress in the worktree, putting its branch back. */
  readonly abortRebase: (input: {
    readonly worktree: string
  }) => Effect.Effect<AbortOutcome, CantTell | GitFailed>
  /** Fast-forwards the branch `base`, checked out in `checkout`, to the commit `to`, by its hash. */
  readonly fastForward: (input: {
    readonly checkout: string
    readonly base: string
    readonly to: CommitHash
  }) => Effect.Effect<FastForwardOutcome, CantTell | GitFailed>
  /** Adds a worktree at `path` on a new branch `branch` from the commit `from`. */
  readonly addWorktree: (input: {
    readonly repo: string
    readonly path: string
    readonly branch: string
    readonly from: CommitHash
  }) => Effect.Effect<void, GitFailed>
  /** Adds a worktree at `path` on the existing branch `branch`. */
  readonly addWorktreeOn: (input: {
    readonly repo: string
    readonly path: string
    readonly branch: string
  }) => Effect.Effect<void, GitFailed>
  /** Removes the worktree at `path`, whatever its files. */
  readonly removeWorktree: (input: {
    readonly repo: string
    readonly path: string
  }) => Effect.Effect<void, GitFailed>
  /** Drops the records of worktrees whose folders are gone. */
  readonly pruneWorktrees: (input: {
    readonly repo: string
  }) => Effect.Effect<void, GitFailed>
  /** Deletes the branch `branch`, merged or not; refused while a worktree has it checked out. */
  readonly deleteBranch: (input: {
    readonly repo: string
    readonly branch: string
  }) => Effect.Effect<void, GitFailed>
}

export class Git extends Context.Service<Git, GitShape>()(
  '@fabrica/engine/Git',
) {}

const MINIMUM = `${MINIMUM_GIT.major}.${MINIMUM_GIT.minor}`

export const make = Effect.fn('Git.make')(function* (config: GitConfig) {
  const runner = yield* ProcessRunner
  const { write, query, queryOutcome, read, unexpected } = makeCommands({
    runner,
    config,
  })

  /** A read of a value that `answer` takes from the exit, failing the attempt where it gives none. */
  const readExit = <A>(
    name: string,
    command: { readonly cwd: string; readonly args: ReadonlyArray<string> },
    answer: (exit: {
      readonly code: number
      readonly stdout: string
    }) => Option.Option<A>,
  ): Effect.Effect<A, CantTell> =>
    read(
      name,
      Effect.flatMap(query(command), exit =>
        Option.match(answer(exit), {
          onNone: () => unexpected(command.args, exit),
          onSome: Effect.succeed,
        }),
      ),
    )

  const version = Effect.map(
    queryOutcome({ cwd: '/', args: ['version'] }),
    CommandOutcome.$match({
      Exited: ({ stdout, stderr }) =>
        Option.match(parseGitVersion(stdout), {
          onNone: () =>
            GitVersion.Unreadable({
              reason: `git version said: ${stdout.trim() || stderr.trim()}`,
            }),
          onSome: ({ version, supported }) =>
            supported
              ? GitVersion.Supported({ version })
              : GitVersion.TooOld({ version, minimum: MINIMUM }),
        }),
      TimedOut: () =>
        GitVersion.Unreadable({ reason: 'git version timed out' }),
      Cut: () => GitVersion.Unreadable({ reason: 'git version was cut' }),
      FailedToStart: ({ reason }) =>
        StartFailure.$match(reason, {
          NotOnPath: ({ path }) => GitVersion.Missing({ path }),
          SpawnFailed: ({ message }) =>
            GitVersion.Unreadable({ reason: `git didn't start: ${message}` }),
        }),
    }),
  ).pipe(Effect.withSpan('Git.version'))

  const status = Effect.fn('Git.status')(function* ({
    worktree,
  }: {
    readonly worktree: string
  }) {
    return yield* readExit(
      'status',
      {
        cwd: worktree,
        args: [
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--no-renames',
        ],
      },
      exit => (exit.code === 0 ? parseStatus(exit.stdout) : Option.none()),
    )
  })

  const isAncestor = (
    name: string,
    {
      repo,
      ancestor,
      descendant,
    }: {
      readonly repo: string
      readonly ancestor: string
      readonly descendant: string
    },
  ) =>
    readExit(
      name,
      {
        cwd: repo,
        args: [
          'merge-base',
          '--is-ancestor',
          '--end-of-options',
          ancestor,
          descendant,
        ],
      },
      exit =>
        exit.code === 0
          ? Option.some(true)
          : exit.code === 1
            ? Option.some(false)
            : Option.none(),
    )

  const isOnBase = Effect.fn('Git.isOnBase')(function* ({
    repo,
    branch,
    base,
  }: {
    readonly repo: string
    readonly branch: string
    readonly base: string
  }) {
    return yield* isAncestor('isOnBase', {
      repo,
      ancestor: branch,
      descendant: base,
    })
  })

  const mergeBase = Effect.fn('Git.mergeBase')(function* ({
    repo,
    branch,
    base,
  }: {
    readonly repo: string
    readonly branch: string
    readonly base: string
  }) {
    return yield* readExit(
      'mergeBase',
      {
        cwd: repo,
        args: ['merge-base', '--end-of-options', branch, base],
      },
      exit =>
        exit.code === 0
          ? Option.map(parseHash(exit.stdout), Option.some)
          : exit.code === 1 && exit.stdout.trim() === ''
            ? Option.some(Option.none<CommitHash>())
            : Option.none(),
    )
  })

  /** The object `revision` names, peeled to `peel` (`commit`, `tree`) and read by `parse`; none when it names none. */
  const peeledHash = <H>(
    name: string,
    input: {
      readonly repo: string
      readonly revision: string
      readonly peel: 'commit' | 'tree'
      readonly parse: (output: string) => Option.Option<H>
    },
  ) =>
    readExit(
      name,
      {
        cwd: input.repo,
        args: [
          'rev-parse',
          '--verify',
          '--quiet',
          '--end-of-options',
          `${input.revision}^{${input.peel}}`,
        ],
      },
      exit =>
        exit.code === 0
          ? Option.map(input.parse(exit.stdout), Option.some)
          : exit.code === 1
            ? Option.some(Option.none<H>())
            : Option.none(),
    )

  const hashOf = (name: string, repo: string, revision: string) =>
    peeledHash(name, { repo, revision, peel: 'commit', parse: parseHash })

  const commitHash = Effect.fn('Git.commitHash')(function* ({
    repo,
    revision,
  }: {
    readonly repo: string
    readonly revision: string
  }) {
    return yield* hashOf('commitHash', repo, revision)
  })

  const treeHash = Effect.fn('Git.treeHash')(function* ({
    repo,
    revision,
  }: {
    readonly repo: string
    readonly revision: string
  }) {
    return yield* peeledHash('treeHash', {
      repo,
      revision,
      peel: 'tree',
      parse: parseTreeHash,
    })
  })

  const currentBranch = Effect.fn('Git.currentBranch')(function* ({
    repo,
  }: {
    readonly repo: string
  }) {
    return yield* readExit(
      'currentBranch',
      { cwd: repo, args: ['symbolic-ref', '--quiet', 'HEAD'] },
      exit =>
        exit.code === 0
          ? Option.some(shortBranch(exit.stdout.trim()))
          : exit.code === 1
            ? Option.some(Option.none<string>())
            : Option.none(),
    )
  })

  const changedFiles = Effect.fn('Git.changedFiles')(function* ({
    repo,
    branch,
    base,
  }: {
    readonly repo: string
    readonly branch: string
    readonly base: string
  }) {
    return yield* readExit(
      'changedFiles',
      {
        cwd: repo,
        args: [
          'diff',
          '--name-only',
          '-z',
          '--no-renames',
          '--no-relative',
          '--no-color',
          '--no-ext-diff',
          '--end-of-options',
          `${base}...${branch}`,
          '--',
        ],
      },
      exit =>
        exit.code === 0 ? Option.some(nulList(exit.stdout)) : Option.none(),
    )
  })

  const trackedFiles = Effect.fn('Git.trackedFiles')(function* ({
    repo,
    revision,
  }: {
    readonly repo: string
    readonly revision: string
  }) {
    return yield* readExit(
      'trackedFiles',
      {
        cwd: repo,
        args: [
          'ls-tree',
          '-r',
          '-z',
          '--name-only',
          '--full-tree',
          '--end-of-options',
          revision,
        ],
      },
      exit =>
        exit.code === 0 ? Option.some(nulList(exit.stdout)) : Option.none(),
    )
  })

  const worktrees = Effect.fn('Git.worktrees')(function* ({
    repo,
  }: {
    readonly repo: string
  }) {
    return yield* readExit(
      'worktrees',
      { cwd: repo, args: ['worktree', 'list', '--porcelain', '-z'] },
      exit => (exit.code === 0 ? parseWorktrees(exit.stdout) : Option.none()),
    )
  })

  /** The worktree's HEAD commit: "can't tell" when it names none, as on an unborn branch. */
  const headOf = (name: string, worktree: string) =>
    Effect.flatMap(hashOf(name, worktree, 'HEAD'), head =>
      Option.match(head, {
        onNone: () =>
          Effect.fail(
            new CantTell({ read: name, reason: 'HEAD names no commit' }),
          ),
        onSome: Effect.succeed,
      }),
    )

  /** Whether a rebase is in progress in the worktree: its state folder, from `--git-path`, exists. */
  const rebasing = (name: string, worktree: string) =>
    Effect.map(
      readExit(
        name,
        {
          cwd: worktree,
          args: [
            'rev-parse',
            '--git-path',
            'rebase-merge',
            '--git-path',
            'rebase-apply',
          ],
        },
        exit => {
          const folders = exit.stdout.split('\n').filter(line => line !== '')
          return exit.code === 0 && folders.length === 2
            ? Option.some(folders.map(folder => resolve(worktree, folder)))
            : Option.none()
        },
      ),
      folders => () => folders.some(folder => existsSync(folder)),
    )

  const unmerged = (worktree: string) =>
    readExit(
      'rebase',
      {
        cwd: worktree,
        args: [
          'diff',
          '--name-only',
          '-z',
          '--diff-filter=U',
          '--no-relative',
          '--no-color',
          '--no-ext-diff',
          '--',
        ],
      },
      exit =>
        exit.code === 0 ? Option.some(nulList(exit.stdout)) : Option.none(),
    )

  const rebase = Effect.fn('Git.rebase')(function* ({
    worktree,
    onto,
  }: {
    readonly worktree: string
    readonly onto: CommitHash
  }) {
    const [inProgress, from] = yield* Effect.all(
      [rebasing('rebase', worktree), headOf('rebase', worktree)],
      { concurrency: 'unbounded' },
    )
    if (inProgress()) return RebaseOutcome.AlreadyRebasing()
    const args = [
      'rebase',
      '--merge',
      '--no-update-refs',
      '--no-autostash',
      '--end-of-options',
      onto,
    ]
    const exit = yield* write({ cwd: worktree, args })
    if (exit.code === 0) {
      return RebaseOutcome.Rebased({
        from,
        head: yield* headOf('rebase', worktree),
      })
    }
    if (inProgress()) {
      return RebaseOutcome.Conflict({ files: yield* unmerged(worktree) })
    }
    return RebaseOutcome.Refused({
      message: exit.stderr.trim() || exit.stdout.trim(),
    })
  })

  const abortRebase = Effect.fn('Git.abortRebase')(function* ({
    worktree,
  }: {
    readonly worktree: string
  }) {
    const inProgress = yield* rebasing('abortRebase', worktree)
    if (!inProgress()) return AbortOutcome.NotRebasing()
    const args = ['rebase', '--abort']
    const exit = yield* write({ cwd: worktree, args })
    if (exit.code !== 0) return yield* unexpected(args, exit)
    return AbortOutcome.Aborted()
  })

  const fastForward = Effect.fn('Git.fastForward')(function* ({
    checkout,
    base,
    to,
  }: {
    readonly checkout: string
    readonly base: string
    readonly to: CommitHash
  }) {
    const [branch, from] = yield* Effect.all(
      [currentBranch({ repo: checkout }), headOf('fastForward', checkout)],
      { concurrency: 'unbounded' },
    )
    if (!Option.contains(branch, base)) {
      return FastForwardOutcome.OffBranch({ branch })
    }
    if (from === to) return FastForwardOutcome.FastForwarded({ from, to })
    const descends = yield* isAncestor('fastForward', {
      repo: checkout,
      ancestor: from,
      descendant: to,
    })
    if (!descends) return FastForwardOutcome.NotFastForward({ base: from })
    const exit = yield* write({
      cwd: checkout,
      args: [
        'merge',
        '--ff-only',
        '--no-autostash',
        '--no-stat',
        '--end-of-options',
        to,
      ],
    })
    if (exit.code !== 0) {
      return FastForwardOutcome.Refused({
        message: exit.stderr.trim() || exit.stdout.trim(),
      })
    }
    const head = yield* headOf('fastForward', checkout)
    return head === to
      ? FastForwardOutcome.FastForwarded({ from, to })
      : FastForwardOutcome.Refused({
          message: `Base is at ${head} after its fast-forward to ${to}`,
        })
  })

  /** A write that has one answer, exit 0; any other exit fails it. */
  const writeOnly = (command: {
    readonly cwd: string
    readonly args: ReadonlyArray<string>
  }) =>
    Effect.flatMap(write(command), exit =>
      exit.code === 0 ? Effect.void : unexpected(command.args, exit),
    )

  const addWorktree = Effect.fn('Git.addWorktree')(function* ({
    repo,
    path,
    branch,
    from,
  }: {
    readonly repo: string
    readonly path: string
    readonly branch: string
    readonly from: CommitHash
  }) {
    yield* writeOnly({
      cwd: repo,
      args: [
        'worktree',
        'add',
        '--no-track',
        '-b',
        branch,
        '--end-of-options',
        path,
        from,
      ],
    })
  })

  const addWorktreeOn = Effect.fn('Git.addWorktreeOn')(function* ({
    repo,
    path,
    branch,
  }: {
    readonly repo: string
    readonly path: string
    readonly branch: string
  }) {
    yield* writeOnly({
      cwd: repo,
      args: ['worktree', 'add', '--end-of-options', path, branch],
    })
  })

  const removeWorktree = Effect.fn('Git.removeWorktree')(function* ({
    repo,
    path,
  }: {
    readonly repo: string
    readonly path: string
  }) {
    yield* writeOnly({
      cwd: repo,
      args: ['worktree', 'remove', '--force', '--end-of-options', path],
    })
  })

  const pruneWorktrees = Effect.fn('Git.pruneWorktrees')(function* ({
    repo,
  }: {
    readonly repo: string
  }) {
    yield* writeOnly({ cwd: repo, args: ['worktree', 'prune'] })
  })

  const deleteBranch = Effect.fn('Git.deleteBranch')(function* ({
    repo,
    branch,
  }: {
    readonly repo: string
    readonly branch: string
  }) {
    yield* writeOnly({
      cwd: repo,
      args: ['branch', '-D', '--end-of-options', branch],
    })
  })

  return Git.of({
    version,
    status,
    isOnBase,
    mergeBase,
    commitHash,
    treeHash,
    currentBranch,
    changedFiles,
    trackedFiles,
    worktrees,
    rebase,
    abortRebase,
    fastForward,
    addWorktree,
    addWorktreeOn,
    removeWorktree,
    pruneWorktrees,
    deleteBranch,
  })
})

/** The git service over the process runner, with `config`'s time limit and retries. */
export const layer = (
  config: GitConfig = defaultConfig,
): Layer.Layer<Git, never, ProcessRunner> => Layer.effect(Git, make(config))
