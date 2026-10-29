import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Stream,
} from 'effect'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
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
  SetupOutcome,
  isSetupFile,
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

// The merge queue's basic path against real git in temp folders, real check scripts and an in-memory
// work graph (spec §13.7, H59, H62, H71): a ticket's worktree is made from Base, its worker's commits
// made in it, and the queue takes it to its outcome.

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
  git(cwd, 'add', '--all')
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
    'src/a.ts': 'export const a = 1\n',
  })
  return { checkout, first }
}

/** A file of its own under the test's root, not made. */
const freshPath = (name: string): string => {
  counter += 1
  return join(root, `${name}-${counter}`)
}

const STUBS: Readonly<Record<string, string>> = {
  'check-pass': 'echo passing\n',
  'check-fail': 'echo failing\nexit 3\n',
  // The first time (no `$1` yet), commits a file in the worktree after the check has begun.
  'check-commit-once':
    'if [ ! -e "$1" ]; then : > "$1"; echo late > late.txt; git add late.txt; git commit --quiet --message late; fi\necho passing\n',
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-merge-')))
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

const isOutcome = (update: MergeUpdate, ticket: TicketId) =>
  update.ticket === ticket && update._tag !== 'Step' && update._tag !== 'Check'

/** Puts the worktree in the queue's line and collects its updates up to its outcome. */
const mergeOne = (merging: MergeConfig, worktree: Worktree) =>
  Effect.gen(function* () {
    const merges = yield* makeQueue(merging)
    const updates = yield* merges.updates
    expect(yield* merges.enqueue(worktree)).toBe(true)
    const seen = yield* Stream.runCollect(
      Stream.takeUntil(updates, update => isOutcome(update, worktree.ticket)),
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

describe('the merge queue', () => {
  it.live('closes a branch that changes nothing as no_change', () =>
    Effect.gen(function* () {
      const { checkout, first } = repository()
      const worktree = yield* ticketWorktree(checkout)
      const { outcome, updates } = yield* mergeOne(config(checkout), worktree)
      expect(outcome).toEqual(
        MergeOutcome.NoChange({ ticket: worktree.ticket }),
      )
      expect(steps(updates)).toEqual(['enter', 'locate'])
      expect(hash(checkout, 'main')).toBe(first)
      const { ticket } = yield* show(worktree.ticket)
      expect(ticket.status).toBe('closed')
      expect(ticket.resolution).toEqual(Option.some('no_change'))
      expect(existsSync(worktree.path)).toBe(false)
      expect(git(checkout, 'branch', '--list', worktree.branch)).toBe('')
    }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'rebases onto the Base commit, checks it and fast-forwards Base to the checked hash',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const worktree = yield* ticketWorktree(checkout)
        commit(worktree.path, 'the change', {
          'src/b.ts': 'export const b = 2\n',
        })
        const moved = commit(checkout, 'Base moves', { 'docs/c.md': 'c\n' })
        const { outcome, updates } = yield* mergeOne(config(checkout), worktree)
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
          'rebase',
          'check',
          'confirm',
          'fast_forward',
        ])
        expect(checks(updates)).toEqual([
          expect.objectContaining({
            suite: 'merge',
            command: 'check-pass',
            commit: merged,
            result: 'passed',
          }),
        ])
        expect(hash(checkout, 'main~1')).toBe(moved)
        expect(git(checkout, 'show', '--format=%s', '--no-patch', 'main')).toBe(
          'the change',
        )
        const { ticket } = yield* show(worktree.ticket)
        expect(ticket.status).toBe('closed')
        expect(ticket.resolution).toEqual(Option.some('done'))
        expect(ticket.mergedCommit).toEqual(Option.some(merged))
        expect(existsSync(worktree.path)).toBe(false)
        expect(git(checkout, 'branch', '--list', worktree.branch)).toBe('')
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'checks a commit made after the check before it merges it, never unchecked',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const worktree = yield* ticketWorktree(checkout)
        const change = commit(worktree.path, 'the change', {
          'src/b.ts': 'export const b = 2\n',
        })
        const marker = freshPath('committed')
        const { outcome, updates } = yield* mergeOne(
          config(checkout, command(`check-commit-once ${marker}`)),
          worktree,
        )
        const merged = hash(checkout, 'main')
        expect(merged).not.toBe(change)
        expect(hash(checkout, 'main~1')).toBe(change)
        expect(outcome).toEqual(
          MergeOutcome.Merged({
            ticket: worktree.ticket,
            commit: merged,
            unchecked: false,
          }),
        )
        // The first check ran on the change, the second on the commit made during it.
        expect(checks(updates).map(record => record.commit)).toEqual([
          change,
          merged,
        ])
        expect(steps(updates)).toEqual([
          'enter',
          'locate',
          'check',
          'confirm',
          'locate',
          'check',
          'confirm',
          'fast_forward',
        ])
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'sets a conflict aside as MERGE_CONFLICT, its rebase aborted and its worktree kept',
    () =>
      Effect.gen(function* () {
        const { checkout, first } = repository()
        const worktree = yield* ticketWorktree(checkout)
        const change = commit(worktree.path, 'the change', {
          'src/a.ts': 'export const a = 2\n',
        })
        const moved = commit(checkout, 'Base changes it too', {
          'src/a.ts': 'export const a = 3\n',
        })
        const { outcome } = yield* mergeOne(config(checkout), worktree)
        expect(outcome).toEqual(
          MergeOutcome.SetAside({
            ticket: worktree.ticket,
            reason: 'MERGE_CONFLICT',
            detail: 'MERGE_CONFLICT in src/a.ts',
          }),
        )
        expect(hash(checkout, 'main')).toBe(moved)
        expect(hash(worktree.path, 'HEAD')).toBe(change)
        expect(git(worktree.path, 'symbolic-ref', 'HEAD')).toBe(
          `refs/heads/${worktree.branch}`,
        )
        expect(git(worktree.path, 'status', '--porcelain')).toBe('')
        expect(first).not.toBe(moved)
        const { ticket, notes } = yield* show(worktree.ticket)
        expect(ticket.status).toBe('deferred')
        expect(notes.map(note => note.body)).toEqual([
          'MERGE_CONFLICT in src/a.ts',
        ])
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live('sets a failing check aside as CHECKS_FAILED, Base unmoved', () =>
    Effect.gen(function* () {
      const { checkout, first } = repository()
      const worktree = yield* ticketWorktree(checkout)
      commit(worktree.path, 'the change', {
        'src/b.ts': 'export const b = 2\n',
      })
      const { outcome, updates } = yield* mergeOne(
        config(checkout, command('check-fail')),
        worktree,
      )
      expect(outcome).toEqual(
        MergeOutcome.SetAside({
          ticket: worktree.ticket,
          reason: 'CHECKS_FAILED',
          detail: `CHECKS_FAILED: the merge check failed; its output is in ${join(checkout, '.fabrica/run/checks', `${worktree.ticket}.merge.log`)}`,
        }),
      )
      expect(checks(updates).map(record => record.result)).toEqual(['failed'])
      expect(hash(checkout, 'main')).toBe(first)
      expect(existsSync(worktree.path)).toBe(true)
      const { ticket } = yield* show(worktree.ticket)
      expect(ticket.status).toBe('deferred')
    }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live('merges nothing without a check_fast', () =>
    Effect.gen(function* () {
      const { checkout, first } = repository()
      const worktree = yield* ticketWorktree(checkout)
      commit(worktree.path, 'the change', {
        'src/b.ts': 'export const b = 2\n',
      })
      const { outcome, updates } = yield* mergeOne(
        config(checkout, CommandSetting.cases.Unset.make({})),
        worktree,
      )
      expect(outcome).toEqual(
        MergeOutcome.NoMergeCheck({ ticket: worktree.ticket }),
      )
      expect(steps(updates)).toEqual(['enter'])
      expect(hash(checkout, 'main')).toBe(first)
      const { ticket } = yield* show(worktree.ticket)
      expect(ticket.status).toBe('in_progress')
    }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live('merges unchecked under check_fast: none, and says so', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      const worktree = yield* ticketWorktree(checkout)
      const change = commit(worktree.path, 'the change', {
        'src/b.ts': 'export const b = 2\n',
      })
      const { outcome, updates } = yield* mergeOne(
        config(checkout, CommandSetting.cases.None.make({})),
        worktree,
      )
      expect(outcome).toEqual(
        MergeOutcome.Merged({
          ticket: worktree.ticket,
          commit: change,
          unchecked: true,
        }),
      )
      expect(checks(updates)).toEqual([])
      expect(hash(checkout, 'main')).toBe(change)
      const { ticket } = yield* show(worktree.ticket)
      expect(ticket.closeReason).toEqual(
        Option.some(`Merged unchecked as ${change}: check_fast is none.`),
      )
    }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live('sets a ticket aside as GIT_FAILED when git can’t tell', () =>
    Effect.gen(function* () {
      const { checkout, first } = repository()
      const worktree = yield* ticketWorktree(checkout)
      commit(worktree.path, 'the change', {
        'src/b.ts': 'export const b = 2\n',
      })
      rmSync(worktree.path, { recursive: true, force: true })
      const { outcome } = yield* mergeOne(config(checkout), worktree)
      expect(outcome).toEqual(
        MergeOutcome.SetAside({
          ticket: worktree.ticket,
          reason: 'GIT_FAILED',
          detail: expect.stringMatching(/^GIT_FAILED: can't tell /),
        }),
      )
      expect(hash(checkout, 'main')).toBe(first)
      const { ticket } = yield* show(worktree.ticket)
      expect(ticket.status).toBe('deferred')
    }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live('runs the setup when the rebase brought in a setup file', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
      const recording = Layer.succeed(
        MergeSetup,
        MergeSetup.of({
          run: ({ files }) =>
            Effect.as(
              Ref.update(calls, made => [...made, files]),
              SetupOutcome.Ready(),
            ),
        }),
      )
      return yield* Effect.gen(function* () {
        const { checkout } = repository()
        const worktree = yield* ticketWorktree(checkout)
        commit(worktree.path, 'the change', {
          'src/b.ts': 'export const b = 2\n',
        })
        commit(checkout, 'a dependency', {
          'packages/x/package.json': '{}\n',
          'docs/d.md': 'd\n',
        })
        const { outcome } = yield* mergeOne(config(checkout), worktree)
        expect(outcome?._tag).toBe('Merged')
        expect(yield* Ref.get(calls)).toEqual([['packages/x/package.json']])
      }).pipe(Effect.scoped, Effect.provide(services(recording)))
    }),
  )

  it.live('aborts a rebase the queue is stopped in, its branch put back', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      const worktree = yield* ticketWorktree(checkout)
      const change = commit(worktree.path, 'the change', {
        'src/b.ts': 'export const b = 2\n',
      })
      commit(checkout, 'Base moves', { 'docs/c.md': 'c\n' })
      // The rebase's checkout of Base's commit runs this hook, which waits: the rebase is in progress.
      const started = freshPath('started')
      const release = freshPath('release')
      const hook = join(checkout, '.git', 'hooks', 'post-checkout')
      mkdirSync(dirname(hook), { recursive: true })
      writeFileSync(
        hook,
        `#!/bin/sh\n: > '${started}'\nwhile [ ! -e '${release}' ]; do sleep 0.05; done\n`,
      )
      chmodSync(hook, 0o755)

      const seen = yield* Ref.make<ReadonlyArray<MergeUpdate>>([])
      const subscribed = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            const merges = yield* makeQueue(config(checkout))
            const updates = yield* merges.updates
            yield* Effect.forkScoped(
              Stream.runForEach(updates, update =>
                Ref.update(seen, all => [...all, update]),
              ),
            )
            yield* merges.enqueue(worktree)
            yield* Deferred.succeed(subscribed, undefined)
            return yield* Effect.never
          }),
        ),
      )
      yield* Deferred.await(subscribed)
      yield* appears(started)
      yield* Fiber.interrupt(fiber)
      writeFileSync(release, '')

      expect(
        existsSync(
          join(checkout, '.git', 'worktrees', worktree.ticket, 'rebase-merge'),
        ),
      ).toBe(false)
      expect(hash(worktree.path, 'HEAD')).toBe(change)
      expect(git(worktree.path, 'symbolic-ref', 'HEAD')).toBe(
        `refs/heads/${worktree.branch}`,
      )
      const updates = yield* Ref.get(seen)
      expect(steps(updates)).toEqual(['enter', 'locate', 'rebase'])
      const { ticket } = yield* show(worktree.ticket)
      expect(ticket.status).toBe('in_progress')
    }).pipe(Effect.scoped, Effect.provide(services())),
  )
})

describe('setup files', () => {
  it('match by name at any depth, or by path where the pattern has one', () => {
    expect(isSetupFile('package.json', defaultSetupFiles)).toBe(true)
    expect(isSetupFile('packages/x/package.json', defaultSetupFiles)).toBe(true)
    expect(isSetupFile('requirements-dev.txt', defaultSetupFiles)).toBe(true)
    expect(isSetupFile('src/package.ts', defaultSetupFiles)).toBe(false)
    expect(isSetupFile('tools/deps.lock', ['tools/*.lock'])).toBe(true)
    expect(isSetupFile('other/deps.lock', ['tools/*.lock'])).toBe(false)
  })
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
