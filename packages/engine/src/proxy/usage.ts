import { Option, Schema } from 'effect'

import type { Tokens } from '@fabrica/contracts'

import type { ModelApi } from './routes'

// A model call's tokens, read by the model proxy from the provider's response as it passes through
// (spec §12.9, §14.4): from a stream's events (server-sent events) or a whole JSON answer, each API's
// usage in its own shape. A stream's last report wins, field by field, so Anthropic's input from
// `message_start` and its output from the final `message_delta` both count. Tokens are orchestra's
// four (H65): input neither written to the cache nor read from it, output with thinking.

/** Reads a response's usage from its bytes, decompressed, as they pass. */
export interface UsageReader {
  readonly feed: (chunk: Uint8Array) => void
  /** The call's tokens, where the response reported any. */
  readonly finish: () => Option.Option<Tokens>
}

/** The most of a JSON answer kept to read its usage: an answer longer than this is passed on, not counted. */
const jsonLimit = 16 * 1024 * 1024

/** A usage report, each field where the report gave it. */
interface Reported {
  readonly input?: number
  readonly output?: number
  readonly cache_write?: number
  readonly cache_read?: number
}

const Field = Schema.optional(Schema.NullOr(Schema.Number))

const AnthropicUsage = Schema.Struct({
  input_tokens: Field,
  output_tokens: Field,
  cache_creation_input_tokens: Field,
  cache_read_input_tokens: Field,
})
/** `message_start` carries its usage in its message, `message_delta` and a whole answer at the top. */
const AnthropicEvent = Schema.Struct({
  message: Schema.optional(
    Schema.Struct({ usage: Schema.optional(AnthropicUsage) }),
  ),
  usage: Schema.optional(Schema.NullOr(AnthropicUsage)),
})

const ResponsesUsage = Schema.Struct({
  input_tokens: Field,
  output_tokens: Field,
  input_tokens_details: Schema.optional(
    Schema.NullOr(Schema.Struct({ cached_tokens: Field })),
  ),
})
/** `response.completed` (and `.incomplete`, `.failed`) carry it in their response, a whole answer at the top. */
const ResponsesEvent = Schema.Struct({
  response: Schema.optional(
    Schema.Struct({ usage: Schema.optional(Schema.NullOr(ResponsesUsage)) }),
  ),
  usage: Schema.optional(Schema.NullOr(ResponsesUsage)),
})

const CompletionsUsage = Schema.Struct({
  prompt_tokens: Field,
  completion_tokens: Field,
  prompt_tokens_details: Schema.optional(
    Schema.NullOr(Schema.Struct({ cached_tokens: Field })),
  ),
})
/** The last chunk carries it (with `stream_options.include_usage`), a whole answer at the top. */
const CompletionsEvent = Schema.Struct({
  usage: Schema.optional(Schema.NullOr(CompletionsUsage)),
})

const GoogleUsage = Schema.Struct({
  promptTokenCount: Field,
  candidatesTokenCount: Field,
  thoughtsTokenCount: Field,
  cachedContentTokenCount: Field,
})
/** Every chunk carries the usage so far. */
const GoogleEvent = Schema.Struct({
  usageMetadata: Schema.optional(Schema.NullOr(GoogleUsage)),
})

const given = (value: number | null | undefined): Option.Option<number> =>
  typeof value === 'number' && Number.isFinite(value)
    ? Option.some(value)
    : Option.none()

/** The report with each field given, its others left out. */
const report = (fields: {
  readonly [K in keyof Reported]-?: Option.Option<number>
}): Reported =>
  Object.fromEntries(
    Object.entries(fields).flatMap(([name, value]) =>
      Option.match(value, {
        onNone: () => [],
        onSome: count => [[name, count]],
      }),
    ),
  )

/** Input less what was read from the cache, where the API counts the cache inside its input. */
const uncached = (
  input: Option.Option<number>,
  cached: Option.Option<number>,
): Option.Option<number> =>
  Option.map(input, total => total - Option.getOrElse(cached, () => 0))

const decodeAnthropic = Schema.decodeUnknownOption(
  Schema.fromJsonString(AnthropicEvent),
)
const decodeResponses = Schema.decodeUnknownOption(
  Schema.fromJsonString(ResponsesEvent),
)
const decodeCompletions = Schema.decodeUnknownOption(
  Schema.fromJsonString(CompletionsEvent),
)
const decodeGoogle = Schema.decodeUnknownOption(
  Schema.fromJsonString(GoogleEvent),
)

/** What one event or answer of an API reports, read from its JSON text. */
const readers: Record<ModelApi, (json: string) => Option.Option<Reported>> = {
  'anthropic-messages': json =>
    Option.flatMap(decodeAnthropic(json), event =>
      Option.map(
        Option.orElse(Option.fromNullishOr(event.message?.usage), () =>
          Option.fromNullishOr(event.usage),
        ),
        usage =>
          report({
            input: given(usage.input_tokens),
            output: given(usage.output_tokens),
            cache_write: given(usage.cache_creation_input_tokens),
            cache_read: given(usage.cache_read_input_tokens),
          }),
      ),
    ),
  'openai-responses': json =>
    Option.flatMap(decodeResponses(json), event =>
      Option.map(
        Option.orElse(Option.fromNullishOr(event.response?.usage), () =>
          Option.fromNullishOr(event.usage),
        ),
        usage => {
          const cached = given(usage.input_tokens_details?.cached_tokens)
          return report({
            input: uncached(given(usage.input_tokens), cached),
            output: given(usage.output_tokens),
            cache_write: Option.none(),
            cache_read: cached,
          })
        },
      ),
    ),
  'openai-completions': json =>
    Option.flatMap(decodeCompletions(json), event =>
      Option.map(Option.fromNullishOr(event.usage), usage => {
        const cached = given(usage.prompt_tokens_details?.cached_tokens)
        return report({
          input: uncached(given(usage.prompt_tokens), cached),
          output: given(usage.completion_tokens),
          cache_write: Option.none(),
          cache_read: cached,
        })
      }),
    ),
  'google-generative-ai': json =>
    Option.flatMap(decodeGoogle(json), event =>
      Option.map(Option.fromNullishOr(event.usageMetadata), usage => {
        const cached = given(usage.cachedContentTokenCount)
        const candidates = given(usage.candidatesTokenCount)
        const thoughts = given(usage.thoughtsTokenCount)
        return report({
          input: uncached(given(usage.promptTokenCount), cached),
          output:
            Option.isNone(candidates) && Option.isNone(thoughts)
              ? Option.none()
              : Option.some(
                  Option.getOrElse(candidates, () => 0) +
                    Option.getOrElse(thoughts, () => 0),
                ),
          cache_write: Option.none(),
          cache_read: cached,
        })
      }),
    ),
}

/** A JSON answer's elements: Google's non-SSE stream is an array of its chunks. */
const JsonArray = Schema.fromJsonString(Schema.Array(Schema.Unknown))
const decodeArray = Schema.decodeUnknownOption(JsonArray)

const count = (value: number | undefined): number =>
  Math.max(0, Math.round(value ?? 0))

/** Reads the usage of a response of `api`, a stream of events where `contentType` says so. */
export const usageReader = (
  api: ModelApi,
  contentType: string,
): UsageReader => {
  const read = readers[api]
  const decoder = new TextDecoder()
  const stream = /^\s*text\/event-stream/iu.test(contentType)
  let reported: Option.Option<Reported> = Option.none()
  const take = (json: string) =>
    Option.match(read(json), {
      onNone: () => undefined,
      onSome: next => {
        reported = Option.some({
          ...Option.getOrElse(reported, () => ({})),
          ...next,
        })
      },
    })

  // A stream: its lines, the last one until its end comes, and the data lines of the event being read.
  let pending = ''
  let data: Array<string> = []
  const dispatch = () => {
    const json = data.join('\n')
    data = []
    if (json !== '' && json !== '[DONE]') take(json)
  }
  const line = (text: string) => {
    if (text === '') dispatch()
    else if (text.startsWith('data:'))
      data.push(text.slice(5).replace(/^ /u, ''))
  }

  // A whole answer: its text, until it passes the limit.
  let whole = ''
  let tooLong = false

  const feed = (chunk: Uint8Array) => {
    const text = decoder.decode(chunk, { stream: true })
    if (stream) {
      const lines = `${pending}${text}`.split(/\r\n|\r|\n/u)
      pending = lines.pop() ?? ''
      lines.forEach(line)
    } else if (!tooLong) {
      whole += text
      if (whole.length > jsonLimit) {
        tooLong = true
        whole = ''
      }
    }
  }

  const finish = (): Option.Option<Tokens> => {
    const rest = decoder.decode()
    if (stream) {
      ;`${pending}${rest}`.split(/\r\n|\r|\n/u).forEach(line)
      pending = ''
      dispatch()
    } else if (!tooLong) {
      const json = `${whole}${rest}`
      Option.match(decodeArray(json), {
        onNone: () => take(json),
        onSome: chunks => chunks.forEach(chunk => take(JSON.stringify(chunk))),
      })
    }
    return Option.map(reported, tokens => ({
      input: count(tokens.input),
      output: count(tokens.output),
      cache_write: count(tokens.cache_write),
      cache_read: count(tokens.cache_read),
    }))
  }

  return { feed, finish }
}
