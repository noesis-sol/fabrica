import { Data, Effect, Option, Ref } from 'effect'

import type { CommitHash, EngineId } from '@fabrica/contracts'

import {
  type CantTell,
  Git,
  GitFailed,
  PushOutcome,
  parseHash,
  parsePushed,
} from '../git'

// The tickets ref in git (spec §11.7): `refs/fabrica/tickets`, kept with git's plumbing only, so no
// checkout, index, `HEAD` or stash of the user's is ever touched. Trees are written with `mktree`
// (a temporary index would run `post-index-change`, and the runner never passes `GIT_INDEX_FILE`).
// Every command disables every hook (fab-35m): `core.hooksPath` the hook folder's, `hook.<name>.enabled`
// each hook git's configuration defines, as the git spike found `update-ref`, `fetch` and `push` run
// them. Transport names the ref on both sides, into a tracking ref outside `refs/remotes/`, and never
// forces a push.

/** The ref every engine keeps its copy of the backlog on. */
export const ticketsRef = 'refs/fabrica/tickets'

/** Where a fetch keeps what `remote` holds of the ref: out of any prune's reach. */
export const trackingRef = (remote: string): string =>
  `refs/fabrica/remotes/${remote}/tickets`

/** A commit's files: each path, with its blob's hash. */
export type Listing = ReadonlyMap<string, string>

/** The ref moved, or another process had moved it first and the cycle runs again. */
export type RefMove = Data.TaggedEnum<{
  Moved: {}
  Stale: {}
}>
export const RefMove = Data.taggedEnum<RefMove>()

/** What a fetch of the ref found. */
export type RefFetch = Data.TaggedEnum<{
  /** The remote holds the ref, at this commit. */
  Fetched: { readonly commit: CommitHash }
  /** The remote holds no such ref: nobody has pushed it yet. */
  Absent: {}
  /** Offline, or the credentials refused: `message` is git's, and sync waits for its next turn. */
  Unreachable: { readonly message: string }
}>
export const RefFetch = Data.taggedEnum<RefFetch>()

/** A file changed between two commits. */
export interface ChangedFile {
  readonly path: string
  /** Gone from the later commit. */
  readonly removed: boolean
}

/** How a git failure reaches sync: a read that still failed after its retries, or a write that didn't run. */
export type RefFailure = CantTell | GitFailed

const absentRef = /couldn't find remote ref/u

/** A commit as git gives it, or the command's failure when it gives something else. */
const commitOf = (
  command: string,
  text: string,
): Effect.Effect<CommitHash, GitFailed> =>
  Option.match(parseHash(text), {
    onNone: () =>
      Effect.fail(new GitFailed({ command, reason: `said ${text.trim()}` })),
    onSome: Effect.succeed,
  })

/** `ls-tree -r -z`'s records: `<mode> <type> <hash>\t<path>`. */
export const parseListing = (output: string): Listing =>
  new Map(
    output
      .split('\0')
      .filter(record => record !== '')
      .flatMap(record => {
        const tab = record.indexOf('\t')
        const hash = record.slice(0, tab).split(' ')[2]
        return hash === undefined
          ? []
          : ([[record.slice(tab + 1), hash]] as const)
      }),
  )

/** `diff-tree -r -z --name-status`'s fields: a status, then its path. */
export const parseChanged = (output: string): ReadonlyArray<ChangedFile> => {
  const fields = output.split('\0')
  const changed: Array<ChangedFile> = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const path = fields[index + 1]
    if (path !== undefined && path !== '')
      changed.push({ path, removed: fields[index] === 'D' })
  }
  return changed
}

/** `cat-file --batch`'s answers, each blob by its hash; a hash git hasn't is left out. */
export const parseBatch = (
  output: Uint8Array,
): ReadonlyMap<string, Uint8Array> => {
  const bytes = Buffer.from(output)
  const blobs = new Map<string, Uint8Array>()
  let at = 0
  while (at < bytes.length) {
    const end = bytes.indexOf(10, at)
    if (end === -1) break
    const [hash = '', type = '', size = ''] = bytes
      .subarray(at, end)
      .toString('utf8')
      .split(' ')
    if (type === 'missing' || size === '') {
      at = end + 1
    } else {
      const start = end + 1
      const length = Number(size)
      blobs.set(hash, bytes.subarray(start, start + length))
      at = start + length + 1
    }
  }
  return blobs
}

/** One folder of a tree to write: its files by path relative to it. */
const folders = (
  files: ReadonlyArray<readonly [string, string]>,
): {
  readonly here: ReadonlyArray<readonly [string, string]>
  readonly below: ReadonlyMap<string, ReadonlyArray<readonly [string, string]>>
} => {
  const here: Array<readonly [string, string]> = []
  const below = new Map<string, Array<readonly [string, string]>>()
  for (const [path, hash] of files) {
    const slash = path.indexOf('/')
    if (slash === -1) here.push([path, hash])
    else {
      const name = path.slice(0, slash)
      const rest: readonly [string, string] = [path.slice(slash + 1), hash]
      below.set(name, [...(below.get(name) ?? []), rest])
    }
  }
  return { here, below }
}

/** The plumbing of the tickets ref in the repository holding `repo`. */
export const makeTicketsStore = Effect.fn('TicketsStore.make')(function* ({
  repo,
}: {
  readonly repo: string
}) {
  const { commands } = yield* Git
  const { read, query, write, piped, network, unexpected } = commands
  const hooksOff = yield* Ref.make<ReadonlyArray<string>>([
    '-c',
    'core.hooksPath=/dev/null',
  ])

  /** The arguments that turn every hook off, for a command. */
  const quiet = (args: ReadonlyArray<string>) =>
    Effect.map(Ref.get(hooksOff), off => ({
      cwd: repo,
      args: [...off, ...args],
    }))

  /** Reads which hooks git's configuration defines, so that each is turned off: once a cycle. */
  const refreshHooks = read(
    'tickets.hooks',
    Effect.gen(function* () {
      const args = [
        'config',
        '--name-only',
        '--get-regexp',
        '^hook\\..*\\.command$',
      ]
      const exit = yield* query({ cwd: repo, args })
      // 1: no such key.
      if (exit.code !== 0 && exit.code !== 1)
        return yield* unexpected(args, exit)
      const named = exit.stdout
        .split('\n')
        .filter(line => line !== '')
        .flatMap(key => [
          '-c',
          `${key.slice(0, -'.command'.length)}.enabled=false`,
        ])
      yield* Ref.set(hooksOff, ['-c', 'core.hooksPath=/dev/null', ...named])
    }),
  ).pipe(Effect.withSpan('TicketsStore.refreshHooks'))

  /** The commit `ref` is at; none where there is no such ref. */
  const resolve = Effect.fn('TicketsStore.resolve')(function* (ref: string) {
    const args = ['rev-parse', '--quiet', '--verify', `${ref}^{commit}`]
    return yield* read(
      'tickets.resolve',
      Effect.gen(function* () {
        const exit = yield* query(yield* quiet(args))
        return exit.code === 0
          ? Option.some(yield* commitOf(args.join(' '), exit.stdout))
          : exit.code === 1
            ? Option.none<CommitHash>()
            : yield* unexpected(args, exit)
      }),
    )
  })

  const head = resolve(ticketsRef)

  /** Every file of a commit. */
  const list = Effect.fn('TicketsStore.list')(function* (commit: CommitHash) {
    const args = [
      'ls-tree',
      '-r',
      '-z',
      '--full-tree',
      '--end-of-options',
      commit,
    ]
    return yield* read(
      'tickets.list',
      Effect.gen(function* () {
        const exit = yield* query(yield* quiet(args))
        return exit.code === 0
          ? parseListing(exit.stdout)
          : yield* unexpected(args, exit)
      }),
    )
  })

  /** The files that differ between two commits. */
  const changedBetween = Effect.fn('TicketsStore.changedBetween')(function* (
    from: CommitHash,
    to: CommitHash,
  ) {
    const args = [
      'diff-tree',
      '-r',
      '-z',
      '--no-renames',
      '--name-status',
      '--end-of-options',
      from,
      to,
    ]
    return yield* read(
      'tickets.changed',
      Effect.gen(function* () {
        const exit = yield* query(yield* quiet(args))
        return exit.code === 0
          ? parseChanged(exit.stdout)
          : yield* unexpected(args, exit)
      }),
    )
  })

  /** The base of a merge of two commits; none where they share no history. */
  const mergeBase = Effect.fn('TicketsStore.mergeBase')(function* (
    a: CommitHash,
    b: CommitHash,
  ) {
    const args = ['merge-base', '--end-of-options', a, b]
    return yield* read(
      'tickets.mergeBase',
      Effect.gen(function* () {
        const exit = yield* query(yield* quiet(args))
        return exit.code === 0
          ? Option.some(yield* commitOf(args.join(' '), exit.stdout))
          : exit.code === 1
            ? Option.none<CommitHash>()
            : yield* unexpected(args, exit)
      }),
    )
  })

  /** Whether `commit` is in `descendant`'s history. */
  const isAncestor = Effect.fn('TicketsStore.isAncestor')(function* (
    commit: CommitHash,
    descendant: CommitHash,
  ) {
    return Option.exists(
      yield* mergeBase(commit, descendant),
      base => base === commit,
    )
  })

  /** Reads the blobs in one process; each by its hash, one git hasn't left out. */
  const readBlobs = Effect.fn('TicketsStore.readBlobs')(function* (
    hashes: Iterable<string>,
  ) {
    const unique = [...new Set(hashes)]
    if (unique.length === 0) return new Map<string, Uint8Array>()
    const args = ['cat-file', '--batch']
    const exit = yield* piped(
      yield* quiet(args),
      unique.map(hash => `${hash}\n`).join(''),
    )
    return exit.code === 0
      ? parseBatch(exit.stdout)
      : yield* unexpected(args, {
          code: exit.code,
          stdout: '',
          stderr: exit.stderr,
        })
  })

  const pipedLine = (args: ReadonlyArray<string>, input: string) =>
    Effect.gen(function* () {
      const exit = yield* piped(yield* quiet(args), input)
      return exit.code === 0
        ? Buffer.from(exit.stdout).toString('utf8').trim()
        : yield* unexpected(args, {
            code: exit.code,
            stdout: '',
            stderr: exit.stderr,
          })
    })

  /** Writes a file's text as a blob; its hash. */
  const writeBlob = Effect.fn('TicketsStore.writeBlob')((text: string) =>
    pipedLine(['hash-object', '-w', '--stdin', '--no-filters'], text),
  )

  /** Writes the files as a tree, a `mktree` for each folder and then the root; its hash. */
  const writeTree = Effect.fn('TicketsStore.writeTree')(function* (
    listing: Listing,
  ) {
    const folder = (
      files: ReadonlyArray<readonly [string, string]>,
    ): Effect.Effect<string, RefFailure> =>
      Effect.gen(function* () {
        const { here, below } = folders(files)
        const trees: Array<string> = []
        for (const [name, inside] of below)
          trees.push(`040000 tree ${yield* folder(inside)}\t${name}\0`)
        const blobs = here.map(
          ([name, hash]) => `100644 blob ${hash}\t${name}\0`,
        )
        return yield* pipedLine(['mktree', '-z'], [...blobs, ...trees].join(''))
      })
    return yield* folder([...listing])
  })

  /** Writes a commit of the tree, its author and committer the engine, whatever the host's identity. */
  const commitTree = Effect.fn('TicketsStore.commitTree')(function* ({
    tree,
    parents,
    message,
    engine,
  }: {
    readonly tree: string
    readonly parents: ReadonlyArray<CommitHash>
    readonly message: string
    readonly engine: EngineId
  }) {
    const email = `${engine}@engines.fabrica.invalid`
    const args = [
      '-c',
      `author.name=${engine}`,
      '-c',
      `author.email=${email}`,
      '-c',
      `committer.name=${engine}`,
      '-c',
      `committer.email=${email}`,
      'commit-tree',
      tree,
      ...parents.flatMap(parent => ['-p', parent]),
      '-m',
      message,
    ]
    const exit = yield* write(yield* quiet(args))
    return exit.code === 0
      ? yield* commitOf(args.join(' '), exit.stdout)
      : yield* unexpected(args, exit)
  })

  /**
   * Moves the ref to `to` if it is still at `expected` (none: if there is no such ref). A refusal with
   * the ref elsewhere is `Stale`, and the cycle runs again; any other is the command's failure.
   */
  const moveRef = Effect.fn('TicketsStore.moveRef')(function* ({
    to,
    expected,
  }: {
    readonly to: CommitHash
    readonly expected: Option.Option<CommitHash>
  }) {
    const args = [
      'update-ref',
      ticketsRef,
      to,
      Option.getOrElse(expected, () => ''),
    ]
    const exit = yield* write(yield* quiet(args))
    if (exit.code === 0) return RefMove.Moved()
    const now = yield* head
    return Option.getOrUndefined(now) === Option.getOrUndefined(expected)
      ? yield* unexpected(args, exit)
      : RefMove.Stale()
  })

  /** Fetches the ref into its tracking ref, with the host's own git configuration and credentials. */
  const fetch = Effect.fn('TicketsStore.fetch')(function* (remote: string) {
    const tracking = trackingRef(remote)
    const exit = yield* network(
      yield* quiet([
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-recurse-submodules',
        '--no-write-fetch-head',
        '--end-of-options',
        remote,
        `+${ticketsRef}:${tracking}`,
      ]),
    )
    if (exit.code !== 0) {
      const message = exit.stderr.trim() || `git fetch exited ${exit.code}`
      return absentRef.test(message)
        ? RefFetch.Absent()
        : RefFetch.Unreachable({ message })
    }
    return Option.match(yield* resolve(tracking), {
      onNone: () => RefFetch.Absent(),
      onSome: commit => RefFetch.Fetched({ commit }),
    })
  })

  /** Pushes the commit to the remote's ref, never forced: a push that isn't a fast-forward isn't made. */
  const push = Effect.fn('TicketsStore.push')(function* ({
    remote,
    commit,
  }: {
    readonly remote: string
    readonly commit: CommitHash
  }) {
    const exit = yield* network(
      yield* quiet([
        'push',
        '--porcelain',
        '--no-follow-tags',
        '--end-of-options',
        remote,
        `${commit}:${ticketsRef}`,
      ]),
    )
    return Option.getOrElse(parsePushed(exit.stdout, ticketsRef), () =>
      PushOutcome.Failed({
        message:
          exit.stderr.trim() ||
          exit.stdout.trim() ||
          `git push exited ${exit.code}`,
      }),
    )
  })

  /** Where `remote` points, to name it to the maintainer; its name, where git can't say. */
  const remoteUrl = Effect.fn('TicketsStore.remoteUrl')(function* (
    remote: string,
  ) {
    const exit = yield* query(
      yield* quiet(['remote', 'get-url', '--end-of-options', remote]),
    )
    return exit.code === 0 ? exit.stdout.trim() || remote : remote
  })

  return {
    refreshHooks,
    head,
    resolve,
    list,
    changedBetween,
    mergeBase,
    isAncestor,
    readBlobs,
    writeBlob,
    writeTree,
    commitTree,
    moveRef,
    fetch,
    push,
    remoteUrl,
  }
})

export type TicketsStore = Effect.Success<ReturnType<typeof makeTicketsStore>>
