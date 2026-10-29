import { Data, type Duration } from 'effect'

import type { TicketId } from '@fabrica/contracts'

import type { ExitStatus, StartFailure } from '../process'

// What can go wrong driving an agent (spec §12.1, §12.8). Each is a tagged union made by its
// constructors: a caller matches the reason, never the wording.

/** Why a command sent to an agent didn't get its answer. */
export type SendFailure = Data.TaggedEnum<{
  /** The session is closing: the command was never sent (H75; tutti-763l). */
  Closing: {}
  /** Pi has exited, or closed its stdin: the command wasn't taken, or its answer never came. */
  Exited: {}
  /** No answer came within the limit (H61). */
  NoAnswer: { readonly limit: Duration.Duration }
  /** Pi answered that the command failed. */
  Refused: { readonly error: string }
  /** Pi's answer lacked a field the engine reads. */
  Unreadable: {}
}>
export const SendFailure = Data.taggedEnum<SendFailure>()

/** A command sent to a ticket's agent failed. */
export class AgentSendFailed extends Data.TaggedError('AgentSendFailed')<{
  readonly ticket: TicketId
  /** The command, as Pi names it (`prompt`, `steer`, …). */
  readonly command: string
  readonly reason: SendFailure
}> {
  override get message() {
    return `${this.ticket}: ${this.command} failed (${this.reason._tag})`
  }
}

/** Why an agent didn't start. */
export type AgentStartFailure = Data.TaggedEnum<{
  /** A session of the ticket is starting or open (H75): one session at a time. */
  Busy: {}
  /** The session was closed while it started. */
  Cancelled: {}
  /** Its session or configuration folder couldn't be made. */
  Folders: { readonly message: string }
  /** Pi, or its reaper, couldn't be started. */
  Spawn: { readonly reason: StartFailure }
  /** Pi exited before its handshake; the end of what it wrote on stderr. */
  Exited: { readonly status: ExitStatus; readonly stderr: string }
  /** Pi didn't answer the handshake (or the resume) as it should. */
  Handshake: { readonly command: string; readonly reason: SendFailure }
}>
export const AgentStartFailure = Data.taggedEnum<AgentStartFailure>()

/** A ticket's agent couldn't be started (spec §12.8's `StartFailed`); nothing of it is left. */
export class AgentStartFailed extends Data.TaggedError('AgentStartFailed')<{
  readonly ticket: TicketId
  readonly reason: AgentStartFailure
}> {
  override get message() {
    return `${this.ticket}: the agent didn't start (${this.reason._tag})`
  }
}
