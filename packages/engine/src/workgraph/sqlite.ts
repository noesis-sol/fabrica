import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from 'effect'
import { Reactivity } from 'effect/reactivity'
import { SqlClient, type SqlError } from 'effect/sql'

import { SqliteClient } from '@effect/sql-sqlite-node'
import {
  type Actor,
  Edge,
  type LabelName,
  Note,
  Question,
  type Resolution,
  type Ticket,
  type TicketChange,
  type TicketEvent,
  type TicketId,
  TicketMetadata,
} from '@fabrica/contracts'

import {
  EdgeCycle,
  NotAQuestion,
  StoreFailed,
  TicketNotFound,
  TransitionRefused,
} from './errors'
import { checkPrefix, drawNoteId, drawTicketId, nextChildId } from './ids'
import { migrate } from './migrations'
import {
  blockedTickets,
  finishedEpics,
  readyTickets,
  whyWaiting,
} from './ready'
import {
  type EdgeRow,
  type EventRow,
  type NoteRow,
  type TicketRow,
  actorColumn,
  changeColumns,
  edgeFromRow,
  eventFromRow,
  invalid,
  makeTicket,
  noteFromRow,
  rowFromTicket,
  ticketFromRow,
} from './rows'
import {
  type NewTicket,
  type TicketFilter,
  WorkGraph,
  type WorkGraphShape,
} from './service'

// The local tracker (spec §11.2): one SQLite database per project through `node:sqlite`, the engine
// its single writer. WAL, one serialised connection and a 5 s busy timeout are the client's defaults.
// Every mutation runs in one transaction with the events row it appends, and invalidates the reactive
// queries once committed. `node:sqlite` blocks the event loop while a query runs, so queries stay
// small and indexed, and a long read goes in batches that yield between them.

/** The key every mutation invalidates and every reactive query of the work graph listens on. */
const reactivityKeys = ['work_graph']

/** How many tickets a batch of `list` reads before it yields. */
const listBatchSize = 500

/** The store: the database at `filename` (`:memory:` for one in memory), migrated, foreign keys enforced. */
export const storeLayer = (
  filename: string,
): Layer.Layer<
  SqliteClient.SqliteClient | SqlClient.SqlClient | Reactivity.Reactivity,
  StoreFailed | Effect.Error<ReturnType<typeof migrate>>
> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const sql = yield* SqliteClient.make({ filename })
      yield* sql`PRAGMA foreign_keys = ON`.pipe(
        Effect.mapError(
          error =>
            new StoreFailed({ operation: 'opening', reason: error.message }),
        ),
      )
      const context = Context.make(SqliteClient.SqliteClient, sql).pipe(
        Context.add(SqlClient.SqlClient, sql),
      )
      yield* migrate().pipe(Effect.provide(context))
      return context
    }),
  ).pipe(Layer.provideMerge(Reactivity.layer))

export interface WorkGraphOptions {
  /** The project's ticket ID prefix, such as `fab`. */
  readonly prefix: string
  /** How long a claim's lease lasts unless renewed (§11.2); 5 minutes when left out. */
  readonly leaseTtl?: Duration.Input
}

/** The work graph on the store in context. */
export const makeWorkGraph = Effect.fn('WorkGraph.make')(function* (
  options: WorkGraphOptions,
) {
  const sql = yield* SqliteClient.SqliteClient
  const reactivity = yield* Reactivity.Reactivity
  const prefix = yield* checkPrefix(options.prefix)
  const leaseTtl = Duration.fromInputUnsafe(options.leaseTtl ?? '5 minutes')
  const emptyMetadata = Schema.decodeSync(TicketMetadata)({})

  /** A read, its SQL errors as the store's. */
  const read = <A, E>(
    operation: string,
    effect: Effect.Effect<A, E | SqlError.SqlError>,
  ) =>
    Effect.catchTag(effect, 'SqlError', error =>
      Effect.fail(
        new StoreFailed({
          operation,
          reason: error instanceof Error ? error.message : String(error),
        }),
      ),
    )

  /** A mutation: one transaction, the reactive queries invalidated once it commits. */
  const mutate = <A, E>(
    operation: string,
    effect: Effect.Effect<A, E | SqlError.SqlError>,
  ) =>
    read(
      operation,
      reactivity.mutation(reactivityKeys, sql.withTransaction(effect)),
    )

  const now = DateTime.now

  // --- Reads -----------------------------------------------------------------------------------

  const ticketRow = (id: TicketId) =>
    Effect.map(sql<TicketRow>`SELECT * FROM tickets WHERE id = ${id}`, rows =>
      Option.fromUndefinedOr(rows[0]),
    )

  const getTicket = (id: TicketId) =>
    Effect.flatMap(
      ticketRow(id),
      (row): Effect.Effect<Ticket, TicketNotFound | StoreFailed> =>
        Option.match(row, {
          onNone: () => Effect.fail(new TicketNotFound({ id })),
          onSome: ticketFromRow,
        }),
    )

  const requireTicket = (id: TicketId) => Effect.asVoid(getTicket(id))

  const idTaken = (id: string) =>
    Effect.map(
      sql`SELECT 1 FROM tickets WHERE id = ${id} UNION ALL SELECT 1 FROM tombstones WHERE id = ${id} LIMIT 1`,
      rows => rows.length > 0,
    )

  // --- Writes ----------------------------------------------------------------------------------

  const appendEvent = (options: {
    readonly ticket: TicketId
    readonly actor: Actor
    readonly change: TicketChange
    readonly at: DateTime.Utc
  }) => {
    const { type, payload } = changeColumns(options.change)
    return sql`INSERT INTO events ${sql.insert({
      ticket_id: options.ticket,
      type,
      actor: actorColumn(options.actor),
      payload,
      at: DateTime.toEpochMillis(options.at),
    })}`
  }

  const insertTicket = (ticket: Ticket) =>
    Effect.flatMap(
      rowFromTicket(ticket),
      row => sql`INSERT INTO tickets ${sql.insert({ ...row, clocks: '{}' })}`,
    )

  const writeTicket = (ticket: Ticket) =>
    Effect.flatMap(
      rowFromTicket(ticket),
      row =>
        sql`UPDATE tickets SET ${sql.update(row, ['id'])} WHERE id = ${row.id}`,
    )

  const dropLease = (id: TicketId) =>
    sql`DELETE FROM leases WHERE ticket_id = ${id}`

  /** A new top-level ID no ticket or tombstone has. */
  const freeTicketId = Effect.gen(function* () {
    while (true) {
      const id = yield* drawTicketId(prefix)
      if (!(yield* idTaken(id))) return id
    }
  })

  /** The parent's next child ID, past every child it has had, deleted ones included. */
  const childId = (parent: TicketId) =>
    Effect.map(
      sql<{
        readonly id: string
      }>`SELECT id FROM tickets WHERE id GLOB ${`${parent}.*`} UNION ALL SELECT id FROM tombstones WHERE id GLOB ${`${parent}.*`}`,
      rows =>
        nextChildId(
          parent,
          rows.map(row => row.id),
        ),
    )

  /** Whether `from` reaches `to` along edges of the kind. */
  const reaches = (from: TicketId, to: TicketId, kind: Edge['kind']) =>
    Effect.map(
      sql`WITH RECURSIVE reach(id) AS (
        SELECT ${from}
        UNION
        SELECT edges.to_id FROM edges JOIN reach ON edges.from_id = reach.id WHERE edges.kind = ${kind}
      ) SELECT 1 FROM reach WHERE id = ${to} LIMIT 1`,
      rows => rows.length > 0,
    )

  const edgeExists = (edge: Edge) =>
    Effect.map(
      sql`SELECT 1 FROM edges WHERE from_id = ${edge.from} AND to_id = ${edge.to} AND kind = ${edge.kind}`,
      rows => rows.length > 0,
    )

  /** Adds an edge between two tickets; a `blocks` or `parent` edge closing a cycle is refused. */
  const link = (edge: Edge, actor: Actor, at: DateTime.Utc) =>
    Effect.gen(function* () {
      yield* Effect.all([requireTicket(edge.from), requireTicket(edge.to)])
      if (yield* edgeExists(edge)) return
      if (
        (edge.kind === 'blocks' || edge.kind === 'parent') &&
        (yield* reaches(edge.to, edge.from, edge.kind))
      ) {
        return yield* new EdgeCycle({ edge })
      }
      yield* sql`INSERT INTO edges ${sql.insert({ from_id: edge.from, to_id: edge.to, kind: edge.kind })}`
      yield* appendEvent({
        ticket: edge.from,
        actor,
        change: { _tag: 'linked', edge },
        at,
      })
    })

  const makeEdge = (edge: ConstructorParameters<typeof Edge>[0]) =>
    Edge.makeEffect(edge).pipe(Effect.mapError(invalid))

  const addLabel = (
    id: TicketId,
    label: LabelName,
    actor: Actor,
    at: DateTime.Utc,
  ) =>
    Effect.gen(function* () {
      const present =
        yield* sql`SELECT 1 FROM labels WHERE ticket_id = ${id} AND label = ${label}`
      if (present.length > 0) return
      yield* sql`INSERT INTO labels ${sql.insert({ ticket_id: id, label })}`
      yield* appendEvent({
        ticket: id,
        actor,
        change: { _tag: 'labelled', label },
        at,
      })
    })

  /** Files a ticket: its row, its labels and its parent edge, each with its event. */
  const fileTicket = (input: NewTicket, actor: Actor) =>
    Effect.gen(function* () {
      const parent = Option.fromUndefinedOr(input.parent)
      if (Option.isSome(parent)) yield* requireTicket(parent.value)
      const id = yield* Option.match(parent, {
        onNone: () => freeTicketId,
        onSome: childId,
      })
      const at = yield* now
      const ticket = yield* makeTicket({
        id,
        type: input.type,
        title: input.title,
        description: Option.fromUndefinedOr(input.description),
        design: Option.fromUndefinedOr(input.design),
        acceptance: Option.fromUndefinedOr(input.acceptance),
        status: 'open',
        resolution: Option.none(),
        priority: input.priority ?? 2,
        deferUntil: Option.none(),
        assignee: Option.none(),
        model: Option.fromUndefinedOr(input.model),
        metadata: input.metadata ?? emptyMetadata,
        result: Option.none(),
        question: Option.none(),
        mergedCommit: Option.none(),
        closeReason: Option.none(),
        createdAt: at,
        updatedAt: at,
      })
      yield* insertTicket(ticket)
      yield* appendEvent({ ticket: id, actor, change: { _tag: 'created' }, at })
      for (const label of input.labels ?? []) {
        yield* addLabel(id, label, actor, at)
      }
      if (Option.isSome(parent)) {
        yield* link(
          yield* makeEdge({ from: parent.value, to: id, kind: 'parent' }),
          actor,
          at,
        )
      }
      return ticket
    })

  /**
   * Changes a ticket's status (and what goes with it) when `allowed` says its status lets it, with
   * the change's event. Returns the ticket as written.
   */
  const transition = (options: {
    readonly id: TicketId
    readonly operation: string
    readonly allowed: (ticket: Ticket) => boolean
    readonly change: (
      ticket: Ticket,
      at: DateTime.Utc,
    ) => Partial<ConstructorParameters<typeof Ticket>[0]>
    readonly event: TicketChange
    readonly actor: Actor
    readonly lease?: 'keep' | 'drop'
  }) =>
    Effect.gen(function* () {
      const ticket = yield* getTicket(options.id)
      if (!options.allowed(ticket)) {
        return yield* new TransitionRefused({
          id: options.id,
          operation: options.operation,
          status: ticket.status,
        })
      }
      const at = yield* now
      const changed = yield* makeTicket({
        ...ticket,
        ...options.change(ticket, at),
        updatedAt: at,
      })
      yield* writeTicket(changed)
      if (options.lease === 'drop') yield* dropLease(options.id)
      yield* appendEvent({
        ticket: options.id,
        actor: options.actor,
        change: options.event,
        at,
      })
      return changed
    })

  // --- The interface ---------------------------------------------------------------------------

  const show: WorkGraphShape['show'] = Effect.fn('WorkGraph.show')(
    function* (id) {
      return yield* read(
        'show',
        Effect.gen(function* () {
          const [ticket, labels, edges, notes] = yield* Effect.all([
            getTicket(id),
            sql<{
              readonly label: LabelName
            }>`SELECT label FROM labels WHERE ticket_id = ${id} ORDER BY label`,
            sql<EdgeRow>`SELECT * FROM edges WHERE from_id = ${id} UNION SELECT * FROM edges WHERE to_id = ${id} ORDER BY kind, from_id, to_id`,
            sql<NoteRow>`SELECT * FROM notes WHERE ticket_id = ${id} ORDER BY at, id`,
          ])
          return {
            ticket,
            labels: labels.map(row => row.label),
            edges: yield* Effect.forEach(edges, edgeFromRow),
            notes: yield* Effect.forEach(notes, noteFromRow),
          }
        }),
      )
    },
  )

  const filterClauses = (filter: TicketFilter) => [
    ...(filter.statuses === undefined
      ? []
      : [sql.in('status', filter.statuses)]),
    ...(filter.types === undefined ? [] : [sql.in('type', filter.types)]),
    ...(filter.label === undefined
      ? []
      : [
          sql`id IN (SELECT ticket_id FROM labels WHERE label = ${filter.label})`,
        ]),
  ]

  const list: WorkGraphShape['list'] = Effect.fn('WorkGraph.list')(function* (
    filter = {},
  ) {
    const clauses = filterClauses(filter)
    const tickets: Array<Ticket> = []
    let after: Option.Option<TicketRow> = Option.none()
    while (true) {
      const keyset = Option.match(after, {
        onNone: () => [],
        onSome: row => [
          sql`(priority, created_at, id) > (${row.priority}, ${row.created_at}, ${row.id})`,
        ],
      })
      const rows = yield* read(
        'list',
        sql<TicketRow>`SELECT * FROM tickets WHERE ${sql.and([...clauses, ...keyset])} ORDER BY priority, created_at, id LIMIT ${listBatchSize}`,
      )
      for (const row of rows) tickets.push(yield* ticketFromRow(row))
      if (rows.length < listBatchSize) return tickets
      after = Option.fromUndefinedOr(rows.at(-1))
      yield* Effect.yieldNow
    }
  })

  const create: WorkGraphShape['create'] = Effect.fn('WorkGraph.create')(
    function* ({ ticket, actor }) {
      return yield* mutate('create', fileTicket(ticket, actor))
    },
  )

  const update: WorkGraphShape['update'] = Effect.fn('WorkGraph.update')(
    function* ({ id, changes, actor }) {
      const fields = Object.entries(changes)
        .filter(([, value]) => value !== undefined)
        .map(([field]) => field)
      return yield* mutate(
        'update',
        Effect.gen(function* () {
          const ticket = yield* getTicket(id)
          if (!isNonEmpty(fields)) return ticket
          const at = yield* now
          const changed = yield* makeTicket({
            ...ticket,
            ...changes,
            updatedAt: at,
          })
          yield* writeTicket(changed)
          yield* appendEvent({
            ticket: id,
            actor,
            change: { _tag: 'updated', fields },
            at,
          })
          return changed
        }),
      )
    },
  )

  const claim: WorkGraphShape['claim'] = Effect.fn('WorkGraph.claim')(
    function* ({ id, assignee, actor }) {
      return yield* mutate(
        'claim',
        Effect.gen(function* () {
          const claimed = yield* transition({
            id,
            operation: 'claim',
            allowed: ticket => ticket.status === 'open',
            change: () => ({
              status: 'in_progress',
              assignee: Option.some(assignee),
            }),
            event: { _tag: 'claimed', assignee },
            actor,
          })
          const expires = DateTime.addDuration(claimed.updatedAt, leaseTtl)
          yield* sql`INSERT INTO leases ${sql.insert({
            ticket_id: id,
            engine_id: assignee.engine,
            expires_at: DateTime.toEpochMillis(expires),
          })} ON CONFLICT (ticket_id) DO UPDATE SET engine_id = excluded.engine_id, expires_at = excluded.expires_at`
          return claimed
        }),
      )
    },
  )

  const release: WorkGraphShape['release'] = Effect.fn('WorkGraph.release')(
    function* ({ id, actor }) {
      return yield* mutate(
        'release',
        transition({
          id,
          operation: 'release',
          allowed: ticket => ticket.status === 'in_progress',
          change: () => ({ status: 'open', assignee: Option.none() }),
          event: { _tag: 'released' },
          actor,
          lease: 'drop',
        }),
      )
    },
  )

  const closeTicket = (options: {
    readonly id: TicketId
    readonly resolution: Resolution
    readonly reason: Option.Option<string>
    readonly actor: Actor
  }) =>
    transition({
      id: options.id,
      operation: 'close',
      allowed: ticket => ticket.status !== 'closed',
      change: () => ({
        status: 'closed',
        resolution: Option.some(options.resolution),
        closeReason: options.reason,
      }),
      event: { _tag: 'closed', resolution: options.resolution },
      actor: options.actor,
      lease: 'drop',
    })

  const close: WorkGraphShape['close'] = Effect.fn('WorkGraph.close')(
    function* ({ id, resolution, reason, actor }) {
      return yield* mutate(
        'close',
        Effect.gen(function* () {
          const ticket = yield* closeTicket({
            id,
            resolution,
            reason: Option.fromUndefinedOr(reason),
            actor,
          })
          return { ticket, offers: yield* blockedTickets(sql, id) }
        }),
      )
    },
  )

  const closeEpics: WorkGraphShape['closeEpics'] = Effect.fn(
    'WorkGraph.closeEpics',
  )(function* ({ onBase, actor }) {
    // Git is asked before the transaction, so that none is held open while it answers.
    const finished = yield* read('closeEpics', finishedEpics(sql, onBase))
    if (finished.length === 0) return []
    return yield* mutate(
      'closeEpics',
      Effect.map(
        Effect.forEach(finished, epic =>
          closeTicket({
            id: epic.id,
            resolution: 'done',
            reason: Option.some('Its children are closed and merged.'),
            actor,
          }).pipe(
            Effect.map(Option.some),
            // Closed meanwhile: nothing left to do for it.
            Effect.catchTag('TransitionRefused', () =>
              Effect.succeed(Option.none()),
            ),
          ),
        ),
        closed => closed.flatMap(Option.toArray),
      ),
    )
  })

  const reopen: WorkGraphShape['reopen'] = Effect.fn('WorkGraph.reopen')(
    function* ({ id, actor }) {
      return yield* mutate(
        'reopen',
        transition({
          id,
          operation: 'reopen',
          allowed: ticket => ticket.status === 'closed',
          change: () => ({
            status: 'open',
            resolution: Option.none(),
            closeReason: Option.none(),
            assignee: Option.none(),
          }),
          event: { _tag: 'reopened' },
          actor,
        }),
      )
    },
  )

  const defer: WorkGraphShape['defer'] = Effect.fn('WorkGraph.defer')(
    function* ({ id, until, actor }) {
      return yield* mutate(
        'defer',
        transition({
          id,
          operation: 'defer',
          allowed: ticket => ticket.status !== 'closed',
          change: () => ({ status: 'deferred', deferUntil: until }),
          event: { _tag: 'deferred', until },
          actor,
          lease: 'drop',
        }),
      )
    },
  )

  const undefer: WorkGraphShape['undefer'] = Effect.fn('WorkGraph.undefer')(
    function* ({ id, actor }) {
      return yield* mutate(
        'undefer',
        transition({
          id,
          operation: 'undefer',
          allowed: ticket => ticket.status === 'deferred',
          change: () => ({ status: 'open', deferUntil: Option.none() }),
          event: { _tag: 'undeferred' },
          actor,
        }),
      )
    },
  )

  const addDependency: WorkGraphShape['addDependency'] = Effect.fn(
    'WorkGraph.addDependency',
  )(function* ({ edge, actor }) {
    return yield* mutate(
      'addDependency',
      Effect.flatMap(now, at => link(edge, actor, at)),
    )
  })

  const removeDependency: WorkGraphShape['removeDependency'] = Effect.fn(
    'WorkGraph.removeDependency',
  )(function* ({ edge, actor }) {
    return yield* mutate(
      'removeDependency',
      Effect.gen(function* () {
        if (!(yield* edgeExists(edge))) return
        yield* sql`DELETE FROM edges WHERE from_id = ${edge.from} AND to_id = ${edge.to} AND kind = ${edge.kind}`
        yield* appendEvent({
          ticket: edge.from,
          actor,
          change: { _tag: 'unlinked', edge },
          at: yield* now,
        })
      }),
    )
  })

  const label: WorkGraphShape['label'] = Effect.fn('WorkGraph.label')(
    function* ({ id, label, actor }) {
      return yield* mutate(
        'label',
        Effect.gen(function* () {
          yield* requireTicket(id)
          yield* addLabel(id, label, actor, yield* now)
        }),
      )
    },
  )

  const unlabel: WorkGraphShape['unlabel'] = Effect.fn('WorkGraph.unlabel')(
    function* ({ id, label, actor }) {
      return yield* mutate(
        'unlabel',
        Effect.gen(function* () {
          yield* requireTicket(id)
          const present =
            yield* sql`SELECT 1 FROM labels WHERE ticket_id = ${id} AND label = ${label}`
          if (present.length === 0) return
          yield* sql`DELETE FROM labels WHERE ticket_id = ${id} AND label = ${label}`
          yield* appendEvent({
            ticket: id,
            actor,
            change: { _tag: 'unlabelled', label },
            at: yield* now,
          })
        }),
      )
    },
  )

  const note: WorkGraphShape['note'] = Effect.fn('WorkGraph.note')(function* ({
    id,
    body,
    actor,
  }) {
    return yield* mutate(
      'note',
      Effect.gen(function* () {
        yield* requireTicket(id)
        const at = yield* now
        const written = yield* Note.makeEffect({
          id: yield* drawNoteId,
          ticketId: id,
          author: actor,
          body,
          at,
        }).pipe(Effect.mapError(invalid))
        yield* sql`INSERT INTO notes ${sql.insert({
          id: written.id,
          ticket_id: id,
          author: actorColumn(actor),
          body,
          at: DateTime.toEpochMillis(at),
        })}`
        yield* appendEvent({
          ticket: id,
          actor,
          change: { _tag: 'noted', note: written.id },
          at,
        })
        return written
      }),
    )
  })

  const fileDiscovered: WorkGraphShape['fileDiscovered'] = Effect.fn(
    'WorkGraph.fileDiscovered',
  )(function* ({ from, link: kind, ticket, actor }) {
    return yield* mutate(
      'fileDiscovered',
      Effect.gen(function* () {
        yield* requireTicket(from)
        const filed = yield* fileTicket(ticket, actor)
        const edge = yield* makeEdge(
          kind === 'discovered_from'
            ? { from: filed.id, to: from, kind }
            : { from, to: filed.id, kind },
        )
        yield* link(edge, actor, filed.createdAt)
        return filed
      }),
    )
  })

  const ask: WorkGraphShape['ask'] = Effect.fn('WorkGraph.ask')(function* ({
    question,
    actor,
  }) {
    return yield* mutate(
      'ask',
      Effect.gen(function* () {
        const blocked = question.blocks ?? []
        yield* Effect.forEach(blocked, requireTicket, { discard: true })
        const id = yield* freeTicketId
        const at = yield* now
        const asked = yield* Question.makeEffect({
          choices: Option.fromUndefinedOr(question.choices),
          consequential: question.consequential,
          maintainerOnly: question.maintainerOnly,
          answer: Option.none(),
        }).pipe(Effect.mapError(invalid))
        const ticket = yield* makeTicket({
          id,
          type: 'question',
          title: question.title,
          description: Option.fromUndefinedOr(question.description),
          design: Option.none(),
          acceptance: Option.none(),
          status: 'open',
          resolution: Option.none(),
          priority: question.priority ?? 2,
          deferUntil: Option.none(),
          assignee: Option.none(),
          model: Option.none(),
          metadata: emptyMetadata,
          result: Option.none(),
          question: Option.some(asked),
          mergedCommit: Option.none(),
          closeReason: Option.none(),
          createdAt: at,
          updatedAt: at,
        })
        yield* insertTicket(ticket)
        yield* appendEvent({
          ticket: id,
          actor,
          change: { _tag: 'created' },
          at,
        })
        for (const waiting of blocked) {
          yield* link(
            yield* makeEdge({ from: id, to: waiting, kind: 'blocks' }),
            actor,
            at,
          )
        }
        return ticket
      }),
    )
  })

  const answer: WorkGraphShape['answer'] = Effect.fn('WorkGraph.answer')(
    function* ({ id, answer, actor }) {
      return yield* mutate(
        'answer',
        Effect.gen(function* () {
          const ticket = yield* getTicket(id)
          const asked = yield* Option.match(ticket.question, {
            onNone: () =>
              Effect.fail(new NotAQuestion({ id, type: ticket.type })),
            onSome: Effect.succeed,
          })
          const answered = yield* Question.makeEffect({
            ...asked,
            answer: Option.some(answer),
          }).pipe(Effect.mapError(invalid))
          return yield* transition({
            id,
            operation: 'answer',
            allowed: ticket => ticket.status !== 'closed',
            change: () => ({
              status: 'closed',
              resolution: Option.some('answered' as const),
              question: Option.some(answered),
            }),
            event: { _tag: 'answered', answer },
            actor,
            lease: 'drop',
          })
        }),
      )
    },
  )

  const deleteTicket: WorkGraphShape['delete'] = Effect.fn('WorkGraph.delete')(
    function* ({ id, actor }) {
      return yield* mutate(
        'delete',
        Effect.gen(function* () {
          yield* requireTicket(id)
          const at = yield* now
          yield* sql`DELETE FROM labels WHERE ticket_id = ${id}`
          yield* sql`DELETE FROM edges WHERE from_id = ${id} OR to_id = ${id}`
          yield* sql`DELETE FROM notes WHERE ticket_id = ${id}`
          yield* dropLease(id)
          yield* sql`DELETE FROM tickets WHERE id = ${id}`
          yield* sql`INSERT INTO tombstones ${sql.insert({
            id,
            actor: actorColumn(actor),
            at: DateTime.toEpochMillis(at),
          })}`
          yield* appendEvent({
            ticket: id,
            actor,
            change: { _tag: 'deleted' },
            at,
          })
        }),
      )
    },
  )

  const history: WorkGraphShape['history'] = Effect.fn('WorkGraph.history')(
    function* (id) {
      const rows = yield* read(
        'history',
        sql<EventRow>`SELECT * FROM events WHERE ticket_id = ${id} ORDER BY seq`,
      )
      return yield* Effect.forEach(rows, eventFromRow)
    },
  )

  const lastSeq = read(
    'changes',
    Effect.map(
      sql<{
        readonly seq: number | null
      }>`SELECT max(seq) AS seq FROM events`,
      rows => rows[0]?.seq ?? 0,
    ),
  )

  const changes: WorkGraphShape['changes'] = Effect.gen(function* () {
    const cursor = yield* Ref.make(yield* lastSeq)
    const appended = Effect.gen(function* () {
      const after = yield* Ref.get(cursor)
      const rows = yield* read(
        'changes',
        sql<EventRow>`SELECT * FROM events WHERE seq > ${after} ORDER BY seq`,
      )
      const last = rows.at(-1)
      if (last !== undefined) yield* Ref.set(cursor, last.seq)
      return yield* Effect.forEach(rows, eventFromRow)
    })
    const appendedEach = yield* sql.reactiveMailbox(reactivityKeys, appended)
    return Stream.fromQueue(appendedEach).pipe(
      Stream.flatMap(events => Stream.fromIterable<TicketEvent>(events)),
    )
  }).pipe(Effect.withSpan('WorkGraph.changes'))

  return WorkGraph.of({
    ready: Effect.fn('WorkGraph.ready')(function* (options) {
      return yield* read('ready', readyTickets(sql, options))
    }),
    why: Effect.fn('WorkGraph.why')(function* ({ id, ...options }) {
      return yield* read(
        'why',
        Effect.flatMap(getTicket(id), ticket =>
          whyWaiting(sql, ticket, options),
        ),
      )
    }),
    show,
    list,
    create,
    update,
    claim,
    release,
    close,
    closeEpics,
    reopen,
    defer,
    undefer,
    addDependency,
    removeDependency,
    label,
    unlabel,
    note,
    fileDiscovered,
    ask,
    answer,
    delete: deleteTicket,
    history,
    changes,
  })
})

const isNonEmpty = <A>(
  items: ReadonlyArray<A>,
): items is readonly [A, ...Array<A>] => items.length > 0

/** The work graph on the project's database at `filename`, migrated on opening. */
export const layer = (
  options: WorkGraphOptions & { readonly filename: string },
) =>
  Layer.effect(WorkGraph, makeWorkGraph(options)).pipe(
    Layer.provide(storeLayer(options.filename)),
  )
