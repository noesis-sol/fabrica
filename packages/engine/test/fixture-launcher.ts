import { Effect, type Scope } from 'effect'
import { execFileSync } from 'node:child_process'
import { constants, openSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { Socket } from 'node:net'
import * as NodePath from 'node:path'

import { PATH } from './fixture-releases'

// A stand-in for the updated launcher, for the tests of the restart into an update (spec §9.2), which
// starts it detached and has no handle on it: what it was started with comes back through a FIFO.
//
// The launcher is /bin/sh, which takes the `serve` it is given for the script of that name in its working
// directory. A script written just now and exec'd itself waits on macOS before its first line runs, as each
// file does on its first exec, a copy or a file tar unpacks included: XProtect scans them one at a time for
// the whole machine, 150-190 ms each, so with 16 starting together one waits 2.4 s, and more as a loaded
// machine's suites start more, which took these tests past their limit (fab-q89, fab-0n1). /bin/sh isn't
// new, and reads the script as data, in 10 ms.
//
// The kernel keeps what is written to the FIFO until it is read, so it is there however late the test
// asks, where a folder's change events go to a watcher only once it is up. Opened for reading and writing,
// the FIFO neither blocks its opening nor ends before the launcher comes, and a read waits in the event
// loop, not on a thread that would hold the worker's exit where the launcher never writes.

export interface StubLauncher {
  /** The `launcher` to start, with the folder as its working directory. */
  readonly path: string
  /** What the launcher said: one line, once it has. */
  readonly said: Effect.Effect<string>
}

/**
 * A launcher in `folder` that says `printf` of `says`, where `$*` is its arguments, `serve` first, as a
 * launcher's own would be.
 */
export const stubLauncher = ({
  folder,
  says,
}: {
  readonly folder: string
  /** `printf`'s arguments, its format first, as shell source. */
  readonly says: string
}): Effect.Effect<StubLauncher, never, Scope.Scope> =>
  Effect.gen(function* () {
    const fifo = NodePath.join(folder, 'said')
    const reader = yield* Effect.acquireRelease(
      Effect.sync(() => {
        execFileSync('mkfifo', [fifo], { env: { PATH } })
        return new Socket({
          fd: openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK),
          readable: true,
          writable: false,
        })
      }),
      socket => Effect.sync(() => socket.destroy()),
    )
    yield* Effect.promise(() =>
      writeFile(
        NodePath.join(folder, 'serve'),
        `set -- "$0" "$@"\nprintf ${says} > '${fifo}'\n`,
      ),
    )
    return {
      path: '/bin/sh',
      said: Effect.callback<string>(resume => {
        let line = ''
        reader.on('error', error => resume(Effect.die(error)))
        reader.on('data', chunk => {
          line += chunk.toString()
          if (line.endsWith('\n')) resume(Effect.succeed(line))
        })
      }),
    }
  })
