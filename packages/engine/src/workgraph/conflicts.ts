import { Array, Option, Schema } from 'effect'

import {
  Line,
  type Ticket,
  TicketChange,
  type TicketChanges,
  TicketConflict,
  type TicketEvent,
  type TicketId,
} from '@fabrica/contracts'

import {
  type ClockedField,
  type TicketFields,
  canonicalJson,
  clockedFields,
  fieldTexts,
  fieldsWith,
} from '../ticketsref/codec'
import { StatusChange, statusChangeOf } from './status-change'

// A sync's open merge conflicts (spec §11.4, §11.7), from the work graph's events: each field a merge
// resolved, until it is superseded. A later event that changes the field supersedes its conflict, as
// "use the other value" does, a later merge's conflict on it among them; so does the field holding
// neither side's value, and the ticket's deletion. Which side the merge kept is the one the ticket
// holds, so only a field the ticket's file holds, one with a clock, has a conflict to list.
// An event says what it can change, not whether it did: deferring a deferred ticket ends a conflict on
// its status too, as the event can't tell it from a real defer (fab-6u4).

/** The fields of a ticket an event changes, by the name the merge's conflicts give them. */
const fieldsChangedBy = (change: TicketChange): ReadonlyArray<string> =>
  TicketChange.match<ReadonlyArray<string>>(change, {
    created: () => [],
    updated: ({ fields }) => fields,
    claimed: () => ['status', 'assignee', 'deferUntil'],
    released: () => ['status', 'assignee'],
    closed: () => ['status', 'resolution', 'closeReason'],
    reopened: () => ['status', 'resolution', 'closeReason', 'assignee'],
    deferred: () => ['status', 'deferUntil'],
    undeferred: () => ['status', 'deferUntil'],
    linked: () => [],
    unlinked: () => [],
    labelled: () => [],
    unlabelled: () => [],
    noted: () => [],
    answered: () => ['question', 'status', 'resolution'],
    deleted: () => [],
    merge_conflict: ({ field }) => [field],
  })

/** `changes` to a status or a time to defer until, where `tickets.update` would make them of `ticket`. */
const ifItMoves = (
  ticket: Ticket,
  changes: Pick<TicketChanges, 'status' | 'deferUntil'>,
): Option.Option<TicketChanges> =>
  StatusChange.$match(
    statusChangeOf({ id: ticket.id, current: ticket.status, ...changes }),
    {
      None: () => Option.none(),
      Refused: () => Option.none(),
      Reopen: () => Option.some(changes),
      Undefer: () => Option.some(changes),
      Defer: () => Option.some(changes),
    },
  )

/**
 * What `tickets.update` takes to set `field` of `ticket` to its value in `fields`; none where it can't
 * set it, a status or a time it would refuse or leave as it is among them.
 */
const changesFor = (
  ticket: Ticket,
  field: ClockedField,
  fields: TicketFields,
): Option.Option<TicketChanges> => {
  switch (field) {
    case 'title':
      return Schema.is(Line)(fields.title)
        ? Option.some({ title: fields.title })
        : Option.none()
    case 'description':
      return Option.some({ description: fields.description })
    case 'design':
      return Option.some({ design: fields.design })
    case 'acceptance':
      return Option.some({ acceptance: fields.acceptance })
    case 'priority':
      return Option.some({ priority: fields.priority })
    case 'status':
      return fields.status === 'open' || fields.status === 'deferred'
        ? // Named with its time, as a status alone would defer it with none, and no conflict on that.
          ifItMoves(
            ticket,
            fields.status === 'deferred'
              ? { status: fields.status, deferUntil: ticket.deferUntil }
              : { status: fields.status },
          )
        : Option.none()
    case 'deferUntil':
      return ifItMoves(ticket, { deferUntil: fields.deferUntil })
    case 'model':
      return Option.some({ model: fields.model })
    case 'metadata':
      return Option.some({ metadata: fields.metadata })
    case 'type':
    case 'resolution':
    case 'assignee':
    case 'result':
    case 'question':
    case 'mergedCommit':
    case 'closeReason':
      return Option.none()
  }
}

/** A `merge_conflict` event, with its place in the log. */
interface Recorded {
  readonly seq: number
  readonly ticket: TicketId
  readonly field: string
  readonly ours: Schema.Json
  readonly theirs: Schema.Json
}

/** `recorded` as a conflict of `ticket`, where the field is one the ticket still holds a side of. */
const conflictOf = (
  ticket: Ticket,
  { seq, field: named, ours, theirs }: Recorded,
): Option.Option<TicketConflict> =>
  Option.flatMap(
    Array.findFirst(clockedFields, field => field === named),
    field => {
      const held = fieldTexts(ticket)[field]
      const sides =
        held === canonicalJson(ours)
          ? Option.some({ kept: ours, other: theirs })
          : held === canonicalJson(theirs)
            ? Option.some({ kept: theirs, other: ours })
            : Option.none()
      return Option.map(
        sides,
        ({ kept, other }) =>
          new TicketConflict({
            seq,
            ticket: ticket.id,
            field,
            kept,
            other,
            useOther: Option.flatMap(fieldsWith(ticket, field, other), fields =>
              changesFor(ticket, field, fields),
            ),
          }),
      )
    },
  )

/**
 * The conflicts still open among `events`, every event of the tickets that have one, in order, and
 * `tickets`, those of them the graph still has: oldest first.
 */
export const openConflicts = ({
  events,
  tickets,
}: {
  readonly events: ReadonlyArray<TicketEvent>
  readonly tickets: ReadonlyArray<Ticket>
}): ReadonlyArray<TicketConflict> => {
  const keyOf = (ticket: TicketId, field: string) => `${ticket}\n${field}`
  const open = new Map<string, Recorded>()
  for (const { seq, ticketId, change } of events) {
    if (Option.isNone(ticketId)) continue
    const ticket = ticketId.value
    for (const field of fieldsChangedBy(change)) {
      open.delete(keyOf(ticket, field))
    }
    if (change._tag === 'merge_conflict') {
      open.set(keyOf(ticket, change.field), {
        seq,
        ticket,
        field: change.field,
        ours: change.ours,
        theirs: change.theirs,
      })
    }
  }
  const byId = new Map(tickets.map(ticket => [ticket.id, ticket]))
  return Array.getSomes(
    [...open.values()].map(recorded =>
      Option.flatMap(
        Option.fromUndefinedOr(byId.get(recorded.ticket)),
        ticket => conflictOf(ticket, recorded),
      ),
    ),
  )
}
