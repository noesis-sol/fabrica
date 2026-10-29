import { Schema } from 'effect'

// Branded IDs (spec §6, Code rules). A value of one of these types is made only through its
// schema, where it is read or drawn: `TicketId.make(text)` (throws when the text isn't one),
// `TicketId.makeOption(text)`, `TicketId.makeEffect(text)`, or by decoding with the schema.
// Functions taking several of them take them by name.

/** Text with no whitespace and at least one character: the form of every opaque ID. */
const Opaque = Schema.String.check(Schema.isPattern(/^\S+$/))

/** A ticket's ID: `<prefix>-<short hash>`, e.g. `fa-a1b2`; its children `<parent>.<n>` (spec §11.2). */
export const TicketId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?:\.[1-9][0-9]*)*$/),
).pipe(Schema.brand('TicketId'))
export type TicketId = typeof TicketId.Type

/** A git commit's full hash, lower-case hex: SHA-1 (40 digits) or SHA-256 (64). */
export const CommitHash = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
).pipe(Schema.brand('CommitHash'))
export type CommitHash = typeof CommitHash.Type

/** A worker's or a talk's Pi session. */
export const SessionId = Opaque.pipe(Schema.brand('SessionId'))
export type SessionId = typeof SessionId.Type

/** One message of a session's transcript. */
export const MessageId = Opaque.pipe(Schema.brand('MessageId'))
export type MessageId = typeof MessageId.Type

/** A project registered with an engine. */
export const ProjectId = Opaque.pipe(Schema.brand('ProjectId'))
export type ProjectId = typeof ProjectId.Type

/** One run of a project. */
export const RunId = Opaque.pipe(Schema.brand('RunId'))
export type RunId = typeof RunId.Type

/** An engine, as hybrid logical clocks and run leases name it (spec §11). */
export const EngineId = Opaque.pipe(Schema.brand('EngineId'))
export type EngineId = typeof EngineId.Type
