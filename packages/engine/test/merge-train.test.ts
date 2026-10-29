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
  readFileSync,
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
  type GitConfig,
  type Worktree,
  Worktrees,
  besideCheckout,
  layer as gitLayer,
  worktreesLayer,
} from '../src/git'
import {
  MachineHold,
  type MergeConfig,
  MergeOutcome,
  MergeSetup,
  type MergeUpdate,
  SetupOutcome,
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

// The merge train against real git in temp folders, real check scripts and an in-memory work graph
// (spec §13.7, orchestra-8qk2): two finished tickets are put in line together, so the second rides
// beside the first's merge check, rebased onto the first's rebased head in its own worktree. It merges
// on that check once the first merges as checked, and is put back and prepared afresh otherwise.

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

/** A path of its own under the test's root, not made. */
const freshPath = (name: string): string => {
  counter += 1
  return join(root, `${name}-${counter}`)
}

const STUBS: Readonly<Record<string, string>> = {
  // Logs the worktree and the commit it checks to `$1`. Where the tree has a `fail.txt` it fails, once
  // two checks have started: the first's waits until the second's has started beside it.
  'check-log':
    'echo "$(basename "$PWD") $(git rev-parse HEAD)" >> "$1"\nif [ -e fail.txt ]; then\n  while [ "$(wc -l < "$1")" -lt 2 ]; do sleep 0.05; done\n  echo failing; exit 3\nfi\necho passing\n',
  // Says it started in the folder `$1`, then waits for `$1/release`.
  'check-hold':
    ': > "$1/started-$(basename "$PWD")"\nwhile [ ! -e "$1/release" ]; do sleep 0.05; done\necho passing\n',
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-train-')))
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

const config = (checkout: string, check: string, train = 1): MergeConfig => ({
  home: besideCheckout(checkout),
  base: 'main',
  checkFast: CommandSetting.cases.Command.make({ command: check }),
  checkTimeout: Duration.minutes(1),
  setupFiles: defaultSetupFiles,
  train,
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

/**
 * Puts both worktrees in the queue's line together, the second behind the first, and collects the
 * updates up to the second's outcome; each one's outcome and steps.
 */
const mergeTwo = (merging: MergeConfig, first: Worktree, second: Worktree) =>
  Effect.gen(function* () {
    const merges = yield* makeQueue(merging)
    const updates = yield* merges.updates
    expect(yield* merges.enqueue(first)).toBe(true)
    expect(yield* merges.enqueue(second)).toBe(true)
    const all: ReadonlyArray<MergeUpdate> = yield* Stream.runCollect(
      Stream.takeUntil(updates, update => isOutcome(update, second.ticket)),
    )
    const of = (ticket: TicketId) => ({
      outcome: all.find(update => isOutcome(update, ticket)),
      steps: all.flatMap(update =>
        update._tag === 'Step' && update.ticket === ticket ? [update.step] : [],
      ),
      checks: all.flatMap(update =>
        update._tag === 'Check' && update.ticket === ticket
          ? [update.record]
          : [],
      ),
    })
    return { first: of(first.ticket), second: of(second.ticket) }
  })

/** The lines `check-log` wrote to `log`: each check's worktree folder and commit. */
const logged = (log: string): ReadonlyArray<string> =>
  existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []

/** Completes once `file` exists, on its folder's change events. */
const appears = (file: string): Effect.Effect<void> =>
  Effect.callback<void>(resume => {
    const watcher = watch(dirname(file), () => {
      if (existsSync(file)) resume(Effect.void)
    })
    if (existsSync(file)) resume(Effect.void)
    return Effect.sync(() => watcher.close())
  })

/** A setup port that records the ticket and files of each run, and passes. */
const recordingSetup = (
  calls: Ref.Ref<ReadonlyArray<readonly [TicketId, ReadonlyArray<string>]>>,
) =>
  Layer.succeed(
    MergeSetup,
    MergeSetup.of({
      run: ({ ticket, files }) =>
        Effect.as(
          Ref.update(calls, made => [...made, [ticket, files] as const]),
          SetupOutcome.Ready(),
        ),
    }),
  )

describe('the merge train', () => {
  it.live(
    'merges the second on the check it rode to beside the first, with no further check',
    () =>
      Effect.gen(function* () {
        const { checkout, first: base } = repository()
        const a = yield* ticketWorktree(checkout, {
          'src/b.ts': 'export const b = 2\n',
        })
        const b = yield* ticketWorktree(checkout, {
          'src/c.ts': 'export const c = 3\n',
        })
        const log = freshPath('log')
        const { first, second } = yield* mergeTwo(
          config(checkout, `check-log ${log}`),
          a.worktree,
          b.worktree,
        )

        const merged = hash(checkout, 'main')
        const firstMerged = hash(checkout, 'main~1')
        expect(hash(checkout, 'main~2')).toBe(base)
        expect(first.outcome).toEqual(
          MergeOutcome.Merged({
            ticket: a.worktree.ticket,
            commit: firstMerged,
            unchecked: false,
          }),
        )
        expect(second.outcome).toEqual(
          MergeOutcome.Merged({
            ticket: b.worktree.ticket,
            commit: merged,
            unchecked: false,
          }),
        )
        // The first's check, and the second's beside it on the first's head: no check of its own turn.
        expect(first.checks).toEqual([
          expect.objectContaining({ suite: 'merge', commit: firstMerged }),
        ])
        expect(first.checks[0]?.train).toBeUndefined()
        expect(second.checks).toEqual([
          expect.objectContaining({
            suite: 'merge',
            commit: merged,
            result: 'passed',
            train: true,
          }),
        ])
        expect(new Set(logged(log))).toEqual(
          new Set([
            `${basename(a.worktree.path)} ${firstMerged}`,
            `${basename(b.worktree.path)} ${merged}`,
          ]),
        )
        expect(second.steps).toEqual([
          'enter',
          'locate',
          'check',
          'confirm',
          'fast_forward',
        ])
        const { ticket } = yield* Effect.flatMap(WorkGraph, graph =>
          graph.show(b.worktree.ticket),
        )
        expect(ticket.mergedCommit).toEqual(Option.some(merged))
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'puts the second back and prepares it afresh when the first fails its check',
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make<
          ReadonlyArray<readonly [TicketId, ReadonlyArray<string>]>
        >([])
        return yield* Effect.gen(function* () {
          const { checkout, first: base } = repository()
          const a = yield* ticketWorktree(checkout, {
            'fail.txt': 'the first fails its check\n',
            'package.json': '{}\n',
          })
          const b = yield* ticketWorktree(checkout, {
            'src/c.ts': 'export const c = 3\n',
          })
          const log = freshPath('log')
          const { first, second } = yield* mergeTwo(
            config(checkout, `check-log ${log}`),
            a.worktree,
            b.worktree,
          )

          expect(first.outcome).toEqual(
            MergeOutcome.SetAside({
              ticket: a.worktree.ticket,
              reason: 'CHECKS_FAILED',
              detail: expect.stringMatching(/^CHECKS_FAILED: /),
            }),
          )
          // The second merges as its worker left it, on Base, none of the first's commits with it.
          expect(second.outcome).toEqual(
            MergeOutcome.Merged({
              ticket: b.worktree.ticket,
              commit: b.head,
              unchecked: false,
            }),
          )
          expect(hash(checkout, 'main')).toBe(b.head)
          expect(hash(checkout, 'main~1')).toBe(base)
          expect(git(checkout, 'ls-files', 'fail.txt', 'package.json')).toBe('')
          // Its ride's check ran on the first's head, and was cut short or failed; its own turn checked
          // it again, alone.
          const own = basename(b.worktree.path)
          const [ride, alone] = logged(log)
            .filter(line => line.startsWith(`${own} `))
            .map(line => CommitHash.make(line.slice(own.length + 1)))
          expect(ride && hash(checkout, `${ride}~1`)).toBe(a.head)
          expect(alone).toBe(b.head)
          const ridden = second.checks.filter(record => record.train === true)
          expect(ridden).toEqual(
            ridden.map(() => expect.objectContaining({ result: 'failed' })),
          )
          expect(second.checks.filter(record => record.train !== true)).toEqual(
            [expect.objectContaining({ result: 'passed', commit: b.head })],
          )
          expect(second.steps).toEqual([
            'enter',
            'locate',
            'check',
            'confirm',
            'fast_forward',
          ])
          // The ride set the worktree up for the first's package.json, and putting it back set it up again.
          expect(yield* Ref.get(calls)).toEqual([
            [b.worktree.ticket, ['package.json']],
            [b.worktree.ticket, ['package.json']],
          ])
        }).pipe(Effect.scoped, Effect.provide(services(recordingSetup(calls))))
      }),
  )

  it.live(
    'leaves the second to its own turn when its ride stops on a conflict',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const a = yield* ticketWorktree(checkout, {
          'src/a.ts': 'export const a = 2\n',
        })
        const b = yield* ticketWorktree(checkout, {
          'src/a.ts': 'export const a = 3\n',
        })
        const log = freshPath('log')
        const { first, second } = yield* mergeTwo(
          config(checkout, `check-log ${log}`),
          a.worktree,
          b.worktree,
        )
        expect(first.outcome?._tag).toBe('Merged')
        expect(second.outcome).toEqual(
          MergeOutcome.SetAside({
            ticket: b.worktree.ticket,
            reason: 'MERGE_CONFLICT',
            detail: 'MERGE_CONFLICT in src/a.ts',
          }),
        )
        expect(second.checks).toEqual([])
        expect(logged(log)).toHaveLength(1)
        expect(hash(b.worktree.path, 'HEAD')).toBe(b.head)
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live('takes no rider under merge.train 0', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      const a = yield* ticketWorktree(checkout, {
        'src/b.ts': 'export const b = 2\n',
      })
      const b = yield* ticketWorktree(checkout, {
        'src/c.ts': 'export const c = 3\n',
      })
      const log = freshPath('log')
      const { second } = yield* mergeTwo(
        config(checkout, `check-log ${log}`, 0),
        a.worktree,
        b.worktree,
      )
      expect(second.outcome?._tag).toBe('Merged')
      expect(second.checks).toEqual([
        expect.not.objectContaining({ train: true }),
      ])
      expect(second.steps).toContain('rebase')
    }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live('takes no rider while the machine budget holds', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      const a = yield* ticketWorktree(checkout, {
        'src/b.ts': 'export const b = 2\n',
      })
      const b = yield* ticketWorktree(checkout, {
        'src/c.ts': 'export const c = 3\n',
      })
      const log = freshPath('log')
      const { second } = yield* mergeTwo(
        config(checkout, `check-log ${log}`),
        a.worktree,
        b.worktree,
      ).pipe(
        Effect.provideService(MachineHold, { holds: Effect.succeed(true) }),
      )
      expect(second.outcome?._tag).toBe('Merged')
      expect(second.checks).toEqual([
        expect.not.objectContaining({ train: true }),
      ])
    }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live('puts the rider back when the queue is stopped during its ride', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      const a = yield* ticketWorktree(checkout, {
        'src/b.ts': 'export const b = 2\n',
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
      // The second's check runs on its rebase onto the first's head, the first's still running.
      yield* appears(join(folder, `started-${basename(b.worktree.path)}`))
      expect(hash(b.worktree.path, 'HEAD~1')).toBe(a.head)
      yield* Fiber.interrupt(fiber)
      writeFileSync(join(folder, 'release'), '')

      expect(hash(b.worktree.path, 'HEAD')).toBe(b.head)
      expect(git(b.worktree.path, 'symbolic-ref', 'HEAD')).toBe(
        `refs/heads/${b.worktree.branch}`,
      )
      expect(git(b.worktree.path, 'status', '--porcelain')).toBe('')
      const { ticket } = yield* Effect.flatMap(WorkGraph, graph =>
        graph.show(b.worktree.ticket),
      )
      expect(ticket.status).toBe('in_progress')
    }).pipe(Effect.scoped, Effect.provide(services())),
  )
})
