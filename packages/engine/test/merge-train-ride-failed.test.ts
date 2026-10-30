import { Duration, Effect, Layer, Ref, Stream } from 'effect'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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

// The merge train's ride that didn't pass, against real git in temp folders, real check scripts and an
// in-memory work graph (spec §13.7, orchestra merge_train_blame_test.go): the first merges as checked,
// but the second's ride beside it fails its check or its setup. That says nothing of the second, whose
// check ran beside another: its branch is put back and its own turn rebases, sets up and checks it.

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
  // Logs the worktree and the commit it checks to `$1`. Where the tree has a `flaky.txt` it fails the
  // first check in its worktree, as a check slowed beside another's may, and passes after.
  'check-flaky':
    'echo "$(basename "$PWD") $(git rev-parse HEAD)" >> "$1"\nfailed="$1.failed-$(basename "$PWD")"\nif [ -e flaky.txt ] && [ ! -e "$failed" ]; then\n  : > "$failed"\n  echo failing; exit 3\nfi\necho passing\n',
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
  handBacks: { resolve: 0, fix: 0, timeout: Duration.minutes(20) },
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

/** The lines `check-flaky` wrote to `log`: each check's worktree folder and commit. */
const logged = (log: string): ReadonlyArray<string> =>
  existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []

/** A setup port that records the ticket and files of each run, failing its first and passing after. */
const failingOnceSetup = (
  calls: Ref.Ref<ReadonlyArray<readonly [TicketId, ReadonlyArray<string>]>>,
) =>
  Layer.succeed(
    MergeSetup,
    MergeSetup.of({
      run: ({ ticket, files }) =>
        Ref.modify(calls, made => [
          made.length === 0
            ? SetupOutcome.Failed({ detail: 'the install timed out' })
            : SetupOutcome.Ready(),
          [...made, [ticket, files] as const],
        ]),
    }),
  )

describe('the merge train after a ride that did not pass', () => {
  it.live(
    'checks the second again in its own turn when its ride failed its check',
    () =>
      Effect.gen(function* () {
        const { checkout, first: base } = repository()
        const a = yield* ticketWorktree(checkout, {
          'src/b.ts': 'export const b = 2\n',
        })
        const b = yield* ticketWorktree(checkout, {
          'flaky.txt': 'the first check here fails\n',
        })
        const log = freshPath('log')
        const { first, second } = yield* mergeTwo(
          config(checkout, `check-flaky ${log}`),
          a.worktree,
          b.worktree,
        )

        expect(first.outcome).toEqual(
          MergeOutcome.Merged({
            ticket: a.worktree.ticket,
            commit: a.head,
            unchecked: false,
          }),
        )
        const merged = hash(checkout, 'main')
        expect(second.outcome).toEqual(
          MergeOutcome.Merged({
            ticket: b.worktree.ticket,
            commit: merged,
            unchecked: false,
          }),
        )
        expect(hash(checkout, 'main~1')).toBe(a.head)
        expect(hash(checkout, 'main~2')).toBe(base)
        // Its ride failed on the first's head; its own turn rebased it afresh and checked it there.
        expect(second.checks).toEqual([
          expect.objectContaining({ result: 'failed', train: true }),
          expect.objectContaining({ result: 'passed', commit: merged }),
        ])
        expect(second.checks[1]?.train).toBeUndefined()
        const own = basename(b.worktree.path)
        expect(
          logged(log).filter(line => line.startsWith(`${own} `)),
        ).toHaveLength(2)
        expect(second.steps).toEqual([
          'enter',
          'locate',
          'rebase',
          'check',
          'confirm',
          'fast_forward',
        ])
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'sets the second up and checks it in its own turn when its ride failed its setup',
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make<
          ReadonlyArray<readonly [TicketId, ReadonlyArray<string>]>
        >([])
        return yield* Effect.gen(function* () {
          const { checkout } = repository()
          const a = yield* ticketWorktree(checkout, {
            'package.json': '{}\n',
          })
          const b = yield* ticketWorktree(checkout, {
            'src/c.ts': 'export const c = 3\n',
          })
          const log = freshPath('log')
          const { first, second } = yield* mergeTwo(
            config(checkout, `check-flaky ${log}`),
            a.worktree,
            b.worktree,
          )

          expect(first.outcome?._tag).toBe('Merged')
          const merged = hash(checkout, 'main')
          expect(second.outcome).toEqual(
            MergeOutcome.Merged({
              ticket: b.worktree.ticket,
              commit: merged,
              unchecked: false,
            }),
          )
          expect(hash(checkout, 'main~1')).toBe(a.head)
          // The ride's setup failed, so it ran no check; the turn set the worktree up again and checked it.
          expect(yield* Ref.get(calls)).toEqual([
            [b.worktree.ticket, ['package.json']],
            [b.worktree.ticket, ['package.json']],
          ])
          expect(second.checks).toEqual([
            expect.objectContaining({ result: 'passed', commit: merged }),
          ])
          expect(second.checks[0]?.train).toBeUndefined()
          expect(second.steps).toEqual([
            'enter',
            'locate',
            'rebase',
            'check',
            'confirm',
            'fast_forward',
          ])
        }).pipe(
          Effect.scoped,
          Effect.provide(services(failingOnceSetup(calls))),
        )
      }),
  )
})
