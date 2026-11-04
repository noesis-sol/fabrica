import { Effect, Fiber } from 'effect'
import { mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'

import { readFileTail, readFileText } from '../src/files'
import { readPassphraseFile } from '../src/secrets/file'

// A read interrupted at any point closes what it opened (spec §7.1, H77), as a write does
// (files-write-interrupted.test.ts): a handle left to the garbage collector is an uncaught error on the
// Node the project pins, which a run's settings read, interrupted as the run stopped, ended a test file with.

/** The file descriptors this process holds. */
const openDescriptors = () => readdirSync('/dev/fd').length

/** Waits a turn of the event loop `turns` times, so a read gets as far as those turns take it. */
const turnsOf = (turns: number) =>
  Effect.forEach(
    Array.from({ length: turns }),
    () =>
      Effect.callback<void>(resume => {
        setImmediate(() => resume(Effect.void))
      }),
    { discard: true },
  )

describe('a read of a file', () => {
  const reads: ReadonlyArray<{
    readonly name: string
    readonly read: (root: string) => Effect.Effect<unknown, unknown>
  }> = [
    {
      name: 'whole',
      read: root => readFileText({ root, path: 'state.json' }),
    },
    {
      name: 'by its tail',
      read: root => readFileTail({ root, path: 'state.json' }, 2),
    },
    {
      name: 'of a passphrase',
      read: root => readPassphraseFile(join(root, 'state.json')),
    },
  ]

  for (const { name, read } of reads)
    it.live(
      `${name} closes what it opened however early it is interrupted`,
      () =>
        Effect.gen(function* () {
          const root = realpathSync(
            mkdtempSync(join(tmpdir(), 'fabrica-read-interrupted-')),
          )
          writeFileSync(join(root, 'state.json'), '{"a":1}\n', { mode: 0o600 })
          // The first read opens what the module opens once.
          yield* Effect.ignore(read(root))
          const before = openDescriptors()
          yield* Effect.forEach(
            Array.from({ length: 40 }, (_, turns) => turns),
            turns =>
              Effect.gen(function* () {
                const reading = yield* Effect.forkChild(read(root))
                yield* turnsOf(turns)
                yield* Fiber.interrupt(reading)
              }),
            { discard: true },
          )
          // Closes under way have ended by the next turns of the loop.
          yield* turnsOf(50)
          expect(openDescriptors()).toBe(before)
        }),
    )
})
