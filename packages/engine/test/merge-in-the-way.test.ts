import { Deferred, Duration, Effect, Layer, Stream } from 'effect'
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
  TicketId,
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
  MergeWaits,
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
import { mergesWaitLine } from '../src/runlog'
import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'

// Untracked files in Base's checkout in the way of a fast-forward (spec §13.7, H72, fab-mgi.4.40),
// against real git in temp folders: git refuses to overwrite them, so the merge waits, `MERGES_WAIT`
// naming them, and merges once they are gone, rather than being refused until the ticket is set aside.

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

/** Removes `paths` from `cwd`, files or folders. */
const remove = (cwd: string, ...paths: ReadonlyArray<string>) =>
  execFileSync('rm', ['-rf', ...paths.map(path => join(cwd, path))])

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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-in-the-way-')))
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

const config = (checkout: string): MergeConfig => ({
  home: besideCheckout(checkout),
  base: 'main',
  checkFast: CommandSetting.cases.Command.make({ command: 'check-pass' }),
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
  onUpdate: (update: MergeUpdate) => Effect.Effect<void>,
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
    return { updates: all, outcome: all[all.length - 1] }
  })

/** Waits whose poll comes once `cleaned` completes, as the test clears the checkout; no test sleeps. */
const settles = (cleaned: Deferred.Deferred<void>) => ({
  beforeRetry: Effect.void,
  poll: Deferred.await(cleaned),
})

const waitsOf = (updates: ReadonlyArray<MergeUpdate>) =>
  updates.filter(update => update._tag === 'MergesWait')

describe('untracked files in the way of the fast-forward', () => {
  it.live('make it wait, naming them, and it merges once they are gone', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      const { worktree, change } = yield* changed(checkout, {
        'src/b.ts': 'export const b = 2\n',
        'docs/c.md': 'c\n',
        'lib/d.ts': 'export const d = 4\n',
      })
      // The same path, a file where the branch adds a folder, and a folder where it adds a file;
      // and one out of its way.
      write(checkout, {
        'src/b.ts': 'stray\n',
        docs: 'stray\n',
        'lib/d.ts/e.ts': 'stray\n',
        'notes.txt': 'untracked\n',
      })
      const cleaned = yield* Deferred.make<void>()
      const { outcome, updates } = yield* mergeOne(
        config(checkout),
        worktree,
        update =>
          update._tag === 'MergesWait'
            ? Effect.sync(() => {
                expect(hash(checkout, 'main')).not.toBe(change)
                remove(checkout, 'src/b.ts', 'docs', 'lib')
              }).pipe(Effect.andThen(Deferred.succeed(cleaned, undefined)))
            : Effect.void,
      ).pipe(Effect.provideService(MergeWaits, settles(cleaned)))
      expect(waitsOf(updates)).toEqual([
        expect.objectContaining({
          checkout,
          files: [],
          inTheWay: ['docs', 'lib/d.ts/e.ts', 'src/b.ts'],
          detail: `MERGES_WAIT: ${checkout} has untracked files in the fast-forward's way: docs, lib/d.ts/e.ts, src/b.ts`,
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

  it.live(
    'are named beside uncommitted changes, the wait named again as they go',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const { worktree, change } = yield* changed(checkout, {
          'src/b.ts': 'export const b = 2\n',
        })
        write(checkout, { 'src/b.ts': 'stray\n', 'README.md': 'edited\n' })
        const { outcome, updates } = yield* mergeOne(
          config(checkout),
          worktree,
          update =>
            update._tag !== 'MergesWait'
              ? Effect.void
              : Effect.sync(() =>
                  update.inTheWay.length > 0
                    ? remove(checkout, 'src/b.ts')
                    : git(checkout, 'checkout', '--', 'README.md'),
                ),
        ).pipe(
          // Polled at once: each wait is named before the test clears what it names.
          Effect.provideService(MergeWaits, {
            beforeRetry: Effect.void,
            poll: Effect.void,
          }),
        )
        expect(waitsOf(updates)).toEqual([
          expect.objectContaining({
            files: ['README.md'],
            inTheWay: ['src/b.ts'],
            detail: `MERGES_WAIT: ${checkout} has uncommitted changes to README.md and untracked files in the fast-forward's way: src/b.ts`,
          }),
          expect.objectContaining({
            files: ['README.md'],
            inTheWay: [],
            detail: `MERGES_WAIT: ${checkout} has uncommitted changes to README.md`,
          }),
        ])
        expect(outcome).toEqual(
          MergeOutcome.Merged({
            ticket: worktree.ticket,
            commit: change,
            unchecked: false,
          }),
        )
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it('are named in the log line', () => {
    expect(
      mergesWaitLine({
        ticket: TicketId.make('fa-a1'),
        checkout: '/work/repo',
        files: [],
        inTheWay: ['src/b.ts'],
      }),
    ).toBe(
      "  MERGES_WAIT: /work/repo has untracked files in the fast-forward's way: src/b.ts; fa-a1 merges once it is clean",
    )
  })
})
