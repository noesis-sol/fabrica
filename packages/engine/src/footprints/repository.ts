import { Data } from 'effect'

import {
  type Glob,
  compileGlob,
  compileSettingsGlob,
  isGlob,
  nfc,
} from './glob'
import { basename, dirname, repoPath, sorted } from './names'

// The repository's files as footprints see them (spec §13.4): the files git tracks at Base
// (`Git.trackedFiles`), indexed to tell a path a ticket names from other words, and to say what an
// entry of a ticket's `files` means. Names are compared in NFC: a name with é written as e and
// U+0301 (as Finder gives it) means the file git lists with é.

/**
 * A place a ticket's `files` names: a tracked file, a tracked folder (every file under it, those
 * added there included), a glob (the files it matches from the root, those added later included),
 * or a name git doesn't track, a file or folder the ticket adds.
 */
export type Place = Data.TaggedEnum<{
  File: { readonly path: string }
  Folder: { readonly path: string }
  Glob: { readonly glob: Glob }
  Added: { readonly path: string }
}>
export const Place = Data.taggedEnum<Place>()

/** A place as the log and the reasons name it: a folder ends in `/`. */
export const placeName: (place: Place) => string = Place.$match({
  File: ({ path }) => path,
  Folder: ({ path }) => `${path}/`,
  Glob: ({ glob }) => glob.text,
  Added: ({ path }) => path,
})

/** The files git tracks, indexed. */
export interface Repository {
  /** The tracked files, as git lists them, sorted. */
  readonly files: ReadonlyArray<string>
  /** The tracked file a name is (cleaned and in NFC), if git tracks it. */
  readonly tracked: (name: string) => string | undefined
  /**
   * The tracked files a word of a ticket's text names: its path from the root, or, a bare name (no
   * folder) capitalised or quoted, every tracked file of that name (`Makefile`, `` `check.sh` ``).
   */
  readonly named: (word: string, quoted: boolean) => ReadonlyArray<string>
  /** What an entry of a ticket's `files` means; none for a name that can't be in the repository. */
  readonly place: (entry: string) => ReadonlyArray<Place>
}

/** Indexes the files git tracks at Base. */
export const makeRepository = (tracked: ReadonlyArray<string>): Repository => {
  const files = new Map<string, string>()
  const byBase = new Map<string, Array<string>>()
  const folders = new Set<string>()
  for (const listed of tracked) {
    const path = repoPath(nfc(listed))
    if (path === undefined || files.has(path)) continue
    files.set(path, listed)
    byBase.set(basename(path), [...(byBase.get(basename(path)) ?? []), listed])
    for (let d = dirname(path); d !== '.' && !folders.has(d); d = dirname(d))
      folders.add(d)
  }
  const all = sorted(files.values())
  const trackedPath = (name: string): string | undefined => {
    const path = repoPath(nfc(name))
    return path === undefined ? undefined : files.get(path)
  }
  return {
    files: all,
    tracked: trackedPath,
    named: (word, quoted) => {
      const path = trackedPath(word)
      if (path !== undefined) return [path]
      if (word.includes('/') || !(quoted || /^\p{Lu}/u.test(word))) return []
      return sorted(byBase.get(nfc(word)) ?? [])
    },
    place: entry => {
      const path = repoPath(nfc(entry))
      if (path === undefined) return []
      if (isGlob(path)) return [Place.Glob({ glob: compileGlob(path) })]
      const file = files.get(path)
      if (file !== undefined) return [Place.File({ path: file })]
      if (folders.has(path)) return [Place.Folder({ path })]
      return [Place.Added({ path })]
    },
  }
}

/**
 * The files that stay in footprints but hold no tickets apart, each named by the rule that keeps it
 * there (spec §13.4): those git merges by union (two tickets' lines can't conflict there), those the
 * check commands name and run (nearly every ticket asks for them to pass), and those the project's
 * `shared_files` match (nearly every ticket edits them). Two tickets on one get `LIKELY_CONFLICT`.
 */
export interface ApartFiles {
  /** Whether the place, a file or a glob as written, holds no tickets apart. */
  readonly apart: (name: string) => boolean
}

/** The files apart: `unioned` and `checks` as tracked files, `shared` as `shared_files` gives them. */
export const makeApartFiles = (input: {
  readonly unioned: Iterable<string>
  readonly checks: Iterable<string>
  readonly shared: ReadonlyArray<string>
}): ApartFiles => {
  const named = new Set(
    [...input.unioned, ...input.checks].map(name => nfc(name)),
  )
  const shared = input.shared.map(compileSettingsGlob)
  const written = new Set(shared.map(glob => glob.text))
  return {
    apart: name => {
      const n = nfc(name)
      if (n.endsWith('/')) return false
      return (
        named.has(n) ||
        written.has(n) ||
        (!isGlob(n) && shared.some(glob => glob.matches(n)))
      )
    },
  }
}
