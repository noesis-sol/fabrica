import { Data, Duration, Effect, Schedule } from 'effect'
import { DatabaseSync } from 'node:sqlite'

import type { EnginePaths } from './paths'

// The single-instance lock (spec §7.1): one engine per user per machine. The engine holds an
// exclusive lock on `<data>/engine.lock` for as long as it runs, and the kernel lets it go when the
// process ends, however it ends, so no stale lock outlives a crash. Node has no `flock(2)` and the
// engine takes no native addon (§22.4), so the lock is SQLite's: the file is a database held in a
// write transaction (`BEGIN IMMEDIATE`) that never ends, whose RESERVED lock SQLite keeps with the
// kernel's advisory lock (`fcntl`), refused to every other connection, in this process or another.
// The engine never asks for more than RESERVED, so a second engine's passing SHARED lock can't make
// it fail: of two engines starting at once exactly one wins, where two asking for EXCLUSIVE could
// both be refused and neither run. `acquireFileLock` is the same lock on any file, for processes that
// each hold it a moment and wait their turn.

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

/** A file's lock couldn't be taken: another process held it for all the wait, or `reason`. */
export class FileLockFailed extends Data.TaggedError('FileLockFailed')<{
  readonly lock: string
  readonly busy: boolean
  readonly reason: string
}> {
  override get message() {
    return this.busy
      ? `another process holds the lock ${this.lock}`
      : `the lock ${this.lock} couldn't be taken: ${this.reason}`
  }
}

/** Whether a thrown value is SQLite saying the database is locked. */
const isBusy = (error: unknown): boolean =>
  error instanceof Error && 'errcode' in error && error.errcode === sqliteBusy

/** The lock on `file`, held by the connection returned; throws SQLite's error where it can't be taken. */
const holdLock = (file: string): DatabaseSync => {
  const database = new DatabaseSync(file, { timeout: 0 })
  try {
    database.exec('BEGIN IMMEDIATE')
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

/** Takes the engine's lock for the current scope, or fails saying an engine already holds it. */
export const acquireEngineLock = Effect.fn('Engine.acquireLock')(function* (
  paths: EnginePaths,
) {
  return yield* Effect.acquireRelease(
    Effect.try({
      try: () => holdLock(paths.lock),
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

/** How often a wait for a lock tries it again: the event loop runs in between, as SQLite's own wait wouldn't let it. */
const fileLockSpacing = Duration.millis(50)

/** Takes the lock on `file` for the current scope, waiting up to `wait` for whoever holds it. */
export const acquireFileLock = Effect.fn('Engine.acquireFileLock')(function* ({
  file,
  wait,
}: {
  readonly file: string
  readonly wait: Duration.Duration
}) {
  return yield* Effect.acquireRelease(
    Effect.try({
      try: () => holdLock(file),
      catch: error =>
        new FileLockFailed({
          lock: file,
          busy: isBusy(error),
          reason: error instanceof Error ? error.message : String(error),
        }),
    }).pipe(
      Effect.retry({
        schedule: Schedule.spaced(fileLockSpacing).pipe(
          Schedule.while(({ elapsed }) => elapsed < Duration.toMillis(wait)),
        ),
        while: failure => failure.busy,
      }),
    ),
    database => Effect.sync(() => database.close()),
  ).pipe(Effect.asVoid)
})
