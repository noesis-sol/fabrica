import { Effect, Option } from 'effect'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'

import { notePid, notedPid, stopNotedProcess, tempFolder } from '../src'

// A fixture process noting its PID for the test to stop it by: only a PID read whole is signalled, so
// a file read before the fixture wrote it can't name 0, the test runner's own process group.

describe('a noted PID', () => {
  it('is read where it is a whole number above 1, and nothing else', () => {
    expect(notedPid('4242')).toEqual(Option.some(4242))
    expect(notedPid('4242\n')).toEqual(Option.some(4242))
    for (const text of ['', '\n', '0', '1', '-4242', '42a', '4.2', 'NaN']) {
      expect(notedPid(text)).toEqual(Option.none())
    }
  })
})

describe('stopping a noted process', () => {
  it.live('does nothing where no PID was noted', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folder = yield* tempFolder('noted')
        yield* stopNotedProcess(NodePath.join(folder, 'missing.pid'))
      }),
    ),
  )

  it.live('terminates the process by the PID it noted, written whole', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folder = yield* tempFolder('noted')
        const file = NodePath.join(folder, 'fixture.pid')
        const fixture = spawn(
          process.execPath,
          [
            '-e',
            `const fs = require('node:fs'); const file = process.argv[1]; ${notePid('file')}; console.log('noted'); setInterval(() => {}, 1000)`,
            file,
          ],
          { stdio: ['ignore', 'pipe', 'inherit'] },
        )
        yield* Effect.addFinalizer(() => Effect.sync(() => fixture.kill()))
        yield* Effect.callback<void>(resume => {
          fixture.stdout.once('data', () => resume(Effect.void))
        })
        expect(yield* Effect.promise(() => readFile(file, 'utf8'))).toBe(
          String(fixture.pid),
        )
        // Listened for before the signal, so an exit as quick as it is can't be missed.
        const exited = new Promise<NodeJS.Signals | null>(resolve => {
          fixture.once('exit', (_code, signal) => resolve(signal))
        })
        yield* stopNotedProcess(file)
        expect(yield* Effect.promise(() => exited)).toBe('SIGTERM')
      }),
    ),
  )
})
