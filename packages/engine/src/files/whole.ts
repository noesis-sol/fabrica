import { Effect } from 'effect'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import * as NodePath from 'node:path'

import {
  type FileLocation,
  attempt,
  checkFolders,
  closeQuietly,
  openRegular,
  resolveLocation,
  writeAll,
} from './open'

// The one writer for a file written whole (spec §20.2, H84; tutti-q8fy): the content goes to a
// temporary file of the target's own name in its folder, is synced, and is renamed over the target,
// and the folder is synced, so a crash leaves the old file or the new one, never a part of either.
// A rename replaces the name: a link at the target is replaced, not written through, and a file
// hard-linked to the target keeps its content.

/** The text or bytes to write. */
export type FileContent = string | Uint8Array

/** The bytes of a content, text as UTF-8. */
export const toBytes = (content: FileContent): Uint8Array =>
  typeof content === 'string' ? Buffer.from(content, 'utf8') : content

/** Writes `content` at `full`, whose folders are already checked, through a synced temporary file and a rename. */
export const replaceWhole = Effect.fn('SafeFiles.replaceWhole')(function* (
  full: string,
  content: FileContent,
  mode = 0o644,
) {
  const folder = NodePath.dirname(full)
  const temporary = NodePath.join(
    folder,
    `.${NodePath.basename(full)}.${randomBytes(6).toString('hex')}.tmp`,
  )
  const { handle } = yield* openRegular(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    mode,
  )
  yield* Effect.gen(function* () {
    yield* writeAll(temporary, handle, toBytes(content))
    yield* attempt(temporary, 'fsync', () => handle.sync())
  }).pipe(
    Effect.ensuring(closeQuietly(handle)),
    Effect.andThen(attempt(full, 'rename', () => rename(temporary, full))),
    Effect.tapError(() =>
      Effect.tryPromise(() => unlink(temporary)).pipe(Effect.ignore),
    ),
  )
  yield* syncFolder(folder)
})

/** Syncs a folder, so a rename in it survives a crash. */
const syncFolder = Effect.fn('SafeFiles.syncFolder')(function* (
  folder: string,
) {
  const handle = yield* attempt(folder, 'open', () =>
    open(folder, constants.O_RDONLY | constants.O_DIRECTORY),
  )
  yield* attempt(folder, 'fsync', () => handle.sync()).pipe(
    Effect.ensuring(closeQuietly(handle)),
  )
})

/** Writes a file whole at `location`, making the folders it needs; a crash leaves the old file or the new one. */
export const writeFileWhole = Effect.fn('SafeFiles.writeFileWhole')(function* (
  location: FileLocation,
  content: FileContent,
  options?: { readonly mode?: number },
) {
  const { full, folders } = yield* resolveLocation(location)
  yield* checkFolders(folders, true)
  yield* replaceWhole(full, content, options?.mode)
})
