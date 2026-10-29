import { Effect } from 'effect'
import { rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

import { readFileText, writeFileWhole } from '../files'
import { CantTell, GitFailed, type GitShape } from '../git'

// What the merge queue records of one worktree across runs (spec §13.7, §13.8): lists of files, each
// kept under its name in the worktree's own git folder, out of its files and removed with it.

/** Where the worktree's record `name` is, as the engine's files name it. */
const recordAt = (git: GitShape, worktree: string, name: string) =>
  Effect.map(git.ownPath({ worktree, name }), path => ({
    root: dirname(path),
    path: basename(path),
  }))

/** The files the worktree's record `name` lists; none where it has none. */
export const readRecord = (
  git: GitShape,
  { worktree, name }: { readonly worktree: string; readonly name: string },
): Effect.Effect<ReadonlyArray<string>, CantTell> =>
  Effect.flatMap(recordAt(git, worktree, name), location =>
    readFileText(location).pipe(
      Effect.map(text => text.split('\0').filter(file => file !== '')),
      Effect.catchTag('FileMissing', () =>
        Effect.succeed<ReadonlyArray<string>>([]),
      ),
      Effect.mapError(
        error => new CantTell({ read: name, reason: error.message }),
      ),
    ),
  )

/** Records `files` as the worktree's record `name`, in place of what it listed. */
export const writeRecord = (
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
  Effect.flatMap(recordAt(git, worktree, name), location =>
    writeFileWhole(location, files.join('\0')).pipe(
      Effect.mapError(
        error =>
          new GitFailed({
            command: `writing ${location.root}/${location.path}`,
            reason: error.message,
          }),
      ),
    ),
  )

/** Drops the worktree's record `name`. */
export const dropRecord = (
  git: GitShape,
  { worktree, name }: { readonly worktree: string; readonly name: string },
): Effect.Effect<void, CantTell | GitFailed> =>
  Effect.flatMap(git.ownPath({ worktree, name }), path =>
    Effect.tryPromise({
      try: () => rm(path, { force: true }),
      catch: cause =>
        new GitFailed({
          command: `removing ${path}`,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    }),
  )
