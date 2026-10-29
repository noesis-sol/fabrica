import { Effect } from 'effect'
import { constants } from 'node:fs'

import {
  type FileLocation,
  attempt,
  checkFolders,
  closeQuietly,
  openRegular,
  resolveLocation,
} from './open'

// Reading a file's last lines (the human log's tail, spec §7.5, §8.1): as the safe reader reads a
// file, without following a link or waiting on a named pipe, and only a regular file (H62); from its
// end backwards, a block at a time, so a long log is never read whole for a few of its lines.

const newline = 0x0a

/** How many bytes each read back from the end takes. */
const blockBytes = 64 * 1024

/** The newlines in `bytes`. */
const newlines = (bytes: Uint8Array): number => {
  let count = 0
  for (const byte of bytes) if (byte === newline) count += 1
  return count
}

/**
 * The last `lines` lines of the regular file at `location`, read as UTF-8, oldest first, without their
 * newlines; fewer where the file has fewer. A last line with no newline yet (one being written) counts.
 */
export const readFileTail = Effect.fn('SafeFiles.readFileTail')(function* (
  location: FileLocation,
  lines: number,
) {
  const { full, folders } = yield* resolveLocation(location)
  yield* checkFolders(folders, false)
  const { handle, stats } = yield* openRegular(full, constants.O_RDONLY)
  return yield* Effect.gen(function* () {
    const blocks: Array<Uint8Array> = []
    let start = stats.size
    // A line is whole once the newline before it is read: `lines` of them past the file's last newline.
    let found = 0
    let last = true
    while (start > 0 && found < lines) {
      const length = Math.min(blockBytes, start)
      start -= length
      const block = new Uint8Array(length)
      const { bytesRead } = yield* attempt(full, 'read', () =>
        handle.read(block, 0, length, start),
      )
      const read = block.subarray(0, bytesRead)
      blocks.unshift(read)
      // The file's own last newline ends its last line; it begins none.
      found += newlines(read) - (last && read.at(-1) === newline ? 1 : 0)
      last = false
    }
    const text = Buffer.concat(blocks).toString('utf8')
    const all = text.split('\n')
    if (all.at(-1) === '') all.pop()
    return all.slice(-lines)
  }).pipe(Effect.ensuring(closeQuietly(handle)))
})
