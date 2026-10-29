import { Data, Effect } from 'effect'
import { lstat, mkdir } from 'node:fs/promises'
import * as NodePath from 'node:path'

import type { ProjectId } from '@fabrica/contracts'

import { readFileText, writeFileWhole } from '../files'
import { type WorktreeHome, besideCheckout, inFolder } from '../git'

// A project's files (spec §7.2, §10.2): the `.fabrica/` folder of its checkout, what of it is
// committed and what its ignore rules keep out of git, and where the engine keeps a cloned project.
// The ignored files are kept out through the repository's `info/exclude` as the project is added:
// it is shared by every worktree and never committed, so the work graph the engine opens at once
// never shows as an untracked file, on Base or on a branch cut before `init` committed
// `.fabrica/.gitignore`, which holds the same entries for every clone.

/** The project's own folder, below its checkout. */
export const fabricaFolder = '.fabrica'

/** Committed: the project's own worker rules, added to the standing rules (§12.4). */
export const workerRulesPath = '.fabrica/worker-rules.md'

/** Committed: specs from outside the repository, copied in by spec runs (§15.5). */
export const specsFolder = '.fabrica/specs'

/** Ignored: the work graph's SQLite store (§11.2). */
export const workGraphPath = '.fabrica/work.db'

/** `.fabrica/.gitignore`, which `init` commits. */
export const fabricaIgnorePath = '.fabrica/.gitignore'

/**
 * The ignored files, as `.fabrica/.gitignore` names them: the work graph with its journal and its
 * backups (`work.db-wal`, `work.db.v1.backup`), the run's files, the reports and the human log.
 */
const ignoredInFolder = ['work.db*', 'run/', 'reports/', 'fabrica.log']

/** `.fabrica/.gitignore`'s text, which `init` writes. */
export const fabricaIgnoreText = `# Fabrica's files that aren't committed: the work graph, the run's files, the reports and the log.\n${ignoredInFolder.join('\n')}\n`

/** The same entries in `info/exclude`, from the checkout's top. */
export const excludedEntries: ReadonlyArray<string> = ignoredInFolder.map(
  entry => `/${fabricaFolder}/${entry}`,
)

const excludeComment = "# Fabrica's files that aren't committed (§10.2)"

/** The most `info/exclude` may hold to be read and written again. */
const excludeMaxBytes = 1024 * 1024

/**
 * Adds the entries `info/exclude` lacks, in the git folder `commonDir`, keeping every other line as it
 * is; the file is written whole, so a crash leaves it as it was or with them.
 */
export const excludeIgnored = Effect.fn('Projects.excludeIgnored')(function* (
  commonDir: string,
) {
  const location = { root: commonDir, path: 'info/exclude' }
  const text = yield* readFileText(location, {
    maxBytes: excludeMaxBytes,
  }).pipe(Effect.catchTag('FileMissing', () => Effect.succeed('')))
  const lines = new Set(text.split('\n').map(line => line.trim()))
  const missing = excludedEntries.filter(entry => !lines.has(entry))
  if (missing.length === 0) return
  const kept = text === '' || text.endsWith('\n') ? text : `${text}\n`
  yield* writeFileWhole(
    location,
    `${kept}${[excludeComment, ...missing].join('\n')}\n`,
  )
})

/** `.fabrica/` couldn't be made in the checkout, or is something other than a folder there. */
export class FabricaFolderRefused extends Data.TaggedError(
  'FabricaFolderRefused',
)<{ readonly folder: string; readonly reason: string }> {
  override get message() {
    return `${this.folder} can't be used: ${this.reason}`
  }
}

/** Makes the checkout's `.fabrica/` where it is missing; one there must be a folder, not a link to one. */
export const makeFabricaFolder = Effect.fn('Projects.makeFabricaFolder')(
  function* (checkout: string) {
    const folder = NodePath.join(checkout, fabricaFolder)
    const refused = (reason: unknown) =>
      new FabricaFolderRefused({
        folder,
        reason: reason instanceof Error ? reason.message : String(reason),
      })
    // One already there is checked below.
    yield* Effect.tryPromise(() => mkdir(folder)).pipe(Effect.ignore)
    const found = yield* Effect.tryPromise({
      try: () => lstat(folder),
      catch: refused,
    })
    if (!found.isDirectory())
      return yield* refused('it is a link or a file, not a folder')
  },
)

/** Where the engine keeps a cloned project (§7.2): `<data>/projects/<id>/`, its checkout in `repo/`. */
export const projectFolder = ({
  data,
  project,
}: {
  readonly data: string
  readonly project: ProjectId
}): string => NodePath.join(data, 'projects', project)

/** A cloned project's checkout: `<data>/projects/<id>/repo`. */
export const clonePath = (options: {
  readonly data: string
  readonly project: ProjectId
}): string => NodePath.join(projectFolder(options), 'repo')

/** Where a project's worktrees go (§10.2): beside a registered checkout, in the engine's folder for a clone. */
export const worktreeHome = (options: {
  readonly data: string
  readonly project: ProjectId
  readonly checkout: string
  readonly origin: 'registered' | 'cloned'
}): WorktreeHome =>
  options.origin === 'registered'
    ? besideCheckout(options.checkout)
    : inFolder({
        checkout: options.checkout,
        folder: NodePath.join(projectFolder(options), 'worktrees'),
      })
