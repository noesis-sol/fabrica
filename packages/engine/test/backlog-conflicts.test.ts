import {
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
} from 'effect'
import { Reactivity } from 'effect/reactivity'
import { RpcTest } from 'effect/rpc'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { SqliteClient } from '@effect/sql-sqlite-node'
import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  Assignee,
  BacklogItem,
  BacklogRpcs,
  EngineId,
  ProjectSource,
  Resume,
  SessionId,
  type Ticket,
  TicketChange,
  TicketEvent,
  type TicketId,
  TicketMetadata,
  type TicketStatus,
} from '@fabrica/contracts'

import { engineDatabaseLayer } from '../src/engine'
import { EngineFiles, pathsIn } from '../src/engine/paths'
import { layer as gitLayer } from '../src/git'
import { makeKeyedFeed } from '../src/keyed-feed'
import {
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import { Projects, layer as projectsLayer } from '../src/projects'
import { workGraphPath } from '../src/projects/layout'
import { backlogHandlers, sendChange } from '../src/rpc/backlog'
import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'
import { changeColumns } from '../src/workgraph/rows'

// A sync's open merge conflicts (spec §11.4, §11.7): which side the merge kept, what `tickets.update`
// takes to set the other, what supersedes a conflict, and the backlog stream's frame as one is
// recorded. The events are written to the store as a merge's import writes them: against an in-memory
// work graph, then over RPC on a real project.

const graphLayer = Layer.effect(
  WorkGraph,
  makeWorkGraph({ prefix: 'fa' }),
).pipe(Layer.provideMerge(storeLayer(':memory:')))

const maintainer: Actor = { _tag: 'maintainer' }

const at = 1_793_268_900_000

/** A conflict on `field`, as a merge's import records it. */
const conflictChange = (
  field: string,
  ours: Schema.Json,
  theirs: Schema.Json,
) => TicketChange.cases.merge_conflict.make({ field, ours, theirs })

/** Appends a `merge_conflict` event to the store. */
const recordConflict = (
  sql: SqliteClient.SqliteClient,
  {
    ticket,
    field,
    ours,
    theirs,
  }: {
    readonly ticket: TicketId
    readonly field: string
    readonly ours: Schema.Json
    readonly theirs: Schema.Json
  },
) => {
  const { type, payload } = changeColumns(conflictChange(field, ours, theirs))
  return sql`INSERT INTO events ${sql.insert({
    ticket_id: ticket,
    type,
    actor: null,
    payload,
    at,
  })}`
}

const fileTask = Effect.gen(function* () {
  const graph = yield* WorkGraph
  return yield* graph.create({
    ticket: { type: 'task', title: 'Kept title' },
    actor: maintainer,
  })
})

describe('the open conflicts', () => {
  it.effect('none where no merge resolved anything', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      yield* fileTask
      expect(yield* graph.conflicts()).toEqual([])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect(
    'the side the ticket holds is the one kept, whichever side it was',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const sql = yield* SqliteClient.SqliteClient
        const ticket = yield* fileTask
        yield* recordConflict(sql, {
          ticket: ticket.id,
          field: 'title',
          ours: 'Kept title',
          theirs: 'Lost title',
        })
        yield* recordConflict(sql, {
          ticket: ticket.id,
          field: 'priority',
          ours: 1,
          theirs: 2,
        })
        const conflicts = yield* graph.conflicts()
        expect(
          conflicts.map(({ ticket: id, field, kept, other, useOther }) => ({
            id,
            field,
            kept,
            other,
            useOther,
          })),
        ).toEqual([
          {
            id: ticket.id,
            field: 'title',
            kept: 'Kept title',
            other: 'Lost title',
            useOther: Option.some({ title: 'Lost title' }),
          },
          {
            id: ticket.id,
            field: 'priority',
            kept: 2,
            other: 1,
            useOther: Option.some({ priority: 1 }),
          },
        ])
      }).pipe(Effect.provide(graphLayer)),
  )

  it.effect(
    'says what tickets.update takes for each value it can set, and nothing for the rest',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const sql = yield* SqliteClient.SqliteClient
        const ticket = yield* graph.create({
          ticket: {
            type: 'task',
            title: 'Kept title',
            description: 'Kept',
            metadata: Schema.decodeSync(TicketMetadata)({ team: 'ours' }),
          },
          actor: maintainer,
        })
        const until = '2026-10-30T09:00:00.000Z'
        const recorded: ReadonlyArray<
          readonly [string, Schema.Json, Schema.Json]
        > = [
          ['description', 'Kept', null],
          ['design', null, 'A design'],
          ['acceptance', null, 'It works'],
          ['status', 'open', 'deferred'],
          ['deferUntil', null, until],
          ['model', null, 'anthropic/a-model'],
          ['metadata', { team: 'ours' }, { team: 'theirs' }],
          ['type', 'task', 'bug'],
          ['resolution', null, 'done'],
          ['closeReason', null, 'Done'],
        ]
        yield* Effect.forEach(recorded, ([field, ours, theirs]) =>
          recordConflict(sql, { ticket: ticket.id, field, ours, theirs }),
        )
        const uses = new Map(
          (yield* graph.conflicts()).map(({ field, useOther }) => [
            field,
            useOther,
          ]),
        )
        expect(uses.get('description')).toEqual(
          Option.some({ description: Option.none() }),
        )
        expect(uses.get('design')).toEqual(
          Option.some({ design: Option.some('A design') }),
        )
        expect(uses.get('acceptance')).toEqual(
          Option.some({ acceptance: Option.some('It works') }),
        )
        expect(uses.get('status')).toEqual(Option.some({ status: 'deferred' }))
        expect(uses.get('deferUntil')).toEqual(
          Option.some({
            deferUntil: Option.some(DateTime.makeUnsafe(until)),
          }),
        )
        expect(uses.get('model')).toEqual(
          Option.some({ model: Option.some('anthropic/a-model') }),
        )
        expect(uses.get('metadata')).toEqual(
          Option.some({
            metadata: Schema.decodeSync(TicketMetadata)({ team: 'theirs' }),
          }),
        )
        expect(uses.get('type')).toEqual(Option.none())
        expect(uses.get('resolution')).toEqual(Option.none())
        expect(uses.get('closeReason')).toEqual(Option.none())
      }).pipe(Effect.provide(graphLayer)),
  )

  it.effect(
    'nothing to use for a status it can’t set or a title it can’t take',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const sql = yield* SqliteClient.SqliteClient
        const ticket = yield* fileTask
        yield* recordConflict(sql, {
          ticket: ticket.id,
          field: 'status',
          ours: 'open',
          theirs: 'closed',
        })
        yield* recordConflict(sql, {
          ticket: ticket.id,
          field: 'title',
          ours: 'Kept title',
          theirs: 'Two\nlines',
        })
        expect(
          (yield* graph.conflicts()).map(({ field, useOther }) => [
            field,
            useOther,
          ]),
        ).toEqual([
          ['status', Option.none()],
          ['title', Option.none()],
        ])
      }).pipe(Effect.provide(graphLayer)),
  )

  describe('a status or a time, by the status the ticket holds', () => {
    const until = '2026-10-30T09:00:00.000Z'
    const untilMillis = Date.parse(until)
    const assignee = new Assignee({
      engine: EngineId.make('e-1'),
      session: SessionId.make('s-1'),
    })

    /** A task brought to `status`, holding the time to defer until where `withTime`. */
    const taskHolding = (status: TicketStatus, withTime: boolean) =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const sql = yield* SqliteClient.SqliteClient
        const { id } = yield* fileTask
        switch (status) {
          case 'open':
            break
          case 'in_progress':
            yield* graph.claim({ id, assignee, actor: maintainer })
            break
          case 'deferred':
            yield* graph.defer({
              id,
              until: Option.none(),
              actor: maintainer,
            })
            break
          case 'closed':
            yield* graph.close({ id, resolution: 'done', actor: maintainer })
            break
        }
        // A merge decides the time and the status apart, so it can leave a time on any status.
        if (withTime) {
          yield* sql`UPDATE tickets SET defer_until = ${untilMillis} WHERE id = ${id}`
        }
        return id
      })

    /** What the conflict on `field` offers, from `kept` to `other`, on a task holding `status`. */
    const offered = (
      status: TicketStatus,
      field: 'status' | 'deferUntil',
      kept: Schema.Json,
      other: Schema.Json,
    ) =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const sql = yield* SqliteClient.SqliteClient
        const ticket = yield* taskHolding(status, kept === until)
        yield* recordConflict(sql, { ticket, field, ours: kept, theirs: other })
        const [conflict] = yield* graph.conflicts()
        if (conflict === undefined) return expect.unreachable()
        expect(conflict.kept).toEqual(kept)
        return conflict.useOther
      }).pipe(Effect.provide(graphLayer))

    it.effect('a status tickets.update refuses isn’t offered', () =>
      Effect.gen(function* () {
        expect(
          yield* offered('in_progress', 'status', 'in_progress', 'open'),
        ).toEqual(Option.none())
        expect(
          yield* offered('closed', 'status', 'closed', 'deferred'),
        ).toEqual(Option.none())
      }),
    )

    it.effect('a status it can make is offered', () =>
      Effect.gen(function* () {
        expect(yield* offered('closed', 'status', 'closed', 'open')).toEqual(
          Option.some({ status: 'open' }),
        )
        expect(
          yield* offered('deferred', 'status', 'deferred', 'open'),
        ).toEqual(Option.some({ status: 'open' }))
        expect(
          yield* offered('in_progress', 'status', 'in_progress', 'deferred'),
        ).toEqual(Option.some({ status: 'deferred' }))
      }),
    )

    it.effect(
      'clearing the time is offered only on a deferred ticket: elsewhere tickets.update would leave it',
      () =>
        Effect.gen(function* () {
          expect(yield* offered('open', 'deferUntil', until, null)).toEqual(
            Option.none(),
          )
          expect(
            yield* offered('in_progress', 'deferUntil', until, null),
          ).toEqual(Option.none())
          expect(yield* offered('closed', 'deferUntil', until, null)).toEqual(
            Option.none(),
          )
          expect(yield* offered('deferred', 'deferUntil', until, null)).toEqual(
            Option.some({ deferUntil: Option.none() }),
          )
        }),
    )

    it.effect('a time on a closed ticket isn’t offered, as it is refused', () =>
      Effect.gen(function* () {
        expect(yield* offered('closed', 'deferUntil', null, until)).toEqual(
          Option.none(),
        )
      }),
    )
  })

  it.effect(
    'a later change of the field supersedes its conflict; a change of another leaves it',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const sql = yield* SqliteClient.SqliteClient
        const ticket = yield* fileTask
        yield* recordConflict(sql, {
          ticket: ticket.id,
          field: 'title',
          ours: 'Kept title',
          theirs: 'Lost title',
        })
        yield* graph.update({
          id: ticket.id,
          changes: { priority: 1 },
          actor: maintainer,
        })
        expect((yield* graph.conflicts()).map(({ field }) => field)).toEqual([
          'title',
        ])
        yield* graph.update({
          id: ticket.id,
          changes: { title: 'Lost title' },
          actor: maintainer,
        })
        expect(yield* graph.conflicts()).toEqual([])
      }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('a change of status supersedes a conflict on it', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const sql = yield* SqliteClient.SqliteClient
      const ticket = yield* fileTask
      const onStatus = recordConflict(sql, {
        ticket: ticket.id,
        field: 'status',
        ours: 'open',
        theirs: 'deferred',
      })
      yield* onStatus
      expect(yield* graph.conflicts()).toHaveLength(1)
      yield* graph.defer({
        id: ticket.id,
        until: Option.none(),
        actor: maintainer,
      })
      expect(yield* graph.conflicts()).toEqual([])
      yield* onStatus
      expect(yield* graph.conflicts()).toHaveLength(1)
      yield* graph.undefer({ id: ticket.id, actor: maintainer })
      expect(yield* graph.conflicts()).toEqual([])
      yield* onStatus
      yield* graph.close({
        id: ticket.id,
        resolution: 'done',
        actor: maintainer,
      })
      expect(yield* graph.conflicts()).toEqual([])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect(
    'a later merge’s conflict on the field takes the earlier’s place',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const sql = yield* SqliteClient.SqliteClient
        const ticket = yield* fileTask
        yield* recordConflict(sql, {
          ticket: ticket.id,
          field: 'title',
          ours: 'Kept title',
          theirs: 'First loser',
        })
        yield* recordConflict(sql, {
          ticket: ticket.id,
          field: 'title',
          ours: 'Kept title',
          theirs: 'Second loser',
        })
        expect((yield* graph.conflicts()).map(({ other }) => other)).toEqual([
          'Second loser',
        ])
      }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('an answer supersedes the conflicts on what it changes', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const sql = yield* SqliteClient.SqliteClient
      const question = yield* graph.ask({
        question: {
          title: 'Keep it?',
          consequential: false,
          maintainerOnly: false,
        },
        actor: maintainer,
      })
      yield* recordConflict(sql, {
        ticket: question.id,
        field: 'status',
        ours: 'open',
        theirs: 'closed',
      })
      yield* recordConflict(sql, {
        ticket: question.id,
        field: 'resolution',
        ours: null,
        theirs: 'answered',
      })
      expect(yield* graph.conflicts()).toHaveLength(2)
      yield* graph.answer({
        id: question.id,
        answer: 'Yes',
        actor: maintainer,
      })
      expect(yield* graph.conflicts()).toEqual([])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('a field holding neither side’s value has no conflict left', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const sql = yield* SqliteClient.SqliteClient
      const ticket = yield* fileTask
      yield* recordConflict(sql, {
        ticket: ticket.id,
        field: 'title',
        ours: 'One side',
        theirs: 'The other',
      })
      expect(yield* graph.conflicts()).toEqual([])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('a deleted ticket has none, nor a name no ticket field has', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const sql = yield* SqliteClient.SqliteClient
      const ticket = yield* fileTask
      const gone = yield* fileTask
      yield* recordConflict(sql, {
        ticket: ticket.id,
        field: 'constructor',
        ours: 'A',
        theirs: 'B',
      })
      yield* recordConflict(sql, {
        ticket: gone.id,
        field: 'title',
        ours: 'Kept title',
        theirs: 'Lost title',
      })
      yield* graph.delete({ id: gone.id, actor: maintainer })
      expect(yield* graph.conflicts()).toEqual([])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('reads the tickets with a conflict by its partial index', () =>
    Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient
      const plan = yield* sql<{
        readonly detail: string
      }>`EXPLAIN QUERY PLAN SELECT ticket_id FROM events WHERE type = 'merge_conflict'`
      expect(plan.map(({ detail }) => detail).join()).toContain(
        'events_merge_conflict',
      )
    }).pipe(Effect.provide(graphLayer)),
  )
})

describe('the backlog stream as a conflict is recorded', () => {
  it.effect(
    'sends its ticket again though the merge kept the value it held, so a client asks afresh',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const graph = yield* WorkGraph
          const ticket = yield* fileTask
          const feed = yield* makeKeyedFeed<Ticket, TicketId, BacklogItem>({
            name: 'backlog',
            items: yield* graph.list(),
            keyOf: each => each.id,
            snapshot: BacklogItem.cases.snapshot.make,
            patch: BacklogItem.cases.patch.make,
          })
          const snapshot = Option.getOrThrow(
            yield* Stream.runHead(feed.watch(Option.none())),
          )
          if (snapshot._tag !== 'snapshot') return expect.unreachable()
          yield* sendChange(
            graph,
            feed,
          )(
            new TicketEvent({
              seq: 2,
              ticketId: Option.some(ticket.id),
              actor: Option.none(),
              change: conflictChange('title', 'Kept title', 'Lost title'),
              at: DateTime.makeUnsafe(at),
            }),
          )
          const [resent] = yield* feed
            .watch(
              Option.some(
                new Resume({ epoch: snapshot.epoch, after: snapshot.seq }),
              ),
            )
            .pipe(Stream.take(1), Stream.runCollect)
          if (resent?._tag !== 'patch') return expect.unreachable()
          expect(resent.value.upsert.map(({ id }) => id)).toEqual([ticket.id])
        }),
      ).pipe(Effect.provide(graphLayer)),
  )
})

describe('tickets.conflicts over RPC', () => {
  let root = ''
  let home = ''
  let gitFolder = ''

  beforeAll(() => {
    root = realpathSync(
      mkdtempSync(NodePath.join(tmpdir(), 'fabrica-conflicts-')),
    )
    home = NodePath.join(root, 'home')
    mkdirSync(home)
    writeFileSync(
      NodePath.join(home, '.gitconfig'),
      '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n[init]\n\tdefaultBranch = main\n',
    )
    gitFolder = execFileSync('git', ['--exec-path'], {
      encoding: 'utf8',
    }).trim()
  })

  const environment = () => ({
    PATH: `${gitFolder}:/usr/bin:/bin`,
    HOME: home,
    LANG: 'C',
  })

  /** A checkout on `main` with one commit. */
  const newCheckout = Effect.sync(() => {
    const work = mkdtempSync(NodePath.join(root, 'work-'))
    const git = (...args: ReadonlyArray<string>) =>
      execFileSync('git', args, {
        cwd: work,
        env: { ...environment(), GIT_CONFIG_NOSYSTEM: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    git('init', '--quiet')
    writeFileSync(NodePath.join(work, 'README.md'), '# Test\n')
    git('add', 'README.md')
    git('commit', '--quiet', '--message', 'First commit')
    return work
  })

  const engine = () => {
    const data = mkdtempSync(NodePath.join(root, 'data-'))
    return backlogHandlers.pipe(
      Layer.provideMerge(projectsLayer),
      Layer.provide(
        gitLayer({
          timeLimit: Duration.minutes(1),
          readRetries: { times: 0, spacing: Duration.zero },
        }).pipe(
          Layer.provide(
            runnerLayer({
              hostEnvironment: environment(),
              enginePriority: 0,
              priority: hostPriority,
              listProcesses,
              pipeHolders: hostHolders({
                platform: process.platform,
                self: process.pid,
              }),
              self: process.pid,
              killGrace: Duration.seconds(2),
              outputGrace: Duration.millis(200),
            }),
          ),
          Layer.provide(layerClock),
        ),
      ),
      Layer.provide(engineDatabaseLayer(':memory:')),
      Layer.provide(
        Layer.succeed(EngineFiles)(pathsIn({ data, socketFolder: data })),
      ),
    )
  }

  it.live(
    'lists a conflict; the use it gives, through tickets.update, sets the other value and ends it',
    () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const client = yield* RpcTest.makeClient(BacklogRpcs)
        const added = yield* projects.add({
          source: ProjectSource.cases.path.make({ path: yield* newCheckout }),
          name: Option.some('work'),
        })
        const project = added.id
        const { id: ticket } = yield* client['tickets.create']({
          project,
          ticket: {
            type: 'task',
            title: 'Kept title',
            description: Option.none(),
            design: Option.none(),
            acceptance: Option.none(),
            priority: Option.none(),
            labels: Option.none(),
            parent: Option.none(),
            metadata: Option.none(),
            model: Option.none(),
          },
        })
        const sql = yield* SqliteClient.make({
          filename: NodePath.join(added.path, workGraphPath),
        }).pipe(Effect.provide(Reactivity.layer))
        yield* recordConflict(sql, {
          ticket,
          field: 'title',
          ours: 'Kept title',
          theirs: 'Lost title',
        })

        const [conflict, ...rest] = yield* client['tickets.conflicts']({
          project,
        })
        expect(rest).toEqual([])
        if (conflict === undefined) return expect.unreachable()
        expect(conflict.kept).toBe('Kept title')
        expect(conflict.other).toBe('Lost title')
        yield* client['tickets.update']({
          project,
          ticket,
          changes: Option.getOrThrow(conflict.useOther),
        })

        const { ticket: shown } = yield* client['tickets.show']({
          project,
          ticket,
        })
        expect(shown.title).toBe('Lost title')
        expect(yield* client['tickets.conflicts']({ project })).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(engine())),
  )

  it.live(
    'on a deferred ticket, the time cleared by the use it gives ends the conflict',
    () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const client = yield* RpcTest.makeClient(BacklogRpcs)
        const added = yield* projects.add({
          source: ProjectSource.cases.path.make({ path: yield* newCheckout }),
          name: Option.some('work'),
        })
        const project = added.id
        const { id: ticket } = yield* client['tickets.create']({
          project,
          ticket: {
            type: 'task',
            title: 'A task',
            description: Option.none(),
            design: Option.none(),
            acceptance: Option.none(),
            priority: Option.none(),
            labels: Option.none(),
            parent: Option.none(),
            metadata: Option.none(),
            model: Option.none(),
          },
        })
        const until = DateTime.makeUnsafe('2026-10-30T09:00:00.000Z')
        yield* client['tickets.update']({
          project,
          ticket,
          changes: { deferUntil: Option.some(until) },
        })
        const sql = yield* SqliteClient.make({
          filename: NodePath.join(added.path, workGraphPath),
        }).pipe(Effect.provide(Reactivity.layer))
        yield* recordConflict(sql, {
          ticket,
          field: 'deferUntil',
          ours: DateTime.formatIso(until),
          theirs: null,
        })

        const [conflict] = yield* client['tickets.conflicts']({ project })
        if (conflict === undefined) return expect.unreachable()
        yield* client['tickets.update']({
          project,
          ticket,
          changes: Option.getOrThrow(conflict.useOther),
        })

        const { ticket: shown } = yield* client['tickets.show']({
          project,
          ticket,
        })
        expect(shown.deferUntil).toEqual(Option.none())
        expect(yield* client['tickets.conflicts']({ project })).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(engine())),
  )
})
