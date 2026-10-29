import { Data, Exit, Option, Schema } from 'effect'

// The records Pi writes in RPC mode (spec §12.1, H61), as Pi 1.4.0's rpc-types.ts and agent-session.ts
// give them, each decoded with a schema before the engine reads it. A schema asks only for the fields
// the engine reads, so a field Pi drops or adds that the engine doesn't need changes nothing; a record
// of a kind not listed here, or one missing a field the engine reads, is skipped, never fatal.

const optional = Schema.optionalKey

/** Pi's answer to a command, matched to it by `id`. */
export const PiResponse = Schema.Struct({
  type: Schema.Literal('response'),
  id: optional(Schema.String),
  command: Schema.String,
  success: Schema.Boolean,
  data: optional(Schema.Unknown),
  error: optional(Schema.String),
})
export type PiResponse = typeof PiResponse.Type

/** An extension's request for an answer from a UI; the engine has none, so a dialog is cancelled. */
export const PiUiRequest = Schema.Struct({
  type: Schema.Literal('extension_ui_request'),
  id: Schema.String,
  method: Schema.String,
})
export type PiUiRequest = typeof PiUiRequest.Type

/** The methods of an extension's UI request that wait on an answer. */
export const DIALOG_METHODS: ReadonlySet<string> = new Set([
  'select',
  'confirm',
  'input',
  'editor',
])

/** A model response's tokens and cost, as the provider's final event gave them (spec §12.2). */
export const PiUsage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  totalTokens: Schema.Number,
  cost: Schema.Struct({ total: Schema.Number }),
})
export type PiUsage = typeof PiUsage.Type

/** A transcript message as the engine reads it: who wrote it and, for a model's, which model and what it cost. */
export const PiMessage = Schema.Struct({
  role: Schema.String,
  provider: optional(Schema.String),
  model: optional(Schema.String),
  usage: optional(PiUsage),
})
export type PiMessage = typeof PiMessage.Type

const kind = <
  const Kind extends string,
  const Fields extends Schema.Struct.Fields,
>(
  type: Kind,
  fields: Fields,
) => Schema.Struct({ type: Schema.Literal(type), ...fields })

/** The events of an agent's session the engine reads; any other kind is skipped. */
export const PiEvent = Schema.Union([
  kind('agent_start', {}),
  kind('agent_end', { willRetry: optional(Schema.Boolean) }),
  kind('turn_start', {}),
  kind('turn_end', {}),
  kind('message_start', { message: PiMessage }),
  kind('message_update', {}),
  kind('message_end', { message: PiMessage }),
  kind('tool_execution_start', {
    toolCallId: Schema.String,
    toolName: Schema.String,
  }),
  kind('tool_execution_update', {
    toolCallId: Schema.String,
    toolName: Schema.String,
  }),
  kind('tool_execution_end', {
    toolCallId: Schema.String,
    toolName: Schema.String,
    isError: Schema.Boolean,
  }),
  /** The agent has settled: its turn is over, and nothing more will run until it is sent a command. */
  kind('agent_settled', { aborted: Schema.Boolean }),
  kind('compaction_start', { reason: Schema.String }),
  kind('compaction_end', { reason: Schema.String, aborted: Schema.Boolean }),
  kind('auto_retry_start', {
    attempt: Schema.Number,
    maxAttempts: Schema.Number,
    errorMessage: Schema.String,
  }),
  kind('auto_retry_end', { success: Schema.Boolean, attempt: Schema.Number }),
  kind('extension_error', {
    extensionPath: Schema.String,
    event: Schema.String,
    error: Schema.String,
  }),
])
export type PiEvent = typeof PiEvent.Type

/** The kinds of event `PiEvent` reads. */
export const EVENT_KINDS: ReadonlySet<string> = new Set(
  PiEvent.members.map(member => member.fields.type.literal),
)

/** `get_state`'s answer, the handshake's: the session Pi opened. */
export const PiState = Schema.Struct({
  sessionId: Schema.String,
  sessionFile: optional(Schema.String),
})

/** A disposition of a prompt or a steer: run at once, queued behind the running turn, or handled by an extension. */
export const PiDisposition = Schema.Struct({
  disposition: Schema.Literals(['started', 'queued', 'handled']),
})
export type Disposition = (typeof PiDisposition.Type)['disposition']

/** `switch_session`'s answer: whether an extension cancelled the switch. */
export const PiSwitched = Schema.Struct({ cancelled: Schema.Boolean })

/** `fork`'s answer: the forked message's text, and whether an extension cancelled the fork. */
export const PiForked = Schema.Struct({
  text: Schema.String,
  cancelled: Schema.Boolean,
})
export type Forked = typeof PiForked.Type

/** `get_session_stats`'s answer, as far as the engine reads it. */
export const PiSessionStats = Schema.Struct({
  sessionId: Schema.String,
  sessionFile: optional(Schema.String),
  userMessages: Schema.Number,
  assistantMessages: Schema.Number,
  toolCalls: Schema.Number,
  totalMessages: Schema.Number,
  tokens: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
    total: Schema.Number,
  }),
  cost: Schema.Number,
})
export type SessionStats = typeof PiSessionStats.Type

/** What one line of Pi's stdout came to. */
export type PiRecord = Data.TaggedEnum<{
  Response: { readonly response: PiResponse }
  UiRequest: { readonly request: PiUiRequest }
  Event: { readonly event: PiEvent }
  /** Skipped: its kind and why, logged once for each pair. */
  Skipped: { readonly kind: string; readonly reason: SkipReason }
}>
export const PiRecord = Data.taggedEnum<PiRecord>()

/** Why a line was skipped. */
export type SkipReason =
  | 'not JSON'
  | 'no kind'
  | 'unknown kind'
  | 'missing fields'

const Envelope = Schema.Struct({ type: Schema.String })

const decodeEnvelope = Schema.decodeUnknownOption(Envelope)
const decodeResponse = Schema.decodeUnknownExit(PiResponse)
const decodeUiRequest = Schema.decodeUnknownExit(PiUiRequest)
const decodeEvent = Schema.decodeUnknownExit(PiEvent)

const parseJson = (line: string): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(line))
  } catch {
    return Option.none()
  }
}

/** One line of Pi's stdout, decoded. */
export const readRecord = (line: string): PiRecord => {
  const json = parseJson(line)
  if (Option.isNone(json))
    return PiRecord.Skipped({ kind: '(none)', reason: 'not JSON' })
  const envelope = decodeEnvelope(json.value)
  if (Option.isNone(envelope))
    return PiRecord.Skipped({ kind: '(none)', reason: 'no kind' })
  const { type } = envelope.value
  const missing = PiRecord.Skipped({ kind: type, reason: 'missing fields' })
  if (type === 'response')
    return Exit.match(decodeResponse(json.value), {
      onSuccess: response => PiRecord.Response({ response }),
      onFailure: () => missing,
    })
  if (type === 'extension_ui_request')
    return Exit.match(decodeUiRequest(json.value), {
      onSuccess: request => PiRecord.UiRequest({ request }),
      onFailure: () => missing,
    })
  if (!EVENT_KINDS.has(type))
    return PiRecord.Skipped({ kind: type, reason: 'unknown kind' })
  return Exit.match(decodeEvent(json.value), {
    onSuccess: event => PiRecord.Event({ event }),
    onFailure: () => missing,
  })
}
