import { Schema } from 'effect'

import { Tokens } from '../events'
import { MessageId, ToolCallId } from '../ids'
import { Text } from '../ticket'
import { Moment } from './common'
import { streamItem } from './stream'

// A session's transcript, a worker's or a talk's (spec §8.3, §18.4), as it happens: messages, streamed
// text and thinking, tool calls (their input streamed, then whole) and their output. Tokens and tool
// output are batched before they cross, one flush per `stream_flush`; a snapshot holds the entries so
// far, a patch those since.

/** Who wrote a message. */
export const MessageRole = Schema.Literals(['user', 'assistant', 'engine'])
export type MessageRole = typeof MessageRole.Type

/** One entry of a transcript. */
export const TranscriptEntry = Schema.TaggedUnion({
  /** A message begun, with its text so far. */
  message: {
    id: MessageId,
    role: MessageRole,
    text: Schema.String,
    at: Moment,
  },
  /** More of a message's text. */
  text: { message: MessageId, delta: Schema.String },
  /** More of a message's thinking. */
  thinking: { message: MessageId, delta: Schema.String },
  /**
   * More of a tool call's input, as the model streams it: never drawn (§18.5), the call shown by its
   * tool alone until its `tool_call` brings the input whole.
   */
  tool_input: { id: ToolCallId, tool: Text, delta: Schema.String },
  /** A tool call, its input whole (§18.5: never drawn until it is). */
  tool_call: { id: ToolCallId, tool: Text, input: Schema.Json, at: Moment },
  /** More of a tool call's output. */
  tool_output: { id: ToolCallId, chunk: Schema.String },
  tool_end: { id: ToolCallId, ok: Schema.Boolean, at: Moment },
  /** A turn ended, with what it spent. */
  turn_end: { at: Moment, tokens: Schema.OptionFromNullOr(Tokens) },
}).annotate({ identifier: 'TranscriptEntry' })
export type TranscriptEntry = typeof TranscriptEntry.Type

/** A transcript's stream items. */
export const TranscriptItem = streamItem(
  Schema.Array(TranscriptEntry),
  Schema.Array(TranscriptEntry),
)
export type TranscriptItem = typeof TranscriptItem.Type
