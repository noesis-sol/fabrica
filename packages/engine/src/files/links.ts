import { Effect } from 'effect'
import { constants } from 'node:fs'
import { unlink } from 'node:fs/promises'

import { FileRefused } from './errors'
import { type OpenedFile, attempt, closeQuietly, openRegular } from './open'
import { replaceWhole } from './whole'

// A file the engine writes into must be its name's own (spec §20.2, H84; tutti-vy3y): a file with
// more than one link may be another file under a second name (a worker that linked .git/config to a
// check log's name had tutti overwrite it). Such a name is replaced, never written through: a
// truncating open unlinks it and creates the file afresh; an append copies what it held to a fresh
// file of the same name first, so the stream keeps its records and the other name its content.

/** What a write keeps of a linked file it replaces: nothing (a truncating open), or what it held (an append). */
export type LinkedKeeps = 'nothing' | 'contents'

/**
 * Opens the regular file at `full` (its folders already checked) with `flags`, which create it where
 * it is missing; where it has more than one link, its name is first replaced by a file of its own.
 */
export const openOwnFile = Effect.fn('SafeFiles.openOwnFile')(function* (
  full: string,
  flags: number,
  keeps: LinkedKeeps,
) {
  const opened = yield* openRegular(full, flags | constants.O_CREAT)
  if (opened.stats.nlink <= 1) return opened
  if (keeps === 'contents') {
    const held = yield* attempt(full, 'read', () =>
      opened.handle.readFile(),
    ).pipe(Effect.ensuring(closeQuietly(opened.handle)))
    yield* replaceWhole(full, held, opened.stats.mode & 0o777)
  } else {
    yield* closeQuietly(opened.handle)
    yield* attempt(full, 'unlink', () => unlink(full))
  }
  const fresh: OpenedFile = yield* openRegular(
    full,
    flags | constants.O_CREAT | (keeps === 'nothing' ? constants.O_EXCL : 0),
  )
  if (fresh.stats.nlink > 1) {
    yield* closeQuietly(fresh.handle)
    return yield* new FileRefused({
      path: full,
      found: 'hard-linked file',
      wanted: 'regular file',
    })
  }
  return fresh
})
