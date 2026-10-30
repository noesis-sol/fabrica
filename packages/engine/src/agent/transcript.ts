import { DateTime, Effect, Option, Ref, Schema } from 'effect'

import {
  MessageId,
  Text,
  type Tokens,
  ToolCallId,
  TranscriptEntry,
} from '@fabrica/contracts'

import { drawBase36 } from '../workgraph/ids'
import type { PiEvent, PiUsage } from './records'

// A session's transcript as it happens (spec §8.3, §18.4), read from its agent's events: the model's
// messages with their streamed text and thinking, its tool calls with their input as the model writes
// it (never drawn, §18.5), then whole, and their output, and each turn's end with what it spent. A
// turn ends when the agent settles, so one turn holds every model call and tool call a prompt led to.
// The maintainer's and the engine's messages are the caller's to write: Pi's echo of a prompt is not
// read.

/** A model's streamed event, as far as the transcript reads it. */
const StreamedEvent = Schema.Struct({
  type: Schema.String,
  delta: Schema.optionalKey(Schema.String),
})

/** A tool call's input streamed, as far as the transcript reads it: the call is the message's part at `contentIndex`. */
const ToolCallDelta = Schema.Struct({
  type: Schema.Literal('toolcall_delta'),
  contentIndex: Schema.Number,
  delta: Schema.String,
  partial: Schema.Struct({ content: Schema.Array(Schema.Unknown) }),
})

/** The tool call a message's part is, as far as the transcript reads it. */
const PartialToolCall = Schema.Struct({
  type: Schema.Literal('toolCall'),
  id: Schema.String,
  name: Schema.String,
})

/** A tool's result, as far as the transcript reads it: its text parts. */
const ToolResult = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optionalKey(Schema.String),
    }),
  ),
})

const decodeStreamed = Schema.decodeUnknownOption(StreamedEvent)
const decodeToolCallDelta = Schema.decodeUnknownOption(ToolCallDelta)
const decodePartialToolCall = Schema.decodeUnknownOption(PartialToolCall)
const decodeToolResult = Schema.decodeUnknownOption(ToolResult)
const decodeJson = Schema.decodeUnknownOption(Schema.Json)

/** The text of a tool's result: its text parts, one after another. */
const resultText = (result: unknown): string =>
  Option.match(decodeToolResult(result), {
    onNone: () => '',
    onSome: ({ content }) =>
      content
        .flatMap(part => (part.type === 'text' ? [part.text ?? ''] : []))
        .join(''),
  })

/** The `tool_input` a streamed event is: more of a tool call's input, where it names the call and its tool. */
const toolInputOf = (streamed: unknown): Option.Option<TranscriptEntry> =>
  Option.gen(function* () {
    const { contentIndex, delta, partial } =
      yield* decodeToolCallDelta(streamed)
    const call = yield* decodePartialToolCall(partial.content[contentIndex])
    const id = yield* ToolCallId.makeOption(call.id)
    const tool = yield* Option.liftPredicate(call.name, Schema.is(Text))
    if (delta === '') return yield* Option.none()
    return TranscriptEntry.cases.tool_input.make({ id, tool, delta })
  })

/** A turn's tokens so far, with one more model response's. */
const addUsage = (tokens: Option.Option<Tokens>, usage: PiUsage): Tokens => {
  const sum = Option.getOrElse(tokens, () => ({
    input: 0,
    output: 0,
    cache_write: 0,
    cache_read: 0,
  }))
  return {
    input: sum.input + usage.input,
    output: sum.output + usage.output,
    cache_write: sum.cache_write + usage.cacheWrite,
    cache_read: sum.cache_read + usage.cacheRead,
  }
}

interface ReaderState {
  /** The model's message being streamed. */
  readonly message: Option.Option<MessageId>
  /** What the turn has spent so far, where a response said. */
  readonly tokens: Option.Option<Tokens>
}

/** Reads an agent's events into transcript entries, one event at a time. */
export interface TranscriptReader {
  readonly read: (
    event: PiEvent,
  ) => Effect.Effect<ReadonlyArray<TranscriptEntry>>
}

/** A message's ID, drawn as it begins. */
export const drawMessageId = Effect.map(drawBase36(12), random =>
  MessageId.make(`m-${random}`),
)

/** A reader of one session's events. */
export const makeTranscriptReader = Effect.fn('Transcript.makeReader')(
  function* () {
    const state = yield* Ref.make<ReaderState>({
      message: Option.none(),
      tokens: Option.none(),
    })
    const none: ReadonlyArray<TranscriptEntry> = []

    const read = (
      event: PiEvent,
    ): Effect.Effect<ReadonlyArray<TranscriptEntry>> =>
      Effect.gen(function* () {
        const at = yield* DateTime.now
        const current = yield* Ref.get(state)
        switch (event.type) {
          case 'message_start': {
            if (event.message.role !== 'assistant') return none
            const id = yield* drawMessageId
            yield* Ref.set(state, { ...current, message: Option.some(id) })
            return [
              TranscriptEntry.cases.message.make({
                id,
                role: 'assistant',
                text: '',
                at,
              }),
            ]
          }
          case 'message_update': {
            const input = toolInputOf(event.assistantMessageEvent)
            if (Option.isSome(input)) return [input.value]
            const streamed = decodeStreamed(event.assistantMessageEvent)
            if (Option.isNone(current.message) || Option.isNone(streamed))
              return none
            const { type, delta } = streamed.value
            if (delta === undefined || delta === '') return none
            const message = current.message.value
            if (type === 'text_delta')
              return [TranscriptEntry.cases.text.make({ message, delta })]
            if (type === 'thinking_delta')
              return [TranscriptEntry.cases.thinking.make({ message, delta })]
            return none
          }
          case 'message_end': {
            if (event.message.role !== 'assistant') return none
            const { usage } = event.message
            yield* Ref.set(state, {
              message: Option.none(),
              tokens:
                usage === undefined
                  ? current.tokens
                  : Option.some(addUsage(current.tokens, usage)),
            })
            return none
          }
          case 'tool_execution_start':
            return Option.match(ToolCallId.makeOption(event.toolCallId), {
              onNone: () => none,
              onSome: id => [
                TranscriptEntry.cases.tool_call.make({
                  id,
                  tool: event.toolName,
                  input: Option.getOrNull(decodeJson(event.args ?? null)),
                  at,
                }),
              ],
            })
          case 'tool_execution_end':
            return Option.match(ToolCallId.makeOption(event.toolCallId), {
              onNone: () => none,
              onSome: id => {
                const chunk = resultText(event.result)
                return [
                  ...(chunk === ''
                    ? []
                    : [TranscriptEntry.cases.tool_output.make({ id, chunk })]),
                  TranscriptEntry.cases.tool_end.make({
                    id,
                    ok: !event.isError,
                    at,
                  }),
                ]
              },
            })
          case 'agent_settled':
            yield* Ref.set(state, {
              message: Option.none(),
              tokens: Option.none(),
            })
            return [
              TranscriptEntry.cases.turn_end.make({
                at,
                tokens: current.tokens,
              }),
            ]
          default:
            return none
        }
      })

    return { read } satisfies TranscriptReader
  },
)
