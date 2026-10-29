import { Deferred, Duration, Effect, Fiber, Layer, Ref, Stream } from 'effect'
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
import { basename, dirname, join } from 'node:path'

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
  SetupOutcome,
  make as makeQueue,
  pendingSetup,
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

// The setup a worktree waits for (spec §13.8, §13.10), against real git in temp folders: a stop during
// a merge-train ride puts the rider's branch back without setting it up again, the worktree records the
// setup files the ride set it up for, and the ticket's next merge sets it up at its rebase step, its
// branch on top of Base or not; a setup that fails is run again at the next merge in the same way.

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
  commit(checkout, 'one', {
    'README.md': 'one\n',
    'src/a.ts': 'export const a = 1\n',
  })
  return checkout
}

/** A path of its own under the test's root, not made. */
const freshPath = (name: string): string => {
  counter += 1
  return join(root, `${name}-${counter}`)
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-setup-again-')))
  home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n[init]\n\tdefaultBranch = main\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  bin = join(root, 'bin')
  mkdirSync(bin)
  // Says it started in the folder `$1`, then waits for `$1/release`.
  writeFileSync(
    join(bin, 'check-hold'),
    '#!/bin/sh\n: > "$1/started-$(basename "$PWD")"\nwhile [ ! -e "$1/release" ]; do sleep 0.05; done\necho passing\n',
  )
  chmodSync(join(bin, 'check-hold'), 0o755)
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

type Call = readonly [TicketId, ReadonlyArray<string>]
type Calls = Ref.Ref<ReadonlyArray<Call>>

/** A setup port that records the ticket and files of each run, and comes to what `outcome` holds. */
const recordingSetup = (calls: Calls, outcome: Ref.Ref<SetupOutcome>) =>
  Layer.succeed(
    MergeSetup,
    MergeSetup.of({
      run: ({ ticket, files }) =>
        Effect.andThen(
          Ref.update(calls, made => [...made, [ticket, files] as const]),
          Ref.get(outcome),
        ),
    }),
  )

/** The services a merge runs on, a fresh work graph among them, and `setup` as the setup port. */
const services = (setup: Layer.Layer<MergeSetup>) => {
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

const config = (checkout: string, check: string): MergeConfig => ({
  home: besideCheckout(checkout),
  base: 'main',
  checkFast: CommandSetting.cases.Command.make({ command: check }),
  checkTimeout: Duration.minutes(1),
  setupFiles: defaultSetupFiles,
  train: 1,
  cores: 1,
  actor,
})

/** A ticket filed and claimed, its worktree made from Base's head and `files` committed in it. */
const ticketWorktree = (
  checkout: string,
  files: Readonly<Record<string, string>>,
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
  update.ticket === ticket && update._tag !== 'Step' && update._tag !== 'Check'

/** Merges `worktree` alone in a queue of its own: its outcome and steps. */
const mergeAlone = (merging: MergeConfig, worktree: Worktree) =>
  Effect.scoped(
    Effect.gen(function* () {
      const merges = yield* makeQueue(merging)
      const updates = yield* merges.updates
      yield* merges.enqueue(worktree)
      const all: ReadonlyArray<MergeUpdate> = yield* Stream.runCollect(
        Stream.takeUntil(updates, update => isOutcome(update, worktree.ticket)),
      )
      return {
        outcome: all.find(update => isOutcome(update, worktree.ticket)),
        steps: all.flatMap(update =>
          update._tag === 'Step' ? [update.step] : [],
        ),
      }
    }),
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

/** The setup files the worktree at `path` waits for. */
const waitingFor = (path: string) =>
  Effect.flatMap(Git, git =>
    pendingSetup(git, { worktree: path }).pipe(Effect.orDie),
  )

describe('the setup a worktree waits for', () => {
  it.live(
    'is recorded when a stop puts a ride back, and run at the next merge of its branch on Base',
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make<ReadonlyArray<Call>>([])
        const outcome = yield* Ref.make<SetupOutcome>(SetupOutcome.Ready())
        return yield* Effect.gen(function* () {
          const checkout = repository()
          const a = yield* ticketWorktree(checkout, {
            'package.json': '{ "name": "a" }\n',
          })
          const b = yield* ticketWorktree(checkout, {
            'src/c.ts': 'export const c = 3\n',
          })
          const folder = freshPath('hold')
          mkdirSync(folder)
          const queued = yield* Deferred.make<void>()
          const fiber = yield* Effect.forkChild(
            Effect.scoped(
              Effect.gen(function* () {
                const merges = yield* makeQueue(
                  config(checkout, `check-hold ${folder}`),
                )
                yield* merges.enqueue(a.worktree)
                yield* merges.enqueue(b.worktree)
                yield* Deferred.succeed(queued, undefined)
                return yield* Effect.never
              }),
            ),
          )
          yield* Deferred.await(queued)
          // The second rides on the first's head, set up for its package.json, and is checked there.
          yield* appears(join(folder, `started-${basename(b.worktree.path)}`))
          yield* Fiber.interrupt(fiber)
          writeFileSync(join(folder, 'release'), '')

          // Put back on its own head, on Base, its worktree clean and not set up again: the setup waits.
          expect(hash(b.worktree.path, 'HEAD')).toBe(b.head)
          expect(hash(checkout, 'main')).toBe(hash(b.worktree.path, 'HEAD~1'))
          expect(git(b.worktree.path, 'status', '--porcelain')).toBe('')
          expect(yield* Ref.get(calls)).toEqual([
            [b.worktree.ticket, ['package.json']],
          ])
          expect(yield* waitingFor(b.worktree.path)).toEqual(['package.json'])

          // Its next merge, its branch on top of Base, sets it up at the rebase step before its check.
          const next = yield* mergeAlone(config(checkout, 'true'), b.worktree)
          expect(next.outcome).toEqual(
            MergeOutcome.Merged({
              ticket: b.worktree.ticket,
              commit: b.head,
              unchecked: false,
            }),
          )
          expect(next.steps).toEqual([
            'enter',
            'locate',
            'rebase',
            'check',
            'confirm',
            'fast_forward',
          ])
          expect(yield* Ref.get(calls)).toEqual([
            [b.worktree.ticket, ['package.json']],
            [b.worktree.ticket, ['package.json']],
          ])
        }).pipe(
          Effect.scoped,
          Effect.provide(services(recordingSetup(calls, outcome))),
        )
      }),
  )

  it.live(
    'is run again at the next merge after it failed, with what that rebase brings',
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make<ReadonlyArray<Call>>([])
        const outcome = yield* Ref.make<SetupOutcome>(
          SetupOutcome.Failed({ detail: 'the setup failed' }),
        )
        return yield* Effect.gen(function* () {
          const checkout = repository()
          const b = yield* ticketWorktree(checkout, {
            'src/c.ts': 'export const c = 3\n',
          })
          commit(checkout, 'a lockfile', { 'pnpm-lock.yaml': 'one\n' })

          const failed = yield* mergeAlone(config(checkout, 'true'), b.worktree)
          expect(failed.outcome).toEqual(
            MergeOutcome.SetupFailed({
              ticket: b.worktree.ticket,
              detail: 'the setup failed',
            }),
          )
          expect(yield* waitingFor(b.worktree.path)).toEqual(['pnpm-lock.yaml'])

          // Base moves on with another setup file: the next merge sets up for both, once.
          commit(checkout, 'a manifest', { 'package.json': '{}\n' })
          yield* Ref.set(outcome, SetupOutcome.Ready())
          const next = yield* mergeAlone(config(checkout, 'true'), b.worktree)
          expect(next.outcome?._tag).toBe('Merged')
          expect(yield* Ref.get(calls)).toEqual([
            [b.worktree.ticket, ['pnpm-lock.yaml']],
            [b.worktree.ticket, ['pnpm-lock.yaml', 'package.json']],
          ])
        }).pipe(
          Effect.scoped,
          Effect.provide(services(recordingSetup(calls, outcome))),
        )
      }),
  )

  it.live('is none once a setup at the rebase step passed', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([])
      const outcome = yield* Ref.make<SetupOutcome>(SetupOutcome.Ready())
      return yield* Effect.gen(function* () {
        const checkout = repository()
        const b = yield* ticketWorktree(checkout, {
          'src/c.ts': 'export const c = 3\n',
        })
        commit(checkout, 'a lockfile', { 'pnpm-lock.yaml': 'one\n' })
        // A check that fails keeps the worktree, so its record can be read after the merge.
        const merged = yield* mergeAlone(config(checkout, 'false'), b.worktree)
        expect(merged.outcome?._tag).toBe('SetAside')
        expect(yield* Ref.get(calls)).toEqual([
          [b.worktree.ticket, ['pnpm-lock.yaml']],
        ])
        expect(yield* waitingFor(b.worktree.path)).toEqual([])
        expect(git(b.worktree.path, 'status', '--porcelain')).toBe('')
      }).pipe(
        Effect.scoped,
        Effect.provide(services(recordingSetup(calls, outcome))),
      )
    }),
  )
})
