import { Duration, Effect, Layer, Stream } from 'effect'
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
  type MergeUpdate,
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

// Where the merge train puts a rider back (spec §13.7), against real git in temp folders: a rider's
// branch is read from its branch, never its HEAD; a worktree in the middle of a rebase, its HEAD a
// partly rebased commit, takes no ride and keeps every commit of its branch; and putting a rider back
// resets only the ride's rebased head, a branch moved elsewhere during the ride set aside as it is.

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

/** Runs git for a test's fixture with `env` added to its environment, its output trimmed. */
const gitWith = (
  env: Readonly<Record<string, string>>,
  cwd: string,
  ...args: ReadonlyArray<string>
): string =>
  execFileSync('git', args, {
    cwd,
    env: { ...fixtureEnv(), ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

/** Runs git for a test's fixture, its output trimmed. */
const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  gitWith({}, cwd, ...args)

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
  // Logs the worktree and the commit it checks to `$1`, and fails where the tree has a `fail.txt`.
  'check-fail':
    'echo "$(basename "$PWD") $(git rev-parse HEAD)" >> "$1"\nif [ -e fail.txt ]; then echo failing; exit 3; fi\necho passing\n',
  // Where the tree has a `move.txt`, moves its branch two commits back, then logs and passes. Where it
  // has a `fail.txt`, logs and fails once a second check has logged beside it.
  'check-move':
    'if [ -e move.txt ]; then\n  git reset --hard --quiet HEAD~2\n  echo "$(basename "$PWD")" >> "$1"\n  echo passing; exit 0\nfi\necho "$(basename "$PWD")" >> "$1"\nif [ -e fail.txt ]; then\n  while [ "$(wc -l < "$1")" -lt 2 ]; do sleep 0.05; done\n  echo failing; exit 3\nfi\necho passing\n',
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-train-midrebase-')))
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

/** A ticket filed and claimed, its worktree made from Base's head and each of `commits` committed in it in turn. */
const ticketWorktree = (
  checkout: string,
  ...commits: ReadonlyArray<Readonly<Record<string, string>>>
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
    const heads = commits.map((files, index) =>
      commit(worktree.path, `change ${index + 1}`, files),
    )
    return { worktree, heads }
  })

const isOutcome = (update: MergeUpdate, ticket: TicketId) =>
  update.ticket === ticket && update._tag !== 'Step' && update._tag !== 'Check'

/** Puts both worktrees in the queue's line together, the second behind the first: each one's outcome and check records. */
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
      checks: all.flatMap(update =>
        update._tag === 'Check' && update.ticket === ticket
          ? [update.record]
          : [],
      ),
    })
    return { first: of(first.ticket), second: of(second.ticket) }
  })

/** The lines a check stub wrote to `log`. */
const logged = (log: string): ReadonlyArray<string> =>
  existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []

describe('the merge train putting a rider back', () => {
  it.live(
    'takes no rider in the middle of a rebase, and keeps every commit of its branch',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const a = yield* ticketWorktree(checkout, {
          'fail.txt': 'the first fails its check\n',
        })
        const b = yield* ticketWorktree(
          checkout,
          { 'src/c.ts': 'export const c = 3\n' },
          { 'src/d.ts': 'export const d = 4\n' },
        )
        const [b1, b2] = [
          hash(b.worktree.path, 'HEAD~1'),
          hash(b.worktree.path, 'HEAD'),
        ]
        // A rebase stopped at its first commit, as a worker's `rebase -i` or a killed run's leaves it.
        gitWith(
          { GIT_SEQUENCE_EDITOR: 'sed -i.bak -e 1s/^pick/edit/' },
          b.worktree.path,
          'rebase',
          '--interactive',
          'main',
        )
        expect(git(b.worktree.path, 'rev-parse', 'HEAD')).toBe(b1)
        expect(hash(b.worktree.path, `refs/heads/${b.worktree.branch}`)).toBe(
          b2,
        )

        const log = freshPath('log')
        const { first, second } = yield* mergeTwo(
          config(checkout, `check-fail ${log}`),
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
        // No ride beside the first: the second's own turn ended the rebase and merged its whole branch.
        expect(second.checks).toEqual([
          expect.not.objectContaining({ train: true }),
        ])
        expect(second.outcome).toEqual(
          MergeOutcome.Merged({
            ticket: b.worktree.ticket,
            commit: b2,
            unchecked: false,
          }),
        )
        expect(hash(checkout, 'main')).toBe(b2)
        expect(git(checkout, 'ls-files', 'src/c.ts', 'src/d.ts')).toBe(
          'src/c.ts\nsrc/d.ts',
        )
        expect(logged(log)).toEqual([
          `${basename(a.worktree.path)} ${a.heads[0]}`,
          `${basename(b.worktree.path)} ${b2}`,
        ])
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'sets the rider aside, its branch as it is, when its ride moved the branch off its rebase',
    () =>
      Effect.gen(function* () {
        const { checkout, first: base } = repository()
        const a = yield* ticketWorktree(checkout, {
          'fail.txt': 'the first fails its check\n',
        })
        const b = yield* ticketWorktree(checkout, {
          'move.txt': 'the ride moves its branch\n',
        })
        const log = freshPath('log')
        const { first, second } = yield* mergeTwo(
          config(checkout, `check-move ${log}`),
          a.worktree,
          b.worktree,
        )

        expect(first.outcome?._tag).toBe('SetAside')
        expect(second.checks).toEqual([
          expect.objectContaining({ train: true, result: 'passed' }),
        ])
        expect(second.outcome).toEqual(
          MergeOutcome.SetAside({
            ticket: b.worktree.ticket,
            reason: 'GIT_FAILED',
            detail: `GIT_FAILED: the merge train couldn't put ${b.worktree.branch} back at ${b.heads[0]}: its branch moved to ${base}`,
          }),
        )
        // Not reset to where the ride found it, and nothing merged.
        expect(hash(b.worktree.path, `refs/heads/${b.worktree.branch}`)).toBe(
          base,
        )
        expect(hash(checkout, 'main')).toBe(base)
      }).pipe(Effect.scoped, Effect.provide(services())),
  )
})
