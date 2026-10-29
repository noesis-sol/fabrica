import {
  DateTime,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Schema,
  Stream,
} from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { SqliteClient } from '@effect/sql-sqlite-node'
import { describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  Assignee,
  Edge,
  EngineId,
  QuestionChoices,
  QuestionOption,
  SessionId,
  type TicketEvent,
  TicketId,
  TicketMetadata,
} from '@fabrica/contracts'

import {
  DatabaseTooNew,
  EdgeCycle,
  InvalidTicket,
  MigrationFailed,
  NotAQuestion,
  TicketNotFound,
  TransitionRefused,
  WorkGraph,
  makeWorkGraph,
  migrate,
  migrations,
  storeLayer,
  ticketIdRandomLength,
} from '../src/workgraph'

// The work graph's SQLite store (spec §11.1, §11.2), against an in-memory database migrated with the
// engine's own migrations; the backup before a migration against a database in a temporary folder.

/** A fresh in-memory work graph for each test, the store's client beside it. */
const graphLayer = Layer.effect(
  WorkGraph,
  makeWorkGraph({ prefix: 'fa' }),
).pipe(Layer.provideMerge(storeLayer(':memory:')))

const maintainer: Actor = { _tag: 'maintainer' }
const worker: Actor = { _tag: 'worker', session: SessionId.make('session-1') }
const engine = EngineId.make('engine-1')
const assignee = new Assignee({ engine, session: SessionId.make('session-1') })

const id = (text: string) => TicketId.make(text)

/** The tags of the ticket's history, oldest first. */
const historyTags = (ticket: TicketId) =>
  Effect.map(
    Effect.flatMap(WorkGraph, graph => graph.history(ticket)),
    events => events.map(event => event.change._tag),
  )

const countRows = (table: string) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    Effect.map(
      sql<{ readonly n: number }>`SELECT count(*) AS n FROM ${sql(table)}`,
      rows => rows[0]?.n ?? 0,
    ),
  )

const task = (title: string) => ({ type: 'task' as const, title })

describe('create', () => {
  it.effect('files an open ticket with a drawn ID and the defaults', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      yield* TestClock.adjust(Duration.millis(1_793_000_000_000))
      const ticket = yield* graph.create({
        ticket: {
          ...task('Store the work graph'),
          description: 'The details.',
          labels: ['solo', 'engine'],
        },
        actor: maintainer,
      })
      expect(ticket.id).toMatch(
        new RegExp(`^fa-[0-9a-z]{${ticketIdRandomLength}}$`, 'u'),
      )
      expect(ticket.status).toBe('open')
      expect(ticket.priority).toBe(2)
      expect(ticket.description).toEqual(Option.some('The details.'))
      expect(DateTime.toEpochMillis(ticket.createdAt)).toBe(1_793_000_000_000)

      const shown = yield* graph.show(ticket.id)
      expect(shown.ticket).toEqual(ticket)
      expect(shown.labels).toEqual(['engine', 'solo'])
      expect(yield* historyTags(ticket.id)).toEqual([
        'created',
        'labelled',
        'labelled',
      ])
      const [created] = yield* graph.history(ticket.id)
      expect(created?.actor).toEqual(Option.some(maintainer))
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect(
    'numbers children <parent>.<n>, never reusing a deleted child’s',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const epic = yield* graph.create({
          ticket: { type: 'epic', title: 'M1' },
          actor: maintainer,
        })
        const first = yield* graph.create({
          ticket: { ...task('One'), parent: epic.id },
          actor: maintainer,
        })
        const second = yield* graph.create({
          ticket: { ...task('Two'), parent: epic.id },
          actor: maintainer,
        })
        expect([first.id, second.id]).toEqual([`${epic.id}.1`, `${epic.id}.2`])
        const grandchild = yield* graph.create({
          ticket: { ...task('One, part'), parent: first.id },
          actor: maintainer,
        })
        expect(grandchild.id).toBe(`${epic.id}.1.1`)

        yield* graph.delete({ id: second.id, actor: maintainer })
        const third = yield* graph.create({
          ticket: { ...task('Three'), parent: epic.id },
          actor: maintainer,
        })
        expect(third.id).toBe(`${epic.id}.3`)
        expect((yield* graph.show(epic.id)).edges).toEqual([
          new Edge({ from: epic.id, to: first.id, kind: 'parent' }),
          new Edge({ from: epic.id, to: third.id, kind: 'parent' }),
        ])
      }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('refuses an invalid ticket, writing nothing', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const error = yield* Effect.flip(
        graph.create({ ticket: task('   '), actor: maintainer }),
      )
      expect(error).toBeInstanceOf(InvalidTicket)
      expect(yield* countRows('tickets')).toBe(0)
      expect(yield* countRows('events')).toBe(0)

      const missing = yield* Effect.flip(
        graph.create({
          ticket: { ...task('Orphan'), parent: id('fa-missing') },
          actor: maintainer,
        }),
      )
      expect(missing).toEqual(new TicketNotFound({ id: id('fa-missing') }))
    }).pipe(Effect.provide(graphLayer)),
  )
})

describe('update', () => {
  it.effect('changes the fields given, with one event naming them', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const ticket = yield* graph.create({
        ticket: { ...task('Before'), description: 'Old.' },
        actor: maintainer,
      })
      yield* TestClock.adjust(Duration.seconds(5))
      const updated = yield* graph.update({
        id: ticket.id,
        changes: { title: 'After', description: Option.none(), priority: 0 },
        actor: worker,
      })
      expect(updated.title).toBe('After')
      expect(updated.description).toEqual(Option.none())
      expect(updated.priority).toBe(0)
      expect(DateTime.toEpochMillis(updated.updatedAt)).toBe(5_000)
      expect((yield* graph.show(ticket.id)).ticket).toEqual(updated)

      const events = yield* graph.history(ticket.id)
      expect(events.at(-1)?.change).toEqual({
        _tag: 'updated',
        fields: ['title', 'description', 'priority'],
      })
      expect(events.at(-1)?.actor).toEqual(Option.some(worker))

      yield* graph.update({ id: ticket.id, changes: {}, actor: worker })
      expect(yield* historyTags(ticket.id)).toEqual(['created', 'updated'])

      const blank = yield* Effect.flip(
        graph.update({ id: ticket.id, changes: { title: '' }, actor: worker }),
      )
      expect(blank).toBeInstanceOf(InvalidTicket)
      expect((yield* graph.show(ticket.id)).ticket.title).toBe('After')
    }).pipe(Effect.provide(graphLayer)),
  )
})

describe('claim and release', () => {
  it.effect('claims an open ticket with a lease, and releases it', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const sql = yield* SqlClient.SqlClient
      const ticket = yield* graph.create({
        ticket: task('Work'),
        actor: maintainer,
      })
      const claimed = yield* graph.claim({
        id: ticket.id,
        assignee,
        actor: { _tag: 'engine', engine },
      })
      expect(claimed.status).toBe('in_progress')
      expect(claimed.assignee).toEqual(Option.some(assignee))
      expect(
        yield* sql`SELECT ticket_id, engine_id, expires_at FROM leases`,
      ).toEqual([
        { ticket_id: ticket.id, engine_id: engine, expires_at: 300_000 },
      ])

      const again = yield* Effect.flip(
        graph.claim({ id: ticket.id, assignee, actor: maintainer }),
      )
      expect(again).toEqual(
        new TransitionRefused({
          id: ticket.id,
          operation: 'claim',
          status: 'in_progress',
        }),
      )

      const released = yield* graph.release({ id: ticket.id, actor: worker })
      expect(released.status).toBe('open')
      expect(released.assignee).toEqual(Option.none())
      expect(yield* countRows('leases')).toBe(0)
      expect(
        yield* Effect.flip(graph.release({ id: ticket.id, actor: worker })),
      ).toBeInstanceOf(TransitionRefused)
      expect(yield* historyTags(ticket.id)).toEqual([
        'created',
        'claimed',
        'released',
      ])
    }).pipe(Effect.provide(graphLayer)),
  )
})

describe('close and reopen', () => {
  it.effect('closes with a resolution and reason, and reopens', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const ticket = yield* graph.create({
        ticket: task('Work'),
        actor: maintainer,
      })
      yield* graph.claim({ id: ticket.id, assignee, actor: maintainer })
      const { ticket: closed } = yield* graph.close({
        id: ticket.id,
        resolution: 'done',
        reason: 'Merged.',
        actor: worker,
      })
      expect(closed.status).toBe('closed')
      expect(closed.resolution).toEqual(Option.some('done'))
      expect(closed.closeReason).toEqual(Option.some('Merged.'))
      expect(yield* countRows('leases')).toBe(0)
      expect(
        yield* Effect.flip(
          graph.close({ id: ticket.id, resolution: 'done', actor: worker }),
        ),
      ).toBeInstanceOf(TransitionRefused)

      const reopened = yield* graph.reopen({ id: ticket.id, actor: maintainer })
      expect(reopened.status).toBe('open')
      expect(reopened.resolution).toEqual(Option.none())
      expect(reopened.closeReason).toEqual(Option.none())
      expect(reopened.assignee).toEqual(Option.none())
      expect(
        yield* Effect.flip(graph.reopen({ id: ticket.id, actor: maintainer })),
      ).toBeInstanceOf(TransitionRefused)

      const events = yield* graph.history(ticket.id)
      expect(events.map(event => event.change)).toContainEqual({
        _tag: 'closed',
        resolution: 'done',
      })
      expect(events.at(-1)?.change._tag).toBe('reopened')
    }).pipe(Effect.provide(graphLayer)),
  )
})

describe('defer and undefer', () => {
  it.effect('sets a ticket aside until a time, and brings it back', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const ticket = yield* graph.create({
        ticket: task('Later'),
        actor: maintainer,
      })
      const until = DateTime.makeUnsafe(1_800_000_000_000)
      const deferred = yield* graph.defer({
        id: ticket.id,
        until: Option.some(until),
        actor: maintainer,
      })
      expect(deferred.status).toBe('deferred')
      expect(deferred.deferUntil).toEqual(Option.some(until))
      expect((yield* graph.history(ticket.id)).at(-1)?.change).toEqual({
        _tag: 'deferred',
        until: Option.some(until),
      })

      const back = yield* graph.undefer({ id: ticket.id, actor: maintainer })
      expect(back.status).toBe('open')
      expect(back.deferUntil).toEqual(Option.none())
      expect(
        yield* Effect.flip(graph.undefer({ id: ticket.id, actor: maintainer })),
      ).toBeInstanceOf(TransitionRefused)

      yield* graph.close({
        id: ticket.id,
        resolution: 'cancelled',
        actor: maintainer,
      })
      expect(
        yield* Effect.flip(
          graph.defer({
            id: ticket.id,
            until: Option.none(),
            actor: maintainer,
          }),
        ),
      ).toBeInstanceOf(TransitionRefused)
    }).pipe(Effect.provide(graphLayer)),
  )
})

describe('labels', () => {
  it.effect('labels and unlabels, a repeat changing nothing', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const ticket = yield* graph.create({
        ticket: task('Shared'),
        actor: maintainer,
      })
      const other = yield* graph.create({
        ticket: task('Other'),
        actor: maintainer,
      })
      yield* graph.label({ id: ticket.id, label: 'solo', actor: worker })
      yield* graph.label({ id: ticket.id, label: 'solo', actor: worker })
      expect((yield* graph.show(ticket.id)).labels).toEqual(['solo'])
      expect(
        (yield* graph.list({ label: 'solo' })).map(found => found.id),
      ).toEqual([ticket.id])

      yield* graph.unlabel({ id: ticket.id, label: 'solo', actor: worker })
      yield* graph.unlabel({ id: ticket.id, label: 'solo', actor: worker })
      expect((yield* graph.show(ticket.id)).labels).toEqual([])
      expect(yield* historyTags(ticket.id)).toEqual([
        'created',
        'labelled',
        'unlabelled',
      ])
      expect(yield* graph.list({ label: 'solo' })).toEqual([])
      expect(yield* historyTags(other.id)).toEqual(['created'])

      expect(
        yield* Effect.flip(
          graph.label({ id: id('fa-missing'), label: 'solo', actor: worker }),
        ),
      ).toBeInstanceOf(TicketNotFound)
    }).pipe(Effect.provide(graphLayer)),
  )
})

describe('edges', () => {
  const three = Effect.gen(function* () {
    const graph = yield* WorkGraph
    const [a, b, c] = yield* Effect.forEach(['A', 'B', 'C'], title =>
      graph.create({ ticket: task(title), actor: maintainer }),
    )
    if (a === undefined || b === undefined || c === undefined) {
      return yield* Effect.die('three tickets')
    }
    return [a.id, b.id, c.id] as const
  })

  it.effect('adds and removes a dependency, a repeat changing nothing', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const [a, b] = yield* three
      const edge = new Edge({ from: a, to: b, kind: 'blocks' })
      yield* graph.addDependency({ edge, actor: maintainer })
      yield* graph.addDependency({ edge, actor: maintainer })
      expect((yield* graph.show(b)).edges).toEqual([edge])
      expect((yield* graph.history(a)).at(-1)?.change).toEqual({
        _tag: 'linked',
        edge,
      })

      yield* graph.removeDependency({ edge, actor: maintainer })
      yield* graph.removeDependency({ edge, actor: maintainer })
      expect((yield* graph.show(a)).edges).toEqual([])
      expect(yield* historyTags(a)).toEqual(['created', 'linked', 'unlinked'])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect.each(['blocks', 'parent'] as const)(
    'refuses a %s edge that closes a cycle',
    kind =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const [a, b, c] = yield* three
        yield* graph.addDependency({
          edge: new Edge({ from: a, to: b, kind }),
          actor: maintainer,
        })
        yield* graph.addDependency({
          edge: new Edge({ from: b, to: c, kind }),
          actor: maintainer,
        })
        const closing = new Edge({ from: c, to: a, kind })
        expect(
          yield* Effect.flip(
            graph.addDependency({ edge: closing, actor: maintainer }),
          ),
        ).toEqual(new EdgeCycle({ edge: closing }))
        const back = new Edge({ from: b, to: a, kind })
        expect(
          yield* Effect.flip(
            graph.addDependency({ edge: back, actor: maintainer }),
          ),
        ).toEqual(new EdgeCycle({ edge: back }))
        expect(yield* countRows('edges')).toBe(2)
        expect(yield* historyTags(c)).toEqual(['created'])
      }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('allows a cycle across kinds, and among related tickets', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const [a, b] = yield* three
      yield* graph.addDependency({
        edge: new Edge({ from: a, to: b, kind: 'blocks' }),
        actor: maintainer,
      })
      yield* graph.addDependency({
        edge: new Edge({ from: b, to: a, kind: 'parent' }),
        actor: maintainer,
      })
      yield* graph.addDependency({
        edge: new Edge({ from: a, to: b, kind: 'related' }),
        actor: maintainer,
      })
      yield* graph.addDependency({
        edge: new Edge({ from: b, to: a, kind: 'related' }),
        actor: maintainer,
      })
      expect(yield* countRows('edges')).toBe(4)
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('refuses an edge to a ticket that doesn’t exist', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const [a] = yield* three
      expect(
        yield* Effect.flip(
          graph.addDependency({
            edge: new Edge({ from: a, to: id('fa-missing'), kind: 'blocks' }),
            actor: maintainer,
          }),
        ),
      ).toEqual(new TicketNotFound({ id: id('fa-missing') }))
    }).pipe(Effect.provide(graphLayer)),
  )
})

describe('notes', () => {
  it.effect('writes a note with its author, shown oldest first', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const ticket = yield* graph.create({
        ticket: task('Noted'),
        actor: maintainer,
      })
      const first = yield* graph.note({
        id: ticket.id,
        body: 'A decision.',
        actor: worker,
      })
      yield* TestClock.adjust(Duration.seconds(1))
      const second = yield* graph.note({
        id: ticket.id,
        body: 'A gap.',
        actor: maintainer,
      })
      expect(first.id).not.toBe(second.id)
      expect(first.author).toEqual(worker)
      expect((yield* graph.show(ticket.id)).notes).toEqual([first, second])
      expect((yield* graph.history(ticket.id)).at(-1)?.change).toEqual({
        _tag: 'noted',
        note: second.id,
      })
      expect(
        yield* Effect.flip(
          graph.note({ id: ticket.id, body: ' ', actor: worker }),
        ),
      ).toBeInstanceOf(InvalidTicket)
    }).pipe(Effect.provide(graphLayer)),
  )
})

describe('fileDiscovered', () => {
  it.effect.each([
    ['blocks', 'from', 'filed'],
    ['discovered_from', 'filed', 'from'],
    ['related', 'from', 'filed'],
  ] as const)('links a %s ticket from %s to %s', ([link, edgeFrom, edgeTo]) =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const from = yield* graph.create({
        ticket: task('Working'),
        actor: maintainer,
      })
      const filed = yield* graph.fileDiscovered({
        from: from.id,
        link,
        ticket: {
          ...task('Found'),
          metadata: Schema.decodeSync(TicketMetadata)({ files: ['a.ts'] }),
        },
        actor: worker,
      })
      const ends = { from: from.id, filed: filed.id }
      expect((yield* graph.show(filed.id)).edges).toEqual([
        new Edge({ from: ends[edgeFrom], to: ends[edgeTo], kind: link }),
      ])
      expect(filed.metadata.files).toEqual(Option.some(['a.ts']))
    }).pipe(Effect.provide(graphLayer)),
  )
})

describe('ask and answer', () => {
  const choices = new QuestionChoices({
    options: [
      new QuestionOption({ label: 'Keep', tradeOff: 'Less work.' }),
      new QuestionOption({ label: 'Change', tradeOff: 'Cleaner.' }),
    ],
    recommended: 1,
  })

  it.effect('files a question blocking its tickets, and answers it', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const waiting = yield* graph.create({
        ticket: task('Waiting'),
        actor: maintainer,
      })
      const question = yield* graph.ask({
        question: {
          title: 'Keep the format?',
          description: 'The context.',
          choices,
          consequential: true,
          maintainerOnly: false,
          blocks: [waiting.id],
        },
        actor: worker,
      })
      expect(question.type).toBe('question')
      const asked = Option.getOrThrow(question.question)
      expect(asked.choices).toEqual(Option.some(choices))
      expect(asked.consequential).toBe(true)
      expect(asked.maintainerOnly).toBe(false)
      expect((yield* graph.show(question.id)).ticket).toEqual(question)
      expect((yield* graph.show(waiting.id)).edges).toEqual([
        new Edge({ from: question.id, to: waiting.id, kind: 'blocks' }),
      ])

      const answered = yield* graph.answer({
        id: question.id,
        answer: 'Change',
        actor: maintainer,
      })
      expect(answered.status).toBe('closed')
      expect(answered.resolution).toEqual(Option.some('answered'))
      expect(Option.getOrThrow(answered.question).answer).toEqual(
        Option.some('Change'),
      )
      expect((yield* graph.show(question.id)).ticket).toEqual(answered)
      expect(yield* historyTags(question.id)).toEqual([
        'created',
        'linked',
        'answered',
      ])
      expect(
        yield* Effect.flip(
          graph.answer({ id: question.id, answer: 'Keep', actor: maintainer }),
        ),
      ).toBeInstanceOf(TransitionRefused)
      expect(
        yield* Effect.flip(
          graph.answer({ id: waiting.id, answer: 'Keep', actor: maintainer }),
        ),
      ).toEqual(new NotAQuestion({ id: waiting.id, type: 'task' }))
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('files a question without options, for a talk to draft', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const question = yield* graph.ask({
        question: {
          title: 'Which?',
          consequential: false,
          maintainerOnly: true,
        },
        actor: worker,
      })
      const shown = Option.getOrThrow(
        (yield* graph.show(question.id)).ticket.question,
      )
      expect(shown.choices).toEqual(Option.none())
      expect(shown.maintainerOnly).toBe(true)
    }).pipe(Effect.provide(graphLayer)),
  )
})

describe('delete', () => {
  it.effect(
    'leaves a tombstone, drops what hangs off the ticket, keeps its history',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const sql = yield* SqlClient.SqlClient
        const ticket = yield* graph.create({
          ticket: { ...task('Gone'), labels: ['solo'] },
          actor: maintainer,
        })
        const other = yield* graph.create({
          ticket: task('Stays'),
          actor: maintainer,
        })
        yield* graph.addDependency({
          edge: new Edge({ from: other.id, to: ticket.id, kind: 'blocks' }),
          actor: maintainer,
        })
        yield* graph.note({ id: ticket.id, body: 'A note.', actor: worker })
        yield* graph.claim({ id: ticket.id, assignee, actor: maintainer })

        yield* graph.delete({ id: ticket.id, actor: maintainer })
        expect(yield* Effect.flip(graph.show(ticket.id))).toEqual(
          new TicketNotFound({ id: ticket.id }),
        )
        expect(yield* sql`SELECT id, actor FROM tombstones`).toEqual([
          { id: ticket.id, actor: '{"_tag":"maintainer"}' },
        ])
        expect(yield* countRows('labels')).toBe(0)
        expect(yield* countRows('edges')).toBe(0)
        expect(yield* countRows('notes')).toBe(0)
        expect(yield* countRows('leases')).toBe(0)
        expect((yield* historyTags(ticket.id)).at(-1)).toBe('deleted')
        expect((yield* graph.list()).map(found => found.id)).toEqual([other.id])
        expect(
          yield* Effect.flip(
            graph.delete({ id: ticket.id, actor: maintainer }),
          ),
        ).toBeInstanceOf(TicketNotFound)
      }).pipe(Effect.provide(graphLayer)),
  )
})

describe('events', () => {
  it.effect('appends one row per mutation, each with its actor', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const organ: Actor = { _tag: 'organ', organ: 'triage' }
      const a = yield* graph.create({ ticket: task('A'), actor: maintainer })
      const b = yield* graph.create({ ticket: task('B'), actor: organ })
      yield* graph.update({ id: a.id, changes: { priority: 1 }, actor: organ })
      yield* graph.label({ id: a.id, label: 'engine', actor: organ })
      yield* graph.addDependency({
        edge: new Edge({ from: a.id, to: b.id, kind: 'blocks' }),
        actor: organ,
      })
      yield* graph.note({ id: b.id, body: 'Why.', actor: worker })
      yield* graph.claim({ id: a.id, assignee, actor: worker })
      yield* graph.close({ id: a.id, resolution: 'done', actor: worker })
      yield* graph.defer({ id: b.id, until: Option.none(), actor: organ })
      yield* graph.undefer({ id: b.id, actor: maintainer })
      expect(yield* countRows('events')).toBe(10)
      const all = [
        ...(yield* graph.history(a.id)),
        ...(yield* graph.history(b.id)),
      ].sort((x, y) => x.seq - y.seq)
      expect(
        all.map(event => [
          event.change._tag,
          Option.getOrThrow(event.actor)._tag,
        ]),
      ).toEqual([
        ['created', 'maintainer'],
        ['created', 'organ'],
        ['updated', 'organ'],
        ['labelled', 'organ'],
        ['linked', 'organ'],
        ['noted', 'worker'],
        ['claimed', 'worker'],
        ['closed', 'worker'],
        ['deferred', 'organ'],
        ['undeferred', 'maintainer'],
      ])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('streams the events appended after subscribing', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const before = yield* graph.create({
        ticket: task('Before'),
        actor: maintainer,
      })
      const stream = yield* graph.changes
      const collecting = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(stream, 3)),
      )
      const after = yield* graph.create({
        ticket: task('After'),
        actor: maintainer,
      })
      yield* graph.label({ id: before.id, label: 'solo', actor: worker })
      yield* graph.close({ id: after.id, resolution: 'done', actor: worker })
      const events: ReadonlyArray<TicketEvent> = yield* Fiber.join(collecting)
      expect(
        events.map(event => [
          Option.getOrThrow(event.ticketId),
          event.change._tag,
        ]),
      ).toEqual([
        [after.id, 'created'],
        [before.id, 'labelled'],
        [after.id, 'closed'],
      ])
    }).pipe(Effect.scoped, Effect.provide(graphLayer)),
  )
})

describe('list', () => {
  it.effect(
    'lists by status and type, most urgent then oldest, across batches',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const filed = yield* Effect.forEach(
          Array.from({ length: 1_203 }, (_, n) => n),
          n =>
            Effect.andThen(
              TestClock.adjust(Duration.millis(1)),
              graph.create({
                ticket: {
                  ...task(`Ticket ${n}`),
                  priority: n % 3 === 0 ? 1 : 2,
                },
                actor: maintainer,
              }),
            ),
        )
        const all = yield* graph.list()
        expect(all).toHaveLength(1_203)
        expect(all.map(ticket => ticket.id)).toEqual([
          ...filed.filter((_, n) => n % 3 === 0).map(ticket => ticket.id),
          ...filed.filter((_, n) => n % 3 !== 0).map(ticket => ticket.id),
        ])

        const closing = filed.slice(0, 2)
        for (const ticket of closing) {
          yield* graph.close({
            id: ticket.id,
            resolution: 'done',
            actor: worker,
          })
        }
        expect(
          (yield* graph.list({ statuses: ['closed'] })).map(
            ticket => ticket.id,
          ),
        ).toEqual(closing.map(ticket => ticket.id))
        yield* graph.create({
          ticket: { type: 'epic', title: 'E' },
          actor: worker,
        })
        expect(yield* graph.list({ types: ['epic'] })).toHaveLength(1)
        expect(
          yield* graph.list({ statuses: ['closed'], types: ['epic'] }),
        ).toEqual([])
      }).pipe(Effect.provide(graphLayer)),
  )
})

describe('migrations', () => {
  const later = {
    ...migrations,
    '0002_later': Effect.flatMap(SqlClient.SqlClient, sql =>
      Effect.asVoid(sql`CREATE TABLE later (id INTEGER PRIMARY KEY)`),
    ),
  }

  it.effect(
    'opens the store in WAL with foreign keys, at the engine’s version',
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        expect(yield* sql`PRAGMA foreign_keys`).toEqual([{ foreign_keys: 1 }])
        expect(yield* sql`PRAGMA busy_timeout`).toEqual([{ timeout: 5000 }])
        expect(
          yield* sql`SELECT migration_id FROM effect_sql_migrations`,
        ).toEqual([{ migration_id: 1 }])
        expect(yield* migrate()).toBe(1)
      }).pipe(Effect.provide(storeLayer(':memory:'))),
  )

  it.effect('refuses a database a newer engine migrated', () =>
    Effect.gen(function* () {
      expect(yield* migrate(later)).toBe(1)
      expect(yield* Effect.flip(migrate())).toEqual(
        new DatabaseTooNew({ filename: ':memory:', found: 2, known: 1 }),
      )
    }).pipe(Effect.provide(storeLayer(':memory:'))),
  )

  /** A temporary folder for one test, removed when the test ends. */
  const scratch = Effect.acquireRelease(
    Effect.promise(() =>
      mkdtemp(NodePath.join(tmpdir(), 'fabrica-workgraph-')),
    ),
    folder =>
      Effect.promise(() => rm(folder, { recursive: true, force: true })),
  )

  it.effect(
    'backs the database up before migrating it, and refuses it when newer',
    () =>
      Effect.gen(function* () {
        const folder = yield* scratch
        const filename = NodePath.join(folder, 'work.db')
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          expect(yield* sql`PRAGMA journal_mode`).toEqual([
            { journal_mode: 'wal' },
          ])
          yield* migrate(later)
        }).pipe(Effect.provide(storeLayer(filename)))

        const backup = `${filename}.v1.backup`
        yield* Effect.promise(() => access(backup))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          expect(
            yield* sql`SELECT max(migration_id) AS version FROM effect_sql_migrations`,
          ).toEqual([{ version: 1 }])
        }).pipe(
          Effect.provide(
            SqliteClient.layer({ filename: backup, readonly: true }),
          ),
        )

        const refused = yield* Effect.flip(
          Layer.build(storeLayer(filename)).pipe(Effect.scoped),
        )
        expect(refused).toEqual(
          new DatabaseTooNew({ filename, found: 2, known: 1 }),
        )
      }).pipe(Effect.scoped),
  )

  it.effect('leaves the database as it was when a migration fails', () =>
    Effect.gen(function* () {
      const failing = {
        ...migrations,
        '0002_failing': Effect.flatMap(SqlClient.SqlClient, sql =>
          Effect.andThen(
            sql`CREATE TABLE half (id INTEGER)`,
            sql`NOT SQL AT ALL`,
          ),
        ),
      }
      const failed = yield* Effect.flip(migrate(failing))
      expect(failed).toBeInstanceOf(MigrationFailed)
      expect(failed.message).toMatch(/2_failing.*syntax error/u)
      const sql = yield* SqlClient.SqlClient
      expect(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'half'`,
      ).toEqual([])
      expect(yield* migrate()).toBe(1)
    }).pipe(Effect.provide(storeLayer(':memory:'))),
  )
})
