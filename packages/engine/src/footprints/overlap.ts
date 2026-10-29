import { Data, Effect } from 'effect'

import { codeIn } from './code'
import { isSource } from './declared'
import type { Footprint } from './footprint'
import { type Glob, globMeetsFolder, globsMeet } from './glob'
import { sorted } from './names'
import { type ApartFiles, Place } from './repository'
import { type ReadSource, readAll } from './sources'

// Whether two tickets' footprints overlap (spec §13.4, H70): on an area label both have, a function
// both name, or a file one of them is to change that the other works on too, where the functions
// one names are placed in the files that mention them in their code. Two tickets overlap only on a
// file one of them is to change: a document both only cite holds neither. The files git merges by
// union, the check commands' files and the project's `shared_files` never hold tickets apart: they
// give `LIKELY_CONFLICT` instead. File contents are read only for pairs where one names a function.

/** What two footprints share that holds their tickets apart. */
export type Shared = Data.TaggedEnum<{
  /** An `area:` label both have. */
  Area: { readonly label: string }
  /** A function both name: `Loop.merge` and `merge` meet, `Loop.merge` and `Git.merge` don't. */
  Function: { readonly name: string }
  /** A file, folder or glob both work on, one of them to change it. */
  Path: { readonly name: string }
}>
export const Shared = Data.taggedEnum<Shared>()

/** What two footprints come to. */
export type Overlap = Data.TaggedEnum<{
  /** Nothing in common: their tickets run side by side. */
  Clear: {}
  /** They share only files that hold no tickets apart: they run side by side, the second to merge may conflict. */
  LikelyConflict: { readonly files: readonly [string, ...Array<string>] }
  /** They share what holds them apart. */
  Holds: { readonly on: Shared }
}>
export const Overlap = Data.taggedEnum<Overlap>()

/** What two footprints share, in words: `src/x.ts`, `the function Loop.merge`, `the area area:ui`. */
export const describeShared: (shared: Shared) => string = Shared.$match({
  Area: ({ label }) => `the area ${label}`,
  Function: ({ name }) => `the function ${name}`,
  Path: ({ name }) => name,
})

/**
 * Whether a tracked file mentions a function in its code (its comments, strings and documents left
 * out): by its name, and by its type too where it gives one (`Loop.merge`: `Loop` and `merge`). A
 * file whose contents weren't read, or that isn't source, mentions none.
 */
export type Mentions = (file: string, fn: string) => boolean

/** Mentions from no contents: every function in no file. */
export const noMentions: Mentions = () => false

// A word of source code.
const identifier = /[A-Za-z_$][\w$]*/gu

/** Mentions read from the files' contents, by path, each file's words found once. */
export const mentionsIn = (contents: ReadonlyMap<string, string>): Mentions => {
  const words = new Map<string, ReadonlySet<string>>()
  return (file, fn) => {
    let known = words.get(file)
    if (known === undefined) {
      const text = contents.get(file)
      if (text === undefined || !isSource(file)) return false
      known = new Set(codeIn(file, text).match(identifier) ?? [])
      words.set(file, known)
    }
    const found = known
    return fn.split('.').every(part => found.has(part))
  }
}

/** Whether two function names can mean one function: one name, and one type where both give one. */
const functionsMeet = (a: string, b: string): boolean => {
  const [ta, na] = a.includes('.') ? a.split('.', 2) : ['', a]
  const [tb, nb] = b.includes('.') ? b.split('.', 2) : ['', b]
  return na === nb && (ta === '' || tb === '' || ta === tb)
}

const sharedArea = (a: Footprint, b: Footprint): string | undefined =>
  a.areas.find(label => b.areas.includes(label))

const sharedFunction = (a: Footprint, b: Footprint): string | undefined =>
  a.functions.find(x => b.functions.some(y => functionsMeet(x, y)))

/**
 * A place as compared: its path, whether it is that path itself (a file, or a name added) and
 * whether it holds what is under it (a folder, or a name added, which may be one); or a glob.
 */
type Region =
  | {
      readonly glob: undefined
      readonly path: string
      readonly self: boolean
      readonly subtree: boolean
    }
  | { readonly glob: Glob }

const regionOf: (place: Place) => Region = Place.$match({
  File: ({ path }): Region => ({
    glob: undefined,
    path,
    self: true,
    subtree: false,
  }),
  Folder: ({ path }): Region => ({
    glob: undefined,
    path,
    self: false,
    subtree: true,
  }),
  Added: ({ path }): Region => ({
    glob: undefined,
    path,
    self: true,
    subtree: true,
  }),
  Glob: ({ glob }): Region => ({ glob }),
})

const under = (path: string, folder: string): boolean =>
  path.startsWith(`${folder}/`)

/** The name of what two places both hold, if anything: a file where one is, else a folder or a glob. */
const meet = (x: Region, y: Region): string | undefined => {
  if (x.glob !== undefined && y.glob !== undefined)
    return globsMeet(x.glob, y.glob) ? x.glob.text : undefined
  if (y.glob !== undefined) return meet(y, x)
  if (x.glob !== undefined) {
    if (y.self && x.glob.matches(y.path)) return y.path
    return y.subtree && globMeetsFolder(x.glob, y.path)
      ? x.glob.text
      : undefined
  }
  const holds = (r: typeof x, path: string) =>
    (r.self && path === r.path) || (r.subtree && under(path, r.path))
  if (y.self && holds(x, y.path)) return y.path
  if (x.self && holds(y, x.path)) return x.path
  if (!x.subtree || !y.subtree) return undefined
  if (x.path === y.path || under(y.path, x.path)) return `${y.path}/`
  return under(x.path, y.path) ? `${x.path}/` : undefined
}

/** A place a footprint works on, and whether it is to change it. */
interface Touch {
  readonly region: Region
  /** The tracked files it holds, whose contents may mention a function. */
  readonly files: ReadonlyArray<string>
  readonly changes: boolean
}

const touchesOf = (footprint: Footprint): ReadonlyArray<Touch> => [
  ...footprint.places.map(place => ({
    region: regionOf(place),
    files: Place.$match(place, {
      File: ({ path }) => [path],
      Folder: ({ files }) => files,
      Glob: ({ files }) => files,
      Added: () => [],
    }),
    changes: true,
  })),
  ...footprint.changed.map(path => ({
    region: regionOf(Place.File({ path })),
    files: [path],
    changes: true,
  })),
  ...footprint.cited.map(path => ({
    region: regionOf(Place.File({ path })),
    files: [path],
    changes: false,
  })),
]

/** Each name both footprints work on, one of them to change it: by their places, then by mentions. */
const sharedPaths = (
  a: Footprint,
  b: Footprint,
  mentions: Mentions,
): ReadonlyArray<string> => {
  const ta = touchesOf(a)
  const tb = touchesOf(b)
  const byPlace = ta.flatMap(x =>
    tb.flatMap(y => {
      if (!x.changes && !y.changes) return []
      const name = meet(x.region, y.region)
      return name === undefined ? [] : [name]
    }),
  )
  // A file of one that mentions a function the other names: the other is to change it there.
  const mentioned = (named: Footprint, other: ReadonlyArray<Touch>) =>
    other.flatMap(({ files }) =>
      files.filter(file => named.functions.some(fn => mentions(file, fn))),
    )
  return [...byPlace, ...mentioned(a, tb), ...mentioned(b, ta)]
}

/**
 * What two footprints come to: held apart by an area, a function or a path, the first found in that
 * order; or sharing only files `apart` holds no tickets apart on (`LIKELY_CONFLICT`); or clear.
 */
export const overlap = (input: {
  readonly a: Footprint
  readonly b: Footprint
  /** Where the functions they name are mentioned; `noMentions` when neither names one. */
  readonly mentions: Mentions
  readonly apart: ApartFiles
}): Overlap => {
  const { a, b } = input
  const area = sharedArea(a, b)
  if (area !== undefined)
    return Overlap.Holds({ on: Shared.Area({ label: area }) })
  const fn = sharedFunction(a, b)
  if (fn !== undefined)
    return Overlap.Holds({ on: Shared.Function({ name: fn }) })
  const paths = sharedPaths(a, b, input.mentions)
  const holding = paths.find(name => !input.apart.apart(name))
  if (holding !== undefined)
    return Overlap.Holds({ on: Shared.Path({ name: holding }) })
  const [first, ...rest] = sorted(paths)
  return first === undefined
    ? Overlap.Clear()
    : Overlap.LikelyConflict({ files: [first, ...rest] })
}

/**
 * The files whose contents `overlap` may ask about for the pairs: for a pair where one names a
 * function and that share no area or function (which `overlap` answers first), the tracked source
 * files the other works on. Pairs naming no function read nothing.
 */
export const askedFiles = (
  pairs: Iterable<readonly [Footprint, Footprint]>,
): ReadonlySet<string> => {
  const asked = new Set<string>()
  const files = (footprint: Footprint) =>
    touchesOf(footprint).flatMap(({ files }) => files.filter(isSource))
  for (const [a, b] of pairs) {
    if (sharedArea(a, b) !== undefined || sharedFunction(a, b) !== undefined)
      continue
    if (a.functions.length > 0) for (const file of files(b)) asked.add(file)
    if (b.functions.length > 0) for (const file of files(a)) asked.add(file)
  }
  return asked
}

/** The mentions `overlap` asks about for the pairs, each file read once and only where asked. */
export const readMentions = (input: {
  readonly pairs: Iterable<readonly [Footprint, Footprint]>
  readonly read: ReadSource
}): Effect.Effect<Mentions> => {
  const asked = askedFiles(input.pairs)
  return asked.size === 0
    ? Effect.succeed(noMentions)
    : Effect.map(readAll(input.read, asked), mentionsIn)
}
