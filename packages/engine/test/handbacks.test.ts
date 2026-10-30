import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Stream,
  SubscriptionRef,
} from 'effect'
import { TestClock } from 'effect/testing'
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
  HandBackClock,
  type HandBackClockShape,
  HandBackWorker,
  type HandBackWorkerShape,
  WorkerAnswer,
  documentsOnly,
  inOwnCode,
  namedFiles,
  runsOut,
} from '../src/merge/handbacks'
import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'

// Hand-backs (spec §13.7) against real git in temp folders, real check scripts, an in-memory work graph
// and scripted workers: a conflict resolved and merged, a fix merged, the limits, a deadline taking a
// finished commit, a docs-only conflict's prompt, a recheck once Base moves, and the clock stopped
// while the run holds.

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
  GIT_EDITOR: 'true',
})

/** Runs git for a test's fixture or a scripted worker, its output trimmed. */
const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync('git', args, {
    cwd,
    env: fixtureEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

const hash = (cwd: string, revision: string): CommitHash =>
  CommitHash.make(git(cwd, 'rev-parse', '--verify', `${revision}^{commit}`))

/** Writes `files` in `cwd`. */
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
    'docs/spec.md': '# Spec\n\nOne.\n',
    'src/a.ts': 'export const a = 1\n',
    'src/b.test.ts': 'b\n',
    'other/c.test.ts': 'c\n',
  })
  return { checkout }
}

/** A file of its own under the test's root, not made. */
const freshPath = (name: string): string => {
  counter += 1
  return join(root, `${name}-${counter}`)
}

const STUBS: Readonly<Record<string, string>> = {
  'check-pass': 'echo passing\n',
  // Fails in the ticket's own folder until it has its fix.
  'check-own':
    'if [ -e src/fixed.ts ]; then echo passing; else echo "FAIL src/b.test.ts > b works"; exit 1; fi\n',
  // Fails outside the ticket's code until Base has what it needs.
  'check-outside':
    'if [ -e other/ok.ts ]; then echo passing; else echo "FAIL other/c.test.ts > c works"; exit 1; fi\n',
  // Fails the first time (no `$1` yet), in the ticket's own folder, then passes.
  'check-flaky':
    'if [ ! -e "$1" ]; then : > "$1"; echo "FAIL src/b.test.ts > b works"; exit 1; fi\necho passing\n',
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-handbacks-')))
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
  check: string,
  limits: Partial<MergeConfig['handBacks']> = {},
): MergeConfig => ({
  home: besideCheckout(checkout),
  base: 'main',
  checkFast: command(check),
  checkTimeout: Duration.minutes(1),
  setupFiles: defaultSetupFiles,
  handBacks: { resolve: 2, fix: 2, timeout: Duration.minutes(20), ...limits },
  train: 0,
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

/** An update that ends the ticket's part in the queue: every outcome but a hand-back. */
const isFinal = (update: MergeUpdate, ticket: TicketId) =>
  update.ticket === ticket &&
  [
    'Merged',
    'NoChange',
    'SetAside',
    'NoMergeCheck',
    'SetupFailed',
    'Stopped',
  ].includes(update._tag)

/** What a scripted worker was given and told. */
interface Heard {
  readonly prompts: Array<string>
  readonly told: Array<string>
}

/** A scripted worker: `act` runs in the worktree for each hand-back, its answer the worker's. */
const scripted = (
  act: (input: {
    readonly worktree: Worktree
    readonly prompt: string
    readonly attempt: number
  }) => Effect.Effect<WorkerAnswer>,
  told: (message: string) => Effect.Effect<void> = () => Effect.void,
): { readonly worker: HandBackWorkerShape; readonly heard: Heard } => {
  const heard: Heard = { prompts: [], told: [] }
  return {
    heard,
    worker: {
      give: ({ worktree, prompt, attempt }) =>
        Effect.suspend(() => {
          heard.prompts.push(prompt)
          return act({ worktree, prompt, attempt })
        }),
      tell: ({ message }) =>
        Effect.suspend(() => {
          heard.told.push(message)
          return told(message)
        }),
    },
  }
}

const settled = (effect: () => void) =>
  Effect.sync(() => {
    effect()
    return WorkerAnswer.Settled()
  })

/**
 * Puts the worktrees in the queue's line, in order, `worker` taking their hand-backs, and collects the
 * updates up to `last`, by default once each has had a final outcome.
 */
const mergeAll = (
  merging: MergeConfig,
  worktrees: ReadonlyArray<Worktree>,
  worker: HandBackWorkerShape,
  clock: Option.Option<HandBackClockShape> = Option.none(),
  last: Option.Option<(update: MergeUpdate) => boolean> = Option.none(),
) =>
  Effect.gen(function* () {
    const merges = yield* makeQueue(merging).pipe(
      Effect.provideService(HandBackWorker, worker),
      made =>
        Option.match(clock, {
          onNone: () => made,
          onSome: given => Effect.provideService(made, HandBackClock, given),
        }),
    )
    const updates = yield* merges.updates
    const finals = new Set<TicketId>()
    const collected = yield* Effect.forkChild(
      Stream.runCollect(
        Stream.takeUntil(updates, update => {
          if (isFinal(update, update.ticket)) finals.add(update.ticket)
          return Option.match(last, {
            onNone: () => worktrees.every(each => finals.has(each.ticket)),
            onSome: ends => ends(update),
          })
        }),
      ),
    )
    for (const worktree of worktrees) yield* merges.enqueue(worktree)
    const all: ReadonlyArray<MergeUpdate> = yield* Fiber.join(collected)
    return { all }
  })

const of = (updates: ReadonlyArray<MergeUpdate>, ticket: TicketId) =>
  updates.filter(update => update.ticket === ticket)

const outcomes = (updates: ReadonlyArray<MergeUpdate>) =>
  updates.filter(
    update =>
      update._tag !== 'Step' &&
      update._tag !== 'Check' &&
      update._tag !== 'Wrote',
  )

const suites = (updates: ReadonlyArray<MergeUpdate>) =>
  updates.flatMap(update =>
    update._tag === 'Check'
      ? [`${update.record.suite}:${update.record.result}`]
      : [],
  )

/** The update putting a ticket set aside back in line once Base moved on. */
const rechecked = (ticket: TicketId) =>
  expect.objectContaining({
    _tag: 'Requeued',
    ticket,
    for: 'recheck',
    detail: `RECHECK: ${ticket} is checked once more, as main moved on`,
  })

const show = (ticket: TicketId) =>
  Effect.flatMap(WorkGraph, graph => graph.show(ticket))

/** A conflict on `file`: the ticket's change and Base's to the same line. */
const conflicting = (checkout: string, worktree: Worktree, file: string) => {
  const change = commit(worktree.path, 'the change', { [file]: 'ours\n' })
  commit(checkout, 'Base changes it too', { [file]: 'theirs\n' })
  return change
}

/** A scripted resolution: the file written with both sides, added, and the rebase finished. */
const resolve = (worktree: Worktree, file: string) => () => {
  write(worktree.path, { [file]: 'theirs\nours\n' })
  git(worktree.path, 'add', '--', file)
  git(worktree.path, 'rebase', '--continue')
}

describe('a conflict hand-back', () => {
  it.live(
    'goes to the ticket’s worker, whose resolution is checked once and merged',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const worktree = yield* ticketWorktree(checkout)
        conflicting(checkout, worktree, 'src/a.ts')
        const { worker, heard } = scripted(() =>
          settled(resolve(worktree, 'src/a.ts')),
        )
        const { all } = yield* mergeAll(
          config(checkout, 'check-pass'),
          [worktree],
          worker,
        )
        const ticket = worktree.ticket
        const merged = hash(checkout, 'main')
        expect(outcomes(all)).toEqual([
          MergeOutcome.HandedBack({
            ticket,
            kind: 'resolve',
            attempt: 1,
            detail: 'MERGE_CONFLICT in src/a.ts',
          }),
          expect.objectContaining({ _tag: 'Requeued', for: 'hand_back' }),
          MergeOutcome.Merged({ ticket, commit: merged, unchecked: false }),
        ])
        expect(suites(all)).toEqual(['merge:passed'])
        expect(heard.prompts).toHaveLength(1)
        expect(heard.prompts[0]).toContain('conflicts in src/a.ts')
        expect(heard.prompts[0]).toContain('git rebase --continue')
        expect(heard.prompts[0]).toContain('the tests of your change')
        expect(git(checkout, 'show', 'main:src/a.ts')).toBe('theirs\nours')
        const { ticket: shown } = yield* show(ticket)
        expect(shown.status).toBe('closed')
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'asks for the resolution and the rebase alone where the conflict is in documents',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const worktree = yield* ticketWorktree(checkout)
        conflicting(checkout, worktree, 'docs/spec.md')
        const { worker, heard } = scripted(() =>
          settled(resolve(worktree, 'docs/spec.md')),
        )
        const { all } = yield* mergeAll(
          config(checkout, 'check-pass'),
          [worktree],
          worker,
        )
        expect(all[all.length - 1]?._tag).toBe('Merged')
        expect(heard.prompts[0]).toContain('in documents alone')
        expect(heard.prompts[0]).not.toContain('the tests of your change')
        expect(documentsOnly(['docs/spec.md', 'CHANGELOG.md'])).toBe(true)
        expect(documentsOnly(['docs/spec.md', 'src/a.ts'])).toBe(false)
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live('runs the setup first where the rebase brings a setup file', () => {
    const ran: Array<string> = []
    const setup = Layer.succeed(
      MergeSetup,
      MergeSetup.of({
        run: ({ files }) =>
          Effect.sync(() => {
            ran.push(`setup ${files.join(', ')}`)
            return SetupOutcome.Ready()
          }),
      }),
    )
    return Effect.gen(function* () {
      const { checkout } = repository()
      const worktree = yield* ticketWorktree(checkout)
      commit(worktree.path, 'the change', { 'src/a.ts': 'ours\n' })
      commit(checkout, 'Base changes it, and its manifest', {
        'src/a.ts': 'theirs\n',
        'package.json': '{}\n',
      })
      const { worker } = scripted(() =>
        Effect.suspend(() => {
          ran.push('worker')
          return settled(resolve(worktree, 'src/a.ts'))
        }),
      )
      const { all } = yield* mergeAll(
        config(checkout, 'check-pass'),
        [worktree],
        worker,
      )
      expect(all[all.length - 1]?._tag).toBe('Merged')
      expect(ran.slice(0, 2)).toEqual(['setup package.json', 'worker'])
    }).pipe(Effect.scoped, Effect.provide(services(setup)))
  })

  it.live(
    'sets the ticket aside once its resolve hand-backs are used up, its branch put back',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const worktree = yield* ticketWorktree(checkout)
        const change = conflicting(checkout, worktree, 'src/a.ts')
        // Its worker resolves the file but leaves the rebase unfinished.
        const { worker, heard } = scripted(() =>
          settled(() => {
            write(worktree.path, { 'src/a.ts': 'theirs\nours\n' })
            git(worktree.path, 'add', '--', 'src/a.ts')
          }),
        )
        const { all } = yield* mergeAll(
          config(checkout, 'check-pass', { resolve: 1 }),
          [worktree],
          worker,
        )
        const final = all[all.length - 1]
        expect(final).toEqual(
          MergeOutcome.SetAside({
            ticket: worktree.ticket,
            reason: 'MERGE_CONFLICT',
            detail:
              'MERGE_CONFLICT in src/a.ts; its worker ended its hand-back undone: the rebase is still in progress',
          }),
        )
        expect(heard.prompts).toHaveLength(1)
        expect(hash(worktree.path, 'HEAD')).toBe(change)
        expect(git(worktree.path, 'status', '--porcelain')).toBe('')
        const { ticket } = yield* show(worktree.ticket)
        expect(ticket.status).toBe('deferred')
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'sets the ticket aside at once with no resolve hand-back to give',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const worktree = yield* ticketWorktree(checkout)
        conflicting(checkout, worktree, 'src/a.ts')
        const { worker, heard } = scripted(() => settled(() => {}))
        const { all } = yield* mergeAll(
          config(checkout, 'check-pass', { resolve: 0 }),
          [worktree],
          worker,
        )
        expect(outcomes(all)).toEqual([
          MergeOutcome.SetAside({
            ticket: worktree.ticket,
            reason: 'MERGE_CONFLICT',
            detail: 'MERGE_CONFLICT in src/a.ts',
          }),
        ])
        expect(heard.prompts).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(services())),
  )
})

describe('a fix hand-back', () => {
  it.live(
    'goes to the ticket’s worker on a failure in its own code, and its fix is checked once and merged',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const worktree = yield* ticketWorktree(checkout)
        commit(worktree.path, 'the change', { 'src/b.ts': 'b\n' })
        const { worker, heard } = scripted(() =>
          settled(() => {
            commit(worktree.path, 'the fix', { 'src/fixed.ts': 'fixed\n' })
          }),
        )
        const { all } = yield* mergeAll(
          config(checkout, 'check-own'),
          [worktree],
          worker,
        )
        const ticket = worktree.ticket
        expect(outcomes(all).map(update => update._tag)).toEqual([
          'HandedBack',
          'Requeued',
          'Merged',
        ])
        expect(suites(all)).toEqual(['merge:failed', 'fix:passed'])
        expect(heard.prompts[0]).toContain('FAIL src/b.test.ts > b works')
        expect(heard.prompts[0]).toContain('the tests of your change')
        expect(heard.prompts[0]).toContain('not the whole check')
        expect(git(checkout, 'show', 'main:src/fixed.ts')).toBe('fixed')
        const { ticket: shown } = yield* show(ticket)
        expect(shown.status).toBe('closed')
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'checks once more where its worker commits nothing, and merges on a pass',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const worktree = yield* ticketWorktree(checkout)
        commit(worktree.path, 'the change', { 'src/b.ts': 'b\n' })
        const { worker } = scripted(() => settled(() => {}))
        const { all } = yield* mergeAll(
          config(checkout, `check-flaky ${freshPath('flaky')}`),
          [worktree],
          worker,
        )
        expect(all[all.length - 1]?._tag).toBe('Merged')
        expect(suites(all)).toEqual(['merge:failed', 'fix:passed'])
        expect(
          outcomes(all).find(update => update._tag === 'Requeued'),
        ).toEqual(
          expect.objectContaining({
            detail: 'its worker committed no fix: checked once more',
          }),
        )
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'sets the ticket aside where its worker commits nothing and the check fails again',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const worktree = yield* ticketWorktree(checkout)
        commit(worktree.path, 'the change', { 'src/b.ts': 'b\n' })
        const { worker, heard } = scripted(() => settled(() => {}))
        const { all } = yield* mergeAll(
          config(checkout, 'check-own'),
          [worktree],
          worker,
        )
        expect(heard.prompts).toHaveLength(1)
        expect(all[all.length - 1]).toEqual(
          expect.objectContaining({
            _tag: 'SetAside',
            reason: 'CHECKS_FAILED',
            detail: expect.stringContaining(
              'its worker found nothing to fix, and it failed again',
            ),
          }),
        )
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live('sets the ticket aside once its fix hand-backs are used up', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      const worktree = yield* ticketWorktree(checkout)
      commit(worktree.path, 'the change', { 'src/b.ts': 'b\n' })
      // Each attempt commits something that isn't the fix.
      const { worker, heard } = scripted(({ attempt }) =>
        settled(() => {
          commit(worktree.path, `attempt ${attempt}`, {
            'src/b.ts': `b ${attempt}\n`,
          })
        }),
      )
      const { all } = yield* mergeAll(
        config(checkout, 'check-own', { fix: 2 }),
        [worktree],
        worker,
      )
      expect(heard.prompts).toHaveLength(2)
      expect(heard.prompts[1]).toContain('Hand-back 2 of 2')
      expect(suites(all)).toEqual(['merge:failed', 'fix:failed', 'fix:failed'])
      expect(all[all.length - 1]).toEqual(
        expect.objectContaining({
          _tag: 'SetAside',
          reason: 'CHECKS_FAILED',
          detail: expect.stringContaining('its 2 hand-backs to fix used up'),
        }),
      )
    }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'rejects a fix that leaves an untracked file, naming it, its branch put back and its attempt kept',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const worktree = yield* ticketWorktree(checkout)
        const change = commit(worktree.path, 'the change', {
          'src/b.ts': 'b\n',
        })
        const { worker } = scripted(() =>
          settled(() => {
            commit(worktree.path, 'the fix', { 'src/fixed.ts': 'fixed\n' })
            write(worktree.path, { 'notes.txt': 'scratch\n' })
          }),
        )
        const { all } = yield* mergeAll(
          config(checkout, 'check-own'),
          [worktree],
          worker,
        )
        const final = all[all.length - 1]
        expect(final).toEqual(
          expect.objectContaining({
            _tag: 'SetAside',
            reason: 'CHECKS_FAILED',
            detail: expect.stringContaining(
              'its fix was rejected: it left untracked files: notes.txt; its attempt is kept as refs/fabrica/attempts/',
            ),
          }),
        )
        expect(hash(worktree.path, 'HEAD')).toBe(change)
        expect(
          git(
            worktree.path,
            'show',
            `refs/fabrica/attempts/${worktree.ticket}/fix-1:src/fixed.ts`,
          ),
        ).toBe('fixed')
      }).pipe(Effect.scoped, Effect.provide(services())),
  )
})

describe('a hand-back’s deadline', () => {
  /** A clock whose deadline comes when `due` is done; the run never holds. */
  const dueWhen = (due: Deferred.Deferred<void>): HandBackClockShape => ({
    sleep: () => Deferred.await(due),
    held: Stream.concat(Stream.make(false), Stream.never),
  })

  it.live(
    'takes a fix its worker committed from git, tells it so, and merges it',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const worktree = yield* ticketWorktree(checkout)
        commit(worktree.path, 'the change', { 'src/b.ts': 'b\n' })
        const due = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        // It commits its fix and works on past its time, never settling.
        const { worker, heard } = scripted(() =>
          Effect.sync(() => {
            commit(worktree.path, 'the fix', { 'src/fixed.ts': 'fixed\n' })
          }).pipe(
            Effect.andThen(Deferred.succeed(due, undefined)),
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        )
        const { all } = yield* mergeAll(
          config(checkout, 'check-own'),
          [worktree],
          worker,
          Option.some(dueWhen(due)),
        )
        expect(all[all.length - 1]?._tag).toBe('Merged')
        expect(yield* Deferred.isDone(interrupted)).toBe(true)
        expect(heard.told).toHaveLength(1)
        expect(heard.told[0]).toContain('Your branch is taken as it is')
        expect(suites(all)).toEqual(['merge:failed', 'fix:passed'])
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'tells a worker with nothing done that the hand-back is over before its branch is put back',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const worktree = yield* ticketWorktree(checkout)
        const change = commit(worktree.path, 'the change', {
          'src/b.ts': 'b\n',
        })
        const due = yield* Deferred.make<void>()
        const headWhenTold: Array<CommitHash> = []
        const { worker, heard } = scripted(
          () =>
            Effect.sync(() => {
              commit(worktree.path, 'half a fix', { 'src/half.ts': 'half\n' })
              write(worktree.path, { 'src/b.ts': 'b, unsaved\n' })
            }).pipe(
              Effect.andThen(Deferred.succeed(due, undefined)),
              Effect.andThen(Effect.never),
            ),
          () =>
            Effect.sync(() => {
              headWhenTold.push(hash(worktree.path, 'HEAD'))
            }),
        )
        const { all } = yield* mergeAll(
          config(checkout, 'check-own'),
          [worktree],
          worker,
          Option.some(dueWhen(due)),
        )
        const ref = `refs/fabrica/attempts/${worktree.ticket}/fix-1`
        expect(all[all.length - 1]).toEqual(
          expect.objectContaining({
            _tag: 'SetAside',
            reason: 'CHECKS_FAILED',
            detail: expect.stringContaining(
              `its hand-back ran past resolve_timeout (20m); its attempt is kept as ${ref}`,
            ),
          }),
        )
        expect(heard.told).toHaveLength(1)
        expect(heard.told[0]).toContain('Your hand-back')
        expect(heard.told[0]).toContain('is over')
        expect(heard.told[0]).toContain(ref)
        expect(headWhenTold).not.toContain(change)
        expect(hash(worktree.path, 'HEAD')).toBe(change)
        expect(git(worktree.path, 'show', `${ref}:src/half.ts`)).toBe('half')
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.effect('stops its clock while the run holds', () =>
    Effect.gen(function* () {
      const held = yield* SubscriptionRef.make(false)
      const started = yield* Queue.unbounded<number>()
      const stopped = yield* Queue.unbounded<void>()
      // Says each count-down it starts, with the minutes left, and each the hold stops.
      const clock: HandBackClockShape = {
        sleep: duration =>
          Effect.andThen(
            Queue.offer(started, Duration.toMinutes(duration)),
            Effect.onInterrupt(Effect.sleep(duration), () =>
              Queue.offer(stopped, undefined),
            ),
          ),
        held: SubscriptionRef.changes(held),
      }
      const out = yield* Effect.forkChild(runsOut(clock, '10 minutes'))
      expect(yield* Queue.take(started)).toBe(10)
      yield* TestClock.adjust('6 minutes')
      yield* SubscriptionRef.set(held, true)
      yield* Queue.take(stopped)
      yield* TestClock.adjust('1 hour')
      expect(out.pollUnsafe()).toBeUndefined()
      yield* SubscriptionRef.set(held, false)
      expect(yield* Queue.take(started)).toBe(4)
      yield* TestClock.adjust('3 minutes')
      expect(out.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust('1 minute')
      yield* Fiber.join(out)
    }),
  )
})

describe('a hand-back at the usage limit', () => {
  it.live(
    'takes a fix committed before the turn ended on the limit from git',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const worktree = yield* ticketWorktree(checkout)
        commit(worktree.path, 'the change', { 'src/b.ts': 'b\n' })
        const { worker, heard } = scripted(() =>
          Effect.sync(() => {
            commit(worktree.path, 'the fix', { 'src/fixed.ts': 'fixed\n' })
            return WorkerAnswer.AtLimit()
          }),
        )
        const { all } = yield* mergeAll(
          config(checkout, 'check-own'),
          [worktree],
          worker,
        )
        expect(all[all.length - 1]?._tag).toBe('Merged')
        expect(heard.prompts).toHaveLength(1)
        expect(heard.told[0]).toContain('its turn ended on the usage limit')
        expect(heard.told[0]).toContain('Your branch is taken as it is')
      }).pipe(Effect.scoped, Effect.provide(services())),
  )

  it.live(
    'gives the hand-back again once the hold lifts where nothing is done',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const worktree = yield* ticketWorktree(checkout)
        commit(worktree.path, 'the change', { 'src/b.ts': 'b\n' })
        const held = yield* SubscriptionRef.make(false)
        const { worker, heard } = scripted(({ prompt }) =>
          prompt.startsWith('The usage limit has lifted')
            ? settled(() => {
                commit(worktree.path, 'the fix', {
                  'src/fixed.ts': 'fixed\n',
                })
              })
            : // The hold is on by the time its turn ends on the limit, and lifts later.
              Effect.as(
                Effect.andThen(
                  SubscriptionRef.set(held, true),
                  Effect.forkDetach(SubscriptionRef.set(held, false)),
                ),
                WorkerAnswer.AtLimit(),
              ),
        )
        const { all } = yield* mergeAll(
          config(checkout, 'check-own'),
          [worktree],
          worker,
          Option.some({
            sleep: duration => Effect.sleep(duration),
            held: SubscriptionRef.changes(held),
          }),
        )
        expect(all[all.length - 1]?._tag).toBe('Merged')
        expect(heard.prompts).toHaveLength(2)
        expect(heard.prompts[1]).toContain('carry on with hand-back 1 for')
        expect(heard.prompts[1]).toContain(heard.prompts[0] ?? '')
      }).pipe(Effect.scoped, Effect.provide(services())),
  )
})

describe('a check failing outside the ticket’s code', () => {
  it.live(
    'sets it aside, checked once more once Base moves on, and merges it then',
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const first = yield* ticketWorktree(checkout)
        commit(first.path, 'the change', { 'src/b.ts': 'b\n' })
        const second = yield* ticketWorktree(checkout)
        commit(second.path, 'what the check needs', { 'other/ok.ts': 'ok\n' })
        const { worker, heard } = scripted(() => settled(() => {}))
        const { all } = yield* mergeAll(
          config(checkout, 'check-outside'),
          [first, second],
          worker,
          Option.none(),
          Option.some(
            update =>
              update.ticket === first.ticket && update._tag === 'Merged',
          ),
        )
        expect(heard.prompts).toEqual([])
        expect(outcomes(of(all, first.ticket))).toEqual([
          expect.objectContaining({
            _tag: 'SetAside',
            reason: 'CHECKS_FAILED',
            detail: expect.stringContaining(
              'checked once more if main moves on: it failed in other/c.test.ts, outside its own code',
            ),
          }),
          rechecked(first.ticket),
          expect.objectContaining({ _tag: 'Merged' }),
        ])
        expect(suites(of(all, first.ticket))).toEqual([
          'merge:failed',
          'recheck:passed',
        ])
        expect(git(checkout, 'show', 'main:src/b.ts')).toBe('b')
        const { ticket } = yield* show(first.ticket)
        expect(ticket.status).toBe('closed')
      }).pipe(Effect.scoped, Effect.provide(services())),
  )
})

describe('where a check failed', () => {
  it('is the ticket’s own code where it names a folder its commits change, or nothing', () => {
    const tracked = new Set(['src/a.ts', 'src/b.test.ts', 'other/c.test.ts'])
    const named = namedFiles(
      [
        'FAIL src/b.test.ts > b works',
        'other/c.test.ts(3,1): error TS2322: no',
        '/work/tree/src/a.ts:10:5: error',
        'Error: e.g. something',
      ],
      { worktree: '/work/tree', tracked },
    )
    expect(named).toEqual(['src/b.test.ts', 'other/c.test.ts', 'src/a.ts'])
    expect(
      inOwnCode({ named: ['other/c.test.ts'], changed: ['src/b.ts'] }),
    ).toBe(false)
    expect(inOwnCode({ named: ['src/b.test.ts'], changed: ['src/b.ts'] })).toBe(
      true,
    )
    expect(inOwnCode({ named: [], changed: ['src/b.ts'] })).toBe(true)
  })
})
