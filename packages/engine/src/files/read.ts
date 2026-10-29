import { Effect } from 'effect'
import { constants } from 'node:fs'

import { FileTooLarge } from './errors'
import {
  type FileLocation,
  attempt,
  checkFolders,
  closeQuietly,
  openRegular,
  resolveLocation,
} from './open'

// Reading a file the engine doesn't own (a worker's answer file, a check log, a run file in a
// checkout): without following a link, without waiting on a named pipe, and only a regular file
// (spec §20.2, H62).

/** The bytes of the regular file at `location`; past `maxBytes`, a failure rather than a part of it. */
export const readFileBytes = Effect.fn('SafeFiles.readFileBytes')(function* (
  location: FileLocation,
  options?: { readonly maxBytes?: number },
) {
  const { full, folders } = yield* resolveLocation(location)
  yield* checkFolders(folders, false)
  const { handle, stats } = yield* openRegular(full, constants.O_RDONLY)
  return yield* Effect.gen(function* () {
    const maxBytes = options?.maxBytes
    if (maxBytes !== undefined && stats.size > maxBytes)
      return yield* new FileTooLarge({ path: full, size: stats.size, maxBytes })
    const bytes = yield* attempt(full, 'read', () => handle.readFile())
    if (maxBytes !== undefined && bytes.length > maxBytes)
      return yield* new FileTooLarge({
        path: full,
        size: bytes.length,
        maxBytes,
      })
    return new Uint8Array(bytes)
  }).pipe(Effect.ensuring(closeQuietly(handle)))
})

/** The text of the regular file at `location`, read as UTF-8; past `maxBytes`, a failure. */
export const readFileText = Effect.fn('SafeFiles.readFileText')(function* (
  location: FileLocation,
  options?: { readonly maxBytes?: number },
) {
  const bytes = yield* readFileBytes(location, options)
  return Buffer.from(bytes).toString('utf8')
})
