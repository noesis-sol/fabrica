import { Effect, Option } from 'effect'
import { type Stats, constants } from 'node:fs'
import { type FileHandle, lstat, mkdir, open } from 'node:fs/promises'
import * as NodePath from 'node:path'

import {
  FileFailed,
  FileMissing,
  FileRefused,
  type FoundKind,
  PathOutsideRoot,
  errorCode,
} from './errors'

// How the engine opens a file (spec §20.2, H62): every file it reads or writes is treated as hostile,
// since a worktree's files are the agent's and a checkout's .fabrica/ takes whatever a merged ticket
// committed. A file is named by a trusted root and a path inside it; each folder on the way must be a
// real folder, not a link to one, and the file is opened without following a link, non-blocking (so a
// named pipe can't stall the engine), and kept only when it is a regular file.

/** A file the engine reads or writes: a path inside a root the engine trusts (a worktree, a checkout, its data folder). */
export interface FileLocation {
  readonly root: string
  readonly path: string
}

/** A location resolved: the file's full path, and the folders from the root down to it. */
export interface ResolvedLocation {
  readonly full: string
  readonly folders: ReadonlyArray<string>
}

/** The full path a location names, or a failure when it leaves its root. */
export const resolveLocation = (
  location: FileLocation,
): Effect.Effect<ResolvedLocation, PathOutsideRoot> => {
  const relative = NodePath.normalize(location.path)
  const parts = relative.split(NodePath.sep)
  if (
    location.path === '' ||
    NodePath.isAbsolute(location.path) ||
    relative === '.' ||
    parts.includes('..')
  )
    return Effect.fail(new PathOutsideRoot(location))
  const folders = parts
    .slice(0, -1)
    .map((_, index) =>
      NodePath.join(location.root, ...parts.slice(0, index + 1)),
    )
  return Effect.succeed({
    full: NodePath.join(location.root, relative),
    folders,
  })
}

/** What a stat shows, where it isn't a regular file. */
export const foundKind = (stats: Stats): FoundKind =>
  stats.isSymbolicLink()
    ? 'symbolic link'
    : stats.isFIFO()
      ? 'named pipe'
      : stats.isDirectory()
        ? 'folder'
        : stats.isFile()
          ? 'file'
          : stats.isSocket()
            ? 'socket'
            : stats.isBlockDevice() || stats.isCharacterDevice()
              ? 'device'
              : 'other'

/** A system call on `path`, its rejection a FileFailed (or FileMissing, where nothing is there). */
export const attempt = <A>(
  path: string,
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, FileFailed | FileMissing> =>
  Effect.tryPromise({
    try: run,
    catch: cause =>
      Option.contains(errorCode(cause), 'ENOENT')
        ? new FileMissing({ path })
        : FileFailed.fromCause(path, operation, cause),
  })

/** Closes a handle, ignoring a failure: nothing written is pending once it has been synced or failed. */
export const closeQuietly = (handle: FileHandle): Effect.Effect<void> =>
  Effect.tryPromise(() => handle.close()).pipe(Effect.ignore)

/**
 * Checks that each folder is a real folder, not a link to one; with `create`, makes the missing ones,
 * one at a time, so none is made through a link.
 */
export const checkFolders = Effect.fn('SafeFiles.checkFolders')(function* (
  folders: ReadonlyArray<string>,
  create: boolean,
) {
  for (const folder of folders) {
    const stats = yield* attempt(folder, 'lstat', () => lstat(folder)).pipe(
      Effect.catchTag('FileMissing', missing =>
        create
          ? attempt(folder, 'mkdir', () => mkdir(folder)).pipe(
              Effect.catchIf(
                failure =>
                  failure._tag === 'FileFailed' &&
                  Option.contains(failure.code, 'EEXIST'),
                () => Effect.void,
              ),
              Effect.andThen(attempt(folder, 'lstat', () => lstat(folder))),
            )
          : Effect.fail(missing),
      ),
    )
    if (!stats.isDirectory())
      return yield* new FileRefused({
        path: folder,
        found: foundKind(stats),
        wanted: 'folder',
      })
  }
})

/** An open regular file and what its stat showed when it was opened. */
export interface OpenedFile {
  readonly handle: FileHandle
  readonly stats: Stats
}

/**
 * Opens `full` with `flags`, never following a link at its name and never waiting on a named pipe,
 * and keeps it only when it is a regular file. The folders on the way are checked by the caller.
 */
export const openRegular = Effect.fn('SafeFiles.openRegular')(function* (
  full: string,
  flags: number,
  mode = 0o644,
) {
  const handle = yield* Effect.tryPromise(() =>
    open(full, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode),
  ).pipe(Effect.catch(error => refusalOrFailure(full, error.cause)))
  const stats = yield* attempt(full, 'fstat', () => handle.stat()).pipe(
    Effect.tapError(() => closeQuietly(handle)),
  )
  if (!stats.isFile()) {
    yield* closeQuietly(handle)
    return yield* new FileRefused({
      path: full,
      found: foundKind(stats),
      wanted: 'regular file',
    })
  }
  return { handle, stats } satisfies OpenedFile
})

/** Why an open failed: what stands at the path when it isn't a regular file (a link, a pipe with no reader), or the system's error. */
const refusalOrFailure = (
  full: string,
  cause: unknown,
): Effect.Effect<never, FileRefused | FileFailed | FileMissing> =>
  Effect.gen(function* () {
    if (Option.contains(errorCode(cause), 'ENOENT'))
      return yield* new FileMissing({ path: full })
    const stats = yield* Effect.option(Effect.tryPromise(() => lstat(full)))
    if (Option.isSome(stats) && !stats.value.isFile())
      return yield* new FileRefused({
        path: full,
        found: foundKind(stats.value),
        wanted: 'regular file',
      })
    return yield* FileFailed.fromCause(full, 'open', cause)
  })

/** Writes every byte of `bytes` at the handle's position, a write at a time until none is left. */
export const writeAll = Effect.fn('SafeFiles.writeAll')(function* (
  full: string,
  handle: FileHandle,
  bytes: Uint8Array,
) {
  let written = 0
  while (written < bytes.length) {
    const { bytesWritten } = yield* attempt(full, 'write', () =>
      handle.write(bytes, written, bytes.length - written),
    )
    if (bytesWritten === 0)
      return yield* new FileFailed({
        path: full,
        operation: 'write',
        code: Option.none(),
        reason: 'the system wrote no bytes',
      })
    written += bytesWritten
  }
})
