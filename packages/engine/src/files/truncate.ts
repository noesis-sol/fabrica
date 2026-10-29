import { Effect, type Scope } from 'effect'
import { constants } from 'node:fs'

import type {
  FileFailed,
  FileMissing,
  FileRefused,
  PathOutsideRoot,
} from './errors'
import { openOwnFile } from './links'
import {
  type FileLocation,
  attempt,
  checkFolders,
  closeQuietly,
  resolveLocation,
  writeAll,
} from './open'
import { type FileContent, toBytes } from './whole'

// A file written as it goes, from empty (a check's log): opened as every engine file is, and, where its
// name has other links, created afresh rather than truncated (spec §20.2, H84).

/** A file open for writing from its start, closed with its scope. */
export interface FileWriter {
  readonly path: string
  /** Writes every byte of `content` after what was written before. */
  readonly write: (
    content: FileContent,
  ) => Effect.Effect<void, FileFailed | FileMissing>
  /** Syncs what was written to the disk. */
  readonly sync: Effect.Effect<void, FileFailed | FileMissing>
}

/** Opens the file at `location` empty, making the folders it needs; it is closed when the scope closes. */
export const openFileTruncating: (
  location: FileLocation,
) => Effect.Effect<
  FileWriter,
  PathOutsideRoot | FileRefused | FileFailed | FileMissing,
  Scope.Scope
> = Effect.fn('SafeFiles.openFileTruncating')(function* (
  location: FileLocation,
) {
  const { full, folders } = yield* resolveLocation(location)
  yield* checkFolders(folders, true)
  const { handle } = yield* Effect.acquireRelease(
    openOwnFile(full, constants.O_WRONLY, 'nothing'),
    opened => closeQuietly(opened.handle),
  )
  yield* attempt(full, 'truncate', () => handle.truncate(0))
  return {
    path: full,
    write: content => writeAll(full, handle, toBytes(content)),
    sync: attempt(full, 'fsync', () => handle.sync()),
  } satisfies FileWriter
})
