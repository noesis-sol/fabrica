import { Schema } from 'effect'

// Branded IDs (spec §6, Code rules). A value of one of these types is made only through its
// schema, where it is read or drawn: `TicketId.make(text)` (throws when the text isn't one),
// `TicketId.makeOption(text)`, `TicketId.makeEffect(text)`, or by decoding with the schema.
// Functions taking several of them take them by name.

/** Text with no whitespace and at least one character: the form of every opaque ID. */
const Opaque = Schema.String.check(Schema.isPattern(/^\S+$/u))

/** A ticket's ID: `<prefix>-<short hash>`, e.g. `fa-a1b2`; its children `<parent>.<n>` (spec §11.2). */
export const TicketId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?:\.[1-9][0-9]*)*$/u),
).pipe(Schema.brand('TicketId'))
export type TicketId = typeof TicketId.Type

/** A git commit's full hash, lower-case hex: SHA-1 (40 digits) or SHA-256 (64). */
export const CommitHash = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
).pipe(Schema.brand('CommitHash'))
export type CommitHash = typeof CommitHash.Type

/** A git tree's full hash, in a commit's form: what a check ran on, HEAD's tree with the uncommitted and untracked files (spec §13.6). */
export const TreeHash = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
).pipe(Schema.brand('TreeHash'))
export type TreeHash = typeof TreeHash.Type

/** A note on a ticket; notes from two engines merge as a union by this ID (spec §11.4). */
export const NoteId = Opaque.pipe(Schema.brand('NoteId'))
export type NoteId = typeof NoteId.Type

/** A worker's or a talk's Pi session. */
export const SessionId = Opaque.pipe(Schema.brand('SessionId'))
export type SessionId = typeof SessionId.Type

/** One message of a session's transcript. */
export const MessageId = Opaque.pipe(Schema.brand('MessageId'))
export type MessageId = typeof MessageId.Type

/** A talk the engine runs with the maintainer (spec §15.4). */
export const TalkId = Opaque.pipe(Schema.brand('TalkId'))
export type TalkId = typeof TalkId.Type

/** A permission request from the gate (spec §12.6, §15.1); an answer carries it. */
export const PermissionId = Opaque.pipe(Schema.brand('PermissionId'))
export type PermissionId = typeof PermissionId.Type

/** One tool call in a session's transcript, as Pi names it. */
export const ToolCallId = Opaque.pipe(Schema.brand('ToolCallId'))
export type ToolCallId = typeof ToolCallId.Type

/** A project registered with an engine. */
export const ProjectId = Opaque.pipe(Schema.brand('ProjectId'))
export type ProjectId = typeof ProjectId.Type

/** One run of a project. */
export const RunId = Opaque.pipe(Schema.brand('RunId'))
export type RunId = typeof RunId.Type

/** An engine, as hybrid logical clocks and run leases name it (spec §11). */
export const EngineId = Opaque.pipe(Schema.brand('EngineId'))
export type EngineId = typeof EngineId.Type
