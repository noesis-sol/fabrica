import { Effect, Fiber } from 'effect'
import { mkdtempSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'

import { writeFileWhole } from '../src/files'

// A write interrupted at any point closes what it opened (spec §13.10: a stop interrupts a run's writes
// of its state): a handle left to the garbage collector is an uncaught error on the Node the project pins.

/** The file descriptors this process holds. */
const openDescriptors = () => readdirSync('/dev/fd').length

/** Waits a turn of the event loop `turns` times, so a write gets as far as those turns take it. */
const turnsOf = (turns: number) =>
  Effect.forEach(
    Array.from({ length: turns }),
    () =>
      Effect.callback<void>(resume => {
        setImmediate(() => resume(Effect.void))
      }),
    { discard: true },
  )

describe('a whole-file write', () => {
  it.live('closes what it opened however early it is interrupted', () =>
    Effect.gen(function* () {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), 'fabrica-write-interrupted-')),
      )
      // The first write opens what the module opens once.
      yield* writeFileWhole({ root, path: 'first.json' }, '{}')
      const before = openDescriptors()
      yield* Effect.forEach(
        Array.from({ length: 40 }, (_, turns) => turns),
        turns =>
          Effect.gen(function* () {
            const write = yield* Effect.forkChild(
              writeFileWhole({ root, path: 'state.json' }, '{"a":1}'),
            )
            yield* turnsOf(turns)
            yield* Fiber.interrupt(write)
          }),
        { discard: true },
      )
      // Closes under way have ended by the next turns of the loop.
      yield* turnsOf(50)
      expect(openDescriptors()).toBe(before)
    }),
  )
})
