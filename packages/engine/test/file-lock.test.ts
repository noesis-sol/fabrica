import { Deferred, Duration, Effect, Exit, Fiber } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'

import { FileLockFailed, acquireFileLock } from '../src/engine'

// A file's lock (spec §7.1's, on any file): one holder at a time, the others waiting their turn up to
// a limit, and the lock free again as its holder's scope ends.

/** A temporary folder for the test's scope. */
const tempFolder = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(NodePath.join(tmpdir(), 'fab-lock-'))),
  folder => Effect.promise(() => rm(folder, { recursive: true, force: true })),
)

describe('acquireFileLock', () => {
  it.live('has a second holder wait until the first lets go', () =>
    Effect.gen(function* () {
      const file = NodePath.join(yield* tempFolder, 'a.lock')
      const wait = Duration.seconds(30)
      const held = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const order: Array<string> = []
      const first = yield* acquireFileLock({ file, wait }).pipe(
        Effect.andThen(Deferred.succeed(held, undefined)),
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Effect.sync(() => order.push('first let go'))),
        Effect.scoped,
        Effect.forkChild,
      )
      yield* Deferred.await(held)
      const second = yield* acquireFileLock({ file, wait }).pipe(
        Effect.andThen(Effect.sync(() => order.push('second took it'))),
        Effect.scoped,
        Effect.forkChild,
      )
      yield* Effect.yieldNow
      expect(order).toStrictEqual([])
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(order).toStrictEqual(['first let go', 'second took it'])
    }).pipe(Effect.scoped),
  )

  it.live('fails saying so where the holder outlasts the wait', () =>
    Effect.gen(function* () {
      const file = NodePath.join(yield* tempFolder, 'a.lock')
      yield* acquireFileLock({ file, wait: Duration.zero })
      const exit = yield* acquireFileLock({
        file,
        wait: Duration.zero,
      }).pipe(Effect.scoped, Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = yield* acquireFileLock({
        file,
        wait: Duration.zero,
      }).pipe(Effect.scoped, Effect.flip)
      expect(failure).toBeInstanceOf(FileLockFailed)
      expect(failure.busy).toBe(true)
      expect(failure.message).toBe(`another process holds the lock ${file}`)
    }).pipe(Effect.scoped),
  )

  it.live('says why where the file can’t be locked', () =>
    Effect.gen(function* () {
      const folder = yield* tempFolder
      const failure = yield* acquireFileLock({
        file: NodePath.join(folder, 'no-folder', 'a.lock'),
        wait: Duration.seconds(30),
      }).pipe(Effect.scoped, Effect.flip)
      expect(failure.busy).toBe(false)
    }).pipe(Effect.scoped),
  )
})
