import { Duration, Effect, Fiber, Layer, Stream } from 'effect'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  changedRecorded,
  make as makeQueue,
  noSetup,
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

// The tracked files the merge queue's checks change in a ticket's worktree (spec §13.7 What a check
// leaves, fab-mgi.95), against real git in temp folders and real check scripts: recorded as the queue's
// however the check ends, put back at `enter` rather than taken for its worker's, and put back as the
// ticket is set aside, its note naming them, so it goes back with its worker's own changes only.

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

// Each rewrites a tracked file, as a formatter does, and deletes another.
const FORMATS = "printf 'export const a = 1;\\n' > src/a.ts; rm README.md\n"

const STUBS: Readonly<Record<string, string>> = {
  'check-passes': 'echo passing\n',
  'check-formats': `${FORMATS}echo passing\n`,
  'check-formats-fails': `${FORMATS}echo failing\nexit 3\n`,
  // Formats and fails in a worktree with src/c.ts alone, and passes elsewhere untouched.
  'check-formats-fails-c': `if [ -e src/c.ts ]; then ${FORMATS.trim()}; echo failing; exit 3; fi\necho passing\n`,
  // Says it started in the folder `$1`, then waits for `$1/release`.
  'check-formats-holds': `${FORMATS}: > "$1/started"\nwhile [ ! -e "$1/release" ]; do sleep 0.05; done\necho passing\n`,
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-changed-')))
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

/** The tracked files the worktree's record says the queue changed there. */
const recorded = (worktree: Worktree) =>
  Effect.flatMap(Git, given =>
    changedRecorded(given, { worktree: worktree.path }),
  )

/** The bodies of the ticket's notes, oldest first. */
const notes = (ticket: TicketId) =>
  Effect.map(
    Effect.flatMap(WorkGraph, graph => graph.show(ticket)),
    detail => detail.notes.map(note => note.body),
  )

/** What `src/a.ts` holds in the worktree. */
const a = (worktree: Worktree) =>
  readFileSync(join(worktree.path, 'src', 'a.ts'), 'utf8')

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

describe('the tracked files a merge check changed', () => {
  it.live(
    'are put back as a failed check sets the ticket aside, its note naming them, so it merges when it comes back',
    () =>
      Effect.gen(function* () {
        const checkout = repository()
        const { worktree, head } = yield* ticketWorktree(checkout)
        const failed = yield* merge(
          config(checkout, 'check-formats-fails'),
          worktree,
        )
        expect(failed.outcome(worktree.ticket)).toEqual(
          MergeOutcome.SetAside({
            ticket: worktree.ticket,
            reason: 'CHECKS_FAILED',
            detail: expect.stringMatching(/^CHECKS_FAILED: /),
          }),
        )
        expect(git(worktree.path, 'status', '--porcelain')).toBe('')
        expect(a(worktree)).toBe('export const a = 1\n')
        expect(yield* recorded(worktree)).toEqual([])
        expect(yield* notes(worktree.ticket)).toEqual([
          expect.stringMatching(
            /^CHECKS_FAILED: .*; the tracked files it changed were put back: README\.md, src\/a\.ts$/,
          ),
        ])

        const again = yield* merge(config(checkout, 'check-passes'), worktree)
        expect(again.outcome(worktree.ticket)).toEqual(
          merged(worktree.ticket, head),
        )
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'are put back as a passing check that left them sets the ticket aside as DIRTY_WORKTREE',
    () =>
      Effect.gen(function* () {
        const checkout = repository()
        const { worktree } = yield* ticketWorktree(checkout)
        const dirty = yield* merge(config(checkout, 'check-formats'), worktree)
        expect(dirty.outcome(worktree.ticket)).toEqual(
          MergeOutcome.SetAside({
            ticket: worktree.ticket,
            reason: 'DIRTY_WORKTREE',
            detail:
              'DIRTY_WORKTREE: the merge check left tracked files changed: README.md, src/a.ts',
          }),
        )
        expect(git(worktree.path, 'status', '--porcelain')).toBe('')
        expect(yield* recorded(worktree)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    "by a check cut short are put back at the next merge, and only the worker's own named as CLOSED_UNCOMMITTED",
    () =>
      Effect.gen(function* () {
        const checkout = repository()
        const { worktree, head } = yield* ticketWorktree(checkout)
        const folder = freshPath('hold')
        mkdirSync(folder)
        // A check the run is stopped in, after it changed its files.
        const fiber = yield* Effect.forkChild(
          Effect.scoped(
            merge(config(checkout, `check-formats-holds ${folder}`), worktree),
          ),
        )
        yield* appears(join(folder, 'started'))
        yield* Fiber.interrupt(fiber)
        writeFileSync(join(folder, 'release'), '')
        expect(yield* recorded(worktree)).toEqual(['README.md', 'src/a.ts'])

        const again = yield* merge(config(checkout, 'check-passes'), worktree)
        expect(again.outcome(worktree.ticket)).toEqual(
          merged(worktree.ticket, head),
        )

        const other = yield* ticketWorktree(checkout, {
          'src/d.ts': 'export const d = 4\n',
        })
        const held = freshPath('hold')
        mkdirSync(held)
        const stopped = yield* Effect.forkChild(
          Effect.scoped(
            merge(
              config(checkout, `check-formats-holds ${held}`),
              other.worktree,
            ),
          ),
        )
        yield* appears(join(held, 'started'))
        yield* Fiber.interrupt(stopped)
        writeFileSync(join(held, 'release'), '')
        commit(other.worktree.path, 'the worker goes on', {
          'src/d.ts': 'export const d = 5\n',
        })
        writeFileSync(join(other.worktree.path, 'src', 'd.ts'), 'unfinished\n')
        const refused = yield* merge(
          config(checkout, 'check-passes'),
          other.worktree,
        )
        expect(refused.outcome(other.worktree.ticket)).toEqual(
          MergeOutcome.SetAside({
            ticket: other.worktree.ticket,
            reason: 'CLOSED_UNCOMMITTED',
            detail: 'CLOSED_UNCOMMITTED: src/d.ts',
          }),
        )
        expect(a(other.worktree)).toBe('export const a = 1\n')
        expect(
          readFileSync(join(other.worktree.path, 'src', 'd.ts'), 'utf8'),
        ).toBe('unfinished\n')
        expect(yield* recorded(other.worktree)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    "by the check a ticket rode to aren't taken for its worker's: its ride's failure sets it aside as CHECKS_FAILED",
    () =>
      Effect.gen(function* () {
        const checkout = repository()
        const first = yield* ticketWorktree(checkout)
        const rider = yield* ticketWorktree(checkout, {
          'src/c.ts': 'export const c = 3\n',
        })
        const outcomes = yield* merge(
          config(checkout, 'check-formats-fails-c'),
          first.worktree,
          rider.worktree,
        )
        expect(outcomes.outcome(first.worktree.ticket)?._tag).toBe('Merged')
        expect(outcomes.outcome(rider.worktree.ticket)).toEqual(
          MergeOutcome.SetAside({
            ticket: rider.worktree.ticket,
            reason: 'CHECKS_FAILED',
            detail: expect.stringMatching(/^CHECKS_FAILED: /),
          }),
        )
        // Its turn took its ride's failed check, which changed its files.
        expect(outcomes.checks(rider.worktree.ticket)).toEqual([
          expect.objectContaining({ result: 'failed', train: true }),
        ])
        expect(git(rider.worktree.path, 'status', '--porcelain')).toBe('')
        expect(yield* recorded(rider.worktree)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(services())),
  )
})
