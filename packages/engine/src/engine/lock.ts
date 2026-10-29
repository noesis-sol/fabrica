import { Data, Effect } from 'effect'
import { DatabaseSync } from 'node:sqlite'

import type { EnginePaths } from './paths'

// The single-instance lock (spec §7.1): one engine per user per machine. The engine holds an
// exclusive lock on `<data>/engine.lock` for as long as it runs, and the kernel lets it go when the
// process ends, however it ends, so no stale lock outlives a crash. Node has no `flock(2)` and the
// engine takes no native addon (§22.4), so the lock is SQLite's: the file is a database held in an
// exclusive transaction under `locking_mode = EXCLUSIVE`, which SQLite keeps with the kernel's
// advisory lock (`fcntl`), refused to every other connection, in this process or another.

/** SQLite's `SQLITE_BUSY`: another connection holds the lock. */
const sqliteBusy = 5

/** An engine already holds the lock: this one doesn't start. */
export class EngineAlreadyRunning extends Data.TaggedError(
  'EngineAlreadyRunning',
)<{ readonly lock: string; readonly socket: string }> {
  override get message() {
    return `an engine is already running here: it holds ${this.lock} and serves ${this.socket}`
  }
}

/** The lock couldn't be taken or checked for another reason than another engine holding it. */
export class LockFailed extends Data.TaggedError('LockFailed')<{
  readonly lock: string
  readonly reason: string
}> {
  override get message() {
    return `the engine's lock ${this.lock} couldn't be taken: ${this.reason}`
  }
}

/** Whether a thrown value is SQLite saying the database is locked. */
const isBusy = (error: unknown): boolean =>
  error instanceof Error && 'errcode' in error && error.errcode === sqliteBusy

/** Takes the engine's lock for the current scope, or fails saying an engine already holds it. */
export const acquireEngineLock = Effect.fn('Engine.acquireLock')(function* (
  paths: EnginePaths,
) {
  return yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const database = new DatabaseSync(paths.lock, { timeout: 0 })
        try {
          database.exec('PRAGMA locking_mode = EXCLUSIVE')
          database.exec('BEGIN EXCLUSIVE')
          return database
        } catch (error) {
          database.close()
          throw error
        }
      },
      catch: error =>
        isBusy(error)
          ? new EngineAlreadyRunning({ lock: paths.lock, socket: paths.socket })
          : new LockFailed({
              lock: paths.lock,
              reason: error instanceof Error ? error.message : String(error),
            }),
    }),
    database => Effect.sync(() => database.close()),
  ).pipe(Effect.asVoid)
})
