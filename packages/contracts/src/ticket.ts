import { Option, Schema } from 'effect'

import { CommitHash, EngineId, NoteId, SessionId, TicketId } from './ids'

// The work graph's vocabulary (spec §11.2): a ticket, its labels, edges, notes and events. Rows of the
// local store and the RPC protocol decode into these; the same types reach the UI unchanged. A value
// the store keeps as NULL is an `Option` here, encoded as `null`; times are `DateTime.Utc`, encoded as
// milliseconds since the epoch. Tags and literals are written as the spec writes them, snake_case.

/** Text with something in it besides whitespace. */
export const Text = Schema.String.check(Schema.isPattern(/\S/u))

/** Text on one line. */
export const Line = Text.check(
  Schema.isPattern(/^[^\n\r]*$/u, { expected: 'one line' }),
)

/** A moment, encoded as milliseconds since the epoch, as the store keeps it. */
const Moment = Schema.DateTimeUtcFromMillis

/** What a ticket is. Epics are never dispatched; questions and manual tickets are the maintainer's (§2.1). */
export const TicketType = Schema.Literals([
  'task',
  'bug',
  'feature',
  'chore',
  'epic',
  'question',
  'manual',
])
export type TicketType = typeof TicketType.Type

export const TicketStatus = Schema.Literals([
  'open',
  'in_progress',
  'deferred',
  'closed',
])
export type TicketStatus = typeof TicketStatus.Type

/** How a closed ticket ended. */
export const Resolution = Schema.Literals([
  'done',
  'no_change',
  'cancelled',
  'superseded',
  'answered',
])
export type Resolution = typeof Resolution.Type

/** 0 (most urgent) to 4 (backlog). */
export const Priority = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 4 }),
)
export type Priority = typeof Priority.Type

/** A per-ticket model override: `<provider>/<model>`, with the provider's thinking level where it takes one (§12.5). */
export const ModelOverride = Schema.String.check(
  Schema.isPattern(/^[^/\s]+\/\S+$/u),
)
export type ModelOverride = typeof ModelOverride.Type

/** A label: one word, such as `solo` or an area label. */
export const LabelName = Schema.String.check(Schema.isPattern(/^\S+$/u))
export type LabelName = typeof LabelName.Type

/** The organs, one-shot advisers that file notes and questions (§16). */
export const OrganName = Schema.Literals([
  'triage',
  'predictor',
  'reviewer',
  'scout',
  'breakdown',
])
export type OrganName = typeof OrganName.Type

/** Who changed the work graph: the maintainer through a client, a worker's or a talk's session, an organ, the engine (§11.2). */
export const Actor = Schema.TaggedUnion({
  maintainer: {},
  worker: { session: SessionId },
  talk: { session: SessionId },
  organ: { organ: OrganName },
  engine: { engine: EngineId },
})
export type Actor = typeof Actor.Type

/** A claim: the engine holding the run lease and its worker's session (§11.5). */
export class Assignee extends Schema.Class<Assignee>('Assignee')({
  engine: EngineId,
  session: SessionId,
}) {}

/**
 * A finished ticket's hand-off (§13.5): a summary, plus the fields of its kind. Tickets depending on
 * it get it in their first prompt and through `get_ticket`.
 */
export const TicketResult = Schema.TaggedUnion({
  summary: { summary: Text },
  /** A contract other code relies on changed: a schema, an RPC, a module's interface. */
  contract_changed: {
    summary: Text,
    contracts: Schema.NonEmptyArray(Text),
    breaking: Schema.Boolean,
  },
  /** A migration was added: its name, as the migrations list it. */
  migration_added: { summary: Text, migration: Text },
  /** A decision was recorded: the decision, in a sentence. */
  decision_recorded: { summary: Text, decision: Text },
})
export type TicketResult = typeof TicketResult.Type

/** The result a ticket finishes with, named in its metadata (`result_kind`); one per case of `TicketResult`. */
export const ResultKind = Schema.Literals([
  'summary',
  'contract_changed',
  'migration_added',
  'decision_recorded',
])
export type ResultKind = typeof ResultKind.Type

/** The metadata keys the engine reads. */
const metadataFields = {
  /** The files it will change: its footprint (§13.4). */
  files: Schema.OptionFromOptionalKey(Schema.Array(Text)),
  /** The spec it is part of. */
  spec: Schema.OptionFromOptionalKey(Text),
  /** The files the predictor expects it to change, when it names none (§16). */
  predicted_files: Schema.OptionFromOptionalKey(Schema.Array(Text)),
  result_kind: Schema.OptionFromOptionalKey(ResultKind),
}

/** Any other key: the rest record leaves the engine's keys to their fields, so their decoded values aren't checked as JSON. */
const OtherMetadataKey = Schema.String.check(
  Schema.makeFilter((key: string) =>
    Object.hasOwn(metadataFields, key) ? "one of the engine's keys" : undefined,
  ),
)

/**
 * A ticket's metadata, a JSON object: the keys the engine reads, each optional, and any others kept
 * as they are (an import's, a project's own).
 */
export const TicketMetadata = Schema.StructWithRest(
  Schema.Struct(metadataFields),
  [Schema.Record(OtherMetadataKey, Schema.Unknown)],
)
export type TicketMetadata = typeof TicketMetadata.Type

/** One of a question's options: a short label and a one-line trade-off (§12.3). */
export class QuestionOption extends Schema.Class<QuestionOption>(
  'QuestionOption',
)({
  label: Line.annotate({ description: 'A short label.' }),
  tradeOff: Line.annotate({ description: 'Its trade-off, in one line.' }),
}) {}

/** A question's options, 2 to 4, and the index of the one recommended. */
export class QuestionChoices extends Schema.Class<QuestionChoices>(
  'QuestionChoices',
)(
  Schema.Struct({
    options: Schema.Array(QuestionOption)
      .check(Schema.isBetweenLength(2, 4))
      .annotate({ description: '2 to 4 options.' }),
    recommended: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: 'The index, from 0, of the option recommended.',
    }),
  }).check(
    Schema.makeFilter(({ options, recommended }) =>
      recommended < options.length
        ? undefined
        : {
            path: ['recommended'],
            issue: `the recommended option must be one of the ${options.length} options`,
          },
    ),
  ),
) {}

/**
 * What only a question has (§15). A question filed without options has none, and a talk drafts
 * them. `consequential`: its options would close, cancel, defer or freeze work, or change a recorded
 * decision, so it is never answered in a batch (§15.2). `maintainerOnly`: it asks the maintainer to
 * approve something done in their name, so nothing answers it for them (§15.1).
 */
export class Question extends Schema.Class<Question>('Question')({
  choices: Schema.OptionFromNullOr(QuestionChoices),
  consequential: Schema.Boolean,
  maintainerOnly: Schema.Boolean,
  answer: Schema.OptionFromNullOr(Text),
}) {}

/** An item of the work graph (§11.2). A ticket has a `question` exactly when it is of type `question`. */
export class Ticket extends Schema.Class<Ticket>('Ticket')(
  Schema.Struct({
    id: TicketId,
    type: TicketType,
    title: Text,
    description: Schema.OptionFromNullOr(Schema.String),
    design: Schema.OptionFromNullOr(Schema.String),
    acceptance: Schema.OptionFromNullOr(Schema.String),
    status: TicketStatus,
    resolution: Schema.OptionFromNullOr(Resolution),
    priority: Priority,
    deferUntil: Schema.OptionFromNullOr(Moment),
    assignee: Schema.OptionFromNullOr(Assignee),
    model: Schema.OptionFromNullOr(ModelOverride),
    metadata: TicketMetadata,
    result: Schema.OptionFromNullOr(TicketResult),
    question: Schema.OptionFromNullOr(Question),
    /** Set by the merge queue. */
    mergedCommit: Schema.OptionFromNullOr(CommitHash),
    closeReason: Schema.OptionFromNullOr(Schema.String),
    createdAt: Moment,
    updatedAt: Moment,
  }).check(
    Schema.makeFilter(({ type, question }) =>
      (type === 'question') === Option.isSome(question)
        ? undefined
        : {
            path: ['question'],
            issue:
              type === 'question'
                ? 'a question must have its question'
                : `a ticket of type ${type} has no question`,
          },
    ),
  ),
) {}

/** A label on a ticket. */
export class Label extends Schema.Class<Label>('Label')({
  ticketId: TicketId,
  label: LabelName,
}) {}

/**
 * How two tickets are linked: `from` blocks `to`; `from` is the parent of `to`; `from` was
 * discovered from `to`; `from` and `to` are related.
 */
export const EdgeKind = Schema.Literals([
  'blocks',
  'parent',
  'discovered_from',
  'related',
])
export type EdgeKind = typeof EdgeKind.Type

/** A link between two tickets; a ticket is never linked to itself. */
export class Edge extends Schema.Class<Edge>('Edge')(
  Schema.Struct({
    from: TicketId,
    to: TicketId,
    kind: EdgeKind,
  }).check(
    Schema.makeFilter(({ from, to }) =>
      from === to
        ? { path: ['to'], issue: 'a ticket is never linked to itself' }
        : undefined,
    ),
  ),
) {}

/** An edge in words: `fa-a1b2 blocks fa-c3d4`. */
export const edgeWords = (edge: Edge): string => {
  switch (edge.kind) {
    case 'blocks':
      return `${edge.from} blocks ${edge.to}`
    case 'parent':
      return `${edge.from} is the parent of ${edge.to}`
    case 'discovered_from':
      return `${edge.from} was discovered from ${edge.to}`
    case 'related':
      return `${edge.from} is related to ${edge.to}`
  }
}

/** A note on a ticket. */
export class Note extends Schema.Class<Note>('Note')({
  id: NoteId,
  ticketId: TicketId,
  author: Actor,
  body: Text,
  at: Moment,
}) {}

/** What a mutation of the work graph did: an event's `type` is its tag, its `payload` the rest. */
export const TicketChange = Schema.TaggedUnion({
  created: {},
  /** Plain fields changed, by name. */
  updated: { fields: Schema.NonEmptyArray(Text) },
  claimed: { assignee: Assignee },
  released: {},
  closed: { resolution: Resolution },
  reopened: {},
  deferred: { until: Schema.OptionFromNullOr(Moment) },
  undeferred: {},
  linked: { edge: Edge },
  unlinked: { edge: Edge },
  labelled: { label: LabelName },
  unlabelled: { label: LabelName },
  noted: { note: NoteId },
  answered: { answer: Text },
  /** Deleted, leaving a tombstone (§11.7). */
  deleted: {},
  /** A field both sides of a sync changed; the later clock's value was kept (§11.7). */
  merge_conflict: { field: Text, ours: Schema.Json, theirs: Schema.Json },
})
export type TicketChange = typeof TicketChange.Type

/** One row of the work graph's history: every mutation appends one, with its actor (§11.2). */
export class TicketEvent extends Schema.Class<TicketEvent>('TicketEvent')({
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  ticketId: Schema.OptionFromNullOr(TicketId),
  actor: Schema.OptionFromNullOr(Actor),
  change: TicketChange,
  at: Moment,
}) {}
