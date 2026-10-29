import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import { NoteId, ProjectId, TicketId } from '../ids'
import { HoldBack, SetAsideReason } from '../phases'
import {
  Edge,
  LabelName,
  Line,
  ModelOverride,
  Note,
  Priority,
  Resolution,
  Text,
  Ticket,
  TicketMetadata,
  TicketStatus,
  TicketType,
} from '../ticket'
import { Count, Moment, optional } from './common'
import { ProjectNotFound, Refused, TicketNotFound } from './errors'
import { keyedPatch, resume, streamItem } from './stream'

// The Backlog group (spec §8.1, §11): the work graph's tickets, read and changed through the engine,
// what is ready and why the rest isn't, a Beads import (§11.6), and the stream of its changes.

/** Which tickets `tickets.list` gives: every one when nothing is named. */
export const TicketFilter = Schema.Struct({
  status: optional(Schema.NonEmptyArray(TicketStatus)),
  type: optional(Schema.NonEmptyArray(TicketType)),
  labels: optional(Schema.NonEmptyArray(LabelName)),
  /** Children of this ticket. */
  parent: optional(TicketId),
})
export type TicketFilter = typeof TicketFilter.Type

/** A ticket whole: its labels, links and notes with it. */
export class TicketDetail extends Schema.Class<TicketDetail>('TicketDetail')({
  ticket: Ticket,
  labels: Schema.Array(LabelName),
  edges: Schema.Array(Edge),
  notes: Schema.Array(Note),
}) {}

/** A ticket to file. */
export const NewTicket = Schema.Struct({
  type: TicketType,
  title: Line,
  description: optional(Schema.String),
  design: optional(Schema.String),
  acceptance: optional(Schema.String),
  priority: optional(Priority),
  labels: optional(Schema.Array(LabelName)),
  parent: optional(TicketId),
  metadata: optional(TicketMetadata),
  model: optional(ModelOverride),
})
export type NewTicket = typeof NewTicket.Type

/** A field to clear (`null`) or set; left out, it stays. */
const change = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(Schema.OptionFromNullOr(schema))

/** Changes to a ticket's fields: what is left out stays as it is. */
export const TicketChanges = Schema.Struct({
  title: Schema.optionalKey(Line),
  description: change(Schema.String),
  design: change(Schema.String),
  acceptance: change(Schema.String),
  priority: Schema.optionalKey(Priority),
  /** Reopen a closed ticket, defer one, or undefer it. */
  status: Schema.optionalKey(Schema.Literals(['open', 'deferred'])),
  deferUntil: change(Moment),
  model: change(ModelOverride),
  metadata: Schema.optionalKey(TicketMetadata),
})
export type TicketChanges = typeof TicketChanges.Type

/** One thing that keeps a ticket from being ready (§13.3, §13.4), in the log's words where it has them. */
export const NotReady = Schema.TaggedUnion({
  closed: {},
  /** Claimed: a worker is at it. */
  in_progress: {},
  deferred: { until: Schema.OptionFromNullOr(Moment) },
  /** Epics, questions and maintainer tasks are never dispatched. */
  not_dispatched: { type: Schema.Literals(['epic', 'question', 'manual']) },
  /** A `blocks` blocker not closed. */
  blocked: { by: TicketId, status: TicketStatus },
  /** A blocker closed but not merged (`CLOSED_UNMERGED`). */
  closed_unmerged: { by: TicketId },
  /** The ticket it was filed from isn't merged. */
  filed_from_unmerged: { ticket: TicketId },
  set_aside: { reason: SetAsideReason },
  /** Ready, held back in the run by something besides a slot. */
  held_back: { reason: HoldBack, detail: Text },
}).annotate({ identifier: 'NotReady' })
export type NotReady = typeof NotReady.Type

/** A reason a ticket isn't ready, with the words the log and the console say it in (H81). */
export class NotReadyReason extends Schema.Class<NotReadyReason>(
  'NotReadyReason',
)({
  reason: NotReady,
  words: Text,
}) {}

/** `tickets.why`'s answer. */
export const Why = Schema.TaggedUnion({
  ready: {},
  not_ready: { reasons: Schema.NonEmptyArray(NotReadyReason) },
})
export type Why = typeof Why.Type

/** A ticket the project had that an import changed, and the fields it changed. */
export class ImportedChange extends Schema.Class<ImportedChange>(
  'ImportedChange',
)({
  ticket: TicketId,
  fields: Schema.NonEmptyArray(Text),
}) {}

/** What a Beads import did. */
export class Imported extends Schema.Class<Imported>('Imported')({
  created: Count,
  /** Tickets the project had, merged as a sync merges them (§11.4). */
  merged: Count,
  /** The merged tickets the import changed; importing the same file again changes none. */
  changed: Schema.Array(ImportedChange),
  /** What the file had that the import left out, in words: a link of a kind the work graph lacks, a link to a ticket of another project. */
  dropped: Schema.Array(Text),
}) {}

/** The Beads file was refused: every problem with it. */
export class ImportFailed extends Schema.TaggedError<ImportFailed>()(
  'ImportFailed',
  { problems: Schema.NonEmptyArray(Text) },
) {}

const inProject = Schema.Union([ProjectNotFound, TicketNotFound, Refused])

/** The patch to the backlog: a deleted ticket by its ID. */
export const BacklogPatch = keyedPatch(Ticket, TicketId)

/** The backlog stream's items: every ticket, then patches. */
export const BacklogItem = streamItem(Schema.Array(Ticket), BacklogPatch)
export type BacklogItem = typeof BacklogItem.Type

export const BacklogRpcs = RpcGroup.make(
  Rpc.make('tickets.list', {
    payload: { project: ProjectId, filter: TicketFilter },
    success: Schema.Array(Ticket),
    error: ProjectNotFound,
  }),
  Rpc.make('tickets.show', {
    payload: { project: ProjectId, ticket: TicketId },
    success: TicketDetail,
    error: Schema.Union([ProjectNotFound, TicketNotFound]),
  }),
  Rpc.make('tickets.create', {
    payload: { project: ProjectId, ticket: NewTicket },
    success: Schema.Struct({ id: TicketId }),
    error: inProject,
  }),
  Rpc.make('tickets.update', {
    payload: { project: ProjectId, ticket: TicketId, changes: TicketChanges },
    error: inProject,
  }),
  Rpc.make('tickets.close', {
    payload: {
      project: ProjectId,
      ticket: TicketId,
      resolution: Resolution,
      reason: optional(Text),
    },
    error: inProject,
  }),
  Rpc.make('tickets.dep.add', {
    payload: { project: ProjectId, edge: Edge },
    error: inProject,
  }),
  Rpc.make('tickets.dep.remove', {
    payload: { project: ProjectId, edge: Edge },
    error: inProject,
  }),
  Rpc.make('tickets.label', {
    payload: {
      project: ProjectId,
      ticket: TicketId,
      add: Schema.Array(LabelName),
      remove: Schema.Array(LabelName),
    },
    error: inProject,
  }),
  Rpc.make('tickets.note', {
    payload: { project: ProjectId, ticket: TicketId, body: Text },
    success: Schema.Struct({ id: NoteId }),
    error: inProject,
  }),
  Rpc.make('tickets.ready', {
    payload: { project: ProjectId },
    success: Schema.Array(Ticket),
    error: ProjectNotFound,
  }),
  Rpc.make('tickets.why', {
    payload: { project: ProjectId, ticket: TicketId },
    success: Why,
    error: Schema.Union([ProjectNotFound, TicketNotFound]),
  }),
  /** A `bd export` JSONL file's text: the client reads it, so a remote engine needn't. */
  Rpc.make('tickets.import', {
    payload: { project: ProjectId, beads: Schema.String },
    success: Imported,
    error: Schema.Union([ProjectNotFound, ImportFailed]),
  }),
  Rpc.make('tickets.watch', {
    payload: { project: ProjectId, resume },
    success: BacklogItem,
    error: ProjectNotFound,
    stream: true,
  }),
)
