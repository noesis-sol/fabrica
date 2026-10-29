import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Stream,
} from 'effect'
import { RpcTest } from 'effect/rpc'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type BacklogItem,
  BacklogRpcs,
  Edge,
  type NewTicket,
  ProjectId,
  ProjectNotFound,
  ProjectSource,
  Refused,
  Resume,
  TicketDetail,
  TicketId,
  TicketNotFound,
} from '@fabrica/contracts'

import { engineDatabaseLayer } from '../src/engine'
import { EngineFiles, pathsIn } from '../src/engine/paths'
import { type GitConfig, layer as gitLayer } from '../src/git'
import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import { Projects, layer as projectsLayer } from '../src/projects'
import { backlogHandlers } from '../src/rpc/backlog'

// The Backlog group over RPC (spec §8.1, §11.1): tickets filed, read, changed, linked, labelled,
// noted and closed through the engine on a project's work graph, each change the maintainer's; what
// is ready and why the rest isn't, in words; and the backlog stream, resumed after a reconnect. A
// project is a real checkout in a temp folder, added to an engine whose engine.db is in memory.

let root = ''
let home = ''
let gitFolder = ''

beforeAll(() => {
  root = realpathSync(mkdtempSync(NodePath.join(tmpdir(), 'fabrica-backlog-')))
  home = NodePath.join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    NodePath.join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n[init]\n\tdefaultBranch = main\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
})

const gitEnvironment = () => ({
  PATH: `${gitFolder}:/usr/bin:/bin`,
  HOME: home,
  LANG: 'C',
})

/** A checkout on `main` with one commit, in a folder of its own. */
const newCheckout = Effect.sync(() => {
  const work = mkdtempSync(NodePath.join(root, 'work-'))
  const git = (...args: ReadonlyArray<string>) =>
    execFileSync('git', args, {
      cwd: work,
      env: { ...gitEnvironment(), GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  git('init', '--quiet')
  writeFileSync(NodePath.join(work, 'README.md'), '# Test\n')
  git('add', 'README.md')
  git('commit', '--quiet', '--message', 'First commit')
  return work
})

const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: gitEnvironment(),
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
  readRetries: { times: 0, spacing: Duration.zero },
}

/** An engine with one project, `work`, on a new checkout: the Backlog client and the Projects service. */
const newEngine = Effect.gen(function* () {
  const data = mkdtempSync(NodePath.join(root, 'data-'))
  const services = yield* Layer.build(
    backlogHandlers.pipe(
      Layer.provideMerge(projectsLayer),
      Layer.provide(
        gitLayer(gitConfig).pipe(
          Layer.provide(runnerLayer(runnerConfig())),
          Layer.provide(layerClock),
        ),
      ),
      Layer.provide(engineDatabaseLayer(':memory:')),
      Layer.provide(
        Layer.succeed(EngineFiles)(pathsIn({ data, socketFolder: data })),
      ),
    ),
  )
  const projects = Context.get(services, Projects)
  const added = yield* projects.add({
    source: ProjectSource.cases.path.make({ path: yield* newCheckout }),
    name: Option.some('work'),
  })
  const client = yield* RpcTest.makeClient(BacklogRpcs).pipe(
    Effect.provide(services),
  )
  return { client, projects, project: added.id }
})

/** A ticket to file: `fields`, the rest left out. */
const newTicket = (
  fields: Pick<NewTicket, 'type' | 'title'> & Partial<NewTicket>,
): NewTicket => ({
  description: Option.none(),
  design: Option.none(),
  acceptance: Option.none(),
  priority: Option.none(),
  labels: Option.none(),
  parent: Option.none(),
  metadata: Option.none(),
  model: Option.none(),
  ...fields,
})

/** The error `exit` failed with. */
const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : expect.fail('it succeeded')

describe('the backlog over RPC', () => {
  it.live(
    'files, reads, changes, links, labels, notes and closes tickets as the maintainer',
    () =>
      Effect.gen(function* () {
        const { client, projects, project } = yield* newEngine
        const { id: epic } = yield* client['tickets.create']({
          project,
          ticket: newTicket({ type: 'epic', title: 'Accounts' }),
        })
        const { id: login } = yield* client['tickets.create']({
          project,
          ticket: newTicket({
            type: 'feature',
            title: 'Log in',
            description: Option.some('With a password'),
            priority: Option.some(1),
            labels: Option.some(['auth', 'ui']),
            parent: Option.some(epic),
            metadata: Option.some({
              files: Option.some(['src/login.ts']),
              spec: Option.none(),
              predicted_files: Option.none(),
              result_kind: Option.none(),
            }),
          }),
        })
        expect(login).toBe(`${epic}.1`)
        const { id: bug } = yield* client['tickets.create']({
          project,
          ticket: newTicket({
            type: 'bug',
            title: 'Crash',
            labels: Option.some(['auth']),
          }),
        })

        const shown = yield* client['tickets.show']({ project, ticket: login })
        // As the protocol's class: the server encodes nothing else.
        expect(shown).toBeInstanceOf(TicketDetail)
        expect(shown.ticket.title).toBe('Log in')
        expect(shown.ticket.description).toStrictEqual(
          Option.some('With a password'),
        )
        expect(shown.ticket.priority).toBe(1)
        expect(shown.ticket.metadata.files).toStrictEqual(
          Option.some(['src/login.ts']),
        )
        expect(shown.labels).toStrictEqual(['auth', 'ui'])
        expect(shown.edges).toStrictEqual([
          new Edge({ from: epic, to: login, kind: 'parent' }),
        ])

        const ids = (filter: Parameters<(typeof client)['tickets.list']>[0]) =>
          client['tickets.list'](filter).pipe(
            Effect.map(tickets => tickets.map(({ id }) => id)),
          )
        const none = {
          status: Option.none(),
          type: Option.none(),
          labels: Option.none(),
          parent: Option.none(),
        }
        expect(yield* ids({ project, filter: none })).toStrictEqual([
          login,
          epic,
          bug,
        ])
        expect(
          yield* ids({
            project,
            filter: { ...none, labels: Option.some(['auth']) },
          }),
        ).toStrictEqual([login, bug])
        expect(
          yield* ids({
            project,
            filter: { ...none, labels: Option.some(['auth', 'ui']) },
          }),
        ).toStrictEqual([login])
        expect(
          yield* ids({
            project,
            filter: { ...none, type: Option.some(['bug', 'epic']) },
          }),
        ).toStrictEqual([epic, bug])
        expect(
          yield* ids({
            project,
            filter: { ...none, parent: Option.some(epic) },
          }),
        ).toStrictEqual([login])

        yield* client['tickets.update']({
          project,
          ticket: bug,
          changes: {
            title: 'Crash on start',
            description: Option.some('Seen on Linux'),
            priority: 0,
          },
        })
        yield* client['tickets.update']({
          project,
          ticket: login,
          changes: { description: Option.none() },
        })
        yield* client['tickets.label']({
          project,
          ticket: bug,
          add: ['solo'],
          remove: ['auth'],
        })
        const { id: note } = yield* client['tickets.note']({
          project,
          ticket: bug,
          body: 'Tried the other store first.',
        })
        yield* client['tickets.dep.add']({
          project,
          edge: new Edge({ from: bug, to: login, kind: 'blocks' }),
        })
        const changed = yield* client['tickets.show']({ project, ticket: bug })
        expect(changed.ticket.title).toBe('Crash on start')
        expect(changed.ticket.description).toStrictEqual(
          Option.some('Seen on Linux'),
        )
        expect(changed.ticket.priority).toBe(0)
        expect(changed.labels).toStrictEqual(['solo'])
        expect(changed.notes.map(({ id, body }) => [id, body])).toStrictEqual([
          [note, 'Tried the other store first.'],
        ])
        expect(changed.notes[0]?.author._tag).toBe('maintainer')
        expect(changed.edges).toStrictEqual([
          new Edge({ from: bug, to: login, kind: 'blocks' }),
        ])
        expect(
          (yield* client['tickets.show']({ project, ticket: login })).ticket
            .description,
        ).toStrictEqual(Option.none())

        yield* client['tickets.dep.remove']({
          project,
          edge: new Edge({ from: bug, to: login, kind: 'blocks' }),
        })
        expect(
          (yield* client['tickets.show']({ project, ticket: bug })).edges,
        ).toStrictEqual([])

        yield* client['tickets.close']({
          project,
          ticket: bug,
          resolution: 'no_change',
          reason: Option.some('Not reproducible'),
        })
        const closed = (yield* client['tickets.show']({ project, ticket: bug }))
          .ticket
        expect(closed.status).toBe('closed')
        expect(closed.resolution).toStrictEqual(Option.some('no_change'))
        expect(closed.closeReason).toStrictEqual(
          Option.some('Not reproducible'),
        )

        // Reopened, deferred until a time, then undeferred: `update`'s status.
        yield* client['tickets.update']({
          project,
          ticket: bug,
          changes: { status: 'open' },
        })
        expect(
          (yield* client['tickets.show']({ project, ticket: bug })).ticket
            .status,
        ).toBe('open')
        const until = DateTime.makeUnsafe('2030-01-01T00:00:00.000Z')
        yield* client['tickets.update']({
          project,
          ticket: bug,
          changes: { deferUntil: Option.some(until) },
        })
        const deferred = (yield* client['tickets.show']({
          project,
          ticket: bug,
        })).ticket
        expect(deferred.status).toBe('deferred')
        expect(deferred.deferUntil).toStrictEqual(Option.some(until))
        yield* client['tickets.update']({
          project,
          ticket: bug,
          changes: { status: 'open' },
        })
        expect(
          (yield* client['tickets.show']({ project, ticket: bug })).ticket
            .status,
        ).toBe('open')

        // Every change was the maintainer's.
        const graph = yield* projects.workGraph(project)
        const history = yield* graph.history(bug)
        expect(history.length).toBeGreaterThan(5)
        expect(
          history.every(event =>
            Option.match(event.actor, {
              onNone: () => false,
              onSome: actor => actor._tag === 'maintainer',
            }),
          ),
        ).toBe(true)
      }).pipe(Effect.scoped),
  )

  it.live('refuses what the work graph refuses, and names what it hasn’t', () =>
    Effect.gen(function* () {
      const { client, project } = yield* newEngine
      const { id: a } = yield* client['tickets.create']({
        project,
        ticket: newTicket({ type: 'task', title: 'A' }),
      })
      const { id: b } = yield* client['tickets.create']({
        project,
        ticket: newTicket({ type: 'task', title: 'B' }),
      })
      yield* client['tickets.dep.add']({
        project,
        edge: new Edge({ from: a, to: b, kind: 'blocks' }),
      })

      const cycle = failureOf(
        yield* Effect.exit(
          client['tickets.dep.add']({
            project,
            edge: new Edge({ from: b, to: a, kind: 'blocks' }),
          }),
        ),
      )
      expect(cycle).toBeInstanceOf(Refused)
      expect(cycle).toMatchObject({
        reason: `${b} blocks ${a} would close a cycle; refused`,
      })

      const question = failureOf(
        yield* Effect.exit(
          client['tickets.create']({
            project,
            ticket: newTicket({ type: 'question', title: 'Which store?' }),
          }),
        ),
      )
      expect(question).toBeInstanceOf(Refused)

      yield* client['tickets.close']({
        project,
        ticket: a,
        resolution: 'done',
        reason: Option.none(),
      })
      const twice = failureOf(
        yield* Effect.exit(
          client['tickets.close']({
            project,
            ticket: a,
            resolution: 'done',
            reason: Option.none(),
          }),
        ),
      )
      expect(twice).toStrictEqual(
        new Refused({ reason: `can't close ${a}: it is closed` }),
      )

      const missing = TicketId.make(`${project}-zzzz`)
      for (const exit of [
        yield* Effect.exit(
          client['tickets.show']({ project, ticket: missing }),
        ),
        yield* Effect.exit(client['tickets.why']({ project, ticket: missing })),
        yield* Effect.exit(
          client['tickets.label']({
            project,
            ticket: missing,
            add: [],
            remove: [],
          }),
        ),
        yield* Effect.exit(
          client['tickets.note']({ project, ticket: missing, body: 'Hm' }),
        ),
        yield* Effect.exit(
          client['tickets.update']({
            project,
            ticket: missing,
            changes: { status: 'open' },
          }),
        ),
      ])
        expect(failureOf(exit)).toStrictEqual(
          new TicketNotFound({ project, ticket: missing }),
        )

      const nowhere = ProjectId.make('nowhere')
      expect(
        failureOf(
          yield* Effect.exit(client['tickets.ready']({ project: nowhere })),
        ),
      ).toStrictEqual(new ProjectNotFound({ project: nowhere }))
    }).pipe(Effect.scoped),
  )

  it.live(
    'changes nothing on a refused update, and clears a defer time without deferring',
    () =>
      Effect.gen(function* () {
        const { client, project } = yield* newEngine
        const { id } = yield* client['tickets.create']({
          project,
          ticket: newTicket({ type: 'task', title: 'Kept' }),
        })
        const show = client['tickets.show']({ project, ticket: id }).pipe(
          Effect.map(({ ticket }) => ticket),
        )

        // Clearing the time of a ticket not deferred leaves it as it is.
        yield* client['tickets.update']({
          project,
          ticket: id,
          changes: { deferUntil: Option.none() },
        })
        expect((yield* show).status).toBe('open')

        // Clearing a deferred ticket's time keeps it deferred, until undeferred.
        const until = DateTime.makeUnsafe('2030-01-01T00:00:00.000Z')
        yield* client['tickets.update']({
          project,
          ticket: id,
          changes: { deferUntil: Option.some(until) },
        })
        yield* client['tickets.update']({
          project,
          ticket: id,
          changes: { deferUntil: Option.none() },
        })
        const cleared = yield* show
        expect(cleared.status).toBe('deferred')
        expect(cleared.deferUntil).toStrictEqual(Option.none())

        // A status change refused writes none of the fields sent with it.
        yield* client['tickets.close']({
          project,
          ticket: id,
          resolution: 'done',
          reason: Option.none(),
        })
        const refusal = failureOf(
          yield* Effect.exit(
            client['tickets.update']({
              project,
              ticket: id,
              changes: { title: 'Renamed', status: 'deferred' },
            }),
          ),
        )
        expect(refusal).toStrictEqual(
          new Refused({ reason: `can't defer ${id}: it is closed` }),
        )
        const after = yield* show
        expect(after.title).toBe('Kept')
        expect(after.status).toBe('closed')
      }).pipe(Effect.scoped),
  )

  it.live('says what is ready, and why the rest isn’t in words', () =>
    Effect.gen(function* () {
      const { client, project } = yield* newEngine
      const create = (title: string, type: 'task' | 'epic' = 'task') =>
        client['tickets.create']({
          project,
          ticket: newTicket({ type, title }),
        }).pipe(Effect.map(({ id }) => id))
      const blocker = yield* create('Blocker')
      const waiting = yield* create('Waiting')
      const epic = yield* create('Epic', 'epic')
      yield* client['tickets.dep.add']({
        project,
        edge: new Edge({ from: blocker, to: waiting, kind: 'blocks' }),
      })

      const ready = yield* client['tickets.ready']({ project })
      expect(ready.map(({ id }) => id)).toStrictEqual([blocker])
      expect(
        yield* client['tickets.why']({ project, ticket: blocker }),
      ).toStrictEqual({ _tag: 'ready' })

      const words = (ticket: TicketId) =>
        client['tickets.why']({ project, ticket }).pipe(
          Effect.map(why =>
            why._tag === 'ready'
              ? []
              : why.reasons.map(({ reason, words }) => [reason._tag, words]),
          ),
        )
      expect(yield* words(waiting)).toStrictEqual([
        ['blocked', `waits for ${blocker} to merge: it is open`],
      ])
      expect(yield* words(epic)).toStrictEqual([
        [
          'not_dispatched',
          'it is an epic: it closes itself once its children are closed and merged',
        ],
      ])

      // Closed, its branch not on Base: it still holds the ticket it blocks.
      yield* client['tickets.close']({
        project,
        ticket: blocker,
        resolution: 'done',
        reason: Option.none(),
      })
      expect(yield* words(waiting)).toStrictEqual([
        [
          'closed_unmerged',
          `waits for ${blocker} to merge: it is closed but not merged`,
        ],
      ])
      expect(yield* words(blocker)).toStrictEqual([['closed', 'it is closed']])
      expect(yield* client['tickets.ready']({ project })).toStrictEqual([])
    }).pipe(Effect.scoped),
  )

  it.live('streams the backlog: a snapshot, a patch per change, resumed', () =>
    Effect.gen(function* () {
      const { client, project } = yield* newEngine
      const { id: first } = yield* client['tickets.create']({
        project,
        ticket: newTicket({ type: 'task', title: 'First' }),
      })
      const items = yield* Queue.unbounded<BacklogItem>()
      yield* client['tickets.watch']({ project, resume: Option.none() }).pipe(
        Stream.runForEach(item => Queue.offer(items, item)),
        Effect.forkScoped,
      )
      const snapshot = yield* Queue.take(items)
      if (snapshot._tag !== 'snapshot') return expect.fail('no snapshot')
      expect(snapshot.value.map(({ id }) => id)).toStrictEqual([first])

      const { id: second } = yield* client['tickets.create']({
        project,
        ticket: newTicket({ type: 'task', title: 'Second' }),
      })
      const created = yield* Queue.take(items)
      if (created._tag !== 'patch') return expect.fail('no patch')
      expect(created.seq).toBe(snapshot.seq + 1)
      expect(created.value.upsert.map(({ id }) => id)).toStrictEqual([second])

      yield* client['tickets.update']({
        project,
        ticket: first,
        changes: { title: 'First, renamed' },
      })
      const renamed = yield* Queue.take(items)
      if (renamed._tag !== 'patch') return expect.fail('no patch')
      expect(renamed.value.upsert.map(({ title }) => title)).toStrictEqual([
        'First, renamed',
      ])

      // A client that took the snapshot and the first patch gets the rest.
      const resumed = yield* client['tickets.watch']({
        project,
        resume: Option.some(
          new Resume({ epoch: snapshot.epoch, after: created.seq }),
        ),
      }).pipe(Stream.take(1), Stream.runCollect)
      expect(resumed).toStrictEqual([renamed])
    }).pipe(Effect.scoped),
  )
})
