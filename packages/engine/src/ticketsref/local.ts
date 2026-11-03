import { Data, DateTime, Effect, Option, Schema } from 'effect'
import { Reactivity } from 'effect/reactivity'
import type { SqlError } from 'effect/sql'

import { SqliteClient } from '@effect/sql-sqlite-node'
import {
  type Actor,
  CommitHash,
  Edge,
  type EdgeKind,
  type EngineId,
  type LabelName,
  type Note,
  Ticket,
  type TicketChange,
  TicketId,
} from '@fabrica/contracts'

import { StoreFailed } from '../workgraph/errors'
import {
  type EdgeRow,
  type NoteRow,
  type TicketRow,
  actorColumn,
  changeColumns,
  noteFromRow,
  rowFromTicket,
  ticketFromRow,
} from '../workgraph/rows'
import { reactivityKeys } from '../workgraph/sqlite'
import {
  Clocks,
  type FileEdges,
  type TicketFile,
  type Tombstone,
  clockedFields,
  fieldTexts,
} from './codec'
import { type Hlc, HlcFromString, zero } from './hlc'
import { isOverCap } from './privacy'

// The tickets ref's side in SQLite (spec §11.7): the sync state, the tickets as the store has them now,
// and an import's one transaction. An import writes only what differs, so importing a commit twice
// changes nothing, appends each change's event as every mutation does, and is refused (`LocalMoved`)
// when anything has changed since the state it was merged with was read: it runs again from there.

/** How many tickets a batch reads or writes before it yields (§11.2). */
const batchSize = 200

const decodeClock = Schema.decodeUnknownSync(HlcFromString)
const encodeClock = Schema.encodeSync(HlcFromString)
const encodeClocks = Schema.encodeSync(Clocks)
const decodeClocks = Schema.decodeUnknownOption(Schema.fromJsonString(Clocks))

/** The tickets ref's sync state. */
export interface SyncState {
  readonly engine: EngineId
  readonly lastPushed: Option.Option<CommitHash>
  readonly lastImported: Option.Option<CommitHash>
  /** The last event whose ticket has been compared with the ref. */
  readonly exportedSeq: number
  /** The last clock the engine issued or merged. */
  readonly lastClock: Hlc
  /** The remote last named to the maintainer (§11.7). */
  readonly namedRemote: Option.Option<string>
  /** The export's last warning, so that the same one is recorded once. */
  readonly blocked: Option.Option<string>
}

interface SyncRow {
  readonly engine_id: string
  readonly last_pushed: string | null
  readonly last_imported: string | null
  readonly exported_seq: number
  readonly last_clock: string
  readonly named_remote: string | null
  readonly blocked: string | null
}

/** A ticket as the store has it now, with what its file holds beside it. */
export interface LocalTicket {
  readonly ticket: Ticket
  readonly labels: ReadonlyArray<LabelName>
  readonly edges: FileEdges
  readonly notes: ReadonlyArray<Note>
  /** The clocks of the file last imported or exported for it; none before its first. */
  readonly clocks: Option.Option<Clocks>
}

/** A file of the ref an import skipped: its path and why (§11.7). */
export interface QuarantinedFile {
  readonly path: string
  readonly ticket: Option.Option<TicketId>
  readonly reason: string
}

/** What a merge has to record once its commit is imported. */
export interface PendingChange {
  readonly ticket: TicketId
  readonly change: TicketChange
}

/** What an import writes, in one transaction. */
export interface ImportPlan {
  readonly to: CommitHash
  /** The last event when the state it was merged with was read; none for a rebuild, which replaces what is there. */
  readonly seen: Option.Option<number>
  readonly files: ReadonlyArray<TicketFile>
  readonly tombstones: ReadonlyArray<Tombstone>
  readonly quarantined: ReadonlyArray<QuarantinedFile>
  /** The last clock, past every clock read. */
  readonly lastClock: Hlc
  /** The merges whose commits are in `to`'s history: their pending changes are recorded, the others' dropped. */
  readonly merges: ReadonlyArray<CommitHash>
  /** A rebuild: tickets the ref doesn't have go too, but for those a quarantined file keeps. */
  readonly replace: boolean
}

/** What an import did. */
export interface Applied {
  readonly changed: number
  readonly droppedEdges: ReadonlyArray<Edge>
  readonly cycles: ReadonlyArray<Edge>
}

/** Something changed in the store since the state an import was merged with was read. */
export class LocalMoved extends Data.TaggedError('LocalMoved')<{}> {
  override get message() {
    return 'the work graph changed during a sync'
  }
}

const edgeKinds: ReadonlyArray<EdgeKind> = [
  'blocks',
  'discovered_from',
  'parent',
  'related',
]

const inBatches = <A>(
  items: ReadonlyArray<A>,
): ReadonlyArray<ReadonlyArray<A>> => {
  const batches: Array<ReadonlyArray<A>> = []
  for (let at = 0; at < items.length; at += batchSize)
    batches.push(items.slice(at, at + batchSize))
  return batches
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const isNonEmpty = <A>(
  items: ReadonlyArray<A>,
): items is readonly [A, ...Array<A>] => items.length > 0

/** The sync's reads and writes of the project's database. */
export const makeLocal = Effect.fn('TicketsLocal.make')(function* (
  engine: EngineId,
) {
  const sql = yield* SqliteClient.SqliteClient
  const reactivity = yield* Reactivity.Reactivity
  const engineActor: Actor = { _tag: 'engine', engine }

  const failed = (operation: string) => (error: unknown) =>
    new StoreFailed({ operation, reason: describe(error) })

  const storeError = <A, E>(
    operation: string,
    effect: Effect.Effect<A, E | SqlError.SqlError>,
  ) =>
    Effect.catchTag(effect, 'SqlError', error =>
      Effect.fail(failed(operation)(error)),
    )

  const stateOf = (row: SyncRow): SyncState => ({
    engine,
    lastPushed: Option.flatMap(
      Option.fromNullishOr(row.last_pushed),
      CommitHash.makeOption,
    ),
    lastImported: Option.flatMap(
      Option.fromNullishOr(row.last_imported),
      CommitHash.makeOption,
    ),
    exportedSeq: row.exported_seq,
    lastClock: decodeClock(row.last_clock),
    namedRemote: Option.fromNullishOr(row.named_remote),
    blocked: Option.fromNullishOr(row.blocked),
  })

  /** The sync state; made at first, an engine's ID written over a copied database's. */
  const readState = storeError(
    'reading the sync state',
    Effect.gen(function* () {
      const rows = yield* sql<SyncRow>`SELECT * FROM tickets_sync`
      const row = rows[0]
      if (row === undefined) {
        const fresh = {
          singleton: 1,
          engine_id: engine,
          exported_seq: 0,
          last_clock: encodeClock(zero(engine)),
        }
        yield* sql`INSERT INTO tickets_sync ${sql.insert(fresh)}`
        return stateOf({
          engine_id: engine,
          last_pushed: null,
          last_imported: null,
          exported_seq: 0,
          last_clock: fresh.last_clock,
          named_remote: null,
          blocked: null,
        })
      }
      if (row.engine_id !== engine)
        yield* sql`UPDATE tickets_sync SET engine_id = ${engine}`
      return stateOf(row)
    }),
  )

  const setClock = (clock: Hlc) =>
    storeError(
      'keeping the last clock',
      sql`UPDATE tickets_sync SET last_clock = ${encodeClock(clock)}`,
    ).pipe(Effect.asVoid)

  const setPushed = (commit: CommitHash) =>
    storeError(
      'keeping the last push',
      sql`UPDATE tickets_sync SET last_pushed = ${commit}`,
    ).pipe(Effect.asVoid)

  const lastSeq = storeError(
    'reading the last event',
    Effect.map(
      sql<{ readonly seq: number | null }>`SELECT max(seq) AS seq FROM events`,
      rows => rows[0]?.seq ?? 0,
    ),
  )

  const appendEvent = (ticket: Option.Option<TicketId>, change: TicketChange) =>
    Effect.gen(function* () {
      const { type, payload } = changeColumns(change)
      const at = yield* DateTime.now
      yield* sql`INSERT INTO events ${sql.insert({
        ticket_id: Option.getOrNull(ticket),
        type,
        actor: actorColumn(engineActor),
        payload,
        at: DateTime.toEpochMillis(at),
      })}`
    })

  /** A mutation: one transaction, the reactive queries invalidated once it commits. */
  const mutate = <A, E>(
    operation: string,
    effect: Effect.Effect<A, E | SqlError.SqlError>,
  ) =>
    storeError(
      operation,
      reactivity.mutation(reactivityKeys, sql.withTransaction(effect)),
    )

  /** Names the remote before the first push there, once for each remote (§11.7). */
  const nameRemote = (remote: string, url: string) =>
    mutate(
      'naming the remote',
      Effect.gen(function* () {
        yield* sql`UPDATE tickets_sync SET named_remote = ${remote}`
        yield* appendEvent(Option.none(), {
          _tag: 'ref_remote_named',
          remote,
          url,
        })
      }),
    )

  /** Warns of what blocked the export, once for the same findings; `exportedSeq` stays, so nothing is lost. */
  const warnBlocked = (findings: readonly [string, ...Array<string>]) =>
    mutate(
      'warning of a blocked export',
      Effect.gen(function* () {
        const warning = findings.join('\n')
        const rows = yield* sql<{
          readonly blocked: string | null
        }>`SELECT blocked FROM tickets_sync`
        if (rows[0]?.blocked === warning) return
        yield* sql`UPDATE tickets_sync SET blocked = ${warning}`
        yield* appendEvent(Option.none(), {
          _tag: 'export_blocked',
          findings,
        })
      }),
    )

  /** The tickets with events since `seq`, and whether one was deleted: a deletion changes the files linked to it too. */
  const changedSince = (seq: number) =>
    storeError(
      'reading what changed',
      Effect.map(
        sql<{
          readonly ticket_id: string
          readonly type: string
        }>`SELECT DISTINCT ticket_id, type FROM events WHERE seq > ${seq} AND ticket_id IS NOT NULL`,
        rows => ({
          ids: [
            ...new Set(
              rows.flatMap(row =>
                Option.toArray(TicketId.makeOption(row.ticket_id)),
              ),
            ),
          ],
          deleted: rows.some(row => row.type === 'deleted'),
        }),
      ),
    )

  const allIds = storeError(
    'listing the tickets',
    Effect.map(sql<{ readonly id: string }>`SELECT id FROM tickets`, rows =>
      rows.flatMap(row => Option.toArray(TicketId.makeOption(row.id))),
    ),
  )

  /** The tombstones the store has, each with when it was made. */
  const tombstonesOf = storeError(
    'listing the tombstones',
    Effect.map(
      sql<{
        readonly id: string
        readonly at: number
      }>`SELECT id, at FROM tombstones`,
      rows =>
        new Map(
          rows.flatMap(row =>
            Option.toArray(
              Option.map(
                TicketId.makeOption(row.id),
                (id): readonly [TicketId, number] => [id, row.at],
              ),
            ),
          ),
        ),
    ),
  )

  /** Of the IDs, those the store has a ticket for. */
  const present = (ids: ReadonlyArray<TicketId>) =>
    storeError(
      'reading the tickets',
      Effect.gen(function* () {
        const found = new Set<string>()
        for (const batch of inBatches(ids)) {
          const rows = yield* sql<{
            readonly id: string
          }>`SELECT id FROM tickets WHERE id IN ${sql.in(batch)}`
          for (const row of rows) found.add(row.id)
        }
        return found
      }),
    )

  /** The tickets as the store has them, in batches that yield; IDs it hasn't are left out. */
  const readTickets = (ids: ReadonlyArray<TicketId>) =>
    Effect.gen(function* () {
      const tickets: Array<LocalTicket> = []
      for (const batch of inBatches(ids)) {
        const read = yield* storeError(
          'reading the tickets',
          Effect.gen(function* () {
            const [rows, labels, edges, notes] = yield* Effect.all([
              sql<
                TicketRow & { readonly clocks: string }
              >`SELECT * FROM tickets WHERE id IN ${sql.in(batch)}`,
              sql<{
                readonly ticket_id: string
                readonly label: LabelName
              }>`SELECT ticket_id, label FROM labels WHERE ticket_id IN ${sql.in(batch)}`,
              sql<EdgeRow>`SELECT * FROM edges WHERE from_id IN ${sql.in(batch)}`,
              sql<NoteRow>`SELECT * FROM notes WHERE ticket_id IN ${sql.in(batch)}`,
            ])
            const decodedNotes = yield* Effect.forEach(notes, noteFromRow)
            return yield* Effect.forEach(rows, row =>
              Effect.map(ticketFromRow(row), ticket => ({
                ticket,
                labels: labels
                  .filter(label => label.ticket_id === row.id)
                  .map(label => label.label),
                edges: fileEdges(edges.filter(edge => edge.from_id === row.id)),
                notes: decodedNotes.filter(note => note.ticketId === row.id),
                clocks: decodeClocks(row.clocks),
              })),
            )
          }),
        )
        tickets.push(...read)
        yield* Effect.yieldNow
      }
      return tickets
    })

  /** Records an export made from the store: the commit is what it holds, so only the clocks are written. */
  const recordExport = ({
    commit,
    seq,
    files,
    lastClock,
  }: {
    readonly commit: CommitHash
    readonly seq: number
    readonly files: ReadonlyArray<TicketFile>
    readonly lastClock: Hlc
  }) =>
    storeError(
      'recording an export',
      sql.withTransaction(
        Effect.gen(function* () {
          for (const batch of inBatches(files)) {
            for (const file of batch) {
              const clocks = JSON.stringify(encodeClocks(file.clocks))
              yield* sql`UPDATE tickets SET clocks = ${clocks} WHERE id = ${file.ticket.id}`
            }
            yield* Effect.yieldNow
          }
          yield* sql`UPDATE tickets_sync SET ${sql.update({
            last_imported: commit,
            exported_seq: seq,
            last_clock: encodeClock(lastClock),
            blocked: null,
          })}`
        }),
      ),
    ).pipe(Effect.asVoid)

  /** Marks the events up to `seq` as compared with the ref: none of their tickets differed from it. */
  const recordSeen = (seq: number) =>
    storeError(
      'recording an export',
      sql`UPDATE tickets_sync SET ${sql.update({ exported_seq: seq, blocked: null })}`,
    ).pipe(Effect.asVoid)

  /** Keeps what a merge has to record, before its commit reaches the ref. */
  const keepPending = (
    commit: CommitHash,
    changes: ReadonlyArray<PendingChange>,
  ) =>
    storeError(
      'keeping a merge',
      sql.withTransaction(
        Effect.forEach(
          changes,
          ({ ticket, change }) => {
            const { type, payload } = changeColumns(change)
            return sql`INSERT INTO tickets_sync_pending ${sql.insert({
              commit_hash: commit,
              ticket_id: ticket,
              type,
              payload,
            })}`
          },
          { discard: true },
        ),
      ),
    )

  const dropPending = (commit: CommitHash) =>
    storeError(
      'dropping a merge',
      sql`DELETE FROM tickets_sync_pending WHERE commit_hash = ${commit}`,
    ).pipe(Effect.asVoid)

  const pendingCommits = storeError(
    'reading the merges',
    Effect.map(
      sql<{
        readonly commit_hash: string
      }>`SELECT DISTINCT commit_hash FROM tickets_sync_pending`,
      rows =>
        rows.flatMap(row =>
          Option.toArray(CommitHash.makeOption(row.commit_hash)),
        ),
    ),
  )

  // --- An import -------------------------------------------------------------------------------

  /** Drops what the store keeps of a ticket going: labels, links, notes, its lease, passes and rounds, its row. */
  const removeTicket = (id: TicketId) =>
    Effect.gen(function* () {
      const incoming =
        yield* sql<EdgeRow>`SELECT * FROM edges WHERE to_id = ${id}`
      yield* sql`DELETE FROM labels WHERE ticket_id = ${id}`
      yield* sql`DELETE FROM edges WHERE from_id = ${id} OR to_id = ${id}`
      yield* sql`DELETE FROM notes WHERE ticket_id = ${id}`
      yield* sql`DELETE FROM leases WHERE ticket_id = ${id}`
      yield* sql`DELETE FROM check_own_passes WHERE ticket_id = ${id}`
      yield* sql`DELETE FROM verifier_rounds WHERE ticket_id = ${id}`
      yield* sql`DELETE FROM tickets WHERE id = ${id}`
      yield* appendEvent(Option.some(id), { _tag: 'deleted' })
      return incoming.flatMap(row =>
        Option.toArray(
          Schema.decodeUnknownOption(Edge)({
            from: row.from_id,
            to: row.to_id,
            kind: row.kind,
          }),
        ),
      )
    })

  const applyTombstone = (tombstone: Tombstone, dropped: Array<Edge>) =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT 1 FROM tickets WHERE id = ${tombstone.id}`
      if (rows.length > 0) {
        const incoming = yield* removeTicket(tombstone.id)
        for (const edge of incoming) {
          dropped.push(edge)
          yield* appendEvent(Option.some(edge.from), {
            _tag: 'edge_dropped',
            edge,
          })
        }
      }
      const actor = actorColumn({
        _tag: 'engine',
        engine: tombstone.clock.engine,
      })
      yield* sql`INSERT INTO tombstones ${sql.insert({
        id: tombstone.id,
        actor,
        at: tombstone.clock.wall,
      })} ON CONFLICT (id) DO UPDATE SET actor = excluded.actor, at = excluded.at`
    })

  /** The ticket a file brings in: a result that stays local (§11.7) stays, whatever the ref has. */
  const incoming = (file: TicketFile, ours: Option.Option<Ticket>) =>
    Option.match(ours, {
      onNone: () => Effect.succeed(file.ticket),
      onSome: kept =>
        Option.exists(kept.result, isOverCap)
          ? Ticket.makeEffect({ ...file.ticket, result: kept.result }).pipe(
              Effect.mapError(failed('keeping a large result local')),
            )
          : Effect.succeed(file.ticket),
    })

  /** Writes a ticket's row, labels and notes where they differ; whether anything did. */
  const applyTicket = (file: TicketFile) =>
    Effect.gen(function* () {
      const id = file.ticket.id
      const rows = yield* sql<
        TicketRow & {
          readonly clocks: string
        }
      >`SELECT * FROM tickets WHERE id = ${id}`
      const row = rows[0]
      const ours =
        row === undefined
          ? Option.none<Ticket>()
          : Option.some(yield* ticketFromRow(row))
      const ticket = yield* incoming(file, ours)
      const wanted = yield* rowFromTicket(ticket).pipe(
        Effect.mapError(failed('writing a ticket')),
      )
      const clocks = JSON.stringify(encodeClocks(file.clocks))
      let changed = false
      if (row === undefined) {
        yield* sql`DELETE FROM tombstones WHERE id = ${id}`
        yield* sql`INSERT INTO tickets ${sql.insert({ ...wanted, clocks })}`
        yield* appendEvent(Option.some(id), { _tag: 'created' })
        changed = true
      } else {
        const fields = Option.match(ours, {
          onNone: (): ReadonlyArray<string> => [],
          onSome: kept => differingFields(kept, ticket),
        })
        if (fields.length > 0 || clocks !== row.clocks)
          yield* sql`UPDATE tickets SET ${sql.update({ ...wanted, clocks }, ['id'])} WHERE id = ${id}`
        if (isNonEmpty(fields)) {
          yield* appendEvent(Option.some(id), { _tag: 'updated', fields })
          changed = true
          if (
            ticket.status === 'closed' &&
            Option.exists(ours, kept => kept.status !== 'closed')
          ) {
            yield* sql`DELETE FROM leases WHERE ticket_id = ${id}`
            yield* sql`DELETE FROM check_own_passes WHERE ticket_id = ${id}`
            yield* sql`DELETE FROM verifier_rounds WHERE ticket_id = ${id}`
          }
        }
      }
      const labels = yield* sql<{
        readonly label: LabelName
      }>`SELECT label FROM labels WHERE ticket_id = ${id}`
      const have = new Set<string>(labels.map(each => each.label))
      const want = new Set<string>(file.labels)
      for (const { label } of labels) {
        if (!want.has(label)) {
          yield* sql`DELETE FROM labels WHERE ticket_id = ${id} AND label = ${label}`
          yield* appendEvent(Option.some(id), { _tag: 'unlabelled', label })
          changed = true
        }
      }
      for (const label of file.labels) {
        if (!have.has(label)) {
          yield* sql`INSERT INTO labels ${sql.insert({ ticket_id: id, label })}`
          yield* appendEvent(Option.some(id), { _tag: 'labelled', label })
          changed = true
        }
      }
      const noteRows =
        yield* sql<NoteRow>`SELECT * FROM notes WHERE ticket_id = ${id}`
      const notesHad = new Map(noteRows.map(note => [note.id, note]))
      const wantedNotes = new Set<string>(file.notes.map(note => note.id))
      for (const note of noteRows) {
        if (!wantedNotes.has(note.id)) {
          yield* sql`DELETE FROM notes WHERE id = ${note.id}`
          changed = true
        }
      }
      for (const note of file.notes) {
        const noteRow = {
          id: note.id,
          ticket_id: id,
          author: actorColumn(note.author),
          body: note.body,
          at: DateTime.toEpochMillis(note.at),
        }
        const had = notesHad.get(note.id)
        if (
          had === undefined ||
          had.author !== noteRow.author ||
          had.body !== noteRow.body ||
          had.at !== noteRow.at
        ) {
          yield* sql`INSERT INTO notes ${sql.insert(noteRow)} ON CONFLICT (id) DO UPDATE SET ticket_id = excluded.ticket_id, author = excluded.author, body = excluded.body, at = excluded.at`
          if (had === undefined)
            yield* appendEvent(Option.some(id), {
              _tag: 'noted',
              note: note.id,
            })
          changed = true
        }
      }
      return changed
    })

  /** Whether `from` reaches `to` along `blocks` edges. */
  const blocksReach = (from: TicketId, to: TicketId) =>
    Effect.map(
      sql`WITH RECURSIVE reach(id) AS (
        SELECT ${from}
        UNION
        SELECT edges.to_id FROM edges JOIN reach ON edges.from_id = reach.id WHERE edges.kind = 'blocks'
      ) SELECT 1 FROM reach WHERE id = ${to} LIMIT 1`,
      rows => rows.length > 0,
    )

  /** Rebuilds the edges from a ticket as its file has them, with what an edge to no ticket or closing a cycle comes to. */
  const applyEdges = (
    file: TicketFile,
    dropped: Array<Edge>,
    cycles: Array<Edge>,
  ) =>
    Effect.gen(function* () {
      const id = file.ticket.id
      const rows =
        yield* sql<EdgeRow>`SELECT * FROM edges WHERE from_id = ${id}`
      const key = (to: string, kind: string) => `${kind} ${to}`
      const wanted = new Set(
        edgeKinds.flatMap(kind => file.edges[kind].map(to => key(to, kind))),
      )
      const had = new Set(rows.map(row => key(row.to_id, row.kind)))
      let changed = false
      for (const row of rows) {
        if (!wanted.has(key(row.to_id, row.kind))) {
          yield* sql`DELETE FROM edges WHERE from_id = ${id} AND to_id = ${row.to_id} AND kind = ${row.kind}`
          const edge = yield* Schema.decodeUnknownEffect(Edge)({
            from: row.from_id,
            to: row.to_id,
            kind: row.kind,
          }).pipe(Effect.mapError(failed('reading an edge')))
          yield* appendEvent(Option.some(id), { _tag: 'unlinked', edge })
          changed = true
        }
      }
      for (const kind of edgeKinds) {
        for (const to of file.edges[kind]) {
          if (had.has(key(to, kind))) continue
          const edge = new Edge({ from: id, to, kind })
          const target = yield* sql`SELECT 1 FROM tickets WHERE id = ${to}`
          if (target.length === 0) {
            dropped.push(edge)
            yield* appendEvent(Option.some(id), { _tag: 'edge_dropped', edge })
            continue
          }
          if (kind === 'blocks' && (yield* blocksReach(to, id))) {
            cycles.push(edge)
            yield* appendEvent(Option.some(id), { _tag: 'blocks_cycle', edge })
          }
          yield* sql`INSERT INTO edges ${sql.insert({ from_id: id, to_id: to, kind })}`
          yield* appendEvent(Option.some(id), { _tag: 'linked', edge })
          changed = true
        }
      }
      return changed
    })

  /** The ticket a quarantine event hangs on, where it has one in the store. */
  const quarantineTicket = (file: QuarantinedFile) =>
    Option.match(file.ticket, {
      onNone: () => Effect.succeed(Option.none<TicketId>()),
      onSome: id =>
        Effect.map(sql`SELECT 1 FROM tickets WHERE id = ${id}`, rows =>
          rows.length > 0 ? Option.some(id) : Option.none<TicketId>(),
        ),
    })

  /** Writes an import in one transaction: its files, tombstones and a merge's records, then the commit. */
  const applyImport = Effect.fn('TicketsLocal.applyImport')(function* (
    plan: ImportPlan,
  ) {
    return yield* mutate(
      'importing the tickets ref',
      Effect.gen(function* () {
        if (Option.isSome(plan.seen)) {
          const rows = yield* sql<{
            readonly seq: number | null
          }>`SELECT max(seq) AS seq FROM events`
          if ((rows[0]?.seq ?? 0) !== plan.seen.value)
            return yield* new LocalMoved()
        }
        const dropped: Array<Edge> = []
        const cycles: Array<Edge> = []
        let changed = 0
        if (plan.replace) {
          const keep = new Set<string>([
            ...plan.files.map(file => file.ticket.id),
            ...plan.quarantined.flatMap(file => Option.toArray(file.ticket)),
          ])
          const gone = (yield* sql<{
            readonly id: string
          }>`SELECT id FROM tickets`).flatMap(row =>
            keep.has(row.id) ? [] : Option.toArray(TicketId.makeOption(row.id)),
          )
          for (const id of gone) {
            yield* removeTicket(id)
            changed += 1
          }
        }
        for (const batch of inBatches(plan.tombstones)) {
          for (const tombstone of batch) {
            yield* applyTombstone(tombstone, dropped)
            changed += 1
          }
          yield* Effect.yieldNow
        }
        for (const batch of inBatches(plan.files)) {
          for (const file of batch) if (yield* applyTicket(file)) changed += 1
          yield* Effect.yieldNow
        }
        for (const batch of inBatches(plan.files)) {
          for (const file of batch)
            if (yield* applyEdges(file, dropped, cycles)) changed += 1
          yield* Effect.yieldNow
        }
        for (const file of plan.quarantined) {
          yield* appendEvent(yield* quarantineTicket(file), {
            _tag: 'quarantined',
            file: file.path,
            reason: file.reason,
          })
        }
        const pending = yield* sql<{
          readonly commit_hash: string
          readonly ticket_id: string
          readonly type: string
          readonly payload: string
        }>`SELECT commit_hash, ticket_id, type, payload FROM tickets_sync_pending ORDER BY seq`
        const merged = new Set<string>(plan.merges)
        const at = DateTime.toEpochMillis(yield* DateTime.now)
        for (const row of pending) {
          if (!merged.has(row.commit_hash)) continue
          yield* sql`INSERT INTO events ${sql.insert({
            ticket_id: row.ticket_id,
            type: row.type,
            actor: actorColumn(engineActor),
            payload: row.payload,
            at,
          })}`
        }
        if (pending.length > 0) yield* sql`DELETE FROM tickets_sync_pending`
        const last = yield* sql<{
          readonly seq: number | null
        }>`SELECT max(seq) AS seq FROM events`
        yield* sql`UPDATE tickets_sync SET ${sql.update({
          last_imported: plan.to,
          exported_seq: last[0]?.seq ?? 0,
          last_clock: encodeClock(plan.lastClock),
          blocked: null,
        })}`
        const applied: Applied = { changed, droppedEdges: dropped, cycles }
        return applied
      }),
    )
  })

  return {
    readState,
    setClock,
    setPushed,
    lastSeq,
    nameRemote,
    warnBlocked,
    changedSince,
    allIds,
    tombstones: tombstonesOf,
    present,
    readTickets,
    recordExport,
    recordSeen,
    keepPending,
    dropPending,
    pendingCommits,
    applyImport,
  }
})

export type Local = Effect.Success<ReturnType<typeof makeLocal>>

/** A ticket's edges from its rows, by kind. */
const fileEdges = (rows: ReadonlyArray<EdgeRow>): FileEdges => {
  const toKind = (kind: EdgeKind) =>
    rows.flatMap(row =>
      row.kind === kind ? Option.toArray(TicketId.makeOption(row.to_id)) : [],
    )
  return {
    blocks: toKind('blocks'),
    discovered_from: toKind('discovered_from'),
    parent: toKind('parent'),
    related: toKind('related'),
  }
}

/** The fields of a ticket that differ, by name; its two times by theirs. */
const differingFields = (
  ours: Ticket,
  theirs: Ticket,
): ReadonlyArray<string> => {
  const a = fieldTexts(ours)
  const b = fieldTexts(theirs)
  return [
    ...clockedFields.filter(field => a[field] !== b[field]),
    ...(DateTime.Equivalence(ours.createdAt, theirs.createdAt)
      ? []
      : ['createdAt']),
    ...(DateTime.Equivalence(ours.updatedAt, theirs.updatedAt)
      ? []
      : ['updatedAt']),
  ]
}
