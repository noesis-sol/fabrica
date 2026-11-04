import { Effect, Option, Schema } from 'effect'
import { type Server, createServer } from 'node:http'

import { Proxy } from '@fabrica/engine'

// The model the packaged app's smoke test runs its ticket with (spec §22.3, §24): the stub stands where a
// local model stands, on the loopback port the engine's route for it names, so the packaged engine runs as
// it ships: nothing in it is told of a stub, and the call comes through its model proxy with no credential
// (§12.9). It speaks Chat Completions, as a local model's route does, and plays a worker: it commits a
// file, runs `check_own`, and finishes with what that told it. Each answer is read from the request, as a
// model's is, so a retried call gets the same one.

/** The file the stub's worker commits, and what it writes in it. */
export const committed = { file: 'stub-model.txt', text: 'stubbed' }

/** What a call asked of the stub, as far as it reads one. */
const ChatRequest = Schema.Struct({
  stream: Schema.optionalKey(Schema.Boolean),
  messages: Schema.Array(
    Schema.Struct({ role: Schema.String, content: Schema.Unknown }),
  ),
  tools: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ function: Schema.Struct({ name: Schema.String }) }),
    ),
  ),
})
type ChatRequest = typeof ChatRequest.Type
const decodeRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(ChatRequest),
)

const CheckOwnPassed = Schema.fromJsonString(
  Schema.Struct({
    _tag: Schema.Literal('passed'),
    tree: Schema.String,
    output: Schema.String,
  }),
)
const decodePassed = Schema.decodeUnknownOption(CheckOwnPassed)

/** A tool result's text: Pi sends it as a string, or as a list of text parts. */
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((part: { readonly text?: unknown }) =>
            typeof part.text === 'string' ? part.text : '',
          )
          .join('')
      : ''

/** A reply: text, ending the model's turn, or a call of a tool. */
type Reply =
  | { readonly text: string }
  | { readonly name: string; readonly input: unknown }

/** The commit a worker's bash call printed last, and the pass `check_own` answered with. */
const finishing = (results: ReadonlyArray<string>): Option.Option<Reply> =>
  Option.flatMap(decodePassed(results[1] ?? ''), ({ tree, output }) =>
    Option.map(
      Option.fromNullishOr(/[0-9a-f]{40}/u.exec(results[0] ?? '')?.[0]),
      (commit): Reply => ({
        name: 'finish',
        input: {
          checkOwn: { tree, commit, output },
          result: { _tag: 'summary', summary: 'Added the file.' },
        },
      }),
    ),
  )

/** The reply to a call: the next step of the worker, by the results it has had; text for any other agent. */
const replyTo = (request: ChatRequest): Reply => {
  const finishes = (request.tools ?? []).some(
    tool => tool.function.name === 'finish',
  )
  if (!finishes) return { text: 'OK' }
  const results = request.messages
    .filter(message => message.role === 'tool')
    .map(message => textOf(message.content))
  switch (results.length) {
    case 0:
      return {
        name: 'bash',
        input: {
          command: `echo ${committed.text} > ${committed.file} && git add ${committed.file} && git commit --quiet --message 'Add the file' && git rev-parse HEAD`,
        },
      }
    case 1:
      return { name: 'check_own', input: {} }
    default:
      return Option.getOrElse(
        results.length === 2 ? finishing(results) : Option.none<Reply>(),
        () => ({ text: `Done: ${results.at(-1) ?? ''}` }),
      )
  }
}

const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }

const isCall = (
  reply: Reply,
): reply is { readonly name: string; readonly input: unknown } =>
  'name' in reply

/** A reply as Chat Completions streams it: its delta, then its finish and usage. */
const streamed = (reply: Reply, index: number): string =>
  [
    {
      index: 0,
      delta: isCall(reply)
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${index}`,
                type: 'function',
                function: {
                  name: reply.name,
                  arguments: JSON.stringify(reply.input),
                },
              },
            ],
          }
        : { role: 'assistant', content: reply.text },
      finish_reason: null,
    },
    {
      index: 0,
      delta: {},
      finish_reason: isCall(reply) ? 'tool_calls' : 'stop',
    },
  ]
    .map(
      choice =>
        `data: ${JSON.stringify({
          id: 'stub',
          object: 'chat.completion.chunk',
          choices: [choice],
          ...(choice.finish_reason === null ? {} : { usage }),
        })}\n\n`,
    )
    .concat('data: [DONE]\n\n')
    .join('')

/** A probe's answer, which doesn't stream (§13.1). */
const answered = JSON.stringify({
  id: 'stub',
  object: 'chat.completion',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'OK' },
      finish_reason: 'stop',
    },
  ],
  usage,
})

const closed = (server: Server) =>
  Effect.callback<void>(resume => {
    server.closeAllConnections()
    server.close(() => resume(Effect.void))
  })

/** Listens on `port` of the loopback address, or says it is taken. */
const listened = (server: Server, port: number) =>
  Effect.callback<boolean>(resume => {
    server.once('error', () => resume(Effect.succeed(false)))
    server.listen(port, '127.0.0.1', () => resume(Effect.succeed(true)))
  })

/** The local models' routes, each with the port the engine reaches it on. */
const localRoutes = Proxy.knownRoutes.flatMap(route =>
  Proxy.Authentication.$is('None')(route.authentication)
    ? [{ provider: route.provider, port: Number(new URL(route.upstream).port) }]
    : [],
)

/**
 * The stub on the port of the first local model's route that has it free: a machine's own Ollama may
 * hold one. Gives the provider the project's `model` is to name, and the tools the stub's worker called
 * and what it couldn't serve, for the test to read.
 */
export const stubModel = Effect.acquireRelease(
  Effect.gen(function* () {
    const called: Array<string> = []
    const unserved: Array<string> = []
    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = decodeRequest(Buffer.concat(chunks).toString('utf8'))
        if (
          request.method !== 'POST' ||
          !(request.url ?? '').endsWith('/chat/completions') ||
          Option.isNone(body)
        ) {
          unserved.push(`${request.method} ${request.url}`)
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'not served' } }))
          return
        }
        if (body.value.stream !== true) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(answered)
          return
        }
        const reply = replyTo(body.value)
        if (isCall(reply)) called.push(reply.name)
        else if (reply.text !== 'OK') unserved.push(reply.text)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(streamed(reply, called.length))
      })
    })
    for (const { provider, port } of localRoutes) {
      if (yield* listened(server, port)) {
        return { provider, server, called, unserved }
      }
    }
    return yield* Effect.die(
      `the stub model has no port: ${localRoutes.map(({ port }) => port).join(' and ')} are taken`,
    )
  }),
  ({ server }) => closed(server),
)
