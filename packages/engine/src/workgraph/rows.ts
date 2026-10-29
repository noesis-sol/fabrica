import { Effect, Schema, SchemaIssue } from 'effect'

import {
  Actor,
  Edge,
  Note,
  Ticket,
  TicketChange,
  TicketEvent,
  TreeHash,
} from '@fabrica/contracts'

import { InvalidTicket, StoreFailed } from './errors'

// How the store's rows map to the contracts' classes (spec §11.2): a row is the class's encoded form,
// flattened into columns, its JSON columns as text. Every row read decodes through the class's schema.

/** A `tickets` row, as SQLite gives it. */
export type TicketRow = {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly description: string | null
  readonly design: string | null
  readonly acceptance: string | null
  readonly status: string
  readonly resolution: string | null
  readonly priority: number
  readonly defer_until: number | null
  readonly assignee: string | null
  readonly model: string | null
  readonly metadata: string
  readonly result: string | null
  readonly options: string | null
  readonly recommended: number | null
  readonly consequential: number | null
  readonly maintainer_only: number | null
  readonly answer: string | null
  readonly merged_commit: string | null
  readonly close_reason: string | null
  readonly created_at: number
  readonly updated_at: number
}

/** A `notes` row. */
export type NoteRow = {
  readonly id: string
  readonly ticket_id: string
  readonly author: string
  readonly body: string
  readonly at: number
}

/** An `edges` row. */
export type EdgeRow = {
  readonly from_id: string
  readonly to_id: string
  readonly kind: string
}

/** An `events` row. */
export type EventRow = {
  readonly seq: number
  readonly ticket_id: string | null
  readonly type: string
  readonly actor: string | null
  readonly payload: string | null
  readonly at: number
}

const json = (text: string | null): unknown =>
  text === null ? null : JSON.parse(text)

const text = (value: unknown): string | null =>
  value === null ? null : JSON.stringify(value)

const flag = (value: number | null): boolean | null =>
  value === null ? null : value === 1

/** Decodes a row through `schema`, after `toEncoded` has unflattened it; a row that fails is a corrupt store. */
const decodeRow =
  <S extends Schema.Decoder<unknown>>(schema: S, table: string) =>
  <Row extends { readonly [key: string]: unknown }>(
    row: Row,
    toEncoded: (row: Row) => unknown,
  ): Effect.Effect<S['Type'], StoreFailed> =>
    Effect.try({
      try: () => toEncoded(row),
      catch: cause => cause,
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(
        cause =>
          new StoreFailed({
            operation: `reading ${table}`,
            reason: `a row (${JSON.stringify(row)}) doesn't decode: ${String(cause)}`,
          }),
      ),
    )

const decodeTicketRow = decodeRow(Ticket, 'tickets')

/** A ticket, from its row. */
export const ticketFromRow = (
  row: TicketRow,
): Effect.Effect<Ticket, StoreFailed> =>
  decodeTicketRow(row, row => ({
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    design: row.design,
    acceptance: row.acceptance,
    status: row.status,
    resolution: row.resolution,
    priority: row.priority,
    deferUntil: row.defer_until,
    assignee: json(row.assignee),
    model: row.model,
    metadata: json(row.metadata),
    result: json(row.result),
    question:
      row.type === 'question'
        ? {
            choices:
              row.options === null
                ? null
                : { options: json(row.options), recommended: row.recommended },
            consequential: flag(row.consequential),
            maintainerOnly: flag(row.maintainer_only),
            answer: row.answer,
          }
        : null,
    mergedCommit: row.merged_commit,
    closeReason: row.close_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))

const encodeTicket = Schema.encodeEffect(Ticket)

/** A ticket's row, every column but `clocks`; a ticket its schema refuses is invalid. */
export const rowFromTicket = (
  ticket: Ticket,
): Effect.Effect<TicketRow, InvalidTicket> =>
  encodeTicket(ticket).pipe(
    Effect.mapError(error => new InvalidTicket({ issue: error.message })),
    Effect.map(encoded => ({
      id: encoded.id,
      type: encoded.type,
      title: encoded.title,
      description: encoded.description,
      design: encoded.design,
      acceptance: encoded.acceptance,
      status: encoded.status,
      resolution: encoded.resolution,
      priority: encoded.priority,
      defer_until: encoded.deferUntil,
      assignee: text(encoded.assignee),
      model: encoded.model,
      metadata: JSON.stringify(encoded.metadata),
      result: text(encoded.result),
      options: text(encoded.question?.choices?.options ?? null),
      recommended: encoded.question?.choices?.recommended ?? null,
      consequential:
        encoded.question === null
          ? null
          : encoded.question.consequential
            ? 1
            : 0,
      maintainer_only:
        encoded.question === null
          ? null
          : encoded.question.maintainerOnly
            ? 1
            : 0,
      answer: encoded.question?.answer ?? null,
      merged_commit: encoded.mergedCommit,
      close_reason: encoded.closeReason,
      created_at: encoded.createdAt,
      updated_at: encoded.updatedAt,
    })),
  )

/**
 * The ticket the props make, checked by its schema: what a mutation writes. A change that leaves it
 * invalid (a blank title) is refused before anything is written.
 */
export const makeTicket = (
  props: ConstructorParameters<typeof Ticket>[0],
): Effect.Effect<Ticket, InvalidTicket> =>
  Ticket.makeEffect(props).pipe(Effect.mapError(invalid))

const formatIssue = SchemaIssue.makeFormatterDefault()

/** A schema's refusal of a value the work graph was to write. */
export const invalid = (issue: SchemaIssue.Issue): InvalidTicket =>
  new InvalidTicket({ issue: formatIssue(issue) })

const decodeNoteRow = decodeRow(Note, 'notes')

/** A note, from its row. */
export const noteFromRow = (row: NoteRow): Effect.Effect<Note, StoreFailed> =>
  decodeNoteRow(row, row => ({
    id: row.id,
    ticketId: row.ticket_id,
    author: json(row.author),
    body: row.body,
    at: row.at,
  }))

const decodeEdgeRow = decodeRow(Edge, 'edges')

/** An edge, from its row. */
export const edgeFromRow = (row: EdgeRow): Effect.Effect<Edge, StoreFailed> =>
  decodeEdgeRow(row, row => ({
    from: row.from_id,
    to: row.to_id,
    kind: row.kind,
  }))

const decodeEventRow = decodeRow(TicketEvent, 'events')

/** An event, from its row: its `type` is the change's tag, its `payload` the rest. */
export const eventFromRow = (
  row: EventRow,
): Effect.Effect<TicketEvent, StoreFailed> =>
  decodeEventRow(row, row => ({
    seq: row.seq,
    ticketId: row.ticket_id,
    actor: json(row.actor),
    change: {
      ...(row.payload === null ? {} : JSON.parse(row.payload)),
      _tag: row.type,
    },
    at: row.at,
  }))

/** A row of `check_own_passes`, as read for its tree. */
export type CheckOwnPassRow = {
  readonly tree: string
}

const decodePassRow = decodeRow(TreeHash, 'check_own_passes')

/** The tree a pass ran on, from its row. */
export const treeFromPassRow = (
  row: CheckOwnPassRow,
): Effect.Effect<TreeHash, StoreFailed> => decodePassRow(row, row => row.tree)

const encodeActor = Schema.encodeSync(Actor)
const encodeChange = Schema.encodeSync(TicketChange)

/** An actor's column: its encoded form, as JSON. */
export const actorColumn = (actor: Actor): string =>
  JSON.stringify(encodeActor(actor))

/** A change's `type` and `payload` columns. */
export const changeColumns = (
  change: TicketChange,
): { readonly type: string; readonly payload: string } => {
  const { _tag, ...payload } = encodeChange(change)
  return { type: _tag, payload: JSON.stringify(payload) }
}
