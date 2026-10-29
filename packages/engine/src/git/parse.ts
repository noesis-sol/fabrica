import { Option } from 'effect'

import { CommitHash, FileChange, FileDiff, TreeHash } from '@fabrica/contracts'

// How git's output is read: the one place each of its formats is parsed. Every format read is one git
// keeps stable for scripts (`-z`, `--porcelain`), under `LC_ALL=C`.

/** A worktree's files that aren't committed (spec §13.7). */
export interface WorktreeStatus {
  /** Tracked files changed, staged or not, deleted, or unmerged. */
  readonly uncommitted: ReadonlyArray<string>
  /** Files git doesn't track and doesn't ignore. */
  readonly untracked: ReadonlyArray<string>
}

/** Whether a status has nothing uncommitted and nothing untracked. */
export const isClean = (status: WorktreeStatus): boolean =>
  status.uncommitted.length === 0 && status.untracked.length === 0

/** The entries of a NUL-terminated list (`-z`), none for empty output. */
export const nulList = (output: string): ReadonlyArray<string> =>
  output.split('\0').filter(entry => entry !== '')

/**
 * `git status --porcelain=v1 -z --no-renames`: each entry `XY <path>`, `??` for an untracked file;
 * without renames no entry has a second path. Output in another shape is none.
 */
export const parseStatus = (output: string): Option.Option<WorktreeStatus> => {
  const uncommitted: Array<string> = []
  const untracked: Array<string> = []
  for (const entry of nulList(output)) {
    if (entry.length < 4 || entry[2] !== ' ') return Option.none()
    const path = entry.slice(3)
    if (entry.startsWith('??')) untracked.push(path)
    else uncommitted.push(path)
  }
  return Option.some({ uncommitted, untracked })
}

/** One line's commit hash, as `rev-parse` and `merge-base` print it. */
export const parseHash = (output: string): Option.Option<CommitHash> =>
  CommitHash.makeOption(output.trim())

/** One line's tree hash, as `rev-parse <revision>^{tree}` prints it. */
export const parseTreeHash = (output: string): Option.Option<TreeHash> =>
  TreeHash.makeOption(output.trim())

/** How each of `git diff --raw`'s statuses changed a file; any other (a copy, an unmerged path) is none. */
const rawChanges: Readonly<Record<string, FileChange>> = {
  A: 'added',
  M: 'modified',
  // A type change (a file made a link) is a modification of its path, its patch git's two.
  T: 'modified',
  D: 'deleted',
  R: 'renamed',
}

/** Where a file's patch begins in `git diff -p`: no line of a patch's body starts so. */
const PATCH_START = 'diff --git '

/**
 * `git diff --raw -z -p`: the raw entries, each `:<modes> <hashes> <status>` and its path (a rename's
 * two), every field NUL-terminated, a NUL after the last, then one patch per entry in the same order.
 * Paths are taken from the raw entries, as git wrote them; the patches' headers quote theirs. Output in
 * another shape is none.
 */
export const parseDiff = (
  output: string,
): Option.Option<ReadonlyArray<FileDiff>> => {
  const entries: Array<{
    readonly change: FileChange
    readonly path: string
    readonly from: Option.Option<string>
    readonly typeChange: boolean
  }> = []
  let at = 0
  /** The field from `at` to its NUL, `at` moved past it; none where no NUL ends it. */
  const field = (): Option.Option<string> => {
    const end = output.indexOf('\0', at)
    if (end === -1) return Option.none()
    const value = output.slice(at, end)
    at = end + 1
    return Option.some(value)
  }
  while (output.startsWith(':', at)) {
    const header = field()
    if (Option.isNone(header)) return Option.none()
    const status = header.value.split(' ')[4]?.charAt(0) ?? ''
    const change = rawChanges[status]
    if (change === undefined) return Option.none()
    const first = field()
    if (Option.isNone(first)) return Option.none()
    if (change === 'renamed') {
      const to = field()
      if (Option.isNone(to)) return Option.none()
      entries.push({ change, path: to.value, from: first, typeChange: false })
    } else
      entries.push({
        change,
        path: first.value,
        from: Option.none(),
        typeChange: status === 'T',
      })
  }
  const patches = output.slice(output.startsWith('\0', at) ? at + 1 : at)
  if (entries.length === 0)
    return patches === '' ? Option.some([]) : Option.none()
  if (!patches.startsWith(PATCH_START)) return Option.none()
  const starts = [0]
  for (
    let next = patches.indexOf(`\n${PATCH_START}`);
    next !== -1;
    next = patches.indexOf(`\n${PATCH_START}`, next + 1)
  )
    starts.push(next + 1)
  // A type change is written as two patches, its old file's deletion and its new file's addition: its
  // entry takes both.
  const ends: Array<number> = []
  for (const entry of entries)
    ends.push((ends.at(-1) ?? 0) + (entry.typeChange ? 2 : 1))
  if (ends.at(-1) !== starts.length) return Option.none()
  return Option.all(
    entries.map(({ typeChange: _, ...entry }, index) =>
      FileDiff.makeOption({
        ...entry,
        patch: patches.slice(
          starts[ends[index - 1] ?? 0],
          starts[ends[index] ?? starts.length],
        ),
      }),
    ),
  )
}

/** One worktree of a repository, as `git worktree list --porcelain -z` gives it. */
export interface WorktreeEntry {
  readonly path: string
  /** Its HEAD's commit: none for a bare repository or an unborn branch. */
  readonly head: Option.Option<CommitHash>
  /** The branch checked out, its short name: none for a detached HEAD or a bare repository. */
  readonly branch: Option.Option<string>
  readonly bare: boolean
  readonly locked: boolean
  /** Its folder is gone: `git worktree prune` would drop it. */
  readonly prunable: boolean
}

const HEADS = 'refs/heads/'

/** A branch's short name from its full ref, none for a ref outside `refs/heads/`. */
export const shortBranch = (ref: string): Option.Option<string> =>
  ref.startsWith(HEADS) ? Option.some(ref.slice(HEADS.length)) : Option.none()

/**
 * `git worktree list --porcelain -z`: records of NUL-terminated lines, each record ended by an empty
 * line; a record's first line is `worktree <path>`. Output in another shape is none.
 */
export const parseWorktrees = (
  output: string,
): Option.Option<ReadonlyArray<WorktreeEntry>> => {
  const entries: Array<WorktreeEntry> = []
  const records = output.split('\0\0').filter(record => record !== '')
  for (const record of records) {
    const [first, ...lines] = record.split('\0').filter(line => line !== '')
    if (first === undefined || !first.startsWith('worktree ')) {
      return Option.none()
    }
    let head = Option.none<CommitHash>()
    let branch = Option.none<string>()
    let bare = false
    let locked = false
    let prunable = false
    for (const line of lines) {
      const [key = '', ...rest] = line.split(' ')
      const value = rest.join(' ')
      if (key === 'HEAD') head = CommitHash.makeOption(value)
      else if (key === 'branch') branch = shortBranch(value)
      else if (key === 'bare') bare = true
      else if (key === 'locked') locked = true
      else if (key === 'prunable') prunable = true
    }
    entries.push({
      path: first.slice('worktree '.length),
      head,
      branch,
      bare,
      locked,
      prunable,
    })
  }
  return Option.some(entries)
}

/** The oldest git the engine runs (spec §13.1, H85): `worktree list -z`, `merge-tree --write-tree`. */
export const MINIMUM_GIT = { major: 2, minor: 38 } as const

/** `git version`'s answer: its version, and whether it is `MINIMUM_GIT` or later; none when it isn't one. */
export const parseGitVersion = (
  output: string,
): Option.Option<{ readonly version: string; readonly supported: boolean }> => {
  const match = /^git version ((\d+)\.(\d+)\S*)/u.exec(output.trim())
  if (match === null) return Option.none()
  const [, version = '', major = '', minor = ''] = match
  const [majorNumber, minorNumber] = [Number(major), Number(minor)]
  const supported =
    majorNumber > MINIMUM_GIT.major ||
    (majorNumber === MINIMUM_GIT.major && minorNumber >= MINIMUM_GIT.minor)
  return Option.some({ version, supported })
}
