import { Deferred, Duration, Effect, Layer, Option, Ref, Stream } from 'effect'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  TicketId,
  defaultSetupFiles,
} from '@fabrica/contracts'

import { layer as checksLayer } from '../src/checks'
import {
  FastForwardOutcome,
  type GitConfig,
  type Worktree,
  Worktrees,
  besideCheckout,
  layer as gitLayer,
  worktreesLayer,
} from '../src/git'
import {
  Diagnosis,
  type MergeConfig,
  MergeOutcome,
  MergeSetup,
  type MergeTurn,
  type MergeUpdate,
  MergeWaits,
  type MergeWaitsShape,
  SetupOutcome,
  asideFolder,
  cleanUp,
  clearAside,
  diagnose,
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

// Merge hygiene against real git in temp folders and real check scripts (spec §13.7, H71, H72): a
// refused fast-forward tried again or sent back to be rebased, the turn's recheck budget, what a setup
// or check leaves, merged worktrees deleted in the background, and merges waiting on a dirty checkout.

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
  const first = commit(checkout, 'one', {
    'README.md': 'one\n',
    '.gitignore': 'node_modules/\n',
    'src/a.ts': 'export const a = 1\n',
  })
  return { checkout, first }
}

const STUBS: Readonly<Record<string, string>> = {
  'check-pass': 'echo passing\n',
  // Commits in the worktree on every run: the branch moves on during each check.
  'check-commit-always':
    'echo "$$" >> late.txt; git add late.txt; git commit --quiet --message late\necho passing\n',
  // Commits on Base in the checkout `$1` on every run: Base moves on during each check.
  'check-base-moves':
    'git -C "$1" commit --quiet --allow-empty --message moved\necho passing\n',
  'check-dirty': 'echo dirty >> README.md\necho passing\n',
  // Writes an untracked file and an ignored folder, as a coverage report and dependencies.
  'check-writes':
    'echo report > coverage.txt; mkdir -p node_modules/pkg; echo x > node_modules/pkg/index.js\necho passing\n',
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-hygiene-')))
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
  )
}

/** Waits that end at once unless a test says otherwise: no test sleeps. */
const waits = (given: Partial<MergeWaitsShape> = {}): MergeWaitsShape => ({
  beforeRetry: Effect.void,
  poll: Effect.never,
  ...given,
})

/**
 * Waits whose poll comes once `cleaned` completes, as the test cleans the checkout: the wait goes on
 * whether the file watch saw the change or not, as a watch can miss one made as it begins.
 */
const settles = (cleaned: Deferred.Deferred<void>): MergeWaitsShape =>
  waits({ poll: Deferred.await(cleaned) })

const engine = EngineId.make('engine-1')
const actor: Actor = { _tag: 'engine', engine }

const command = (line: string): CommandSetting =>
  CommandSetting.cases.Command.make({ command: line })

const config = (
  checkout: string,
  checkFast: CommandSetting = command('check-pass'),
): MergeConfig => ({
  home: besideCheckout(checkout),
  base: 'main',
  checkFast,
  checkTimeout: Duration.minutes(1),
  setupFiles: defaultSetupFiles,
  train: 1,
  cores: 1,
  actor,
})

/** A ticket filed and claimed, and its worktree made from Base's head. */
const ticketWorktree = (checkout: string) =>
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
    return prepared.worktree
  })

/** A ticket's worktree with one commit of its own. */
const changed = (checkout: string) =>
  Effect.map(ticketWorktree(checkout), worktree => {
    const change = commit(worktree.path, 'the change', {
      'src/b.ts': 'export const b = 2\n',
    })
    return { worktree, change }
  })

const isOutcome = (update: MergeUpdate, ticket: TicketId) =>
  update.ticket === ticket &&
  update._tag !== 'Step' &&
  update._tag !== 'Check' &&
  update._tag !== 'Wrote' &&
  update._tag !== 'MergesWait'

/** Puts the worktree in the queue's line and collects its updates up to its outcome, `onUpdate` hearing each. */
const mergeOne = (
  merging: MergeConfig,
  worktree: Worktree,
  onUpdate: (update: MergeUpdate) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const merges = yield* makeQueue(merging)
    const updates = yield* merges.updates
    expect(yield* merges.enqueue(worktree)).toBe(true)
    const seen = yield* Stream.runCollect(
      updates.pipe(
        Stream.tap(onUpdate),
        Stream.takeUntil(update => isOutcome(update, worktree.ticket)),
      ),
    )
    const all: ReadonlyArray<MergeUpdate> = seen
    const outcome = all[all.length - 1]
    return { updates: all, outcome }
  })

const steps = (updates: ReadonlyArray<MergeUpdate>) =>
  updates.flatMap(update => (update._tag === 'Step' ? [update.step] : []))

const checks = (updates: ReadonlyArray<MergeUpdate>) =>
  updates.flatMap(update => (update._tag === 'Check' ? [update.record] : []))

const show = (ticket: TicketId) =>
  Effect.flatMap(WorkGraph, graph => graph.show(ticket))

/** Holds the checkout's index lock, as another git process does while it runs. */
const lockIndex = (checkout: string) =>
  writeFileSync(join(checkout, '.git', 'index.lock'), '')

const unlockIndex = (checkout: string) =>
  execFileSync('rm', ['-f', join(checkout, '.git', 'index.lock')])

const MERGE_STEPS = ['check', 'confirm', 'fast_forward'] as const

describe('a refused fast-forward', () => {
  it.live(
    "is tried again once another process's index.lock is gone, and merges",
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const { worktree, change } = yield* changed(checkout)
        lockIndex(checkout)
        const retried = yield* Ref.make(0)
        const { outcome, updates } = yield* mergeOne(
          config(checkout),
          worktree,
        ).pipe(
          Effect.provideService(
            MergeWaits,
            waits({
              beforeRetry: Effect.andThen(
                Ref.update(retried, count => count + 1),
                Effect.sync(() => unlockIndex(checkout)),
              ),
            }),
          ),
        )
        expect(outcome).toEqual(
          MergeOutcome.Merged({
            ticket: worktree.ticket,
            commit: change,
            unchecked: false,
          }),
        )
        expect(yield* Ref.get(retried)).toBe(1)
        expect(steps(updates)).toEqual(['enter', 'locate', ...MERGE_STEPS])
        expect(hash(checkout, 'main')).toBe(change)
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live('is GIT_FAILED once tried again 3 times, Base unmoved', () =>
    Effect.gen(function* () {
      const { checkout, first } = repository()
      const { worktree } = yield* changed(checkout)
      lockIndex(checkout)
      const retried = yield* Ref.make(0)
      const { outcome } = yield* mergeOne(config(checkout), worktree).pipe(
        Effect.provideService(
          MergeWaits,
          waits({ beforeRetry: Ref.update(retried, count => count + 1) }),
        ),
      )
      expect(outcome).toEqual(
        MergeOutcome.SetAside({
          ticket: worktree.ticket,
          reason: 'GIT_FAILED',
          detail: expect.stringMatching(
            /^GIT_FAILED: git refused to fast-forward main 4 times: .*index\.lock/,
          ),
        }),
      )
      expect(yield* Ref.get(retried)).toBe(3)
      expect(hash(checkout, 'main')).toBe(first)
      const { ticket } = yield* show(worktree.ticket)
      expect(ticket.status).toBe('deferred')
      expect(existsSync(worktree.path)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'sends the ticket back to be rebased and checked when Base moved on',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const { worktree } = yield* changed(checkout)
        lockIndex(checkout)
        let moved = Option.none<CommitHash>()
        const { outcome, updates } = yield* mergeOne(
          config(checkout),
          worktree,
        ).pipe(
          Effect.provideService(
            MergeWaits,
            // While the fast-forward waits to be tried again, the lock goes and Base moves on.
            waits({
              beforeRetry: Effect.sync(() => {
                unlockIndex(checkout)
                moved = Option.some(
                  commit(checkout, 'Base moves', { 'docs/c.md': 'c\n' }),
                )
              }),
            }),
          ),
        )
        const merged = hash(checkout, 'main')
        expect(outcome).toEqual(
          MergeOutcome.Merged({
            ticket: worktree.ticket,
            commit: merged,
            unchecked: false,
          }),
        )
        expect(steps(updates)).toEqual([
          'enter',
          'locate',
          ...MERGE_STEPS,
          'locate',
          'rebase',
          ...MERGE_STEPS,
        ])
        expect(Option.some(hash(checkout, 'main~1'))).toEqual(moved)
        expect(checks(updates).map(record => record.commit)).toEqual([
          expect.any(String),
          merged,
        ])
      }).pipe(Effect.scoped, Effect.provide(services())),
  )
})

describe('a merge turn', () => {
  it.live(
    'checks a ticket again at most 3 times while its branch keeps moving, then sets it aside',
    () =>
      Effect.gen(function* () {
        const { checkout, first } = repository()
        const { worktree } = yield* changed(checkout)
        const { outcome, updates } = yield* mergeOne(
          config(checkout, command('check-commit-always')),
          worktree,
        )
        expect(outcome).toEqual(
          MergeOutcome.SetAside({
            ticket: worktree.ticket,
            reason: 'BASE_KEPT_MOVING',
            detail: `BASE_KEPT_MOVING: ${worktree.branch} moved on during each of 4 checks`,
          }),
        )
        expect(checks(updates)).toHaveLength(4)
        expect(hash(checkout, 'main')).toBe(first)
        const { ticket } = yield* show(worktree.ticket)
        expect(ticket.status).toBe('deferred')
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live('counts Base moving on over the whole turn, across its rebases', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      const { worktree } = yield* changed(checkout)
      const { outcome, updates } = yield* mergeOne(
        config(checkout, command(`check-base-moves '${checkout}'`)),
        worktree,
      )
      expect(outcome).toEqual(
        MergeOutcome.SetAside({
          ticket: worktree.ticket,
          reason: 'BASE_KEPT_MOVING',
          detail: 'BASE_KEPT_MOVING: main moved on during each of 4 checks',
        }),
      )
      expect(checks(updates)).toHaveLength(4)
      expect(steps(updates).filter(step => step === 'rebase')).toHaveLength(3)
    }).pipe(Effect.scoped, Effect.provide(services())),
  )
})

describe('what a check leaves', () => {
  it.live(
    'sets a ticket aside as DIRTY_WORKTREE when its check changed tracked files',
    () =>
      Effect.gen(function* () {
        const { checkout, first } = repository()
        const { worktree } = yield* changed(checkout)
        const { outcome } = yield* mergeOne(
          config(checkout, command('check-dirty')),
          worktree,
        )
        const detail =
          'DIRTY_WORKTREE: the merge check left tracked files changed: README.md'
        expect(outcome).toEqual(
          MergeOutcome.SetAside({
            ticket: worktree.ticket,
            reason: 'DIRTY_WORKTREE',
            detail,
          }),
        )
        expect(hash(checkout, 'main')).toBe(first)
        const { ticket, notes } = yield* show(worktree.ticket)
        expect(ticket.status).toBe('deferred')
        // Its worktree is kept, the changed file put back.
        expect(notes.map(note => note.body)).toEqual([
          `${detail}; the tracked files it changed were put back: README.md`,
        ])
        expect(existsSync(worktree.path)).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'sets a ticket aside as DIRTY_WORKTREE when the setup its rebase called for changed tracked files',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const { worktree } = yield* changed(checkout)
        const moved = commit(checkout, 'a dependency', {
          'package.json': '{}\n',
        })
        const dirtying = Layer.succeed(
          MergeSetup,
          MergeSetup.of({
            run: ({ worktree: path }) =>
              Effect.sync(() => {
                writeFileSync(join(path, 'README.md'), 'rewritten\n')
                writeFileSync(join(path, 'setup.log'), 'ran\n')
                return SetupOutcome.Ready()
              }),
          }),
        )
        const { outcome, updates } = yield* mergeOne(
          config(checkout),
          worktree,
        ).pipe(Effect.provide(dirtying))
        expect(outcome).toEqual(
          MergeOutcome.SetAside({
            ticket: worktree.ticket,
            reason: 'DIRTY_WORKTREE',
            detail:
              "DIRTY_WORKTREE: the merge's setup left tracked files changed: README.md",
          }),
        )
        expect(updates.filter(update => update._tag === 'Wrote')).toEqual([
          expect.objectContaining({ by: 'setup', files: ['setup.log'] }),
        ])
        expect(checks(updates)).toEqual([])
        expect(hash(checkout, 'main')).toBe(moved)
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'records the untracked files a check wrote, and deletes the merged worktree in the background',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const { worktree, change } = yield* changed(checkout)
        const merging = config(checkout, command('check-writes'))
        const { outcome, updates } = yield* mergeOne(merging, worktree)
        expect(outcome).toEqual(
          MergeOutcome.Merged({
            ticket: worktree.ticket,
            commit: change,
            unchecked: false,
          }),
        )
        expect(updates.filter(update => update._tag === 'Wrote')).toEqual([
          expect.objectContaining({
            ticket: worktree.ticket,
            by: 'check',
            files: ['coverage.txt'],
          }),
        ])
        expect(existsSync(worktree.path)).toBe(false)
        expect(git(checkout, 'branch', '--list', worktree.branch)).toBe('')
        expect(git(checkout, 'worktree', 'list', '--porcelain')).not.toContain(
          worktree.ticket,
        )
        yield* emptied(asideFolder(merging.home))
        expect(readdirSync(asideFolder(merging.home))).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live('keeps a worktree whose tracked files changed after its check', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      const { worktree } = yield* changed(checkout)
      writeFileSync(join(worktree.path, 'README.md'), 'edited\n')
      const turn: MergeTurn = {
        config: config(checkout),
        worktree,
        publish: () => Effect.void,
      }
      yield* cleanUp(turn)
      expect(existsSync(join(worktree.path, 'README.md'))).toBe(true)
      expect(git(checkout, 'branch', '--list', worktree.branch)).not.toBe('')
    }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live('deletes what an earlier run moved aside as a run starts', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      const where = besideCheckout(checkout)
      const left = join(asideFolder(where), 'fa-old-x1', 'worktree')
      mkdirSync(join(left, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(left, 'node_modules', 'pkg', 'index.js'), 'x\n')
      yield* clearAside(where)
      expect(readdirSync(asideFolder(where))).toEqual([])
      // With nothing moved aside yet, there is nothing to delete.
      yield* clearAside(besideCheckout(repository().checkout))
    }),
  )
})

describe('a dirty checkout', () => {
  it.live(
    'makes the fast-forward wait, naming its files, and merges once it is clean',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const { worktree, change } = yield* changed(checkout)
        writeFileSync(join(checkout, 'src', 'a.ts'), 'export const a = 9\n')
        writeFileSync(join(checkout, 'notes.txt'), 'untracked\n')
        const cleaned = yield* Deferred.make<void>()
        const { outcome, updates } = yield* mergeOne(
          config(checkout),
          worktree,
          update =>
            update._tag === 'MergesWait'
              ? Effect.sync(() => {
                  expect(hash(checkout, 'main')).not.toBe(change)
                  git(checkout, 'checkout', '--', 'src/a.ts')
                }).pipe(Effect.andThen(Deferred.succeed(cleaned, undefined)))
              : Effect.void,
        ).pipe(Effect.provideService(MergeWaits, settles(cleaned)))
        expect(updates.filter(update => update._tag === 'MergesWait')).toEqual([
          expect.objectContaining({
            checkout,
            files: ['src/a.ts'],
            detail: `MERGES_WAIT: ${checkout} has uncommitted changes to src/a.ts`,
          }),
        ])
        expect(outcome).toEqual(
          MergeOutcome.Merged({
            ticket: worktree.ticket,
            commit: change,
            unchecked: false,
          }),
        )
        expect(hash(checkout, 'main')).toBe(change)
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live('reads the checkout again on its poll, beside the watch', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      const { worktree, change } = yield* changed(checkout)
      writeFileSync(join(checkout, 'README.md'), 'edited\n')
      const polls = yield* Ref.make(0)
      const { outcome } = yield* mergeOne(config(checkout), worktree).pipe(
        Effect.provideService(
          MergeWaits,
          waits({
            poll: Effect.andThen(
              Ref.update(polls, count => count + 1),
              Effect.sync(() => git(checkout, 'checkout', '--', 'README.md')),
            ),
          }),
        ),
      )
      expect(outcome).toEqual(
        MergeOutcome.Merged({
          ticket: worktree.ticket,
          commit: change,
          unchecked: false,
        }),
      )
      expect(yield* Ref.get(polls)).toBeGreaterThanOrEqual(1)
    }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'rebases and checks the ticket again when Base moved on while it waited',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const { worktree } = yield* changed(checkout)
        writeFileSync(join(checkout, 'README.md'), 'edited\n')
        let moved = Option.none<CommitHash>()
        const cleaned = yield* Deferred.make<void>()
        const { outcome, updates } = yield* mergeOne(
          config(checkout),
          worktree,
          update =>
            update._tag === 'MergesWait'
              ? Effect.sync(() => {
                  moved = Option.some(
                    commit(checkout, 'Base moves', { 'docs/c.md': 'c\n' }),
                  )
                  git(checkout, 'checkout', '--', 'README.md')
                }).pipe(Effect.andThen(Deferred.succeed(cleaned, undefined)))
              : Effect.void,
        ).pipe(Effect.provideService(MergeWaits, settles(cleaned)))
        const merged = hash(checkout, 'main')
        expect(outcome).toEqual(
          MergeOutcome.Merged({
            ticket: worktree.ticket,
            commit: merged,
            unchecked: false,
          }),
        )
        expect(Option.some(hash(checkout, 'main~1'))).toEqual(moved)
        expect(steps(updates)).toEqual([
          'enter',
          'locate',
          ...MERGE_STEPS,
          'locate',
          'rebase',
          ...MERGE_STEPS,
        ])
      }).pipe(Effect.scoped, Effect.provide(services())),
  )
})

describe('diagnose', () => {
  const onto = CommitHash.make('a'.repeat(40))
  const checked = CommitHash.make('b'.repeat(40))
  const elsewhere = CommitHash.make('c'.repeat(40))
  const turn: MergeTurn = {
    config: config('/nowhere/repo'),
    worktree: {
      ticket: TicketId.make('fa-x1'),
      path: '/nowhere/repo-worktrees/fa-x1',
      branch: 'fabrica/fa-x1',
    },
    publish: () => Effect.void,
  }
  const diagnosed = (
    outcome: Parameters<typeof diagnose>[0]['outcome'],
    base: CommitHash = onto,
  ) =>
    diagnose({
      turn,
      onto,
      checked,
      outcome,
      retries: 0,
      base: Effect.succeed(base),
    }).pipe(Effect.provideService(MergeWaits, waits()))

  it.effect(
    'stops merging only for a branch that does not fast-forward Base where it was checked',
    () =>
      Effect.gen(function* () {
        expect(
          yield* diagnosed(FastForwardOutcome.NotFastForward({ base: onto })),
        ).toEqual(
          Diagnosis.Stop({
            kind: 'MERGE_FAILED',
            detail: `MERGE_FAILED: fabrica/fa-x1 doesn't fast-forward main at ${onto}`,
          }),
        )
        expect(
          yield* diagnosed(
            FastForwardOutcome.NotFastForward({ base: elsewhere }),
          ),
        ).toEqual(Diagnosis.Again())
        expect(
          yield* diagnosed(
            FastForwardOutcome.Refused({ message: 'refused' }),
            elsewhere,
          ),
        ).toEqual(Diagnosis.Again())
        expect(
          yield* diagnosed(FastForwardOutcome.Refused({ message: 'refused' })),
        ).toEqual(Diagnosis.Retry())
      }),
  )
})

/** Completes once `folder` is there and empty, on its change events. */
const emptied = (folder: string): Effect.Effect<void> =>
  Effect.callback<void>(resume => {
    const empty = () => existsSync(folder) && readdirSync(folder).length === 0
    const watcher = watch(folder, () => {
      if (empty()) resume(Effect.void)
    })
    if (empty()) resume(Effect.void)
    return Effect.sync(() => watcher.close())
  })
