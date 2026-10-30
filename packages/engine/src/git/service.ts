import { Context, Effect, Layer, Option } from 'effect'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { CommitHash, FileDiff, TreeHash } from '@fabrica/contracts'

import { CommandOutcome, ProcessRunner, StartFailure } from '../process'
import {
  type GitCommand,
  type GitConfig,
  defaultConfig,
  makeCommands,
} from './command'
import { CantTell, GitFailed } from './errors'
import {
  AbortOutcome,
  CloneOutcome,
  FastForwardOutcome,
  GitVersion,
  RebaseOutcome,
} from './outcomes'
import {
  CHECK_ATTR_SOURCE_GIT,
  type CheckoutPlace,
  MINIMUM_GIT,
  type WorktreeEntry,
  type WorktreeStatus,
  gitAtLeast,
  nulList,
  parseCheckAttr,
  parseCheckoutPlace,
  parseDiff,
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
  /**
   * The tree of the worktree as it is: HEAD's, with its uncommitted and untracked files (those its
   * ignore rules leave out stay out), the tree a commit of everything would have (spec §13.6, H89).
   * It is written through an index of the engine's own, so the worktree's index is never changed;
   * one read at a time per worktree, as they share that index's folder.
   */
  readonly worktreeTree: (input: {
    readonly worktree: string
  }) => Effect.Effect<TreeHash, CantTell>
  /**
   * The path of `name` in the worktree's own git folder (`--git-path`): where the engine keeps what it
   * records of one worktree, across runs, out of its files, and removed with it.
   */
  readonly ownPath: (input: {
    readonly worktree: string
    readonly name: string
  }) => Effect.Effect<string, CantTell>
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
  /**
   * The changes from the commit `from` to the commit `to`, one patch per file, renames found; git's
   * own diff, whatever the repository's configuration asks (no external diff, no text conversion).
   */
  readonly diff: (input: {
    readonly repo: string
    readonly from: CommitHash
    readonly to: CommitHash
  }) => Effect.Effect<ReadonlyArray<FileDiff>, CantTell>
  /** The files tracked at `revision`, as paths from the repository's root. */
  readonly trackedFiles: (input: {
    readonly repo: string
    readonly revision: string
  }) => Effect.Effect<ReadonlyArray<string>, CantTell>
  /**
   * The files tracked at `revision` that git merges by union, their `merge` attribute `union`
   * (`merge=union` in `.gitattributes`), as paths from the repository's root (spec §13.4). The
   * attributes are `revision`'s own where git reads them from a tree (2.40, `check-attr --source`);
   * an older git reads them as they are checked out in `repo`'s worktree.
   */
  readonly unionMerged: (input: {
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
  /** Whether a rebase is in progress in the worktree. */
  readonly isRebasing: (input: {
    readonly worktree: string
  }) => Effect.Effect<boolean, CantTell>
  /** Puts the worktree's branch, index and files back at the commit `to`, dropping what moved them since. */
  readonly resetTo: (input: {
    readonly worktree: string
    readonly to: CommitHash
  }) => Effect.Effect<void, GitFailed>
  /** Points the ref `ref` (a full name, `refs/fabrica/…`) at the commit `commit`, so that git keeps it. */
  readonly keepCommit: (input: {
    readonly repo: string
    readonly ref: string
    readonly commit: CommitHash
  }) => Effect.Effect<void, GitFailed>
  /**
   * Removes the untracked `files` (paths from the worktree's root, as its status names them) from the
   * worktree, never a tracked file: one named that git tracks, or that is gone, is left as it is.
   */
  readonly removeUntracked: (input: {
    readonly worktree: string
    readonly files: ReadonlyArray<string>
  }) => Effect.Effect<void, GitFailed>
  /**
   * Puts the tracked `files` (paths from the worktree's root, as its status names them) back as HEAD has
   * them, in the index and the worktree: one HEAD doesn't have is taken out of both, and one named that
   * git doesn't track is left as it is.
   */
  readonly restoreTracked: (input: {
    readonly worktree: string
    readonly files: ReadonlyArray<string>
  }) => Effect.Effect<void, CantTell | GitFailed>
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
  /** The checkout `folder` is in (spec §10.1); none where it is in none: outside a repository, or in a bare one. */
  readonly checkoutOf: (input: {
    readonly folder: string
  }) => Effect.Effect<Option.Option<CheckoutPlace>, CantTell>
  /**
   * Clones `url` into the new folder `into`, with the host's git credentials (spec §10.1): its git
   * configuration, credential helpers, keys and ssh-agent.
   */
  readonly clone: (input: {
    readonly url: string
    readonly into: string
  }) => Effect.Effect<CloneOutcome, GitFailed>
}

export class Git extends Context.Service<Git, GitShape>()(
  '@fabrica/engine/Git',
) {}

const MINIMUM = `${MINIMUM_GIT.major}.${MINIMUM_GIT.minor}`

/** The most bytes of paths one command takes as arguments, well under any system's limit. */
const ARGUMENT_BYTES = 64 * 1024

/** `paths` in batches of at most `ARGUMENT_BYTES` each, one command's arguments a batch. */
const argumentBatches = (
  paths: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const batches: Array<Array<string>> = []
  let bytes = ARGUMENT_BYTES
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1
    const last = batches.at(-1)
    if (last === undefined || bytes + size > ARGUMENT_BYTES) {
      batches.push([path])
      bytes = size
    } else {
      last.push(path)
      bytes += size
    }
  }
  return batches
}

export const make = Effect.fn('Git.make')(function* (config: GitConfig) {
  const runner = yield* ProcessRunner
  const { write, network, query, queryOutcome, read, unexpected } =
    makeCommands({
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

  /** Runs `command` in a read, failing the attempt on any exit but 0. */
  const queryOnly = (command: GitCommand) =>
    Effect.flatMap(query(command), exit =>
      exit.code === 0 ? Effect.succeed(exit) : unexpected(command.args, exit),
    )

  const worktreeTree = Effect.fn('Git.worktreeTree')(function* ({
    worktree,
  }: {
    readonly worktree: string
  }) {
    const head = yield* headOf('worktreeTree', worktree)
    const attempt = Effect.gen(function* () {
      const folders = yield* queryOnly({
        cwd: worktree,
        args: ['rev-parse', '--absolute-git-dir', '--git-common-dir'],
      })
      const [own, common] = folders.stdout
        .split('\n')
        .filter(line => line !== '')
        .map(folder => resolve(worktree, folder))
      if (own === undefined || common === undefined)
        return yield* unexpected(['rev-parse', '--absolute-git-dir'], folders)
      // A git folder of the engine's own beside the worktree's, sharing its repository through
      // `commondir` (its objects, configuration and ignore rules) but holding an index of its own,
      // started from a copy of the worktree's: that keeps the files tracked though ignored, and what
      // git knows of each file's state. Git's local variables never reach a command (H85), so the
      // folder is named by `--git-dir`.
      const tree = join(own, 'fabrica-tree')
      const inTree = (args: ReadonlyArray<string>) =>
        queryOnly({
          cwd: worktree,
          args: ['--git-dir', tree, '--work-tree', worktree, ...args],
        })
      const prepared = Effect.tryPromise({
        try: async () => {
          await rm(tree, { recursive: true, force: true })
          await mkdir(tree)
          await writeFile(join(tree, 'commondir'), `${common}\n`)
          await writeFile(join(tree, 'HEAD'), `${head}\n`)
          const index = join(own, 'index')
          if (!existsSync(index)) return false
          // The copy keeps the index's times: git takes an entry whose file changed in the second
          // the index was written as racily clean, and checks its content, by the index file's
          // mtime; a copy newer than such an edit would have a same-size one taken as unchanged.
          const times = await stat(index)
          await copyFile(index, join(tree, 'index'))
          await utimes(join(tree, 'index'), times.atime, times.mtime)
          return true
        },
        catch: cause =>
          new GitFailed({
            command: `preparing ${tree}`,
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      })
      const written = yield* Effect.gen(function* () {
        if (!(yield* prepared)) yield* inTree(['read-tree', head])
        yield* inTree(['add', '--all', '--', ':/'])
        return yield* inTree(['write-tree'])
      }).pipe(
        Effect.ensuring(
          Effect.ignore(
            Effect.tryPromise(() => rm(tree, { recursive: true, force: true })),
          ),
        ),
      )
      return yield* Option.match(parseTreeHash(written.stdout), {
        onNone: () => unexpected(['write-tree'], written),
        onSome: Effect.succeed,
      })
    })
    return yield* read('worktreeTree', attempt)
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

  const diff = Effect.fn('Git.diff')(function* ({
    repo,
    from,
    to,
  }: {
    readonly repo: string
    readonly from: CommitHash
    readonly to: CommitHash
  }) {
    return yield* readExit(
      'diff',
      {
        cwd: repo,
        args: [
          'diff',
          '--raw',
          '-z',
          '--patch',
          '--find-renames',
          '--no-relative',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '--submodule=short',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          '--end-of-options',
          from,
          to,
          '--',
        ],
      },
      exit => (exit.code === 0 ? parseDiff(exit.stdout) : Option.none()),
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

  /** The top folder of `repo`'s worktree, where `check-attr` reads paths from the repository's root. */
  const topOf = (name: string, repo: string) =>
    readExit(name, { cwd: repo, args: ['rev-parse', '--show-cdup'] }, exit =>
      exit.code === 0
        ? Option.some(resolve(repo, exit.stdout.trim()))
        : Option.none(),
    )

  const unionMerged = Effect.fn('Git.unionMerged')(function* ({
    repo,
    revision,
  }: {
    readonly repo: string
    readonly revision: string
  }) {
    const [files, top, git] = yield* Effect.all(
      [trackedFiles({ repo, revision }), topOf('unionMerged', repo), version],
      { concurrency: 'unbounded' },
    )
    const source =
      GitVersion.$is('Supported')(git) &&
      gitAtLeast(git.version, CHECK_ATTR_SOURCE_GIT)
        ? [`--source=${revision}`]
        : []
    const unioned = yield* Effect.forEach(argumentBatches(files), paths =>
      readExit(
        'unionMerged',
        {
          cwd: top,
          args: ['check-attr', '-z', ...source, 'merge', '--', ...paths],
        },
        exit =>
          exit.code === 0
            ? Option.map(parseCheckAttr(exit.stdout, 'merge'), values =>
                values.flatMap(({ path, value }) =>
                  value === 'union' ? [path] : [],
                ),
              )
            : Option.none(),
      ),
    )
    return unioned.flat()
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

  const ownPath = Effect.fn('Git.ownPath')(function* ({
    worktree,
    name,
  }: {
    readonly worktree: string
    readonly name: string
  }) {
    return yield* readExit(
      'ownPath',
      { cwd: worktree, args: ['rev-parse', '--git-path', name] },
      exit => {
        const [path, ...rest] = exit.stdout
          .split('\n')
          .filter(line => line !== '')
        return exit.code === 0 && path !== undefined && rest.length === 0
          ? Option.some(resolve(worktree, path))
          : Option.none()
      },
    )
  })

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

  const isRebasing = Effect.fn('Git.isRebasing')(function* ({
    worktree,
  }: {
    readonly worktree: string
  }) {
    const inProgress = yield* rebasing('isRebasing', worktree)
    return inProgress()
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

  const resetTo = Effect.fn('Git.resetTo')(function* ({
    worktree,
    to,
  }: {
    readonly worktree: string
    readonly to: CommitHash
  }) {
    yield* writeOnly({
      cwd: worktree,
      args: ['reset', '--hard', '--quiet', '--end-of-options', to, '--'],
    })
  })

  const keepCommit = Effect.fn('Git.keepCommit')(function* ({
    repo,
    ref,
    commit,
  }: {
    readonly repo: string
    readonly ref: string
    readonly commit: CommitHash
  }) {
    yield* writeOnly({ cwd: repo, args: ['update-ref', '--', ref, commit] })
  })

  const removeUntracked = Effect.fn('Git.removeUntracked')(function* ({
    worktree,
    files,
  }: {
    readonly worktree: string
    readonly files: ReadonlyArray<string>
  }) {
    // Literal pathspecs: a file named `*.png` removes that file, never every match.
    yield* Effect.forEach(
      argumentBatches(files),
      paths =>
        writeOnly({
          cwd: worktree,
          args: ['--literal-pathspecs', 'clean', '-f', '-q', '--', ...paths],
        }),
      { discard: true },
    )
  })

  const restoreTracked = Effect.fn('Git.restoreTracked')(function* ({
    worktree,
    files,
  }: {
    readonly worktree: string
    readonly files: ReadonlyArray<string>
  }) {
    const named = new Set(files)
    const listed = (args: ReadonlyArray<string>) =>
      readExit('restoreTracked', { cwd: worktree, args }, exit =>
        exit.code === 0 ? Option.some(nulList(exit.stdout)) : Option.none(),
      )
    yield* Effect.forEach(
      argumentBatches(files),
      paths =>
        Effect.gen(function* () {
          // Restore refuses a path neither HEAD nor the index has: only those either has are named to it.
          const [indexed, committed] = yield* Effect.all(
            [
              listed(['--literal-pathspecs', 'ls-files', '-z', '--', ...paths]),
              listed([
                '--literal-pathspecs',
                'ls-tree',
                '-r',
                '-z',
                '--name-only',
                'HEAD',
                '--',
                ...paths,
              ]),
            ],
            { concurrency: 'unbounded' },
          )
          const tracked = [...new Set([...indexed, ...committed])].filter(
            file => named.has(file),
          )
          if (tracked.length === 0) return
          // Literal pathspecs: a file named `*.ts` puts back that file, never every match.
          yield* writeOnly({
            cwd: worktree,
            args: [
              '--literal-pathspecs',
              'restore',
              '--source=HEAD',
              '--staged',
              '--worktree',
              '--quiet',
              '--',
              ...tracked,
            ],
          })
        }),
      { discard: true },
    )
  })

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

  const checkoutOf = Effect.fn('Git.checkoutOf')(function* ({
    folder,
  }: {
    readonly folder: string
  }) {
    const command = {
      cwd: folder,
      args: [
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-dir',
        '--git-common-dir',
      ],
    }
    return yield* readExit('checkoutOf', command, exit =>
      exit.code === 0
        ? Option.map(parseCheckoutPlace(exit.stdout), Option.some)
        : // 128: not in a repository, or in one with no worktree (a bare one).
          exit.code === 128
          ? Option.some(Option.none<CheckoutPlace>())
          : Option.none(),
    )
  })

  const clone = Effect.fn('Git.clone')(function* ({
    url,
    into,
  }: {
    readonly url: string
    readonly into: string
  }) {
    const exit = yield* network({
      cwd: dirname(into),
      args: ['clone', '--quiet', '--', url, into],
    })
    return exit.code === 0
      ? CloneOutcome.Cloned()
      : CloneOutcome.Refused({
          message: exit.stderr.trim() || `git clone exited ${exit.code}`,
        })
  })

  return Git.of({
    version,
    status,
    isOnBase,
    mergeBase,
    commitHash,
    treeHash,
    worktreeTree,
    ownPath,
    currentBranch,
    changedFiles,
    diff,
    trackedFiles,
    unionMerged,
    worktrees,
    rebase,
    abortRebase,
    isRebasing,
    resetTo,
    keepCommit,
    removeUntracked,
    restoreTracked,
    fastForward,
    addWorktree,
    addWorktreeOn,
    removeWorktree,
    pruneWorktrees,
    deleteBranch,
    checkoutOf,
    clone,
  })
})

/** The git service over the process runner, with `config`'s time limit and retries. */
export const layer = (
  config: GitConfig = defaultConfig,
): Layer.Layer<Git, never, ProcessRunner> => Layer.effect(Git, make(config))
