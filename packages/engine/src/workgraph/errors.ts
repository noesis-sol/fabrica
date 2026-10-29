import { Data } from 'effect'

import type {
  Edge,
  TicketId,
  TicketStatus,
  TicketType,
} from '@fabrica/contracts'

// What the work graph refuses, and what can go wrong in its store (spec §11.1, §11.2).

/** No ticket has the ID: never filed, or deleted. */
export class TicketNotFound extends Data.TaggedError('TicketNotFound')<{
  readonly id: TicketId
}> {
  override get message() {
    return `no ticket ${this.id}`
  }
}

/** A `blocks` or `parent` edge that would close a cycle (§11.2). */
export class EdgeCycle extends Data.TaggedError('EdgeCycle')<{
  readonly edge: Edge
}> {
  override get message() {
    return `${this.edge.from} ${this.edge.kind} ${this.edge.to} would close a cycle; refused`
  }
}

/** An operation the ticket's status doesn't allow: claiming a closed ticket, reopening an open one. */
export class TransitionRefused extends Data.TaggedError('TransitionRefused')<{
  readonly id: TicketId
  readonly operation: string
  readonly status: TicketStatus
}> {
  override get message() {
    return `can't ${this.operation} ${this.id}: it is ${this.status.replace('_', ' ')}`
  }
}

/** An answer given to a ticket that isn't a question. */
export class NotAQuestion extends Data.TaggedError('NotAQuestion')<{
  readonly id: TicketId
  readonly type: TicketType
}> {
  override get message() {
    return `${this.id} is a ${this.type}, not a question`
  }
}

/** A ticket a change would leave invalid, as the contracts' schema says: a blank title, a priority past 4. */
export class InvalidTicket extends Data.TaggedError('InvalidTicket')<{
  readonly issue: string
}> {
  override get message() {
    return `invalid ticket: ${this.issue}`
  }
}

/** The ticket ID prefix can't start a ticket ID: lower-case letters and digits, words joined by `-`. */
export class InvalidPrefix extends Data.TaggedError('InvalidPrefix')<{
  readonly prefix: string
}> {
  override get message() {
    return `${JSON.stringify(this.prefix)} isn't a ticket ID prefix: lower-case letters and digits, starting with a letter`
  }
}

/** The database failed a query, or holds a row its schema doesn't decode. */
export class StoreFailed extends Data.TaggedError('StoreFailed')<{
  readonly operation: string
  readonly reason: string
}> {
  override get message() {
    return `work graph ${this.operation}: ${this.reason}`
  }
}

/** The database was migrated by a newer engine; this one refuses to open it (§11.2). */
export class DatabaseTooNew extends Data.TaggedError('DatabaseTooNew')<{
  readonly filename: string
  readonly found: number
  readonly known: number
}> {
  override get message() {
    return `${this.filename} is at schema version ${this.found}, newer than this engine's ${this.known}; update the engine`
  }
}

/** A migration, or the backup before it, failed; the database is as it was. */
export class MigrationFailed extends Data.TaggedError('MigrationFailed')<{
  readonly filename: string
  readonly reason: string
}> {
  override get message() {
    return `migrating ${this.filename} failed: ${this.reason}`
  }
}
