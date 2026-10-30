import { Duration, Effect, Layer, Stream } from 'effect'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
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
  type MergeUpdate,
  isOutcome,
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

// A ticket's worktree off its branch as it reaches the merge queue, or as its turn goes round (spec
// §13.7, fab-mgi.4.41), against real git in temp folders: the ticket is set aside `OFF_BRANCH`, and
// neither Base, the branch checked out instead, nor the ticket's own branch moves.

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

/** Writes `files` in `cwd`, making their folders. */
const write = (cwd: string, files: Readonly<Record<string, string>>) => {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true })
    writeFileSync(join(cwd, name), content)
  }
}

/** Writes `files` in `cwd` and commits them as `message`, returning the commit. */
const commit = (
  cwd: string,
  message: string,
  files: Readonly<Record<string, string>>,
): CommitHash => {
  write(cwd, files)
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
    'src/a.ts': 'export const a = 1\n',
  })
  return { checkout }
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-off-branch-')))
  home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n[init]\n\tdefaultBranch = main\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'check-pass'), '#!/bin/sh\necho passing\n')
  chmodSync(join(bin, 'check-pass'), 0o755)
  // A check that switches its worktree to a branch of its own and commits there.
  writeFileSync(
    join(bin, 'check-switches'),
    '#!/bin/sh\ngit switch --quiet --create elsewhere && echo elsewhere > elsewhere.txt && git add elsewhere.txt && git commit --quiet --message elsewhere\n',
  )
  chmodSync(join(bin, 'check-switches'), 0o755)
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

/** The services a merge runs on, a fresh work graph among them. */
const services = () => {
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
    noSetup,
  )
}

const engine = EngineId.make('engine-1')
const actor: Actor = { _tag: 'engine', engine }

const config = (checkout: string, check = 'check-pass'): MergeConfig => ({
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

/** A ticket filed and claimed, its worktree made from Base's head, and `files` committed there. */
const changed = (checkout: string, files: Readonly<Record<string, string>>) =>
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
    return { worktree, change: commit(worktree.path, 'the change', files) }
  })

/** Puts the worktree in the queue's line and collects its updates up to its outcome. */
const mergeOne = (merging: MergeConfig, worktree: Worktree) =>
  Effect.gen(function* () {
    const merges = yield* makeQueue(merging)
    const updates = yield* merges.updates
    expect(yield* merges.enqueue(worktree)).toBe(true)
    const seen = yield* Stream.runCollect(
      updates.pipe(
        Stream.takeUntil(
          update => update.ticket === worktree.ticket && isOutcome(update),
        ),
      ),
    )
    const all: ReadonlyArray<MergeUpdate> = seen
    return { updates: all, outcome: all[all.length - 1] }
  })

/** The ticket set aside as its worktree is on `on`, not its branch. */
const offBranch = (worktree: Worktree, on: string) =>
  MergeOutcome.SetAside({
    ticket: worktree.ticket,
    reason: 'OFF_BRANCH',
    detail: `OFF_BRANCH: ${worktree.path} is on ${on}, not ${worktree.branch}`,
  })

/** The rebase steps a merge's updates name. */
const rebases = (updates: ReadonlyArray<MergeUpdate>) =>
  updates.filter(update => update._tag === 'Step' && update.step === 'rebase')

describe('a worktree off its branch', () => {
  it.live(
    'on a detached HEAD sets its ticket aside, its branch and Base kept',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const base = hash(checkout, 'main')
        const { worktree, change } = yield* changed(checkout, {
          'src/b.ts': 'export const b = 2\n',
        })
        const later = commit(worktree.path, 'a later change', {
          'src/c.ts': 'export const c = 3\n',
        })
        commit(checkout, 'Base moves', { 'README.md': 'two\n' })
        const moved = hash(checkout, 'main')
        git(worktree.path, 'checkout', '--quiet', '--detach', change)
        const { outcome, updates } = yield* mergeOne(config(checkout), worktree)
        expect(outcome).toEqual(offBranch(worktree, 'a detached HEAD'))
        expect(rebases(updates)).toEqual([])
        expect(hash(checkout, 'main')).toBe(moved)
        expect(hash(checkout, 'main')).not.toBe(base)
        expect(hash(worktree.path, `refs/heads/${worktree.branch}`)).toBe(later)
        expect(hash(worktree.path, 'HEAD')).toBe(change)
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'on another branch sets its ticket aside, that branch not rebased',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const { worktree, change } = yield* changed(checkout, {
          'src/b.ts': 'export const b = 2\n',
        })
        git(worktree.path, 'switch', '--quiet', '--create', 'other')
        const other = commit(worktree.path, 'on another branch', {
          'src/c.ts': 'export const c = 3\n',
        })
        commit(checkout, 'Base moves', { 'README.md': 'two\n' })
        const moved = hash(checkout, 'main')
        const { outcome, updates } = yield* mergeOne(config(checkout), worktree)
        expect(outcome).toEqual(offBranch(worktree, 'other'))
        expect(rebases(updates)).toEqual([])
        expect(hash(checkout, 'main')).toBe(moved)
        expect(hash(worktree.path, 'refs/heads/other')).toBe(other)
        expect(hash(worktree.path, `refs/heads/${worktree.branch}`)).toBe(
          change,
        )
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'as its turn goes round sets its ticket aside rather than rebase the branch checked out',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const base = hash(checkout, 'main')
        const { worktree, change } = yield* changed(checkout, {
          'src/b.ts': 'export const b = 2\n',
        })
        const { outcome } = yield* mergeOne(
          config(checkout, 'check-switches'),
          worktree,
        )
        expect(outcome).toEqual(offBranch(worktree, 'elsewhere'))
        expect(hash(checkout, 'main')).toBe(base)
        expect(hash(worktree.path, `refs/heads/${worktree.branch}`)).toBe(
          change,
        )
        expect(
          git(worktree.path, 'log', '-1', '--format=%s', 'elsewhere'),
        ).toBe('elsewhere')
      }).pipe(Effect.scoped, Effect.provide(services())),
  )
})
