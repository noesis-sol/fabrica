import { Duration, Effect, Fiber, Layer, Ref, Stream } from 'effect'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  Assignee,
  CommandSetting,
  CommitHash,
  EngineId,
  SessionId,
  type TicketId,
  defaultSetupFiles,
} from '@fabrica/contracts'

import { layer as checksLayer } from '../src/checks'
import {
  Git,
  type GitConfig,
  type Worktree,
  Worktrees,
  besideCheckout,
  layer as gitLayer,
  worktreesLayer,
} from '../src/git'
import {
  type MergeConfig,
  MergeOutcome,
  MergeSetup,
  type MergeUpdate,
  MergeWaits,
  SetupOutcome,
  make as makeQueue,
  noSetup,
  wroteRecorded,
} from '../src/merge'
import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'

// The untracked files the merge queue's setups and checks write in a ticket's worktree (spec §13.7
// What a check leaves, fab-mgi.34), against real git in temp folders and real check scripts: recorded
// as the queue's however the setup or check ends, never taken for its worker's at `enter`, and removed
// as the ticket is set aside, so it goes back with its worker's own files only.

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

const hash = (cwd: string, revision: string): CommitHash =>
  CommitHash.make(git(cwd, 'rev-parse', '--verify', `${revision}^{commit}`))

/** Writes `files` in `cwd` and commits them as `message`, returning the commit. */
const commit = (
  cwd: string,
  message: string,
  files: Readonly<Record<string, string>>,
): CommitHash => {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true })
    writeFileSync(join(cwd, name), content)
  }
  git(cwd, 'add', '--', ...Object.keys(files))
  git(cwd, 'commit', '--quiet', '--message', message)
  return hash(cwd, 'HEAD')
}

/** A new checkout on `main` with one commit, in a folder of its own. */
const repository = () => {
  counter += 1
  const checkout = join(root, `repo-${counter}`)
  mkdirSync(checkout)
  git(checkout, 'init', '--quiet', '--initial-branch=main')
  commit(checkout, 'one', {
    'README.md': 'one\n',
    '.gitignore': 'node_modules/\n',
    'src/a.ts': 'export const a = 1\n',
  })
  return checkout
}

const freshPath = (name: string): string => {
  counter += 1
  return join(root, `${name}-${counter}`)
}

// Each writes an untracked report, in a folder of its own, and an ignored folder, as a coverage report
// and dependencies do.
const WRITES =
  'mkdir -p reports; echo report > reports/coverage.txt; mkdir -p node_modules/pkg; echo x > node_modules/pkg/index.js\n'

const STUBS: Readonly<Record<string, string>> = {
  'check-writes': `${WRITES}echo passing\n`,
  'check-writes-fails': `${WRITES}echo failing\nexit 3\n`,
  // Says it started in the folder `$1`, then waits for `$1/release`.
  'check-writes-holds': `${WRITES}: > "$1/started"\nwhile [ ! -e "$1/release" ]; do sleep 0.05; done\necho passing\n`,
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-wrote-')))
  home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n[init]\n\tdefaultBranch = main\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  bin = join(root, 'bin')
  mkdirSync(bin)
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}`)
    chmodSync(join(bin, name), 0o755)
  }
})

const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: {
    PATH: `${bin}:${gitFolder}:/usr/bin:/bin`,
    HOME: home,
    LANG: 'C',
  },
  enginePriority: 0,
  priority: hostPriority,
  listProcesses,
  pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
  self: process.pid,
  killGrace: Duration.seconds(2),
  outputGrace: Duration.millis(200),
})

const gitConfig: GitConfig = {
  timeLimit: Duration.minutes(1),
  readRetries: { times: 1, spacing: Duration.zero },
}

/** The services a merge runs on, a fresh work graph among them; `setup` the setup port. */
const services = (setup: Layer.Layer<MergeSetup> = noSetup) => {
  const runner = Layer.provide(runnerLayer(runnerConfig()), layerClock)
  const gitServices = Layer.provideMerge(
    worktreesLayer,
    Layer.provide(gitLayer(gitConfig), runner),
  )
  const graph = Layer.effect(WorkGraph, makeWorkGraph({ prefix: 'fa' })).pipe(
    Layer.provide(storeLayer(':memory:')),
  )
  return Layer.mergeAll(
    gitServices,
    Layer.provide(checksLayer, Layer.merge(runner, gitServices)),
    graph,
    setup,
    // No test sleeps: a refused fast-forward is tried again at once, and a dirty checkout isn't polled.
    Layer.succeed(MergeWaits, { beforeRetry: Effect.void, poll: Effect.never }),
  )
}

const engine = EngineId.make('engine-1')
const actor: Actor = { _tag: 'engine', engine }

const config = (checkout: string, check: string): MergeConfig => ({
  home: besideCheckout(checkout),
  base: 'main',
  checkFast: CommandSetting.cases.Command.make({ command: check }),
  checkTimeout: Duration.minutes(1),
  setupFiles: defaultSetupFiles,
  handBacks: { resolve: 0, fix: 0, timeout: Duration.minutes(20) },
  train: 1,
  cores: 1,
  actor,
})

/** A ticket filed and claimed, its worktree made from Base's head and `files` committed in it. */
const ticketWorktree = (
  checkout: string,
  files: Readonly<Record<string, string>> = {
    'src/b.ts': 'export const b = 2\n',
  },
) =>
  Effect.gen(function* () {
    const graph = yield* WorkGraph
    const worktrees = yield* Worktrees
    const ticket = yield* graph.create({
      ticket: { type: 'task', title: 'A change' },
      actor,
    })
    yield* graph.claim({
      id: ticket.id,
      assignee: new Assignee({ engine, session: SessionId.make('session-1') }),
      actor,
    })
    const prepared = yield* worktrees.prepare({
      home: besideCheckout(checkout),
      ticket: ticket.id,
      base: hash(checkout, 'main'),
    })
    const worktree = prepared.worktree
    return { worktree, head: commit(worktree.path, 'the change', files) }
  })

const isOutcome = (update: MergeUpdate, ticket: TicketId) =>
  update.ticket === ticket &&
  update._tag !== 'Step' &&
  update._tag !== 'Check' &&
  update._tag !== 'Wrote' &&
  update._tag !== 'MergesWait'

/** Puts the worktrees in a new queue's line, in order, up to the last one's outcome: each one's outcome and checks. */
const merge = (merging: MergeConfig, ...worktrees: ReadonlyArray<Worktree>) =>
  Effect.gen(function* () {
    const merges = yield* makeQueue(merging)
    const updates = yield* merges.updates
    for (const worktree of worktrees)
      expect(yield* merges.enqueue(worktree)).toBe(true)
    const last = worktrees[worktrees.length - 1]?.ticket
    const all: ReadonlyArray<MergeUpdate> = yield* Stream.runCollect(
      Stream.takeUntil(
        updates,
        update => last !== undefined && isOutcome(update, last),
      ),
    )
    return {
      outcome: (ticket: TicketId) =>
        all.find(update => isOutcome(update, ticket)),
      checks: (ticket: TicketId) =>
        all.flatMap(update =>
          update._tag === 'Check' && update.ticket === ticket
            ? [update.record]
            : [],
        ),
    }
  })

/** The files the worktree's record says the queue wrote there. */
const recorded = (worktree: Worktree) =>
  Effect.flatMap(Git, given =>
    wroteRecorded(given, { worktree: worktree.path }),
  )

/** Completes once `file` exists, on its folder's change events. */
const appears = (file: string): Effect.Effect<void> =>
  Effect.callback<void>(resume => {
    const watcher = watch(dirname(file), () => {
      if (existsSync(file)) resume(Effect.void)
    })
    if (existsSync(file)) resume(Effect.void)
    return Effect.sync(() => watcher.close())
  })

const merged = (ticket: TicketId, commit: CommitHash) =>
  MergeOutcome.Merged({ ticket, commit, unchecked: false })

describe('the files a merge wrote', () => {
  it.live(
    'are removed as a failed check sets the ticket aside, so it merges when it comes back',
    () =>
      Effect.gen(function* () {
        const checkout = repository()
        const { worktree, head } = yield* ticketWorktree(checkout)
        const failed = yield* merge(
          config(checkout, 'check-writes-fails'),
          worktree,
        )
        expect(failed.outcome(worktree.ticket)).toEqual(
          MergeOutcome.SetAside({
            ticket: worktree.ticket,
            reason: 'CHECKS_FAILED',
            detail: expect.stringMatching(/^CHECKS_FAILED: /),
          }),
        )
        // The report the check wrote is gone; what the ignore rules leave out, and the worker's, stay.
        expect(existsSync(join(worktree.path, 'reports', 'coverage.txt'))).toBe(
          false,
        )
        expect(
          existsSync(join(worktree.path, 'node_modules', 'pkg', 'index.js')),
        ).toBe(true)
        expect(existsSync(join(worktree.path, 'src', 'b.ts'))).toBe(true)
        expect(git(worktree.path, 'status', '--porcelain')).toBe('')
        expect(yield* recorded(worktree)).toEqual([])

        const again = yield* merge(config(checkout, 'check-writes'), worktree)
        expect(again.outcome(worktree.ticket)).toEqual(
          merged(worktree.ticket, head),
        )
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    "are not taken for the worker's at its next merge, after a setup that failed",
    () =>
      Effect.gen(function* () {
        const runs = yield* Ref.make(0)
        // Writes a log each run; the first run fails.
        const logging = Layer.succeed(
          MergeSetup,
          MergeSetup.of({
            run: ({ worktree: path }) =>
              Effect.map(
                Ref.getAndUpdate(runs, n => n + 1),
                n => {
                  writeFileSync(join(path, 'setup.log'), `run ${n}\n`)
                  return n === 0
                    ? SetupOutcome.Failed({ detail: 'SETUP_FAILED: once' })
                    : SetupOutcome.Ready()
                },
              ),
          }),
        )
        return yield* Effect.gen(function* () {
          const checkout = repository()
          const { worktree } = yield* ticketWorktree(checkout)
          commit(checkout, 'a dependency', { 'package.json': '{}\n' })
          const merging = config(checkout, 'check-writes')
          const first = yield* merge(merging, worktree)
          expect(first.outcome(worktree.ticket)).toEqual(
            MergeOutcome.SetupFailed({
              ticket: worktree.ticket,
              detail: 'SETUP_FAILED: once',
            }),
          )
          expect(yield* recorded(worktree)).toEqual(['setup.log'])

          const again = yield* merge(merging, worktree)
          expect(again.outcome(worktree.ticket)).toEqual(
            merged(worktree.ticket, hash(checkout, 'main')),
          )
          expect(yield* Ref.get(runs)).toBe(2)
        }).pipe(Effect.scoped, Effect.provide(services(logging)))
      }),
  )

  it.live(
    "leave the worker's own untracked files named as CLOSED_UNCOMMITTED, and only those kept",
    () =>
      Effect.gen(function* () {
        const checkout = repository()
        const { worktree } = yield* ticketWorktree(checkout)
        const folder = freshPath('hold')
        mkdirSync(folder)
        // A check the run is stopped in, after it wrote its report.
        const fiber = yield* Effect.forkChild(
          Effect.scoped(
            merge(config(checkout, `check-writes-holds ${folder}`), worktree),
          ),
        )
        yield* appears(join(folder, 'started'))
        yield* Fiber.interrupt(fiber)
        writeFileSync(join(folder, 'release'), '')
        expect(yield* recorded(worktree)).toEqual(['reports/coverage.txt'])

        writeFileSync(join(worktree.path, 'notes.txt'), "the worker's\n")
        const refused = yield* merge(config(checkout, 'check-writes'), worktree)
        expect(refused.outcome(worktree.ticket)).toEqual(
          MergeOutcome.SetAside({
            ticket: worktree.ticket,
            reason: 'CLOSED_UNCOMMITTED',
            detail: 'CLOSED_UNCOMMITTED: notes.txt',
          }),
        )
        expect(existsSync(join(worktree.path, 'notes.txt'))).toBe(true)
        expect(existsSync(join(worktree.path, 'reports', 'coverage.txt'))).toBe(
          false,
        )
        expect(yield* recorded(worktree)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    "by the check a ticket rode to aren't taken for its worker's at its turn",
    () =>
      Effect.gen(function* () {
        const checkout = repository()
        const a = yield* ticketWorktree(checkout)
        const b = yield* ticketWorktree(checkout, {
          'src/c.ts': 'export const c = 3\n',
        })
        const outcomes = yield* merge(
          config(checkout, 'check-writes'),
          a.worktree,
          b.worktree,
        )
        expect(outcomes.outcome(a.worktree.ticket)?._tag).toBe('Merged')
        expect(outcomes.outcome(b.worktree.ticket)).toEqual(
          merged(b.worktree.ticket, hash(checkout, 'main')),
        )
        // It merged on its ride's check, which wrote its report in its worktree.
        expect(outcomes.checks(b.worktree.ticket)).toEqual([
          expect.objectContaining({ result: 'passed', train: true }),
        ])
      }).pipe(Effect.scoped, Effect.provide(services())),
  )
})
