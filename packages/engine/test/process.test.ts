import { Deferred, Duration, Effect, Layer, Option, Ref, Stream } from 'effect'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { getPriority, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'

import {
  CommandOutcome,
  Deadlines,
  type DeadlinesShape,
  ExitStatus,
  GIT_LOCAL_VARIABLES,
  type PriorityControl,
  type ProcessRow,
  ProcessRunner,
  type RunnerConfig,
  StartFailure,
  commandEnvironment,
  hostHolders,
  hostPriority,
  layer,
  layerClock,
  listProcesses,
  parseLsof,
  parseProcessTable,
  treeOf,
} from '../src/process'

// The process runner against real child processes in a temp folder (spec §24): the test's PATH holds
// its own stubs, the Node running it and the system's tools, and nothing of its host's environment.

let root = ''
let bin = ''
let grandparent = ''

/** A script that starts a grandchild in a process group of its own, says both pids, and waits. */
const GRANDPARENT = `import { spawn } from 'node:child_process'
import { renameSync, writeFileSync } from 'node:fs'
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,
  stdio: 'ignore',
})
const pids = process.pid + ' ' + grandchild.pid + '\\n'
process.stdout.write(pids)
const ready = process.argv[2]
if (ready !== undefined) {
  writeFileSync(ready + '.tmp', pids)
  renameSync(ready + '.tmp', ready)
}
setInterval(() => {}, 1000)
`

/** A script that starts a grandchild in a group of its own, holding its stdout, says its pid, and exits. */
const DETACHER = `import { spawn } from 'node:child_process'
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,
  stdio: ['ignore', 'inherit', 'ignore'],
})
grandchild.unref()
process.stdout.write(grandchild.pid + '\\n')
`
let detacher = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'fabrica-process-'))
  bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'stub-tool'), '#!/bin/sh\necho "stub-tool $*"\n')
  chmodSync(join(bin, 'stub-tool'), 0o755)
  grandparent = join(root, 'grandparent.mjs')
  writeFileSync(grandparent, GRANDPARENT)
  detacher = join(root, 'detacher.mjs')
  writeFileSync(detacher, DETACHER)
})

const PATH = () => `${dirname(process.execPath)}:/usr/bin:/bin`

const config = (overrides: Partial<RunnerConfig> = {}): RunnerConfig => ({
  hostEnvironment: {
    PATH: PATH(),
    HOME: root,
    LANG: 'C',
    CLAUDECODE: '1',
    SECRET_TOKEN: 'never passed',
    GIT_DIR: '/elsewhere/.git',
    GIT_INDEX_FILE: '/elsewhere/.git/index',
  },
  enginePriority: 0,
  priority: hostPriority,
  listProcesses,
  // Where the host finds who holds a pipe is a platform fact (spec §24): lsof on macOS, /proc on Linux.
  pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
  self: process.pid,
  killGrace: Duration.seconds(2),
  outputGrace: Duration.millis(200),
  ...overrides,
})

const runner = (
  overrides: Partial<RunnerConfig> = {},
  deadlines = layerClock,
) => Layer.provide(layer(config(overrides)), deadlines)

const HOUR = Duration.hours(1)

/** Completes once `file` exists, on the folder's change events. */
const appears = (file: string): Effect.Effect<void> =>
  Effect.callback<void>(resume => {
    const watcher = watch(dirname(file), () => {
      if (existsSync(file)) resume(Effect.void)
    })
    if (existsSync(file)) resume(Effect.void)
    return Effect.sync(() => watcher.close())
  })

/** Deadlines whose hour-long time limits run out once `file` appears; the rest on Effect's Clock. */
const limitAt = (file: string): Layer.Layer<Deadlines> =>
  Layer.succeed(Deadlines, {
    sleep: duration =>
      Duration.equals(Duration.fromInputUnsafe(duration), HOUR)
        ? appears(file)
        : Effect.sleep(duration),
  } satisfies DeadlinesShape)

/** Whether `pid` is a live process: listed, and not a zombie. */
const alive = (pid: number) =>
  Effect.map(listProcesses, rows =>
    Option.getOrThrow(rows).some(row => row.pid === pid && !row.zombie),
  )

const pidsOf = (text: string): ReadonlyArray<number> =>
  text.trim().split(/\s+/).map(Number)

describe('commandEnvironment', () => {
  it('keeps allowlisted names and the caller’s, and never git’s local variables', () => {
    const environment = commandEnvironment({
      host: {
        PATH: '/usr/bin',
        HOME: '/home/a',
        LC_CTYPE: 'C.UTF-8',
        CLAUDECODE: '1',
        TERM_SESSION_ID: 'x',
        ANTHROPIC_API_KEY: 'secret',
        GIT_DIR: '/elsewhere/.git',
        GIT_WORK_TREE: '/elsewhere',
        UNSET: undefined,
      },
      extra: {
        FABRICA_CORES: '2',
        GIT_TERMINAL_PROMPT: '0',
        GIT_INDEX_FILE: '/x/index',
      },
    })
    expect(environment).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/a',
      LC_CTYPE: 'C.UTF-8',
      FABRICA_CORES: '2',
      GIT_TERMINAL_PROMPT: '0',
    })
  })

  it('lets the caller’s PATH win over the engine’s', () => {
    expect(
      commandEnvironment({
        host: { PATH: '/usr/bin' },
        extra: { PATH: '/tools:/usr/bin' },
      }),
    ).toEqual({ PATH: '/tools:/usr/bin' })
  })

  it('names every variable git 2.38 lists as local', () => {
    for (const name of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_COMMON_DIR',
    ]) {
      expect(GIT_LOCAL_VARIABLES.has(name)).toBe(true)
    }
  })
})

describe('the process tree', () => {
  const row = (
    pid: number,
    ppid: number,
    pgid: number,
    zombie = false,
  ): ProcessRow => ({
    pid,
    ppid,
    pgid,
    zombie,
  })

  it('reads ps output, zombies marked', () => {
    expect(
      parseProcessTable('  10     1    10 Ss\n  11    10    10 Z+\nPID\n'),
    ).toEqual([row(10, 1, 10), row(11, 10, 10, true)])
  })

  it('takes the group’s members, the named processes and their descendants, never zombies', () => {
    const rows = [
      row(1, 0, 1),
      row(100, 1, 100), // the command
      row(101, 100, 101), // a worker in a group of its own
      row(102, 101, 101), // its child
      row(103, 1, 100), // left behind in the command's group
      row(104, 103, 104), // started by what was left behind, in a group of its own
      row(105, 100, 100, true), // exited, not yet reaped
      row(200, 1, 200), // unrelated
    ]
    const pids = treeOf({
      rows,
      pids: new Set([100]),
      groups: new Set([100]),
    }).map(r => r.pid)
    expect(pids.toSorted((a, b) => a - b)).toEqual([100, 101, 102, 103, 104])
  })
})

describe('the holders of a pipe', () => {
  it('reads lsof output into each process’s devices and names', () => {
    expect(parseLsof('p10\nf1\nd0xab\nn->0xcd\np11\nf0\nn/dev/null\n')).toEqual(
      [
        { pid: 10, devices: ['0xab'], names: ['->0xcd'] },
        { pid: 11, devices: [], names: ['/dev/null'] },
      ],
    )
  })
})

describe('ProcessRunner.run', () => {
  it.live(
    'runs a command found on the PATH it will run with, its output and exit code',
    () =>
      Effect.gen(function* () {
        const { run } = yield* ProcessRunner
        const outcome = yield* run({
          command: 'stub-tool',
          args: ['a', 'b'],
          cwd: root,
          env: { PATH: `${bin}:${PATH()}` },
          timeLimit: HOUR,
        })
        expect(outcome).toEqual(
          CommandOutcome.Exited({
            status: ExitStatus.Code({ code: 0 }),
            stdout: 'stub-tool a b\n',
            stderr: '',
          }),
        )
        const missing = yield* run({
          command: 'stub-tool',
          args: [],
          cwd: root,
          timeLimit: HOUR,
        })
        expect(missing).toEqual(
          CommandOutcome.FailedToStart({
            reason: StartFailure.NotOnPath({
              command: 'stub-tool',
              path: PATH(),
            }),
          }),
        )
      }).pipe(Effect.provide(runner())),
  )

  it.live(
    'says a command that exits on a signal, and one the system refused to start',
    () =>
      Effect.gen(function* () {
        const { run } = yield* ProcessRunner
        const signalled = yield* run({
          command: 'sh',
          args: ['-c', 'echo partial >&2; kill -TERM $$'],
          cwd: root,
          timeLimit: HOUR,
        })
        expect(signalled).toEqual(
          CommandOutcome.Exited({
            status: ExitStatus.Signal({ signal: 'SIGTERM' }),
            stdout: '',
            stderr: 'partial\n',
          }),
        )
        const refused = yield* run({
          command: 'sh',
          args: ['-c', 'true'],
          cwd: join(root, 'no-such-folder'),
          timeLimit: HOUR,
        })
        expect(refused._tag === 'FailedToStart' && refused.reason._tag).toBe(
          'SpawnFailed',
        )
      }).pipe(Effect.provide(runner())),
  )

  it.live(
    'passes only allowlisted names and the caller’s, never GIT_DIR, and stdin from /dev/null',
    () =>
      Effect.gen(function* () {
        const { run } = yield* ProcessRunner
        const outcome = yield* run({
          command: 'node',
          args: [
            '-e',
            'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()) + "\\n" + require("node:fs").readFileSync(0, "utf8").length)',
          ],
          cwd: root,
          env: { FABRICA_CORES: '2', GIT_DIR: '/elsewhere/.git' },
          timeLimit: HOUR,
        })
        if (outcome._tag !== 'Exited') return yield* Effect.die(outcome)
        const [names, stdin] = outcome.stdout.split('\n')
        // macOS gives every process __CF_USER_TEXT_ENCODING itself, whatever its parent passed.
        const platform =
          process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : []
        expect(JSON.parse(names ?? '')).toEqual([
          'FABRICA_CORES',
          'HOME',
          'LANG',
          'PATH',
          ...platform,
        ])
        expect(stdin).toBe('0')
      }).pipe(Effect.provide(runner())),
  )

  it.live(
    'ends the whole tree when the time limit, counted by the deadlines, runs out',
    () => {
      const ready = join(root, 'run-limit.ready')
      return Effect.gen(function* () {
        const { run } = yield* ProcessRunner
        const outcome = yield* run({
          command: 'node',
          args: [grandparent, ready],
          cwd: root,
          timeLimit: HOUR,
        })
        if (outcome._tag !== 'TimedOut') return yield* Effect.die(outcome)
        const [child = 0, grandchild = 0] = pidsOf(outcome.stdout)
        expect(grandchild).toBeGreaterThan(0)
        expect(yield* alive(child)).toBe(false)
        expect(yield* alive(grandchild)).toBe(false)
      }).pipe(Effect.provide(runner({}, limitAt(ready))))
    },
  )

  it.live(
    'stops reading a grace after the command exits, and ends what it left holding the pipes',
    () =>
      Effect.gen(function* () {
        const { run } = yield* ProcessRunner
        const outcome = yield* run({
          command: 'sh',
          args: ['-c', 'sleep 600 & echo $!'],
          cwd: root,
          timeLimit: HOUR,
        })
        if (outcome._tag !== 'Exited') return yield* Effect.die(outcome)
        expect(outcome.status).toEqual(ExitStatus.Code({ code: 0 }))
        const [sleeper = 0] = pidsOf(outcome.stdout)
        expect(sleeper).toBeGreaterThan(0)
        expect(yield* alive(sleeper)).toBe(false)
      }).pipe(Effect.provide(runner())),
  )

  it.live(
    'ends a child in a group of its own still holding the pipes after its parent exited',
    () =>
      Effect.gen(function* () {
        const { run } = yield* ProcessRunner
        const outcome = yield* run({
          command: 'node',
          args: [detacher],
          cwd: root,
          timeLimit: HOUR,
        })
        if (outcome._tag !== 'Exited') return yield* Effect.die(outcome)
        expect(outcome.status).toEqual(ExitStatus.Code({ code: 0 }))
        const [detached = 0] = pidsOf(outcome.stdout)
        expect(detached).toBeGreaterThan(0)
        expect(yield* alive(detached)).toBe(false)
      }).pipe(Effect.provide(runner())),
  )

  it.live(
    'ends what a command left in its group, though it closed its pipes',
    () =>
      Effect.gen(function* () {
        const { run } = yield* ProcessRunner
        const outcome = yield* run({
          command: 'sh',
          args: ['-c', 'sleep 600 >/dev/null 2>&1 & echo $!'],
          cwd: root,
          timeLimit: HOUR,
        })
        if (outcome._tag !== 'Exited') return yield* Effect.die(outcome)
        const [sleeper = 0] = pidsOf(outcome.stdout)
        expect(sleeper).toBeGreaterThan(0)
        expect(yield* alive(sleeper)).toBe(false)
      }).pipe(Effect.provide(runner())),
  )

  it.live(
    'cuts a command whose output passes the cap, never returning its output',
    () =>
      Effect.gen(function* () {
        const { run } = yield* ProcessRunner
        const outcome = yield* run({
          command: 'yes',
          args: [],
          cwd: root,
          timeLimit: HOUR,
          outputLimit: 64 * 1024,
        })
        expect(outcome).toEqual(
          CommandOutcome.Cut({ stream: 'stdout', limit: 64 * 1024 }),
        )
      }).pipe(Effect.provide(runner())),
  )
})

describe('ProcessRunner.start', () => {
  it.live('ends a grandchild in a group of its own with its command', () =>
    Effect.gen(function* () {
      const { start } = yield* ProcessRunner
      const [child = 0, grandchild = 0] = yield* Effect.scoped(
        Effect.gen(function* () {
          const running = yield* start({
            command: 'node',
            args: [grandparent],
            cwd: root,
            stdin: 'null',
          })
          const line = yield* running.stdout.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.runHead,
          )
          const pids = pidsOf(Option.getOrThrow(line))
          expect(pids[0]).toBe(running.pid)
          expect(yield* alive(pids[1] ?? 0)).toBe(true)
          return pids
        }),
      )
      expect(yield* alive(child)).toBe(false)
      expect(yield* alive(grandchild)).toBe(false)
    }).pipe(Effect.provide(runner())),
  )

  it.live(
    'writes to a piped stdin and streams the output until the command exits',
    () =>
      Effect.gen(function* () {
        const { start } = yield* ProcessRunner
        const running = yield* start({
          command: 'cat',
          args: [],
          cwd: root,
          stdin: 'pipe',
        })
        yield* running.write('one\ntwo\n')
        yield* running.closeStdin
        const output = yield* running.stdout.pipe(
          Stream.decodeText,
          Stream.mkString,
        )
        expect(output).toBe('one\ntwo\n')
        expect(yield* running.exit).toEqual(ExitStatus.Code({ code: 0 }))
        const closed = yield* Effect.flip(running.write('three\n'))
        expect(closed._tag).toBe('StdinClosed')
      }).pipe(Effect.scoped, Effect.provide(runner())),
  )

  it.live('fails a command not on the PATH as StartFailed', () =>
    Effect.gen(function* () {
      const { start } = yield* ProcessRunner
      const failure = yield* Effect.flip(
        start({ command: 'no-such-tool', args: [], cwd: root, stdin: 'null' }),
      )
      expect(failure.reason).toEqual(
        StartFailure.NotOnPath({ command: 'no-such-tool', path: PATH() }),
      )
    }).pipe(Effect.scoped, Effect.provide(runner())),
  )
})

describe('the nice value', () => {
  it.live('is applied as the command starts', () =>
    Effect.gen(function* () {
      const { start } = yield* ProcessRunner
      const running = yield* start({
        command: 'node',
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: root,
        stdin: 'null',
        nice: 19,
      })
      expect(getPriority(running.pid)).toBe(19)
    }).pipe(Effect.scoped, Effect.provide(runner())),
  )

  /** A priority control over recorded values: `reads` in turn, then the last set. */
  const recorded = (reads: ReadonlyArray<number>) =>
    Effect.gen(function* () {
      const sets = yield* Ref.make<ReadonlyArray<number>>([])
      const second = yield* Deferred.make<void>()
      const queue = [...reads]
      const control: PriorityControl = {
        get: () => Effect.succeed(Option.fromUndefinedOr(queue.shift())),
        set: (_pid, nice) =>
          Effect.gen(function* () {
            const all = yield* Ref.updateAndGet(sets, values => [
              ...values,
              nice,
            ])
            if (all.length === 2) yield* Deferred.succeed(second, undefined)
            return true
          }),
      }
      return { sets, second, control }
    })

  it.live('is set again where something raised it back 100 ms later', () =>
    Effect.gen(function* () {
      const { sets, second, control } = yield* recorded([10, -10])
      yield* Effect.gen(function* () {
        const { start } = yield* ProcessRunner
        yield* start({
          command: 'node',
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: root,
          stdin: 'null',
          nice: 10,
        })
        yield* Deferred.await(second)
      }).pipe(Effect.scoped, Effect.provide(runner({ priority: control })))
      expect(yield* Ref.get(sets)).toEqual([10, 10])
    }),
  )

  it.live('never raises a priority where the engine runs lower', () =>
    Effect.gen(function* () {
      const { sets, control } = yield* recorded([])
      const outcome = yield* Effect.gen(function* () {
        const { run } = yield* ProcessRunner
        return yield* run({
          command: 'true',
          args: [],
          cwd: root,
          timeLimit: HOUR,
          nice: 10,
        })
      }).pipe(Effect.provide(runner({ priority: control, enginePriority: 15 })))
      expect(outcome._tag).toBe('Exited')
      expect(yield* Ref.get(sets)).toEqual([])
    }),
  )
})
