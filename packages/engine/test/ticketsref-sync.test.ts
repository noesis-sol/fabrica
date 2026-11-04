import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Stream,
} from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it, vi } from '@effect/vitest'
import {
  type Actor,
  Assignee,
  Edge,
  EngineId,
  SessionId,
  TicketEvent,
  TicketId,
} from '@fabrica/contracts'

import { type GitConfig, PushOutcome, layer as gitLayer } from '../src/git'
import {
  CommandOutcome,
  ProcessRunner,
  type RunnerConfig,
  StartFailed,
  StartFailure,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import {
  TicketsMeta,
  commitChanges,
  decodeTicketFile,
  encodeMeta,
  makeTicketsSync,
  secretsIn,
  secretsInFile,
  ticketsRef,
  withoutCredentials,
} from '../src/ticketsref'
import { WaitReason, WorkGraph, sqliteLayer } from '../src/workgraph'

// The tickets ref against real git (spec §11.7, §24): two simulated engines, each with its own database
// and clone of one bare remote, converge after concurrent edits, deletions, offline periods and rejected
// pushes, with failures injected between each step. Every test builds its own engines. The clock is the
// test's, so clocks and the 90 days are the test's to move; git's commands run for real.

// A test's two engines run some hundred git commands: under a loaded machine's checks, more than the 15 s others get.
vi.setConfig({ testTimeout: 90_000 })

let root = ''
let home = ''
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

const freshFolder = (name: string): string => {
  counter += 1
  const folder = join(root, `${name}-${counter}`)
  mkdirSync(folder)
  return folder
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-ticketsref-')))
  home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n[init]\n\tdefaultBranch = main\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
})

/** A bare remote and `clones` clones of it, each with one commit on `main`. */
const repositories = (clones: number) => {
  const remote = join(freshFolder('remote'), 'remote.git')
  mkdirSync(remote)
  git(remote, 'init', '--quiet', '--bare', '--initial-branch=main')
  const seed = freshFolder('seed')
  git(seed, 'init', '--quiet', '--initial-branch=main')
  writeFileSync(join(seed, 'README.md'), 'one\n')
  git(seed, 'add', '--all')
  git(seed, 'commit', '--quiet', '--message', 'one')
  git(seed, 'push', '--quiet', remote, 'main')
  const checkouts = Array.from({ length: clones }, () => {
    const checkout = join(freshFolder('clone'), 'work')
    git(root, 'clone', '--quiet', remote, checkout)
    return checkout
  })
  return { remote, checkouts }
}

const runnerConfig = (path: string): RunnerConfig => ({
  hostEnvironment: { PATH: path, HOME: home, LANG: 'C' },
  enginePriority: 0,
  priority: hostPriority,
  listProcesses,
  pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
  self: process.pid,
  killGrace: Duration.seconds(2),
  outputGrace: Duration.millis(200),
})

const config: GitConfig = {
  timeLimit: Duration.minutes(1),
  readRetries: { times: 0, spacing: Duration.zero },
}

/** A failure injected in the next command it matches: before it runs, or once it has run (a crash just after). */
interface Fault {
  readonly command: string
  readonly when: 'before' | 'after'
}

/** Work of another process or fiber, done just before the next command it matches runs. */
interface Meanwhile {
  readonly command: string
  readonly work: Effect.Effect<void>
}

const maintainer: Actor = { _tag: 'maintainer' }

/** One engine: its own database and clone, its faults to inject. */
const makeEngine = Effect.fnUntraced(function* ({
  id,
  checkout,
  path = `${gitFolder}:/usr/bin:/bin`,
  filename = join(freshFolder('db'), 'work.db'),
}: {
  readonly id: string
  readonly checkout: string
  readonly path?: string
  readonly filename?: string
}) {
  const fault = yield* Ref.make(Option.none<Fault>())
  /** Takes the fault if it is for this command and `when`, doing what it does meanwhile. */
  const firing = (
    args: ReadonlyArray<string>,
    when: Fault['when'],
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const injected = yield* Ref.get(fault)
      if (
        Option.isNone(injected) ||
        injected.value.when !== when ||
        !args.includes(injected.value.command)
      )
        return false
      yield* Ref.set(fault, Option.none())
      return true
    })
  const interleaved = yield* Ref.make(Option.none<Meanwhile>())
  const interleave = (args: ReadonlyArray<string>): Effect.Effect<void> =>
    Effect.gen(function* () {
      const due = yield* Ref.get(interleaved)
      if (Option.isNone(due) || !args.includes(due.value.command)) return
      yield* Ref.set(interleaved, Option.none())
      yield* due.value.work
    })
  const reason = StartFailure.SpawnFailed({
    command: 'git',
    message: 'injected',
  })
  const faulty = Layer.effect(
    ProcessRunner,
    Effect.gen(function* () {
      const inner = yield* ProcessRunner
      return ProcessRunner.of({
        run: command =>
          Effect.gen(function* () {
            yield* interleave(command.args)
            if (yield* firing(command.args, 'before'))
              return CommandOutcome.FailedToStart({ reason })
            const outcome = yield* inner.run(command)
            return (yield* firing(command.args, 'after'))
              ? CommandOutcome.FailedToStart({ reason })
              : outcome
          }),
        start: command =>
          Effect.flatMap(firing(command.args, 'before'), fires =>
            fires
              ? Effect.fail(new StartFailed({ reason }))
              : inner.start(command),
          ),
      })
    }),
  ).pipe(
    Layer.provide(Layer.provide(runnerLayer(runnerConfig(path)), layerClock)),
  )
  const context = yield* Layer.build(
    Layer.merge(
      Layer.provide(gitLayer(config), faulty),
      sqliteLayer({ prefix: 'fa', filename }),
    ),
  )
  const graph = Context.get(context, WorkGraph)
  const sql = Context.get(context, SqlClient.SqlClient)
  const engine = EngineId.make(id)
  const sync = yield* makeTicketsSync({
    repo: checkout,
    prefix: 'fa',
    engine,
  }).pipe(Effect.provide(context))
  /** The store's tickets and what hangs off them, as rows: what two engines that agree both have. */
  const dump = Effect.gen(function* () {
    const [tickets, labels, edges, notes, tombstones] = yield* Effect.all([
      sql`SELECT * FROM tickets ORDER BY id`,
      sql`SELECT * FROM labels ORDER BY ticket_id, label`,
      sql`SELECT * FROM edges ORDER BY from_id, to_id, kind`,
      sql`SELECT * FROM notes ORDER BY id`,
      sql`SELECT id FROM tombstones ORDER BY id`,
    ])
    return { tickets, labels, edges, notes, tombstones }
  })
  const events = (type: string) =>
    sql<{
      readonly ticket_id: string | null
      readonly payload: string
    }>`SELECT ticket_id, payload FROM events WHERE type = ${type} ORDER BY seq`
  const eventCount = Effect.map(
    sql<{ readonly n: number }>`SELECT count(*) AS n FROM events`,
    rows => rows[0]?.n ?? 0,
  )
  const head = () => {
    try {
      return git(checkout, 'rev-parse', '--verify', '--quiet', ticketsRef)
    } catch {
      return ''
    }
  }
  const tree = () => git(checkout, 'rev-parse', `${ticketsRef}^{tree}`)
  const files = () =>
    git(checkout, 'ls-tree', '-r', '--name-only', ticketsRef)
      .split('\n')
      .filter(line => line !== '')
  const file = (path: string) => git(checkout, 'show', `${ticketsRef}:${path}`)
  const inject = (next: Fault) => Ref.set(fault, Option.some(next))
  const during = (next: Meanwhile) => Ref.set(interleaved, Option.some(next))
  const create = (title: string) =>
    Effect.map(
      graph.create({ ticket: { type: 'task', title }, actor: maintainer }),
      ticket => ticket.id,
    )
  return {
    id,
    engine,
    checkout,
    graph,
    sql,
    sync,
    dump,
    events,
    eventCount,
    head,
    tree,
    files,
    file,
    inject,
    during,
    create,
  }
})

type TestEngine = Effect.Success<ReturnType<typeof makeEngine>>

/** The engines' syncs, in turn, until each holds what the others pushed. */
const converge = (...engines: ReadonlyArray<TestEngine>) =>
  Effect.gen(function* () {
    for (let round = 0; round < 2; round += 1) {
      for (const engine of engines) {
        yield* TestClock.adjust('1 second')
        yield* engine.sync.sync('origin')
      }
    }
  })

/** The engines hold one state: the same tree on the ref, the same rows in the store. */
const expectConverged = (a: TestEngine, b: TestEngine) =>
  Effect.gen(function* () {
    expect(a.tree()).toBe(b.tree())
    expect(yield* a.dump).toEqual(yield* b.dump)
  })

const twoEngines = Effect.gen(function* () {
  const { remote, checkouts } = repositories(2)
  const a = yield* makeEngine({
    id: 'fe-a',
    checkout: checkouts[0] ?? '',
  })
  const b = yield* makeEngine({
    id: 'fe-b',
    checkout: checkouts[1] ?? '',
  })
  return { remote, a, b }
})

/** A secret's text, made at run time so no scanner takes this file for one. */
const awsKey = () => ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')

describe('commits', () => {
  it.effect(
    'writes the ref with plumbing, authored by the engine, touching no checkout',
    () =>
      Effect.gen(function* () {
        const { a } = yield* twoEngines
        const before = git(a.checkout, 'status', '--porcelain=v2', '--branch')
        const head = git(a.checkout, 'rev-parse', 'HEAD')
        const id = yield* a.create('One')
        yield* a.graph.label({ id, label: 'x', actor: maintainer })
        yield* a.graph.note({ id, body: 'A note', actor: maintainer })
        const settled = yield* a.sync.commit
        expect(settled.committed).toBe(true)

        expect(a.files()).toEqual(['meta.json', `tickets/${id}.json`])
        expect(
          git(a.checkout, 'log', '-1', '--format=%an|%cn|%s', ticketsRef),
        ).toBe('fe-a|fe-a|tickets: 1 changed (fe-a)')
        const file = yield* decodeTicketFile(
          a.file(`tickets/${id}.json`) + '\n',
        )
        expect(file.ticket.title).toBe('One')
        expect(file.labels).toEqual(['x'])
        expect(file.notes.map(note => note.body)).toEqual(['A note'])

        expect(git(a.checkout, 'status', '--porcelain=v2', '--branch')).toBe(
          before,
        )
        expect(git(a.checkout, 'rev-parse', 'HEAD')).toBe(head)
      }).pipe(Effect.scoped),
  )

  it.effect('makes no commit, and writes nothing, when nothing changed', () =>
    Effect.gen(function* () {
      const { a } = yield* twoEngines
      const none = yield* a.sync.commit
      expect(none.committed).toBe(false)
      expect(a.head()).toBe('')

      const id = yield* a.create('One')
      yield* a.sync.commit
      const head = a.head()
      const dump = yield* a.dump
      const state = yield* a.sync.state
      yield* TestClock.adjust('1 minute')
      const again = yield* a.sync.commit
      expect(again.committed).toBe(false)
      expect(a.head()).toBe(head)
      expect(yield* a.dump).toEqual(dump)
      expect(yield* a.sync.state).toEqual(state)

      // A change put back to what the ref has makes no commit either: only the events moved.
      yield* a.graph.label({ id, label: 'x', actor: maintainer })
      yield* a.graph.unlabel({ id, label: 'x', actor: maintainer })
      const back = yield* a.sync.commit
      expect(back.committed).toBe(false)
      expect(a.head()).toBe(head)
    }).pipe(Effect.scoped),
  )

  it.effect('a changed field alone takes a new clock', () =>
    Effect.gen(function* () {
      const { a } = yield* twoEngines
      yield* TestClock.adjust('1 second')
      const id = yield* a.create('One')
      yield* a.sync.commit
      const path = `tickets/${id}.json`
      const first = yield* decodeTicketFile(a.file(path) + '\n')
      yield* TestClock.adjust('1 second')
      yield* a.graph.update({
        id,
        changes: { title: 'Two' },
        actor: maintainer,
      })
      yield* a.sync.commit
      const second = yield* decodeTicketFile(a.file(path) + '\n')
      expect(second.clocks.title.wall).toBeGreaterThan(first.clocks.title.wall)
      expect(second.clocks.priority).toEqual(first.clocks.priority)
      expect((yield* a.sync.state).lastClock).toEqual(second.clocks.title)
    }).pipe(Effect.scoped),
  )

  it.effect('reruns the cycle when another process moved the ref first', () =>
    Effect.gen(function* () {
      const { a } = yield* twoEngines
      yield* a.create('One')
      yield* a.sync.commit
      const first = a.head()
      const id = yield* a.create('Two')
      yield* a.during({
        command: 'update-ref',
        // Another process moves the ref: the same tree, a commit of its own.
        work: Effect.sync(() => {
          const tree = git(a.checkout, 'rev-parse', `${first}^{tree}`)
          const other = git(
            a.checkout,
            'commit-tree',
            tree,
            '-p',
            first,
            '-m',
            'other',
          )
          git(a.checkout, 'update-ref', ticketsRef, other, first)
        }),
      })
      // The engine's `update-ref` is refused for its stale expected value, and the cycle runs again.
      const settled = yield* a.sync.commit
      expect(settled.committed).toBe(true)
      expect(a.files()).toContain(`tickets/${id}.json`)
      expect(git(a.checkout, 'log', '--format=%s', ticketsRef)).toContain(
        'other',
      )
    }).pipe(Effect.scoped),
  )

  it.effect('never runs a hook, and no hook can stop it', () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoEngines
      const log = join(freshFolder('hooks'), 'ran.log')
      const refuse = `#!/bin/sh\necho "$0" >> "${log}"\nexit 1\n`
      const folder = join(a.checkout, '.git', 'hooks')
      mkdirSync(folder, { recursive: true })
      for (const name of [
        'pre-push',
        'reference-transaction',
        'post-index-change',
        'pre-commit',
        'post-commit',
        'post-rewrite',
      ]) {
        const hook = join(folder, name)
        writeFileSync(hook, refuse)
        chmodSync(hook, 0o755)
      }
      // A hook of git's configuration, which `core.hooksPath` doesn't reach (git 2.54).
      git(
        a.checkout,
        'config',
        'hook.veto.command',
        `/bin/sh -c 'echo veto >> "${log}"; exit 1'`,
      )
      git(a.checkout, 'config', 'hook.veto.event', 'reference-transaction')
      git(a.checkout, 'config', '--add', 'hook.veto.event', 'pre-push')

      yield* b.create('From b')
      yield* b.sync.sync('origin')
      yield* a.create('From a')
      const synced = yield* a.sync.sync('origin')
      expect(synced.pushed._tag).toBe('Pushed')
      expect(existsSync(log)).toBe(false)
      // The hooks were armed: git's own command, with none of the engine's flags, is refused by them.
      expect(() =>
        git(a.checkout, 'update-ref', 'refs/fabrica/armed', 'HEAD'),
      ).toThrow()
      expect(existsSync(log)).toBe(true)
    }).pipe(Effect.scoped),
  )
})

describe('two engines', () => {
  it.effect(
    'converge after concurrent edits of different and the same fields',
    () =>
      Effect.gen(function* () {
        const { a, b } = yield* twoEngines
        const id = yield* a.create('Shared')
        yield* converge(a, b)
        yield* expectConverged(a, b)

        yield* TestClock.adjust('1 second')
        yield* a.graph.update({
          id,
          changes: { title: 'From a', priority: 1 },
          actor: maintainer,
        })
        yield* a.graph.label({ id, label: 'a', actor: maintainer })
        yield* a.graph.note({ id, body: 'Note from a', actor: maintainer })
        yield* a.sync.commit
        yield* TestClock.adjust('1 second')
        yield* b.graph.update({
          id,
          changes: { title: 'From b', description: Option.some('Described') },
          actor: maintainer,
        })
        yield* b.graph.label({ id, label: 'b', actor: maintainer })
        yield* b.graph.note({ id, body: 'Note from b', actor: maintainer })
        yield* b.sync.commit

        yield* converge(a, b)
        yield* expectConverged(a, b)
        const { ticket, labels, notes } = yield* a.graph.show(id)
        // The later clock takes the title; each side's other fields stay.
        expect(ticket.title).toBe('From b')
        expect(ticket.priority).toBe(1)
        expect(ticket.description).toEqual(Option.some('Described'))
        expect(labels).toEqual(['a', 'b'])
        expect(notes.map(note => note.body).sort()).toEqual([
          'Note from a',
          'Note from b',
        ])
        // The engine that merged records the conflict, with both values.
        const recorded = [
          ...(yield* a.events('merge_conflict')),
          ...(yield* b.events('merge_conflict')),
        ]
        expect(recorded.map(event => event.ticket_id)).toEqual([id])
        expect(recorded[0]?.payload).toContain('From a')
        expect(recorded[0]?.payload).toContain('From b')
      }).pipe(Effect.scoped),
  )

  it.effect('a deletion against an edit loses, with a conflict recorded', () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoEngines
      const edited = yield* a.create('Edited')
      const both = yield* a.create('Deleted by both')
      const deleted = yield* a.create('Deleted by a')
      const linked = yield* a.create('Linked to the deleted')
      yield* a.graph.addDependency({
        edge: new Edge({ from: linked, to: deleted, kind: 'related' }),
        actor: maintainer,
      })
      yield* converge(a, b)

      yield* a.graph.delete({ id: edited, actor: maintainer })
      yield* a.graph.delete({ id: both, actor: maintainer })
      yield* a.graph.delete({ id: deleted, actor: maintainer })
      yield* a.sync.commit
      yield* b.graph.update({
        id: edited,
        changes: { title: 'Kept' },
        actor: maintainer,
      })
      yield* b.graph.delete({ id: both, actor: maintainer })
      yield* b.sync.commit

      yield* converge(a, b)
      yield* expectConverged(a, b)
      expect((yield* a.graph.show(edited)).ticket.title).toBe('Kept')
      expect(a.files()).toContain(`tickets/${edited}.json`)
      expect(a.files()).not.toContain(`tombstones/${edited}.json`)
      expect(a.files()).toContain(`tombstones/${both}.json`)
      expect(a.files()).toContain(`tombstones/${deleted}.json`)
      expect((yield* Effect.exit(b.graph.show(deleted)))._tag).toBe('Failure')
      // The deletion took the link with it, on the ref and in both stores.
      expect((yield* b.graph.show(linked)).edges).toEqual([])
      const conflicts = [
        ...(yield* a.events('merge_conflict')),
        ...(yield* b.events('merge_conflict')),
      ].filter(event => event.ticket_id === edited)
      expect(conflicts.length).toBe(1)
      expect(conflicts[0]?.payload).toContain('deleted')
    }).pipe(Effect.scoped),
  )

  it.effect('an offline engine waits, then converges with no lost edit', () =>
    Effect.gen(function* () {
      const { remote, a, b } = yield* twoEngines
      const id = yield* a.create('Shared')
      yield* converge(a, b)
      const away = `${remote}.away`
      renameSync(remote, away)
      yield* a.graph.update({
        id,
        changes: { title: 'Edited offline' },
        actor: maintainer,
      })
      const offline = yield* a.create('Filed offline')
      const synced = yield* a.sync.sync('origin')
      expect(synced.pulled._tag).toBe('Unreachable')
      expect(synced.pushed._tag).toBe('Failed')
      // Committed locally, and waiting.
      expect(a.files()).toContain(`tickets/${offline}.json`)
      renameSync(away, remote)
      yield* b.graph.update({
        id,
        changes: { priority: 0 },
        actor: maintainer,
      })
      yield* converge(a, b)
      yield* expectConverged(a, b)
      const { ticket } = yield* b.graph.show(id)
      expect(ticket.title).toBe('Edited offline')
      expect(ticket.priority).toBe(0)
      expect((yield* b.graph.show(offline)).ticket.title).toBe('Filed offline')
    }).pipe(Effect.scoped),
  )

  it.effect(
    'a push losing to another engine fetches and merges first, never forced',
    () =>
      Effect.gen(function* () {
        const { remote, a, b } = yield* twoEngines
        yield* a.create('Shared')
        yield* converge(a, b)
        const pushedBefore = git(remote, 'rev-parse', ticketsRef)
        const fromA = yield* a.create('From a')
        const fromB = yield* b.create('From b')
        yield* b.sync.push('origin')
        // A's push on its own is refused, and a's ref stays as it was.
        const refused = yield* a.sync.push('origin')
        expect(refused._tag).toBe('NotFastForward')
        const synced = yield* a.sync.sync('origin')
        expect(synced.pushed).toEqual(PushOutcome.Pushed())
        yield* converge(a, b)
        yield* expectConverged(a, b)
        expect((yield* a.graph.show(fromB)).ticket.title).toBe('From b')
        expect((yield* b.graph.show(fromA)).ticket.title).toBe('From a')
        // The history only grows.
        git(remote, 'merge-base', '--is-ancestor', pushedBefore, ticketsRef)
      }).pipe(Effect.scoped),
  )

  it.effect(
    'a push the remote refuses waits, and goes once it stops refusing',
    () =>
      Effect.gen(function* () {
        const { remote, a, b } = yield* twoEngines
        const hook = join(remote, 'hooks', 'pre-receive')
        writeFileSync(hook, '#!/bin/sh\necho no >&2\nexit 1\n')
        chmodSync(hook, 0o755)
        yield* a.create('Refused')
        const synced = yield* a.sync.sync('origin')
        expect(synced.pushed._tag).toBe('Rejected')
        expect(Option.isNone((yield* a.sync.state).lastPushed)).toBe(true)
        writeFileSync(hook, '#!/bin/sh\nexit 0\n')
        yield* converge(a, b)
        yield* expectConverged(a, b)
      }).pipe(Effect.scoped),
  )

  describe('with a failure between steps', () => {
    const steps: ReadonlyArray<{
      readonly name: string
      readonly fault: Fault
    }> = [
      {
        name: 'writing a blob',
        fault: { command: 'hash-object', when: 'before' },
      },
      { name: 'writing a tree', fault: { command: 'mktree', when: 'before' } },
      {
        name: 'writing a commit',
        fault: { command: 'commit-tree', when: 'before' },
      },
      {
        name: 'moving the ref',
        fault: { command: 'update-ref', when: 'before' },
      },
      {
        name: 'after moving the ref',
        fault: { command: 'update-ref', when: 'after' },
      },
      {
        name: 'reading a merge base',
        fault: { command: 'merge-base', when: 'before' },
      },
      {
        name: 'reading the changes',
        fault: { command: 'diff-tree', when: 'before' },
      },
      {
        name: 'reading the files',
        fault: { command: 'cat-file', when: 'before' },
      },
      { name: 'fetching', fault: { command: 'fetch', when: 'before' } },
      { name: 'pushing', fault: { command: 'push', when: 'before' } },
      { name: 'after pushing', fault: { command: 'push', when: 'after' } },
    ]
    for (const { name, fault } of steps) {
      it.effect(`converges with no lost edit: ${name}`, () =>
        Effect.gen(function* () {
          const { a, b } = yield* twoEngines
          const shared = yield* a.create('Shared')
          yield* converge(a, b)
          yield* TestClock.adjust('1 second')
          yield* b.graph.update({
            id: shared,
            changes: { title: 'From b' },
            actor: maintainer,
          })
          yield* b.sync.sync('origin')
          yield* a.graph.update({
            id: shared,
            changes: { priority: 0 },
            actor: maintainer,
          })
          yield* a.graph.note({ id: shared, body: 'Kept', actor: maintainer })
          const filed = yield* a.create('Filed by a')
          yield* a.inject(fault)
          // The step's failure stops the sync, or is taken as a sync that waits.
          yield* Effect.exit(a.sync.sync('origin'))

          yield* converge(a, b)
          yield* expectConverged(a, b)
          const { ticket, notes } = yield* b.graph.show(shared)
          expect(ticket.title).toBe('From b')
          expect(ticket.priority).toBe(0)
          expect(notes.map(note => note.body)).toEqual(['Kept'])
          expect((yield* b.graph.show(filed)).ticket.title).toBe('Filed by a')
        }).pipe(Effect.scoped),
      )
    }

    it.effect(
      'a crash during an import rolls back, the last commit imported unchanged',
      () =>
        Effect.gen(function* () {
          const { a, b } = yield* twoEngines
          const shared = yield* a.create('Shared')
          yield* converge(a, b)
          yield* b.graph.update({
            id: shared,
            changes: { title: 'Bad' },
            actor: maintainer,
          })
          yield* b.graph.label({ id: shared, label: 'boom', actor: maintainer })
          yield* b.sync.sync('origin')
          const before = yield* a.dump
          const state = yield* a.sync.state
          yield* a.sql.unsafe(
            `CREATE TRIGGER boom BEFORE INSERT ON labels WHEN NEW.label = 'boom'
           BEGIN SELECT RAISE(ABORT, 'injected'); END`,
          )
          const stopped = yield* Effect.exit(a.sync.pull('origin'))
          expect(stopped._tag).toBe('Failure')
          expect(yield* a.dump).toEqual(before)
          expect((yield* a.sync.state).lastImported).toEqual(state.lastImported)

          yield* a.sql.unsafe('DROP TRIGGER boom')
          yield* converge(a, b)
          yield* expectConverged(a, b)
          expect((yield* a.graph.show(shared)).ticket.title).toBe('Bad')
        }).pipe(Effect.scoped),
    )

    it.effect('a crash after a merge moved the ref keeps its conflicts', () =>
      Effect.gen(function* () {
        const { a, b } = yield* twoEngines
        const shared = yield* a.create('Shared')
        yield* converge(a, b)
        yield* TestClock.adjust('1 second')
        yield* b.graph.update({
          id: shared,
          changes: { title: 'From b' },
          actor: maintainer,
        })
        yield* b.sync.sync('origin')
        yield* TestClock.adjust('1 second')
        yield* a.graph.update({
          id: shared,
          changes: { title: 'From a' },
          actor: maintainer,
        })
        yield* a.sync.commit
        yield* a.inject({ command: 'diff-tree', when: 'before' })
        yield* Effect.exit(a.sync.pull('origin'))
        yield* converge(a, b)
        yield* expectConverged(a, b)
        const recorded = yield* a.events('merge_conflict')
        expect(recorded.map(event => event.ticket_id)).toEqual([shared])
      }).pipe(Effect.scoped),
    )
  })
})

describe('imports', () => {
  it.effect('importing a commit twice changes nothing', () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoEngines
      const one = yield* a.create('One')
      const two = yield* a.create('Two')
      yield* a.graph.label({ id: one, label: 'x', actor: maintainer })
      yield* a.graph.note({ id: two, body: 'A note', actor: maintainer })
      yield* a.graph.addDependency({
        edge: new Edge({ from: one, to: two, kind: 'blocks' }),
        actor: maintainer,
      })
      yield* converge(a, b)
      const earlier = Option.getOrThrow((yield* b.sync.state).lastImported)
      yield* a.graph.update({
        id: one,
        changes: { title: 'New' },
        actor: maintainer,
      })
      yield* a.graph.label({ id: two, label: 'y', actor: maintainer })
      yield* converge(a, b)
      const head = b.head()
      const dump = yield* b.dump
      const events = yield* b.eventCount
      expect(Option.getOrThrow((yield* b.sync.state).lastImported)).not.toBe(
        earlier,
      )
      // As a crash before the import was recorded would leave it: the same files are imported again.
      yield* b.sql`UPDATE tickets_sync SET last_imported = ${earlier}`
      yield* b.sync.commit
      expect(b.head()).toBe(head)
      expect(yield* b.dump).toEqual(dump)
      expect(yield* b.eventCount).toBe(events)
    }).pipe(Effect.scoped),
  )

  it.effect('reads only the files that changed', () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoEngines
      const one = yield* a.create('One')
      const two = yield* a.create('Two')
      yield* converge(a, b)
      // A file the import would refuse, were it read: it hasn't changed, so it isn't.
      yield* b.sql`UPDATE tickets SET title = 'Local' WHERE id = ${two}`
      yield* a.graph.update({
        id: one,
        changes: { title: 'New' },
        actor: maintainer,
      })
      yield* a.sync.sync('origin')
      yield* b.sync.pull('origin')
      expect((yield* b.graph.show(one)).ticket.title).toBe('New')
      expect((yield* b.graph.show(two)).ticket.title).toBe('Local')
    }).pipe(Effect.scoped),
  )

  it.effect(
    'a change made during a sync is kept, the cycle running again',
    () =>
      Effect.gen(function* () {
        const { a, b } = yield* twoEngines
        const shared = yield* a.create('Shared')
        yield* converge(a, b)
        yield* a.graph.update({
          id: shared,
          changes: { priority: 0 },
          actor: maintainer,
        })
        yield* a.sync.sync('origin')
        // A change arrives between b's read of its store and its import, which is refused and runs again.
        yield* b.during({
          command: 'diff-tree',
          work: b.graph
            .update({
              id: shared,
              changes: { title: 'Made meanwhile' },
              actor: maintainer,
            })
            .pipe(Effect.asVoid, Effect.orDie),
        })
        yield* b.sync.pull('origin')
        expect((yield* b.graph.show(shared)).ticket.title).toBe(
          'Made meanwhile',
        )
        expect((yield* b.graph.show(shared)).ticket.priority).toBe(0)
        yield* converge(a, b)
        yield* expectConverged(a, b)
        const { ticket } = yield* a.graph.show(shared)
        expect(ticket.title).toBe('Made meanwhile')
        expect(ticket.priority).toBe(0)
      }).pipe(Effect.scoped),
  )

  it.effect('a ticket missing from SQLite never removes its file', () =>
    Effect.gen(function* () {
      const { a } = yield* twoEngines
      const id = yield* a.create('One')
      const other = yield* a.create('Other')
      yield* a.sync.commit
      const content = a.file(`tickets/${id}.json`)
      yield* a.sql`DELETE FROM tickets WHERE id = ${id}`
      yield* a.graph.update({
        id: other,
        changes: { title: 'Changed' },
        actor: maintainer,
      })
      yield* a.sync.commit
      expect(a.files()).toContain(`tickets/${id}.json`)
      expect(a.file(`tickets/${id}.json`)).toBe(content)
    }).pipe(Effect.scoped),
  )

  it.effect(
    'a fresh database takes the backlog from the ref, wiping nothing',
    () =>
      Effect.gen(function* () {
        const { a } = yield* twoEngines
        const id = yield* a.create('One')
        yield* a.sync.commit
        const head = a.head()
        const fresh = yield* makeEngine({ id: 'fe-a', checkout: a.checkout })
        const settled = yield* fresh.sync.commit
        expect(settled.imported).toBe(1)
        expect(fresh.head()).toBe(head)
        expect((yield* fresh.graph.show(id)).ticket.title).toBe('One')
      }).pipe(Effect.scoped),
  )

  it.effect(
    'a database with tickets of its own meets an existing ref by merging',
    () =>
      Effect.gen(function* () {
        const { a, b } = yield* twoEngines
        const fromA = yield* a.create('From a')
        yield* a.sync.sync('origin')
        const fromB = yield* b.create('From b')
        yield* converge(b, a)
        yield* expectConverged(a, b)
        expect((yield* a.graph.show(fromB)).ticket.title).toBe('From b')
        expect((yield* b.graph.show(fromA)).ticket.title).toBe('From a')
      }).pipe(Effect.scoped),
  )
})

describe('a store whose ref is gone', () => {
  /** Two engines holding one backlog of every kind of thing another engine goes on to change. */
  const backlog = Effect.gen(function* () {
    const { remote, checkouts } = repositories(2)
    const checkout = checkouts[0] ?? ''
    const a = yield* makeEngine({
      id: 'fe-a',
      checkout,
      filename: join(freshFolder('db'), 'work.db'),
    })
    const b = yield* makeEngine({ id: 'fe-b', checkout: checkouts[1] ?? '' })
    const edited = yield* a.create('Edited')
    const gone = yield* a.create('Gone')
    const goneHere = yield* a.create('Gone here')
    const labelled = yield* a.create('Labelled')
    const linked = yield* a.create('Linked')
    const claimed = yield* a.create('Claimed')
    const deferred = yield* a.create('Deferred')
    yield* a.graph.label({ id: labelled, label: 'x', actor: maintainer })
    yield* a.graph.addDependency({
      edge: new Edge({ from: linked, to: labelled, kind: 'related' }),
      actor: maintainer,
    })
    yield* a.graph.claim({
      id: claimed,
      assignee: new Assignee({
        engine: a.engine,
        session: SessionId.make('s-1'),
      }),
      actor: maintainer,
    })
    yield* a.graph.defer({
      id: deferred,
      until: Option.none(),
      actor: maintainer,
    })
    yield* a.graph.delete({ id: goneHere, actor: maintainer })
    yield* converge(a, b)

    yield* TestClock.adjust('1 second')
    yield* b.graph.update({
      id: edited,
      changes: { title: 'Edited by b', description: Option.some('From b') },
      actor: maintainer,
    })
    yield* b.graph.delete({ id: gone, actor: maintainer })
    yield* b.graph.unlabel({ id: labelled, label: 'x', actor: maintainer })
    yield* b.graph.removeDependency({
      edge: new Edge({ from: linked, to: labelled, kind: 'related' }),
      actor: maintainer,
    })
    yield* b.graph.release({ id: claimed, actor: maintainer })
    yield* b.graph.undefer({ id: deferred, actor: maintainer })
    yield* b.sync.sync('origin')
    yield* TestClock.adjust('1 second')
    return {
      remote,
      checkout,
      a,
      b,
      edited,
      gone,
      goneHere,
      labelled,
      linked,
      claimed,
      deferred,
    }
  })

  type Backlog = Effect.Success<typeof backlog>

  /** The checkout cloned again in its place, the database kept: the old commits are gone. */
  const cloneAgain = ({ remote, checkout, a }: Backlog) =>
    Effect.gen(function* () {
      renameSync(checkout, `${checkout}.old`)
      git(root, 'clone', '--quiet', '--no-local', remote, checkout)
      const imported = Option.getOrThrow((yield* a.sync.state).lastImported)
      expect(() =>
        git(checkout, 'cat-file', '-e', `${imported}^{commit}`),
      ).toThrow()
    })

  /** Every change of the other engine's stands, on both, and no conflict was made up. */
  const expectKept = (backlogged: Backlog) =>
    Effect.gen(function* () {
      const {
        a,
        b,
        edited,
        gone,
        goneHere,
        labelled,
        linked,
        claimed,
        deferred,
      } = backlogged
      yield* expectConverged(a, b)
      const { ticket } = yield* a.graph.show(edited)
      expect(ticket.title).toBe('Edited by b')
      expect(ticket.description).toEqual(Option.some('From b'))
      expect((yield* Effect.exit(a.graph.show(gone)))._tag).toBe('Failure')
      expect((yield* Effect.exit(a.graph.show(goneHere)))._tag).toBe('Failure')
      expect(a.files()).toContain(`tombstones/${gone}.json`)
      expect(a.files()).toContain(`tombstones/${goneHere}.json`)
      expect((yield* a.graph.show(labelled)).labels).toEqual([])
      expect((yield* a.graph.show(linked)).edges).toEqual([])
      const released = (yield* a.graph.show(claimed)).ticket
      expect(released.status).toBe('open')
      expect(Option.isNone(released.assignee)).toBe(true)
      expect((yield* a.graph.show(deferred)).ticket.status).toBe('open')
      expect(yield* a.events('merge_conflict')).toEqual([])
      expect(yield* b.events('merge_conflict')).toEqual([])
    })

  it.effect(
    'a new clone under the same database keeps the remote’s every change, and its own',
    () =>
      Effect.gen(function* () {
        const backlogged = yield* backlog
        const { a, b, edited } = backlogged
        yield* cloneAgain(backlogged)
        yield* a.graph.update({
          id: edited,
          changes: { priority: 0 },
          actor: maintainer,
        })
        yield* a.sync.sync('origin')
        yield* converge(a, b)
        yield* expectKept(backlogged)
        expect((yield* b.graph.show(edited)).ticket.priority).toBe(0)
      }).pipe(Effect.scoped),
  )

  it.effect(
    'a commit comes first, as the batch makes it: it fetches its base too',
    () =>
      Effect.gen(function* () {
        const backlogged = yield* backlog
        const { a, b, edited } = backlogged
        yield* cloneAgain(backlogged)
        yield* a.graph.update({
          id: edited,
          changes: { priority: 0 },
          actor: maintainer,
        })
        const settled = yield* a.sync.commit
        expect(settled.committed).toBe(true)
        yield* converge(a, b)
        yield* expectKept(backlogged)
        expect((yield* b.graph.show(edited)).ticket.priority).toBe(0)
      }).pipe(Effect.scoped),
  )

  it.effect(
    'a last import never pushed: the last push is the base, what came after it kept',
    () =>
      Effect.gen(function* () {
        const backlogged = yield* backlog
        const { a, b, edited, linked } = backlogged
        yield* a.graph.note({ id: linked, body: 'Unpushed', actor: maintainer })
        yield* a.graph.update({
          id: edited,
          changes: { priority: 1 },
          actor: maintainer,
        })
        yield* a.sync.commit
        const unpushed = yield* a.create('Never pushed')
        yield* a.sync.commit
        expect(
          Option.getOrThrow((yield* a.sync.state).lastImported),
        ).not.toEqual(Option.getOrThrow((yield* a.sync.state).lastPushed))
        yield* cloneAgain(backlogged)
        yield* converge(a, b)
        yield* expectKept(backlogged)
        expect((yield* b.graph.show(edited)).ticket.priority).toBe(1)
        expect((yield* b.graph.show(unpushed)).ticket.title).toBe(
          'Never pushed',
        )
        expect(
          (yield* b.graph.show(linked)).notes.map(note => note.body),
        ).toEqual(['Unpushed'])
      }).pipe(Effect.scoped),
  )

  it.effect(
    'an engine that only ever fetched: what it fetched last is the base',
    () =>
      Effect.gen(function* () {
        const { remote, checkouts } = repositories(2)
        const checkout = checkouts[1] ?? ''
        const a = yield* makeEngine({
          id: 'fe-a',
          checkout: checkouts[0] ?? '',
        })
        const b = yield* makeEngine({ id: 'fe-b', checkout })
        const id = yield* a.create('Shared')
        const gone = yield* a.create('Gone')
        yield* a.sync.sync('origin')
        yield* b.sync.pull('origin')
        yield* b.graph.note({ id, body: 'From b', actor: maintainer })
        yield* b.sync.commit
        yield* TestClock.adjust('1 second')
        yield* a.graph.update({
          id,
          changes: { title: 'From a' },
          actor: maintainer,
        })
        yield* a.graph.delete({ id: gone, actor: maintainer })
        yield* a.sync.sync('origin')
        yield* TestClock.adjust('1 second')
        renameSync(checkout, `${checkout}.old`)
        git(root, 'clone', '--quiet', '--no-local', remote, checkout)
        yield* converge(b, a)
        yield* expectConverged(a, b)
        const { ticket, notes } = yield* a.graph.show(id)
        expect(ticket.title).toBe('From a')
        expect(notes.map(note => note.body)).toEqual(['From b'])
        expect((yield* Effect.exit(b.graph.show(gone)))._tag).toBe('Failure')
        expect(yield* a.events('merge_conflict')).toEqual([])
        expect(yield* b.events('merge_conflict')).toEqual([])
      }).pipe(Effect.scoped),
  )

  it.effect(
    'an unpushed edit older than the other engine’s doesn’t outrank it',
    () =>
      Effect.gen(function* () {
        const { remote, a, b } = yield* twoEngines
        const id = yield* a.create('Shared')
        yield* converge(a, b)
        yield* a.graph.update({
          id,
          changes: { title: 'A, the earlier' },
          actor: maintainer,
        })
        yield* a.sync.commit
        yield* TestClock.adjust('1 minute')
        yield* b.graph.update({
          id,
          changes: { title: 'B, the later' },
          actor: maintainer,
        })
        yield* b.sync.sync('origin')
        yield* TestClock.adjust('1 minute')
        renameSync(a.checkout, `${a.checkout}.old`)
        git(root, 'clone', '--quiet', '--no-local', remote, a.checkout)
        yield* converge(a, b)
        yield* expectConverged(a, b)
        expect((yield* a.graph.show(id)).ticket.title).toBe('B, the later')
      }).pipe(Effect.scoped),
  )

  for (const when of ['before', 'after'] as const) {
    it.effect(
      `a merge kept for a commit the clone lost is dropped: a failure ${when} moving the ref`,
      () =>
        Effect.gen(function* () {
          const { remote, a, b } = yield* twoEngines
          const id = yield* a.create('Shared')
          yield* converge(a, b)
          yield* a.graph.update({
            id,
            changes: { title: 'A' },
            actor: maintainer,
          })
          yield* a.sync.commit
          yield* TestClock.adjust('1 second')
          yield* b.graph.update({
            id,
            changes: { title: 'B' },
            actor: maintainer,
          })
          yield* b.sync.sync('origin')
          yield* TestClock.adjust('1 second')
          // The merge's conflict is kept, and its commit goes with the old clone.
          yield* a.inject({ command: 'update-ref', when })
          const stopped = yield* Effect.exit(a.sync.pull('origin'))
          expect(stopped._tag).toBe('Failure')
          const kept = yield* a.sql`SELECT * FROM tickets_sync_pending`
          expect(kept.length).toBeGreaterThan(0)
          renameSync(a.checkout, `${a.checkout}.old`)
          git(root, 'clone', '--quiet', '--no-local', remote, a.checkout)

          yield* converge(a, b)
          yield* expectConverged(a, b)
          expect((yield* a.graph.show(id)).ticket.title).toBe('B')
          expect(yield* a.sql`SELECT * FROM tickets_sync_pending`).toEqual([])
          expect((yield* a.sync.rebuild).tickets).toBe(1)
        }).pipe(Effect.scoped),
    )
  }

  it.effect(
    'a remote that doesn’t answer: nothing is exported until it does',
    () =>
      Effect.gen(function* () {
        const backlogged = yield* backlog
        const { remote, a, b, edited } = backlogged
        yield* cloneAgain(backlogged)
        yield* a.graph.update({
          id: edited,
          changes: { priority: 0 },
          actor: maintainer,
        })
        const away = `${remote}.away`
        renameSync(remote, away)
        const state = yield* a.sync.state
        const stopped = yield* Effect.flip(a.sync.commit)
        expect(stopped._tag).toBe('BaseUnreachable')
        expect(a.head()).toBe('')
        expect(yield* a.sync.state).toEqual(state)
        renameSync(away, remote)
        yield* converge(a, b)
        yield* expectKept(backlogged)
        expect((yield* b.graph.show(edited)).ticket.priority).toBe(0)
      }).pipe(Effect.scoped),
  )

  it.effect(
    'a ref deleted and pruned, with nothing pushed, is written again',
    () =>
      Effect.gen(function* () {
        const { a } = yield* twoEngines
        const id = yield* a.create('One')
        yield* a.sync.commit
        const before = a.file(`tickets/${id}.json`)
        git(a.checkout, 'update-ref', '-d', ticketsRef)
        git(a.checkout, 'gc', '--quiet', '--prune=now')
        const settled = yield* a.sync.commit
        expect(settled.committed).toBe(true)
        expect(a.file(`tickets/${id}.json`)).toBe(before)
        expect((yield* a.sync.rebuild).tickets).toBe(1)
      }).pipe(Effect.scoped),
  )

  it.effect('with no remote at all it is written again, and stops asking', () =>
    Effect.gen(function* () {
      const { a } = yield* twoEngines
      const id = yield* a.create('One')
      yield* a.sync.commit
      git(a.checkout, 'remote', 'remove', 'origin')
      git(a.checkout, 'update-ref', '-d', ticketsRef)
      git(a.checkout, 'gc', '--quiet', '--prune=now')
      const settled = yield* a.sync.commit
      expect(settled.committed).toBe(true)
      expect(a.files()).toContain(`tickets/${id}.json`)
      const held = yield* a.sync.state
      expect(Option.isSome(held.lastImported)).toBe(true)
      expect(Option.getOrThrow(held.lastImported)).toBe(a.head())
    }).pipe(Effect.scoped),
  )
})

describe('deletion', () => {
  it.effect('writes a tombstone, and prunes it after 90 days', () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoEngines
      const id = yield* a.create('Gone')
      yield* converge(a, b)
      yield* a.graph.delete({ id, actor: maintainer })
      yield* converge(a, b)
      expect(a.files()).toContain(`tombstones/${id}.json`)
      expect(a.files()).not.toContain(`tickets/${id}.json`)
      expect((yield* Effect.exit(b.graph.show(id)))._tag).toBe('Failure')

      yield* TestClock.adjust(Duration.days(89))
      yield* a.create('Not long enough')
      yield* a.sync.commit
      expect(a.files()).toContain(`tombstones/${id}.json`)

      yield* TestClock.adjust(Duration.days(2))
      yield* a.create('Past its days')
      yield* converge(a, b)
      expect(a.files()).not.toContain(`tombstones/${id}.json`)
      // It stays pruned on the other engine, and the ID is never drawn again there.
      expect(b.files()).not.toContain(`tombstones/${id}.json`)
      expect((yield* b.dump).tombstones).toEqual([{ id }])
      yield* expectConverged(a, b)
    }).pipe(Effect.scoped),
  )
})

describe('after a merge', () => {
  it.effect('keeps a cycle of blocks, the tickets marked', () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoEngines
      const x = yield* a.create('X')
      const y = yield* a.create('Y')
      yield* converge(a, b)
      yield* a.graph.addDependency({
        edge: new Edge({ from: x, to: y, kind: 'blocks' }),
        actor: maintainer,
      })
      yield* a.sync.commit
      yield* b.graph.addDependency({
        edge: new Edge({ from: y, to: x, kind: 'blocks' }),
        actor: maintainer,
      })
      yield* b.sync.commit
      yield* converge(a, b)
      yield* expectConverged(a, b)
      const onBase = () => Effect.succeed(false)
      for (const engine of [a, b]) {
        const edges = yield* engine.graph.edges()
        expect(edges.filter(edge => edge.kind === 'blocks').length).toBe(2)
      }
      const reasons = yield* a.graph.why({ id: x, onBase })
      expect(reasons).toContainEqual(WaitReason.BlocksCycle())
      expect(yield* b.graph.why({ id: y, onBase })).toContainEqual(
        WaitReason.BlocksCycle(),
      )
      expect(
        (yield* a.graph.ready({ onBase })).map(ticket => ticket.id),
      ).not.toContain(x)
      expect(
        [
          ...(yield* a.events('blocks_cycle')),
          ...(yield* b.events('blocks_cycle')),
        ].length,
      ).toBeGreaterThan(0)
    }).pipe(Effect.scoped),
  )

  it.effect('drops and logs an edge to a ticket the other side deleted', () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoEngines
      const from = yield* a.create('From')
      const gone = yield* a.create('Gone')
      yield* converge(a, b)
      yield* a.graph.addDependency({
        edge: new Edge({ from, to: gone, kind: 'blocks' }),
        actor: maintainer,
      })
      yield* a.sync.commit
      yield* b.graph.delete({ id: gone, actor: maintainer })
      yield* b.sync.commit
      yield* converge(a, b)
      yield* expectConverged(a, b)
      const file = yield* decodeTicketFile(
        a.file(`tickets/${from}.json`) + '\n',
      )
      expect(file.edges.blocks).toEqual([])
      expect(yield* a.graph.edges()).toEqual([])
      const logged = [
        ...(yield* a.events('edge_dropped')),
        ...(yield* b.events('edge_dropped')),
      ]
      expect(logged.length).toBeGreaterThan(0)
      expect(logged[0]?.ticket_id).toBe(from)
    }).pipe(Effect.scoped),
  )
})

describe('versions', () => {
  /** A commit on the ref with `path` holding `text`, by another process. */
  const commitFile = (engine: TestEngine, path: string, text: string) => {
    const scratch = join(freshFolder('index'), 'index')
    const env = { ...fixtureEnv(), GIT_INDEX_FILE: scratch }
    const inRepo = (args: ReadonlyArray<string>, input?: string) =>
      execFileSync('git', [...args], {
        cwd: engine.checkout,
        env,
        encoding: 'utf8',
        input: input ?? '',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
    const parent = inRepo(['rev-parse', ticketsRef])
    inRepo(['read-tree', parent])
    const blob = inRepo(['hash-object', '-w', '--stdin'], text)
    inRepo(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`])
    const tree = inRepo(['write-tree'])
    const next = inRepo(['commit-tree', tree, '-p', parent, '-m', 'by hand'])
    inRepo(['update-ref', ticketsRef, next, parent])
  }

  it.effect(
    'a file that fails to decode is quarantined, its local copy kept',
    () =>
      Effect.gen(function* () {
        const { a, b } = yield* twoEngines
        const id = yield* a.create('One')
        yield* converge(a, b)
        commitFile(a, `tickets/${id}.json`, '{not json\n')
        yield* a.sync.sync('origin')
        yield* b.sync.pull('origin')
        expect((yield* b.graph.show(id)).ticket.title).toBe('One')
        const recorded = yield* b.events('quarantined')
        expect(recorded.length).toBe(1)
        expect(recorded[0]?.ticket_id).toBe(id)
        expect(recorded[0]?.payload).toContain(`tickets/${id}.json`)

        // A local edit of it stays local: the file is skipped, not written over.
        yield* b.graph.update({
          id,
          changes: { title: 'Local' },
          actor: maintainer,
        })
        const other = yield* b.create('Other')
        yield* b.sync.sync('origin')
        expect(b.file(`tickets/${id}.json`)).toBe('{not json')
        expect((yield* b.graph.show(id)).ticket.title).toBe('Local')
        expect(b.files()).toContain(`tickets/${other}.json`)
      }).pipe(Effect.scoped),
  )

  it.effect('a newer layout stops sync, writing nothing', () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoEngines
      yield* a.create('One')
      yield* converge(a, b)
      const layout = (yield* encodeMeta(
        new TicketsMeta({ layout: 1, prefix: 'fa' }),
      )).replace('"layout": 1', '"layout": 2')
      commitFile(a, 'meta.json', layout)
      git(a.checkout, 'push', '--quiet', 'origin', ticketsRef)
      yield* b.create('Kept local')
      const head = b.head()
      const stopped = yield* Effect.flip(b.sync.sync('origin'))
      expect(stopped._tag).toBe('LayoutTooNew')
      expect(stopped.message).toContain('update the engine')
      expect(b.head()).not.toBe('')
      expect(
        git(b.checkout, 'merge-base', '--is-ancestor', head, ticketsRef),
      ).toBe('')
      expect(b.file('meta.json')).toContain('"layout": 1')
    }).pipe(Effect.scoped),
  )
})

describe('privacy', () => {
  it.effect('a result over 64 KB stays local, and an import keeps it', () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoEngines
      const id = yield* a.create('Large')
      yield* a.graph.update({
        id,
        changes: {
          result: Option.some({ _tag: 'summary', summary: 'x'.repeat(70_000) }),
        },
        actor: maintainer,
      })
      yield* a.sync.sync('origin')
      expect(a.file(`tickets/${id}.json`)).not.toContain('xxxx')
      expect(a.file(`tickets/${id}.json`)).toContain('"result": null')
      yield* b.sync.pull('origin')
      expect(Option.isNone((yield* b.graph.show(id)).ticket.result)).toBe(true)

      yield* b.graph.update({
        id,
        changes: { title: 'Renamed' },
        actor: maintainer,
      })
      yield* converge(b, a)
      const { ticket } = yield* a.graph.show(id)
      expect(ticket.title).toBe('Renamed')
      expect(Option.isSome(ticket.result)).toBe(true)

      const small = yield* a.create('Small')
      yield* a.graph.update({
        id: small,
        changes: { result: Option.some({ _tag: 'summary', summary: 'short' }) },
        actor: maintainer,
      })
      yield* a.sync.commit
      expect(a.file(`tickets/${small}.json`)).toContain('short')
    }).pipe(Effect.scoped),
  )

  it.effect('a secret pattern blocks the commit and warns, once', () =>
    Effect.gen(function* () {
      const { a } = yield* twoEngines
      yield* a.create('Clean')
      yield* a.sync.commit
      const head = a.head()
      const id = yield* a.create('Secret')
      yield* a.graph.update({
        id,
        changes: { description: Option.some(`the key is ${awsKey()}`) },
        actor: maintainer,
      })
      const stopped = yield* Effect.flip(a.sync.commit)
      expect(stopped._tag).toBe('ExportBlocked')
      expect(stopped.message).toContain(`tickets/${id}.json`)
      expect(stopped.message).not.toContain(awsKey())
      expect(a.head()).toBe(head)
      yield* Effect.flip(a.sync.commit)
      const warned = yield* a.events('export_blocked')
      expect(warned.length).toBe(1)
      expect(warned[0]?.payload).not.toContain(awsKey())

      yield* a.graph.update({
        id,
        changes: { description: Option.some('no key here') },
        actor: maintainer,
      })
      const settled = yield* a.sync.commit
      expect(settled.committed).toBe(true)
      expect(a.files()).toContain(`tickets/${id}.json`)
    }).pipe(Effect.scoped),
  )

  const placings: ReadonlyArray<readonly [string, () => string]> = [
    ['at the start of a line', () => `the key:\n${awsKey()}`],
    ['after a tab', () => `the key:\t${awsKey()}`],
    ['after a carriage return', () => `the key:\r\n${awsKey()}`],
    ['after a quote', () => `the key: "${awsKey()}"`],
    [
      'a GitHub token on its own line',
      () => `\n${['ghp', 'a'.repeat(36)].join('_')}\n`,
    ],
  ]
  for (const [name, text] of placings) {
    it.effect(`blocks the commit, nothing reaching the remote: ${name}`, () =>
      Effect.gen(function* () {
        const { remote, a } = yield* twoEngines
        const id = yield* a.create('Secret')
        yield* a.graph.update({
          id,
          changes: { description: Option.some(text()) },
          actor: maintainer,
        })
        const stopped = yield* Effect.flip(a.sync.sync('origin'))
        expect(stopped._tag).toBe('ExportBlocked')
        expect(a.head()).toBe('')
        expect(() =>
          git(remote, 'rev-parse', '--verify', '--quiet', ticketsRef),
        ).toThrow()
      }).pipe(Effect.scoped),
    )
  }

  it.effect(
    'a PGP private key block and JSON held in a note are blocked too',
    () =>
      Effect.gen(function* () {
        const { a } = yield* twoEngines
        const pgp = yield* a.create('PGP')
        yield* a.graph.update({
          id: pgp,
          changes: {
            description: Option.some(
              ['-----BEGIN PGP PRIVATE KEY', 'BLOCK-----'].join(' '),
            ),
          },
          actor: maintainer,
        })
        const held = yield* a.create('Held')
        yield* a.graph.note({
          id: held,
          body: JSON.stringify({ stdout: `key:\n${awsKey()}\n` }),
          actor: maintainer,
        })
        const stopped = yield* Effect.flip(a.sync.commit)
        if (stopped._tag !== 'ExportBlocked') return expect.fail(stopped._tag)
        expect(stopped.findings.toSorted()).toEqual(
          [
            `a private key block in tickets/${pgp}.json`,
            `an AWS access key in tickets/${held}.json`,
          ].toSorted(),
        )
        expect(a.head()).toBe('')
      }).pipe(Effect.scoped),
  )

  it('finds each secret whatever comes before it, and passes the words that end like one', () => {
    const secrets: ReadonlyArray<readonly [string, string]> = [
      ['an AWS access key', awsKey()],
      ['an AWS access key', ['ASIA', 'ABCDEFGHIJKLMNOP'].join('')],
      ['a Google API key', ['AIza', 'a'.repeat(35)].join('')],
      ['a GitHub token', ['ghp', 'a'.repeat(36)].join('_')],
      ['a GitHub token', ['github', 'pat', 'a'.repeat(22)].join('_')],
      ['a GitLab token', ['glpat', 'a'.repeat(20)].join('-')],
      ['a Slack token', ['xoxb', 'a'.repeat(10)].join('-')],
      ['an Anthropic key', ['sk', 'ant', 'a'.repeat(24)].join('-')],
      ['an OpenAI key', ['sk', 'a'.repeat(32)].join('-')],
      ['a Stripe key', ['sk', 'live', 'a'.repeat(16)].join('_')],
    ]
    const before = [
      '',
      'KEY=',
      'KEY_',
      '\\n',
      '\\\\n',
      '\\t',
      '\\u000a',
      '%0A',
      '%20',
      '%3D',
      '\\x0a',
      '\\v',
      '\\"',
      '"',
      '/',
    ]
    for (const [name, secret] of secrets)
      for (const prefix of before)
        expect(secretsIn(`${prefix}${secret}`)).toContain(name)
    for (const armour of ['RSA', 'EC', 'OPENSSH'])
      expect(
        secretsIn(['-----BEGIN', armour, 'PRIVATE KEY-----'].join(' ')),
      ).toEqual(['a private key block'])
    expect(
      secretsIn(['-----BEGIN PGP', 'PRIVATE KEY BLOCK-----'].join(' ')),
    ).toEqual(['a private key block'])

    expect(secretsIn('task-ant-colony-simulation-feature')).toEqual([])
    expect(secretsIn(`highs_${'a'.repeat(40)}`)).toEqual([])
    expect(secretsIn(`task-${'a'.repeat(40)}`)).toEqual([])
    expect(secretsIn(`work_live_${'a'.repeat(20)}`)).toEqual([])
    expect(secretsIn('-----BEGIN PUBLIC KEY-----')).toEqual([])
    expect(secretsIn('C:\\new\\table')).toEqual([])
  })

  it.effect('finds a secret in a note, on a line of its own', () =>
    Effect.gen(function* () {
      const { a } = yield* twoEngines
      const id = yield* a.create('Noted')
      yield* a.graph.note({
        id,
        body: `first line\n${awsKey()}`,
        actor: maintainer,
      })
      const stopped = yield* Effect.flip(a.sync.commit)
      expect(stopped._tag).toBe('ExportBlocked')
      expect(a.head()).toBe('')
    }).pipe(Effect.scoped),
  )

  it("reads a file's strings decoded, each pattern named once", () => {
    const file = JSON.stringify({
      description: `one\n${awsKey()}`,
      notes: [{ body: `two\t${awsKey()}` }],
      [awsKey()]: 1,
    })
    expect(secretsInFile(file)).toEqual(['an AWS access key'])
    expect(secretsInFile(JSON.stringify({ title: 'plain\ntext' }))).toEqual([])
  })

  it('knows the secrets it looks for, and passes what only looks like one', () => {
    const named: ReadonlyArray<readonly [string, string]> = [
      ['an AWS access key', awsKey()],
      ['a private key block', ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ')],
      ['a GitHub token', ['ghp', 'a'.repeat(36)].join('_')],
      ['an Anthropic key', ['sk', 'ant', 'a'.repeat(24)].join('-')],
    ]
    for (const [name, text] of named) expect(secretsIn(text)).toContain(name)
    expect(secretsIn('AKIA is a prefix; sk- is one too')).toEqual([])
  })

  it.effect("keeps no credentials of the remote's URL", () =>
    Effect.gen(function* () {
      const { remote, a } = yield* twoEngines
      const token = ['ghp', 'a'.repeat(36)].join('_')
      git(
        a.checkout,
        'remote',
        'set-url',
        'origin',
        `file://x:${token}@localhost${remote}`,
      )
      yield* a.create('One')
      yield* a.sync.push('origin')
      const named = yield* a.events('ref_remote_named')
      expect(named.length).toBe(1)
      expect(named[0]?.payload).not.toContain(token)
      expect(named[0]?.payload).toContain(remote)
    }).pipe(Effect.scoped),
  )

  it('takes credentials out of a URL, and leaves the rest', () => {
    expect(withoutCredentials('https://x-access-token:t0ken@host/a.git')).toBe(
      'https://host/a.git',
    )
    expect(withoutCredentials('https://t0ken@host/a.git')).toBe(
      'https://host/a.git',
    )
    expect(withoutCredentials('https://host/a@b.git')).toBe(
      'https://host/a@b.git',
    )
    expect(withoutCredentials('git@host:a/b.git')).toBe('git@host:a/b.git')
    expect(withoutCredentials('/srv/a.git')).toBe('/srv/a.git')
  })

  it.effect('names the remote before the first push, once', () =>
    Effect.gen(function* () {
      const { remote, a } = yield* twoEngines
      yield* a.create('One')
      // The push fails: the remote was named before it.
      yield* a.inject({ command: 'push', when: 'before' })
      yield* Effect.exit(a.sync.push('origin'))
      const named = yield* a.events('ref_remote_named')
      expect(named.length).toBe(1)
      expect(named[0]?.payload).toContain('origin')
      expect(named[0]?.payload).toContain(remote)
      yield* a.sync.push('origin')
      yield* a.create('Two')
      yield* a.sync.push('origin')
      expect((yield* a.events('ref_remote_named')).length).toBe(1)
      expect(git(remote, 'rev-parse', ticketsRef)).toBe(a.head())
    }).pipe(Effect.scoped),
  )
})

describe('rebuild', () => {
  it.effect('restores SQLite from the ref', () =>
    Effect.gen(function* () {
      const { a } = yield* twoEngines
      const one = yield* a.create('One')
      const two = yield* a.create('Two')
      const gone = yield* a.create('Gone')
      yield* a.graph.label({ id: one, label: 'x', actor: maintainer })
      yield* a.graph.note({ id: one, body: 'A note', actor: maintainer })
      yield* a.graph.addDependency({
        edge: new Edge({ from: one, to: two, kind: 'blocks' }),
        actor: maintainer,
      })
      yield* a.graph.delete({ id: gone, actor: maintainer })
      yield* a.sync.commit
      const dump = yield* a.dump

      // In place: what the store has that the ref hasn't goes, what it lost comes back.
      const extra = yield* a.create('Not on the ref')
      yield* a.sql`DELETE FROM labels`
      yield* a.sql`UPDATE tickets SET title = 'Wrong' WHERE id = ${two}`
      const rebuilt = yield* a.sync.rebuild
      expect(rebuilt).toEqual({ tickets: 2, tombstones: 1, quarantined: 0 })
      expect(yield* a.dump).toEqual(dump)
      expect((yield* Effect.exit(a.graph.show(extra)))._tag).toBe('Failure')

      // Again, it changes nothing.
      const events = yield* a.eventCount
      yield* a.sync.rebuild
      expect(yield* a.dump).toEqual(dump)
      expect(yield* a.eventCount).toBe(events)

      // From a fresh database: the same tickets, labels, links and notes.
      const fresh = yield* makeEngine({ id: 'fe-a', checkout: a.checkout })
      yield* fresh.sync.rebuild
      expect(yield* fresh.dump).toEqual(dump)
      const head = a.head()
      const settled = yield* fresh.sync.commit
      expect(settled.committed).toBe(false)
      expect(fresh.head()).toBe(head)
    }).pipe(Effect.scoped),
  )

  it.effect('refuses where there is no ref', () =>
    Effect.gen(function* () {
      const { a } = yield* twoEngines
      const stopped = yield* Effect.flip(a.sync.rebuild)
      expect(stopped._tag).toBe('NoTicketsRef')
    }).pipe(Effect.scoped),
  )
})

describe('git', () => {
  const stub = (script: string) => {
    const folder = freshFolder('stubs')
    writeFileSync(join(folder, 'git'), script)
    chmodSync(join(folder, 'git'), 0o755)
    return folder
  }

  it.effect('too old turns sync off, with a clear message', () =>
    Effect.gen(function* () {
      const { checkouts } = repositories(1)
      const engine = yield* makeEngine({
        id: 'fe-a',
        checkout: checkouts[0] ?? '',
        path: stub('#!/bin/sh\necho "git version 2.34.1"\n'),
      })
      const stopped = yield* Effect.flip(engine.sync.commit)
      expect(stopped._tag).toBe('SyncOff')
      expect(stopped.message).toContain('2.34.1')
    }).pipe(Effect.scoped),
  )

  it.effect('missing turns sync off, with a clear message', () =>
    Effect.gen(function* () {
      const { checkouts } = repositories(1)
      const engine = yield* makeEngine({
        id: 'fe-a',
        checkout: checkouts[0] ?? '',
        path: freshFolder('no-git'),
      })
      const stopped = yield* Effect.flip(engine.sync.commit)
      expect(stopped._tag).toBe('SyncOff')
      expect(stopped.message).toContain('not on the PATH')
    }).pipe(Effect.scoped),
  )
})

describe('commitChanges', () => {
  const eventOf = (
    change: TicketEvent['change'],
    ticket: TicketId = TicketId.make('fa-a'),
  ) =>
    new TicketEvent({
      seq: 1,
      ticketId: Option.some(ticket),
      actor: Option.some(maintainer),
      change,
      at: DateTime.makeUnsafe(0),
    })

  it.effect(
    'batches changes for at most 2 s, and commits a transition at once',
    () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(
          sqliteLayer({ prefix: 'fa', filename: ':memory:' }),
        )
        const graph = Context.get(context, WorkGraph)
        const commits = yield* Queue.unbounded<number>()
        const changes = yield* Queue.unbounded<TicketEvent>()
        const count = yield* Ref.make(0)
        yield* commitChanges({
          graph,
          changes: Stream.fromQueue(changes),
          commit: Ref.updateAndGet(count, n => n + 1).pipe(
            Effect.flatMap(n => Queue.offer(commits, n)),
          ),
        }).pipe(Effect.forkScoped)
        const settle = Effect.repeat(Effect.yieldNow, { times: 50 })

        yield* Queue.offer(changes, eventOf({ _tag: 'released' }))
        expect(yield* Queue.take(commits)).toBe(1)

        yield* Queue.offer(
          changes,
          eventOf({ _tag: 'updated', fields: ['title'] }),
        )
        yield* settle
        yield* TestClock.adjust('1 second')
        yield* Queue.offer(
          changes,
          eventOf({ _tag: 'updated', fields: ['title'] }),
        )
        yield* settle
        yield* TestClock.adjust('999 millis')
        yield* settle
        expect(yield* Ref.get(count)).toBe(1)
        yield* TestClock.adjust('1 millis')
        expect(yield* Queue.take(commits)).toBe(2)

        // A transition takes the batch with it: no second commit comes of its timer.
        yield* Queue.offer(
          changes,
          eventOf({ _tag: 'updated', fields: ['title'] }),
        )
        yield* settle
        yield* Queue.offer(
          changes,
          eventOf({ _tag: 'updated', fields: ['mergedCommit'] }),
        )
        expect(yield* Queue.take(commits)).toBe(3)
        yield* TestClock.adjust('5 seconds')
        yield* settle
        expect(yield* Ref.get(count)).toBe(3)

        // A question asked is a transition; another ticket's creation isn't.
        const question = yield* graph.ask({
          question: {
            title: 'Which?',
            consequential: false,
            maintainerOnly: false,
          },
          actor: maintainer,
        })
        yield* Queue.offer(changes, eventOf({ _tag: 'created' }, question.id))
        expect(yield* Queue.take(commits)).toBe(4)
        const plain = yield* graph.create({
          ticket: { type: 'task', title: 'Plain' },
          actor: maintainer,
        })
        yield* Queue.offer(changes, eventOf({ _tag: 'created' }, plain.id))
        yield* settle
        expect(yield* Ref.get(count)).toBe(4)
        yield* TestClock.adjust('2 seconds')
        expect(yield* Queue.take(commits)).toBe(5)
      }).pipe(Effect.scoped),
  )
})
