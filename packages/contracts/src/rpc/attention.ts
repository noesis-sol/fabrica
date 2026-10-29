import { Match, Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import { PermissionId, ProjectId, SessionId, TicketId } from '../ids'
import { SetAsideReason } from '../phases'
import { QuestionChoices, Text } from '../ticket'
import { ClientName, Count, Moment, optional } from './common'
import { ProjectNotFound } from './errors'
import { applyKeyedPatch, keyedPatch, resume, streamItem } from './stream'

// The Attention group (spec §8.1, §15.1): what waits on the maintainer, as every client lists it, and
// their answers. The first answer wins (§8.5): a later one is told who answered and when.

/** A permission request's call, rendered for its tool and shown whole, never cut off (§15.1, H62). */
export const PermissionShown = Schema.TaggedUnion({
  /** A command, as its lines. */
  command: { lines: Schema.NonEmptyArray(Schema.String) },
  /** An edit, as its diff. */
  edit: { path: Text, diff: Schema.String },
  /** A write, as its path and content. */
  write: { path: Text, content: Schema.String },
  /** Any other tool: its arguments. */
  call: { input: Schema.Json },
}).annotate({ identifier: 'PermissionShown' })
export type PermissionShown = typeof PermissionShown.Type

/** Something waiting on the maintainer. */
export const AttentionRequest = Schema.TaggedUnion({
  /** A question (§15.1): shown with its own title, the tickets waiting on it and its options. */
  question: {
    project: ProjectId,
    ticket: TicketId,
    title: Text,
    description: Schema.OptionFromNullOr(Schema.String),
    /** None: filed without options; a talk drafts them. */
    choices: Schema.OptionFromNullOr(QuestionChoices),
    consequential: Schema.Boolean,
    maintainerOnly: Schema.Boolean,
    blocks: Schema.Array(TicketId),
    askedFrom: Schema.OptionFromNullOr(TicketId),
    openedAt: Moment,
  },
  /** A permission request from the gate (§12.6). */
  permission: {
    project: ProjectId,
    id: PermissionId,
    ticket: TicketId,
    session: SessionId,
    tool: Text,
    input: Schema.Json,
    shown: PermissionShown,
    why: Text,
    openedAt: Moment,
  },
  /** A maintainer task (H52), done when the maintainer closes it. */
  task: { project: ProjectId, ticket: TicketId, title: Text, openedAt: Moment },
  /** A ticket set aside for review (§18.3). */
  review: {
    project: ProjectId,
    ticket: TicketId,
    title: Text,
    reason: SetAsideReason,
    openedAt: Moment,
  },
}).annotate({ identifier: 'AttentionRequest' })
export type AttentionRequest = typeof AttentionRequest.Type

/** Which request: a permission request by its ID, the others by their ticket. */
export const AttentionRef = Schema.TaggedUnion({
  question: { project: ProjectId, ticket: TicketId },
  permission: { project: ProjectId, id: PermissionId },
  task: { project: ProjectId, ticket: TicketId },
  review: { project: ProjectId, ticket: TicketId },
}).annotate({ identifier: 'AttentionRef' })
export type AttentionRef = typeof AttentionRef.Type

/** A request's key: the same for a request and its ref. */
export const attentionKey = (ref: AttentionRequest | AttentionRef): string =>
  Match.valueTags(ref, {
    question: ({ project, ticket }) => `question:${project}:${ticket}`,
    permission: ({ project, id }) => `permission:${project}:${id}`,
    task: ({ project, ticket }) => `task:${project}:${ticket}`,
    review: ({ project, ticket }) => `review:${project}:${ticket}`,
  })

/** A question's answer: one of its options, by index, or the maintainer's own words. */
export const QuestionAnswer = Schema.TaggedUnion({
  option: { index: Count },
  text: { text: Text },
})
export type QuestionAnswer = typeof QuestionAnswer.Type

/** A permission request's answer (§15.1). */
export const PermissionDecision = Schema.TaggedUnion({
  allow_once: {},
  /** A run-scoped rule. */
  allow_run: {},
  refuse: { note: Schema.OptionFromNullOr(Text) },
})
export type PermissionDecision = typeof PermissionDecision.Type

/** An answer, carrying the ID of what it answers. */
export const AttentionAnswer = Schema.TaggedUnion({
  question: { project: ProjectId, ticket: TicketId, answer: QuestionAnswer },
  permission: {
    project: ProjectId,
    id: PermissionId,
    decision: PermissionDecision,
  },
})
export type AttentionAnswer = typeof AttentionAnswer.Type

/** Who answered, and when. */
export class Answered extends Schema.Class<Answered>('Answered')({
  by: ClientName,
  at: Moment,
}) {}

/** A request that left the list: answered or closed, by whom where someone did. */
export class AttentionClosed extends Schema.Class<AttentionClosed>(
  'AttentionClosed',
)({
  ref: AttentionRef,
  by: Schema.OptionFromNullOr(ClientName),
  at: Moment,
}) {}

/** Another answer came first (§8.5). */
export class AlreadyAnswered extends Schema.TaggedError<AlreadyAnswered>()(
  'AlreadyAnswered',
  { by: ClientName, at: Moment },
) {}

/** No such open request. */
export class AttentionNotFound extends Schema.TaggedError<AttentionNotFound>()(
  'AttentionNotFound',
  { ref: AttentionRef },
) {}

/** The option index isn't one of the question's options. */
export class InvalidAnswer extends Schema.TaggedError<InvalidAnswer>()(
  'InvalidAnswer',
  { reason: Text },
) {}

/** The patch to the open requests. */
export const AttentionPatch = keyedPatch(AttentionRequest, AttentionClosed)

/** `requests` with `patch` applied. */
export const applyAttentionPatch = (
  requests: ReadonlyArray<AttentionRequest>,
  patch: typeof AttentionPatch.Type,
): ReadonlyArray<AttentionRequest> =>
  applyKeyedPatch(requests, patch, {
    of: attentionKey,
    gone: ({ ref }) => attentionKey(ref),
  })

export const AttentionRpcs = RpcGroup.make(
  /** Every project's requests, or one project's. */
  Rpc.make('attention.list', {
    payload: { project: optional(ProjectId) },
    success: Schema.Array(AttentionRequest),
    error: ProjectNotFound,
  }),
  Rpc.make('attention.answer', {
    payload: { answer: AttentionAnswer },
    success: Answered,
    error: Schema.Union([AlreadyAnswered, AttentionNotFound, InvalidAnswer]),
  }),
  Rpc.make('attention.watch', {
    payload: { project: optional(ProjectId), resume },
    success: streamItem(Schema.Array(AttentionRequest), AttentionPatch),
    error: ProjectNotFound,
    stream: true,
  }),
)
