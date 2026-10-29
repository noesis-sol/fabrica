import { Clock, Deferred, Duration, Effect, Fiber, Layer, Option } from 'effect'
import { TestClock } from 'effect/testing'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { CommitHash, TicketId, TreeHash } from '@fabrica/contracts'

import {
  type CheckInput,
  CheckOutcome,
  Checks,
  Leftovers,
  NotRun,
  checkLogPath,
  layer as checksLayer,
  suiteSetting,
} from '../src/checks'
import { layer as gitLayer } from '../src/git'
import {
  Deadlines,
  ExitStatus,
  type RunnerConfig,
  StartFailure,
  coreShareVariables,
  hostHolders,
  hostPriority,
  layerAwake,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import { layerWake, noSleepCauses } from '../src/time'

// The Checks service against real stub scripts and real git in temp folders (spec §13.7–§13.9, §24):
// the commands' PATH holds the test's stubs, git's folder and the system's tools, and the engine's
// environment holds variables that must never reach a check.

let root = ''
let home = ''
let bin = ''
let gitFolder = ''
let counter = 0

const fixtureEnv = () => ({
  PATH: `${gitFolder}:/usr/bin:/bin`,
  HOME: home,
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
})

/** Runs git for a test's fixture, its output trimmed. */
const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync('git', args, {
    cwd,
    env: fixtureEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

/** A folder of its own under the test's root. */
const folder = (name: string): string => {
  counter += 1
  const path = join(root, `${name}-${counter}`)
  mkdirSync(path)
  return path
}

/** A repository on `main` with `files` in one commit, its worktree to check, and a checkout for its logs. */
const project = (
  files: Readonly<Record<string, string>> = { 'README.md': 'one\n' },
) => {
  const worktree = folder('repo')
  git(worktree, 'init', '--quiet', '--initial-branch=main')
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(worktree, name), content)
  git(worktree, 'add', '--all')
  git(worktree, 'commit', '--quiet', '--message', 'one')
  const head = CommitHash.make(git(worktree, 'rev-parse', 'HEAD'))
  return { worktree, checkout: folder('checkout'), head }
}

const STUBS: Readonly<Record<string, string>> = {
  'check-pass': 'echo "out line"\necho "err line" >&2\n',
  'check-fail': 'echo failing\nexit 3\n',
  'check-env':
    'echo "cores=$FABRICA_CORES goflags=$GOFLAGS passed=${FABRICA_CHECK_OWN_PASSED_AT-unset} secret=${SECRET_TOKEN-unset} gitdir=${GIT_DIR-unset}"\n',
  'check-dirty':
    'echo changed >> README.md\necho more >> draft.txt\nmkdir -p out\necho report > out/report.txt\n',
  'check-touch': ': > "$1"\n',
  // Says it started by making `$1`, then waits until `$2` exists.
  'check-wait':
    'echo waiting\n: > "$1"\nwhile [ ! -e "$2" ]; do sleep 0.05; done\necho done\n',
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-checks-')))
  home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  bin = join(root, 'bin')
  mkdirSync(bin)
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}`)
    chmodSync(join(bin, name), 0o755)
  }
})

const runnerConfig = (path: string): RunnerConfig => ({
  hostEnvironment: {
    PATH: path,
    HOME: home,
    LANG: 'C',
    SECRET_TOKEN: 'never passed',
    GIT_DIR: '/elsewhere/.git',
  },
  enginePriority: 0,
  priority: hostPriority,
  listProcesses,
  pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
  self: process.pid,
  killGrace: Duration.seconds(2),
  outputGrace: Duration.millis(200),
})

const gitConfig = {
  timeLimit: Duration.minutes(1),
  readRetries: { times: 1, spacing: Duration.zero },
}

/** The Checks service, its commands found on `path` and timed by `deadlines`. */
const services = ({
  path = `${bin}:${gitFolder}:/usr/bin:/bin`,
  deadlines = layerClock,
}: {
  readonly path?: string
  readonly deadlines?: Layer.Layer<Deadlines>
} = {}) => {
  const runner = Layer.provide(runnerLayer(runnerConfig(path)), deadlines)
  return Layer.provide(
    checksLayer,
    Layer.merge(runner, Layer.provide(gitLayer(gitConfig), runner)),
  )
}

const ticket = TicketId.make('fa-a1b2')

const input = (
  given: Pick<CheckInput, 'worktree' | 'checkout' | 'command'> &
    Partial<CheckInput>,
): CheckInput => ({
  suite: 'merge',
  ticket: Option.some(ticket),
  timeLimit: Duration.hours(1),
  cores: 3,
  passedAt: Option.none(),
  nice: Option.none(),
  ...given,
})

const runCheck = (check: CheckInput) =>
  Effect.gen(function* () {
    return yield* (yield* Checks).run(check)
  })

/** Completes once `file` exists, on its folder's change events. */
const appears = (file: string): Effect.Effect<void> =>
  Effect.callback<void>(resume => {
    const watcher = watch(dirname(file), () => {
      if (existsSync(file)) resume(Effect.void)
    })
    if (existsSync(file)) resume(Effect.void)
    return Effect.sync(() => watcher.close())
  })

describe('a check that runs', () => {
  it.live('passes, its output kept in its log, stderr in order', () =>
    Effect.gen(function* () {
      const { worktree, checkout, head } = project()
      const outcome = yield* runCheck(
        input({ worktree, checkout, command: 'check-pass' }),
      )
      const log = join(checkout, '.fabrica/run/checks/fa-a1b2.merge.log')
      expect(outcome).toEqual(
        CheckOutcome.Passed({
          record: {
            kind: 'check',
            suite: 'merge',
            ticket,
            command: 'check-pass',
            commit: head,
            seconds: expect.any(Number),
            result: 'passed',
          },
          log,
          left: Leftovers.Seen({ changed: [], wrote: [] }),
        }),
      )
      expect(readFileSync(log, 'utf8')).toBe('out line\nerr line\n')
    }).pipe(Effect.provide(services())),
  )

  it.live('fails with its exit status, its record naming its log', () =>
    Effect.gen(function* () {
      const { worktree, checkout, head } = project()
      const outcome = yield* runCheck(
        input({ worktree, checkout, command: 'check-fail' }),
      )
      const log = join(checkout, '.fabrica/run/checks/fa-a1b2.merge.log')
      expect(outcome).toEqual(
        CheckOutcome.Failed({
          record: {
            kind: 'check',
            suite: 'merge',
            ticket,
            command: 'check-fail',
            commit: head,
            seconds: expect.any(Number),
            result: 'failed',
            output: '.fabrica/run/checks/fa-a1b2.merge.log',
          },
          log,
          left: Leftovers.Seen({ changed: [], wrote: [] }),
          status: ExitStatus.Code({ code: 3 }),
        }),
      )
      expect(readFileSync(log, 'utf8')).toBe('failing\n')
    }).pipe(Effect.provide(services())),
  )

  it.live(
    'gets the allowlisted environment, its core share and the last pass’s tree',
    () =>
      Effect.gen(function* () {
        const { worktree, checkout } = project()
        const tree = TreeHash.make('a'.repeat(40))
        const own = yield* runCheck(
          input({
            worktree,
            checkout,
            suite: 'own',
            command: 'check-env',
            passedAt: Option.some(tree),
          }),
        )
        expect(own._tag).toBe('Passed')
        expect(
          readFileSync(
            join(checkout, '.fabrica/run/checks/fa-a1b2.own.log'),
            'utf8',
          ),
        ).toBe(
          `cores=3 goflags=-p=3 passed=${tree} secret=unset gitdir=unset\n`,
        )

        // The run's own check: no ticket in its record or its log's name, and no pass's tree.
        const full = yield* runCheck(
          input({
            worktree,
            checkout,
            suite: 'full',
            ticket: Option.none(),
            command: 'check-env',
            cores: 1,
          }),
        )
        expect(full._tag).toBe('Passed')
        expect(CheckOutcome.$is('Passed')(full) && full.record.ticket).toBe(
          undefined,
        )
        expect(
          readFileSync(join(checkout, '.fabrica/run/checks/full.log'), 'utf8'),
        ).toBe('cores=1 goflags=-p=1 passed=unset secret=unset gitdir=unset\n')
      }).pipe(Effect.provide(services())),
  )
})

describe('what a check leaves', () => {
  it.live(
    'reports the tracked files it changed and the untracked files it wrote, not those there before',
    () =>
      Effect.gen(function* () {
        const { worktree, checkout } = project({
          'README.md': 'one\n',
          'draft.txt': 'draft\n',
        })
        // The worker's own uncommitted and untracked files, there before the check.
        writeFileSync(join(worktree, 'draft.txt'), 'draft, edited\n')
        writeFileSync(join(worktree, 'notes.txt'), 'notes\n')
        const outcome = yield* runCheck(
          input({
            worktree,
            checkout,
            suite: 'setup',
            command: 'check-dirty',
          }),
        )
        expect(outcome._tag).toBe('Passed')
        expect(CheckOutcome.$is('Passed')(outcome) && outcome.left).toEqual(
          Leftovers.Seen({ changed: ['README.md'], wrote: ['out/report.txt'] }),
        )
      }).pipe(Effect.provide(services())),
  )

  it.live('can’t tell what it left where git can’t read the status', () =>
    Effect.gen(function* () {
      const worktree = folder('not-a-repo')
      const checkout = folder('checkout')
      const outcome = yield* runCheck(
        input({ worktree, checkout, command: 'check-pass' }),
      )
      expect(outcome._tag).toBe('Passed')
      if (!CheckOutcome.$is('Passed')(outcome)) return
      expect(outcome.left._tag).toBe('CantTell')
      // HEAD couldn't be read: the record has no commit, never a made-up one.
      expect(outcome.record.commit).toBe(undefined)
    }).pipe(Effect.provide(services())),
  )
})

describe('a check that can’t run', () => {
  it.live('says a command that didn’t start, with the commit it was for', () =>
    Effect.gen(function* () {
      const { worktree, checkout, head } = project()
      const outcome = yield* runCheck(
        input({ worktree, checkout, command: 'check-pass' }),
      )
      expect(outcome).toEqual(
        CheckOutcome.CouldNotRun({
          record: {
            kind: 'check',
            suite: 'merge',
            ticket,
            command: 'check-pass',
            commit: head,
            seconds: 0,
            result: 'not_run',
          },
          reason: NotRun.DidNotStart({
            reason: StartFailure.NotOnPath({ command: 'sh', path: gitFolder }),
          }),
        }),
      )
    }).pipe(Effect.provide(services({ path: gitFolder }))),
  )

  it.live('refuses a command holding a newline or a control character', () =>
    Effect.gen(function* () {
      const { worktree, checkout } = project()
      for (const command of ['check-pass\ncheck-fail', 'check-pass\u0007']) {
        const outcome = yield* runCheck(input({ worktree, checkout, command }))
        expect(outcome).toEqual(
          CheckOutcome.CouldNotRun({
            record: {
              kind: 'check',
              suite: 'merge',
              ticket,
              command,
              seconds: 0,
              result: 'not_run',
            },
            reason: NotRun.CommandRefused({ command }),
          }),
        )
      }
      expect(existsSync(join(checkout, '.fabrica'))).toBe(false)
    }).pipe(Effect.provide(services())),
  )

  it.live(
    'refuses a log that is a link, never running the command or writing through it',
    () =>
      Effect.gen(function* () {
        const { worktree, checkout } = project()
        const target = join(folder('elsewhere'), 'config')
        writeFileSync(target, 'precious\n')
        const log = join(checkout, '.fabrica/run/checks/fa-a1b2.merge.log')
        mkdirSync(dirname(log), { recursive: true })
        symlinkSync(target, log)
        const ran = join(root, `ran-${counter}`)
        const outcome = yield* runCheck(
          input({ worktree, checkout, command: `check-touch ${ran}` }),
        )
        expect(outcome._tag).toBe('CouldNotRun')
        expect(
          CheckOutcome.$is('CouldNotRun')(outcome) && outcome.reason._tag,
        ).toBe('LogNotKept')
        expect(existsSync(ran)).toBe(false)
        expect(readFileSync(target, 'utf8')).toBe('precious\n')
      }).pipe(Effect.provide(services())),
  )
})

// --- Time awake ------------------------------------------------------------------------------

const LIMIT = Duration.minutes(30)

/**
 * The test's host on `TestClock`: a wall clock that can jump while the timers stand still, as a
 * host's does while it sleeps.
 */
const makeHost = Effect.gen(function* () {
  const testClock = yield* TestClock.testClockWith(Effect.succeed)
  let shift = BigInt(0)
  const wallNanos = () => testClock.currentTimeNanosUnsafe() + shift
  const wallMillis = () => Number(wallNanos() / BigInt(1_000_000))
  const clock: TestClock.TestClock = {
    ...testClock,
    currentTimeMillisUnsafe: wallMillis,
    currentTimeMillis: Effect.sync(wallMillis),
    currentTimeNanosUnsafe: wallNanos,
    currentTimeNanos: Effect.sync(wallNanos),
  }
  return {
    clock,
    /** The host sleeps for `span`: the wall clock moves on, the timers don't. */
    sleeps: (span: Duration.Input) =>
      Effect.sync(() => {
        shift += Duration.toNanosUnsafe(Duration.fromInputUnsafe(span))
      }),
  }
})

/**
 * Deadlines in time awake on the host's clock, the wake service's, saying when the check's time
 * limit begins; the check runs on the live clock, so its tree's end polls in real time.
 */
const awakeDeadlines = (began: Deferred.Deferred<void>) =>
  Layer.effect(
    Deadlines,
    Effect.gen(function* () {
      const inner = yield* Deadlines
      return Deadlines.of({
        sleep: duration =>
          Duration.equals(Duration.fromInputUnsafe(duration), LIMIT)
            ? Effect.andThen(
                Deferred.succeed(began, undefined),
                inner.sleep(duration),
              )
            : inner.sleep(duration),
      })
    }),
  ).pipe(
    Layer.provide(layerAwake),
    Layer.provide(layerWake),
    Layer.provide(noSleepCauses),
  )

/**
 * Starts `check-wait` with a 30-minute limit on a host that then sleeps 40 minutes and is awake
 * `awake` more; gives the fiber, and the file that lets the check end.
 */
const sleepThrough = (awake: Duration.Input) =>
  Effect.gen(function* () {
    const host = yield* makeHost
    const began = yield* Deferred.make<void>()
    const { worktree, checkout } = project()
    const started = join(root, `started-${counter}`)
    const go = join(root, `go-${counter}`)
    const services_ = services({ deadlines: awakeDeadlines(began) })
    return yield* Effect.gen(function* () {
      const checks = yield* Checks
      const fiber = yield* Effect.forkChild(
        TestClock.withLive(
          checks.run(
            input({
              worktree,
              checkout,
              command: `check-wait ${started} ${go}`,
              timeLimit: LIMIT,
            }),
          ),
        ),
      )
      yield* appears(started)
      yield* Deferred.await(began)
      yield* host.sleeps(Duration.minutes(40))
      yield* TestClock.adjust(Duration.seconds(1))
      yield* TestClock.adjust(awake)
      return { fiber, go, checkout }
    }).pipe(
      Effect.provide(services_),
      Effect.provideService(Clock.Clock, host.clock),
    )
  })

describe('a check’s time limit', () => {
  it.effect('isn’t spent by the host’s sleep', () =>
    Effect.gen(function* () {
      const { fiber, go } = yield* sleepThrough(Duration.minutes(29))
      writeFileSync(go, '')
      const outcome = yield* Fiber.join(fiber)
      expect(outcome._tag).toBe('Passed')
    }),
  )

  it.effect('runs out in time awake, its tree ended and its output kept', () =>
    Effect.gen(function* () {
      const { fiber, checkout } = yield* sleepThrough(Duration.minutes(30))
      const outcome = yield* Fiber.join(fiber)
      const log = join(checkout, '.fabrica/run/checks/fa-a1b2.merge.log')
      expect(outcome._tag).toBe('TimedOut')
      expect(
        CheckOutcome.$is('TimedOut')(outcome) && outcome.record,
      ).toMatchObject({
        result: 'timed_out',
        output: '.fabrica/run/checks/fa-a1b2.merge.log',
      })
      expect(readFileSync(log, 'utf8')).toBe('waiting\n')
    }),
  )
})

describe('which command a suite runs', () => {
  it('runs check_fast for the merge check, its recheck, a fix and a pre-flight', () => {
    expect(suiteSetting('own')).toBe('check_own')
    for (const suite of ['merge', 'recheck', 'fix', 'base'] as const)
      expect(suiteSetting(suite)).toBe('check_fast')
    expect(suiteSetting('full')).toBe('check_full')
    expect(suiteSetting('setup')).toBe('setup')
  })

  it('names a log by its ticket and suite, the run’s own by its suite', () => {
    expect(checkLogPath({ suite: 'fix', ticket: Option.some(ticket) })).toBe(
      '.fabrica/run/checks/fa-a1b2.fix.log',
    )
    expect(checkLogPath({ suite: 'setup', ticket: Option.none() })).toBe(
      '.fabrica/run/checks/setup.log',
    )
    expect(coreShareVariables(4)).toEqual({
      FABRICA_CORES: '4',
      GOFLAGS: '-p=4',
    })
  })
})
