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

// Pi's RPC mode sends a model's streamed events without the message so far (its `toJsonEvent`): a
// tool call's start names the call and its tool, and its input's deltas name only the message's part
// they write, so the reader keeps the calls each message has begun.

/** A tool call begun, as far as the transcript reads it: the message's part at `contentIndex`. */
const ToolCallStart = Schema.Struct({
  type: Schema.Literal('toolcall_start'),
  contentIndex: Schema.Number,
  id: Schema.String,
  toolName: Schema.String,
})

/** More of a tool call's input, as far as the transcript reads it: the message's part at `contentIndex`. */
const ToolCallDelta = Schema.Struct({
  type: Schema.Literal('toolcall_delta'),
  contentIndex: Schema.Number,
  delta: Schema.String,
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
const decodeToolCallStart = Schema.decodeUnknownOption(ToolCallStart)
const decodeToolCallDelta = Schema.decodeUnknownOption(ToolCallDelta)
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

/** A tool call a message has begun: its ID and its tool. */
interface Call {
  readonly id: ToolCallId
  readonly tool: string
}

/** The call a streamed event begins, at its part's index, where it names the call and its tool. */
const callBegun = (streamed: unknown): Option.Option<readonly [number, Call]> =>
  Option.gen(function* () {
    const start = yield* decodeToolCallStart(streamed)
    const id = yield* ToolCallId.makeOption(start.id)
    const tool = yield* Option.liftPredicate(start.toolName, Schema.is(Text))
    return [start.contentIndex, { id, tool }] as const
  })

/** The `tool_input` a streamed event is: more of the input of a call `calls` has begun. */
const toolInputOf = (
  streamed: unknown,
  calls: ReadonlyMap<number, Call>,
): Option.Option<TranscriptEntry> =>
  Option.gen(function* () {
    const { contentIndex, delta } = yield* decodeToolCallDelta(streamed)
    const { id, tool } = yield* Option.fromUndefinedOr(calls.get(contentIndex))
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
  /** The tool calls the message has begun, by its part's index. */
  readonly calls: ReadonlyMap<number, Call>
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
    const noCalls: ReadonlyMap<number, Call> = new Map()
    const state = yield* Ref.make<ReaderState>({
      message: Option.none(),
      tokens: Option.none(),
      calls: noCalls,
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
            yield* Ref.set(state, {
              ...current,
              message: Option.some(id),
              calls: noCalls,
            })
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
            const begun = callBegun(event.assistantMessageEvent)
            if (Option.isSome(begun)) {
              const [index, call] = begun.value
              yield* Ref.set(state, {
                ...current,
                calls: new Map(current.calls).set(index, call),
              })
              return none
            }
            const input = toolInputOf(
              event.assistantMessageEvent,
              current.calls,
            )
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
              calls: noCalls,
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
              calls: noCalls,
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
