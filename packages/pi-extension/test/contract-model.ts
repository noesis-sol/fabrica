import { Data, Effect, Option, Schema } from 'effect'
import { type Server, createServer } from 'node:http'

// The stub model provider of the Pi contract (spec §24): it speaks Anthropic's Messages API
// (server-sent events) on loopback, at the base URL the agent's `models.json` gives the provider, as the
// model proxy's would be (spike fab-mgi.2.1); it answers each model call with the next of a test's
// scripted replies and records the request.

/** The model every agent here runs: one of Pi's built-in Anthropic models, served by the stub. */
export const model = { provider: 'anthropic', modelId: 'claude-sonnet-4-5' }

/** A reply the stub model gives to one model call. */
export type Reply = Data.TaggedEnum<{
  /** Text, ending the model's turn. */
  Text: { readonly text: string }
  /** A call to `name` with `input`. */
  Call: { readonly id: string; readonly name: string; readonly input: unknown }
}>
export const Reply = Data.taggedEnum<Reply>()

/** The usage the stub reports for every reply, as Anthropic's events carry it. */
export const stubUsage = { input: 11, output: 7, cacheRead: 5, cacheWrite: 2 }

const event = (
  data: { readonly type: string } & Readonly<Record<string, unknown>>,
): string => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`

/** A reply as Anthropic's Messages API streams it. */
const stream = (reply: Reply): string => {
  const [block, delta, stop] = Reply.$match(reply, {
    Text: ({ text }) =>
      [
        { type: 'text', text: '' },
        { type: 'text_delta', text },
        'end_turn',
      ] as const,
    Call: ({ id, name, input }) =>
      [
        { type: 'tool_use', id, name, input: {} },
        { type: 'input_json_delta', partial_json: JSON.stringify(input) },
        'tool_use',
      ] as const,
  })
  return [
    event({
      type: 'message_start',
      message: {
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        model: model.modelId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: stubUsage.input,
          output_tokens: 1,
          cache_read_input_tokens: stubUsage.cacheRead,
          cache_creation_input_tokens: stubUsage.cacheWrite,
        },
      },
    }),
    event({ type: 'content_block_start', index: 0, content_block: block }),
    event({ type: 'content_block_delta', index: 0, delta }),
    event({ type: 'content_block_stop', index: 0 }),
    event({
      type: 'message_delta',
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: stubUsage.output },
    }),
    event({ type: 'message_stop' }),
  ].join('')
}

const ToolResult = Schema.Struct({
  type: Schema.Literal('tool_result'),
  tool_use_id: Schema.String,
  is_error: Schema.optionalKey(Schema.Boolean),
  content: Schema.Unknown,
})
export type ToolResult = typeof ToolResult.Type
const isToolResult = Schema.is(ToolResult)

const TextBlock = Schema.Struct({ type: Schema.String, text: Schema.String })

/** A Messages API request, as far as the tests read it. */
const MessagesRequest = Schema.Struct({
  system: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Array(TextBlock)]),
  ),
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.String,
      content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
    }),
  ),
  tools: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.optionalKey(Schema.String),
        input_schema: Schema.Unknown,
      }),
    ),
  ),
})
type MessagesRequest = typeof MessagesRequest.Type
const decodeRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(MessagesRequest),
)

/** A model call the stub served: the key it carried, and its body. */
export interface ModelCall {
  readonly apiKey: string | undefined
  readonly body: MessagesRequest
}

/** The system prompt's text. */
export const systemText = (call: ModelCall): string => {
  const system = call.body.system
  if (system === undefined) return ''
  return typeof system === 'string'
    ? system
    : system.map(block => block.text).join('\n')
}

/** The tool results the last message of a call holds. */
export const toolResults = (call: ModelCall): ReadonlyArray<ToolResult> => {
  const content = call.body.messages.at(-1)?.content
  return typeof content === 'string' || content === undefined
    ? []
    : content.filter(isToolResult)
}

/**
 * The stub model, on loopback: each model call answered with the next of `replies` and recorded in
 * `calls`. A request it can't serve (another path, a body it can't read, no reply left) gets a client
 * error, which Pi doesn't retry, and is recorded in `unserved`.
 */
export const stubModel = Effect.fn(function* (replies: ReadonlyArray<Reply>) {
  const calls: Array<ModelCall> = []
  const unserved: Array<string> = []
  const left = [...replies]
  const server = createServer((request, response) => {
    const chunks: Array<Buffer> = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = decodeRequest(Buffer.concat(chunks).toString('utf8'))
      const path = (request.url ?? '').split('?')[0] ?? ''
      const reply = left.shift()
      if (
        request.method !== 'POST' ||
        !path.endsWith('/v1/messages') ||
        Option.isNone(body) ||
        reply === undefined
      ) {
        unserved.push(`${request.method} ${request.url}`)
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: `the stub can't serve ${request.method} ${request.url}`,
            },
          }),
        )
        return
      }
      const apiKey = request.headers['x-api-key']
      calls.push({
        apiKey: typeof apiKey === 'string' ? apiKey : undefined,
        body: body.value,
      })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(stream(reply))
    })
  })
  const port = yield* Effect.acquireRelease(
    Effect.callback<number>(resume => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resume(
          typeof address === 'object' && address !== null
            ? Effect.succeed(address.port)
            : Effect.die('the stub model has no port'),
        )
      })
    }),
    () => closed(server),
  )
  return {
    baseUrl: `http://127.0.0.1:${port}/anthropic`,
    calls,
    unserved,
  }
})

const closed = (server: Server) =>
  Effect.callback<void>(resume => {
    server.closeAllConnections()
    server.close(() => resume(Effect.void))
  })
