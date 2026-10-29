import { Effect, Option } from 'effect'

import { readFileText } from '../files'

// How footprints read a tracked file's contents (spec §13.4): through a port, so that the rules stay
// pure and their tests count what they read. Only three things are read: the source files, once per
// Base, for what they declare; the files of pairs compared where one names a function, for what
// they mention; and the check commands' scripts, for the files they run.

/** A file's text in the checkout, by its path from the root; none for one that can't be read. */
export type ReadSource = (path: string) => Effect.Effect<Option.Option<string>>

/** The most of a file read: a larger one (a bundle, a lockfile) is none. */
export const maxSourceBytes = 4 << 20

/** How many files are read at once. */
export const readsAtOnce = 8

/** Reads files in the checkout at `root`, as the engine reads files it doesn't own (spec §20.2). */
export const readerIn =
  (root: string): ReadSource =>
  path =>
    readFileText({ root, path }, { maxBytes: maxSourceBytes }).pipe(
      Effect.option,
    )

/** The texts of the files that could be read, by path, each read once. */
export const readAll = (
  read: ReadSource,
  paths: Iterable<string>,
): Effect.Effect<ReadonlyMap<string, string>> =>
  Effect.map(
    Effect.forEach(
      new Set(paths),
      path => Effect.map(read(path), text => [path, text] as const),
      { concurrency: readsAtOnce },
    ),
    read =>
      new Map(
        read.flatMap(([path, text]) =>
          Option.isSome(text) ? [[path, text.value] as const] : [],
        ),
      ),
  )
