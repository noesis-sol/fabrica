import {
  Data,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Schema,
  Stream,
} from 'effect'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from '@effect/vitest'
import {
  ControlSocketVariable,
  ControlTokenVariable,
  PermissionsVariable,
  ProjectId,
  WorkerTools,
  parametersJsonSchema,
} from '@fabrica/contracts'
import { Agent, Process } from '@fabrica/engine'
import { tempFolder } from '@fabrica/testkit'

import { StandingRulesSection, standingRules } from '../src/rules'
import { NudgeText, SettledType } from '../src/settle'
import {
  type Call,
  RefusalNote,
  answers,
  other,
  own,
  serve,
  token,
} from './control-server'

// The Pi contract (spec §24): the real pinned Pi in RPC mode, launched by the engine's live `PiAgent`
// with the first-party extension loaded from its source, against a stub model provider. The stub
// speaks Anthropic's Messages API (server-sent events) on loopback, at the base URL the agent's
// `models.json` gives the provider, as the model proxy's would be (spike fab-mgi.2.1); it answers each
// model call with the next of a test's scripted replies and records the request. A control server
// answers the extension's tools as the engine would. Run on every Pi upgrade:
// `pnpm --filter @fabrica/pi-extension test:contract`.

/** Pi's package as installed for this package, at the pinned version. */
const piPackage = fileURLToPath(
  new URL('../node_modules/@earendil-works/pi-coding-agent/', import.meta.url),
)

/** The first-party extension, as Pi loads it with `--extension`. */
const extension = fileURLToPath(new URL('../src/index.ts', import.meta.url))

const PiManifest = Schema.Struct({
  version: Schema.String,
  bin: Schema.Struct({ pi: Schema.String }),
})

/** Pi's CLI script, its package's `bin`. */
const piCli = Effect.map(
  Effect.promise(() => readFile(join(piPackage, 'package.json'), 'utf8')),
  text =>
    join(
      piPackage,
      Schema.decodeUnknownSync(PiManifest)(JSON.parse(text)).bin.pi,
    ),
)

/** The model every agent here runs: one of Pi's built-in Anthropic models, served by the stub. */
const model = { provider: 'anthropic', modelId: 'claude-sonnet-4-5' }

/** The agent's token for the model proxy, which Pi sends in place of a provider key. */
const agentToken = 'agent-token-1'

// ---------------------------------------------------------------------------------------------------
// The stub model provider

/** A reply the stub model gives to one model call. */
type Reply = Data.TaggedEnum<{
  /** Text, ending the model's turn. */
  Text: { readonly text: string }
  /** A call to `name` with `input`. */
  Call: { readonly id: string; readonly name: string; readonly input: unknown }
}>
const Reply = Data.taggedEnum<Reply>()

/** The usage the stub reports for every reply, as Anthropic's events carry it. */
const stubUsage = { input: 11, output: 7, cacheRead: 5, cacheWrite: 2 }

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
type ToolResult = typeof ToolResult.Type
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
interface ModelCall {
  readonly apiKey: string | undefined
  readonly body: MessagesRequest
}

/** The system prompt's text. */
const systemText = (call: ModelCall): string => {
  const system = call.body.system
  if (system === undefined) return ''
  return typeof system === 'string'
    ? system
    : system.map(block => block.text).join('\n')
}

/** The tool results the last message of a call holds. */
const toolResults = (call: ModelCall): ReadonlyArray<ToolResult> => {
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
const stubModel = Effect.fn(function* (replies: ReadonlyArray<Reply>) {
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

// ---------------------------------------------------------------------------------------------------
// The agent

const limits: Agent.AgentLimits = {
  handshake: Duration.seconds(30),
  answer: Duration.seconds(30),
  abort: Duration.seconds(5),
  reap: Duration.seconds(5),
}

/** The live `PiAgent` on the live process runner, Pi run by the Node running the tests. */
const services = ({
  cli,
  root,
  home,
}: {
  readonly cli: string
  readonly root: string
  readonly home: string
}) =>
  Agent.layer({
    node: process.execPath,
    cli,
    extension,
    data: join(root, 'data'),
    configRoot: join(root, 'agents'),
    limits,
    reaperPoll: Duration.millis(200),
    reaperGrace: Duration.millis(500),
  }).pipe(
    Layer.provideMerge(
      Process.layer({
        hostEnvironment: {
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: home,
          LANG: 'C',
        },
        enginePriority: 0,
        priority: Process.hostPriority,
        listProcesses: Process.listProcesses,
        pipeHolders: Process.hostHolders({
          platform: process.platform,
          self: process.pid,
        }),
        self: process.pid,
        killGrace: Duration.millis(500),
        outputGrace: Duration.millis(200),
      }),
    ),
    Layer.provide(Process.layerClock),
  )

/**
 * A contract's setting: a worktree for Pi to run in, a control server recording the extension's
 * calls, the stub model with `replies`, and `start`, which starts the ticket's agent (resuming
 * `resume` where given) in the caller's scope.
 */
const setting = Effect.fn(function* (replies: ReadonlyArray<Reply>) {
  const root = yield* tempFolder('pi-contract')
  const worktree = join(root, 'worktree')
  const home = join(root, 'home')
  yield* Effect.promise(async () => {
    await mkdir(worktree)
    await mkdir(home)
  })
  const calls: Array<Call> = []
  const socket = yield* serve(root, answers(calls, { dirty: false }))
  const stub = yield* stubModel(replies)
  const cli = yield* piCli
  const context = yield* Layer.build(services({ cli, root, home }))
  const start = (resume: Option.Option<string> = Option.none()) =>
    Effect.flatMap(Agent.PiAgent, agents =>
      agents.start({
        ticket: own,
        project: ProjectId.make('p1'),
        worktree,
        providers: [{ provider: model.provider, baseUrl: stub.baseUrl }],
        token: agentToken,
        model: Option.some(model),
        tools: Option.none(),
        resume,
        env: {
          [ControlSocketVariable]: socket,
          [ControlTokenVariable]: token,
          [PermissionsVariable]: 'workspace',
        },
        projectTrusted: false,
        nice: Option.none(),
      }),
    ).pipe(Effect.provide(context))
  return { root, worktree, calls, stub, start }
})

/** The entries of a session file, one JSON value a line. */
const sessionEntries = (file: string) =>
  Effect.map(
    Effect.promise(() => readFile(file, 'utf8')),
    text =>
      text
        .split('\n')
        .filter(line => line.length > 0)
        .map((line): unknown => JSON.parse(line)),
  )

const SettledEntry = Schema.Struct({
  type: Schema.Literal('custom'),
  customType: Schema.Literal(SettledType),
  data: Schema.Unknown,
})

/** How each turn of a session settled, as the extension recorded it there. */
const settledEntries = (file: string) =>
  Effect.map(sessionEntries(file), entries =>
    entries.filter(Schema.is(SettledEntry)).map(entry => entry.data),
  )

const sessionFile = (session: Agent.AgentSession) =>
  Option.getOrThrowWith(session.file, () => new Error('no session file'))

/** A real Pi starts, loads its extension and the model, and runs a model call: allow for a loaded machine. */
const timeout = 60_000

// ---------------------------------------------------------------------------------------------------
// The calls the stub model makes

const finishing = {
  checkOwn: {
    tree: 'a'.repeat(40),
    commit: 'b'.repeat(40),
    output: '.fabrica/run/check-own.log',
  },
  result: { _tag: 'summary', summary: 'Built it.' },
}

const choices = {
  options: [
    { label: 'SQLite', tradeOff: 'One file, already in use.' },
    { label: 'Memory', tradeOff: 'Fast, lost on restart.' },
  ],
  recommended: 0,
}

const question = {
  title: 'Which store for the cache?',
  description: 'The cache needs a store. SQLite is recommended.',
  choices,
  consequential: false,
  maintainerOnly: false,
  blocks: other,
}

/** A call to each of the worker's tools that doesn't end the turn, then `finish`, which does. */
const everyTool: ReadonlyArray<Reply> = [
  Reply.Call({ id: 'toolu_get', name: 'get_ticket', input: {} }),
  Reply.Call({
    id: 'toolu_file',
    name: 'file_ticket',
    input: {
      title: 'Split the gate',
      description: 'The gate module holds two rules; each gets its own.',
      type: 'task',
      files: ['src/gate.ts'],
      link: 'blocks',
    },
  }),
  Reply.Call({ id: 'toolu_ask', name: 'ask_question', input: question }),
  Reply.Call({
    id: 'toolu_note',
    name: 'add_note',
    input: { body: 'Chose X.' },
  }),
  Reply.Call({ id: 'toolu_check', name: 'check_own', input: {} }),
  Reply.Call({ id: 'toolu_wait', name: 'ask_and_wait', input: question }),
  Reply.Call({ id: 'toolu_finish', name: 'finish', input: finishing }),
]

describe('the Pi contract', () => {
  it.live(
    'shakes hands, and gives the model the extension’s tools and rules with the agent’s token',
    () =>
      Effect.gen(function* () {
        const { stub, start } = yield* setting([
          Reply.Call({ id: 'toolu_finish', name: 'finish', input: finishing }),
        ])
        const agent = yield* start()
        expect(agent.session.id).not.toBe('')
        expect(Option.isSome(agent.session.file)).toBe(true)

        const settled = yield* agent.prompt('Work on your ticket.')
        expect(settled).toEqual({ disposition: 'started', aborted: false })
        expect(stub.unserved).toEqual([])
        const [first, ...rest] = stub.calls
        // `finish` ended the turn: Pi stopped after it, with no model call more.
        expect(rest).toEqual([])
        expect(first?.apiKey).toBe(agentToken)
        const tools = new Map(
          (first?.body.tools ?? []).map(tool => [tool.name, tool]),
        )
        // Pi sends Anthropic a tool's properties and required keys alone; it checks the rest of the
        // schema itself, as the extension's handler does again.
        for (const tool of WorkerTools) {
          const schema = parametersJsonSchema(tool)
          expect(tools.get(tool.name)?.description).toBe(tool.description)
          expect(tools.get(tool.name)?.input_schema).toEqual({
            type: 'object',
            properties: schema['properties'],
            required: schema['required'] ?? [],
          })
        }
        const system = first === undefined ? '' : systemText(first)
        expect(system).toContain(StandingRulesSection)
        expect(system).toContain(standingRules(Option.none()))
      }),
    timeout,
  )

  it.live(
    'forwards a call to each worker tool to the engine, an outcome tool ending the turn',
    () =>
      Effect.gen(function* () {
        const { calls, stub, start } = yield* setting([
          ...everyTool,
          Reply.Call({
            id: 'toolu_defer',
            name: 'defer',
            input: { reason: 'Needs a decision.' },
          }),
          Reply.Call({
            id: 'toolu_wait_for',
            name: 'wait_for',
            input: { ticket: other, needs: 'Its schema.' },
          }),
        ])
        const agent = yield* start()
        yield* agent.prompt('Work on your ticket.')
        yield* agent.prompt('Carry on.')
        yield* agent.prompt('Carry on.')
        expect(stub.unserved).toEqual([])
        expect(
          calls
            .map(call => call.rpc)
            .filter(rpc => rpc !== 'report_gate_decision'),
        ).toEqual([
          'get_ticket',
          'file_ticket',
          'get_ticket',
          'ask_question',
          'add_note',
          'check_own',
          'get_ticket',
          'ask_and_wait',
          'finish',
          'defer',
          'wait_for',
        ])
        expect(calls.find(call => call.rpc === 'add_note')?.payload).toEqual({
          body: 'Chose X.',
        })
        // Each result came back to the model, none an error; the three outcomes each ended a turn.
        expect(stub.calls).toHaveLength(everyTool.length + 2)
        const results = stub.calls
          .slice(1, everyTool.length)
          .flatMap(toolResults)
        expect(results.map(result => result.tool_use_id)).toEqual(
          everyTool
            .slice(0, -1)
            .map(reply => (reply._tag === 'Call' ? reply.id : '')),
        )
        expect(results.filter(result => result.is_error === true)).toEqual([])
        expect(yield* settledEntries(sessionFile(agent.session))).toEqual([
          { outcome: 'finish', nudged: false, aborted: false },
          { outcome: 'defer', nudged: false, aborted: false },
          { outcome: 'wait_for', nudged: false, aborted: false },
        ])
      }),
    timeout,
  )

  it.live(
    'fails a call whose arguments the tool’s schema refuses, reaching no engine',
    () =>
      Effect.gen(function* () {
        const { calls, stub, start } = yield* setting([
          // A key the schema doesn't have: Pi's own check refuses it.
          Reply.Call({
            id: 'toolu_extra',
            name: 'add_note',
            input: { body: 'Chose X.', urgent: true },
          }),
          // A rule the JSON Schema can't hold: the handler's decode refuses it.
          Reply.Call({
            id: 'toolu_restated',
            name: 'file_ticket',
            input: {
              title: 'Split the gate',
              description: 'Split the gate into its own module.',
              type: 'task',
              files: ['src/gate.ts'],
              link: 'blocks',
            },
          }),
          Reply.Call({ id: 'toolu_finish', name: 'finish', input: finishing }),
        ])
        const agent = yield* start()
        yield* agent.prompt('Work on your ticket.')
        expect(stub.unserved).toEqual([])
        const [extra, restated] = stub.calls
          .slice(1)
          .map(call => toolResults(call)[0])
        expect(extra).toMatchObject({
          tool_use_id: 'toolu_extra',
          is_error: true,
        })
        expect(JSON.stringify(extra?.content)).toContain('urgent')
        expect(restated).toMatchObject({
          tool_use_id: 'toolu_restated',
          is_error: true,
        })
        expect(JSON.stringify(restated?.content)).toContain(
          'opens with the detail',
        )
        expect(calls.map(call => call.rpc)).toEqual(['finish'])
      }),
    timeout,
  )

  it.live(
    'blocks a call the gate refuses or the maintainer refuses, which never runs',
    () =>
      Effect.gen(function* () {
        const { root, worktree, calls, stub, start } = yield* setting([
          Reply.Call({
            id: 'toolu_push',
            name: 'bash',
            input: { command: 'echo pushed > pushed.txt && git push' },
          }),
          Reply.Call({
            id: 'toolu_outside',
            name: 'write',
            input: { path: '../outside.txt', content: 'outside' },
          }),
          Reply.Call({
            id: 'toolu_inside',
            name: 'bash',
            input: { command: 'echo ran > ran.txt' },
          }),
          Reply.Call({ id: 'toolu_finish', name: 'finish', input: finishing }),
        ])
        const agent = yield* start()
        yield* agent.prompt('Work on your ticket.')
        expect(stub.unserved).toEqual([])
        const [push, outside, inside] = stub.calls
          .slice(1)
          .map(call => toolResults(call)[0])
        expect(push).toMatchObject({
          tool_use_id: 'toolu_push',
          is_error: true,
        })
        expect(JSON.stringify(push?.content)).toContain(
          'Fabrica’s gate refused this call: git push',
        )
        expect(outside).toMatchObject({
          tool_use_id: 'toolu_outside',
          is_error: true,
        })
        expect(JSON.stringify(outside?.content)).toContain(RefusalNote)
        expect(inside?.is_error).not.toBe(true)
        expect(existsSync(join(worktree, 'pushed.txt'))).toBe(false)
        expect(existsSync(join(root, 'outside.txt'))).toBe(false)
        expect(existsSync(join(worktree, 'ran.txt'))).toBe(true)
        expect(
          calls
            .filter(call => call.rpc !== 'finish')
            .map(({ rpc, payload }) => [
              rpc,
              Schema.decodeUnknownOption(
                Schema.Struct({
                  verdict: Schema.Struct({ _tag: Schema.String }),
                }),
              )(payload).pipe(
                Option.map(({ verdict }) => verdict._tag),
                Option.getOrElse(() => ''),
              ),
            ]),
        ).toEqual([
          ['report_gate_decision', 'refused'],
          ['request_permission', ''],
          ['report_gate_decision', 'asked'],
          ['report_gate_decision', 'allowed'],
        ])
      }),
    timeout,
  )

  it.live(
    'nudges a turn that ends without an outcome once, then reports it unfinished',
    () =>
      Effect.gen(function* () {
        const { calls, stub, start } = yield* setting([
          Reply.Text({ text: 'I looked around.' }),
          Reply.Text({ text: 'Still looking.' }),
        ])
        const agent = yield* start()
        const settled = yield* agent.prompt('Work on your ticket.')
        expect(settled.aborted).toBe(false)
        expect(stub.unserved).toEqual([])
        const [first, nudged, ...rest] = stub.calls
        expect(rest).toEqual([])
        expect(JSON.stringify(first?.body.messages)).not.toContain(NudgeText)
        expect(JSON.stringify(nudged?.body.messages.at(-1))).toContain(
          NudgeText,
        )
        expect(calls.map(call => call.rpc)).toEqual(['report_unfinished'])
        expect(yield* settledEntries(sessionFile(agent.session))).toEqual([
          { outcome: null, nudged: true, aborted: false },
        ])
      }),
    timeout,
  )

  it.live(
    'resumes a session with switch_session, its history and rules given again',
    () =>
      Effect.gen(function* () {
        const { stub, start } = yield* setting([
          Reply.Call({
            id: 'toolu_defer',
            name: 'defer',
            input: { reason: 'Needs a decision.' },
          }),
          Reply.Call({
            id: 'toolu_wait_for',
            name: 'wait_for',
            input: { ticket: other, needs: 'Its schema.' },
          }),
        ])
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const agent = yield* start()
            yield* agent.prompt('The first prompt.')
            return agent.session
          }),
        )
        const resumed = yield* start(Option.some(sessionFile(first)))
        expect(resumed.session).toEqual(first)
        yield* resumed.prompt('The answer came.')
        expect(stub.unserved).toEqual([])
        const [, again] = stub.calls
        const history = JSON.stringify(again?.body.messages)
        expect(history).toContain('The first prompt.')
        expect(history).toContain('toolu_defer')
        expect(history).toContain('The answer came.')
        expect(again === undefined ? '' : systemText(again)).toContain(
          standingRules(Option.none()),
        )
        expect(yield* settledEntries(sessionFile(first))).toEqual([
          { outcome: 'defer', nudged: false, aborted: false },
          { outcome: 'wait_for', nudged: false, aborted: false },
        ])
      }),
    timeout,
  )

  it.live(
    'reports each model call’s usage, and the session’s',
    () =>
      Effect.gen(function* () {
        const { start } = yield* setting([
          Reply.Call({
            id: 'toolu_note',
            name: 'add_note',
            input: { body: 'Chose X.' },
          }),
          Reply.Call({ id: 'toolu_finish', name: 'finish', input: finishing }),
        ])
        const agent = yield* start()
        const events = yield* agent.events
        const collected = yield* events.pipe(
          Stream.takeUntil(event => event.type === 'agent_settled'),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* agent.prompt('Work on your ticket.')
        const ended = (yield* Fiber.join(collected)).flatMap(event =>
          event.type === 'message_end' && event.message.role === 'assistant'
            ? [event.message]
            : [],
        )
        expect(ended).toHaveLength(2)
        for (const message of ended) {
          expect(message.provider).toBe(model.provider)
          expect(message.model).toBe(model.modelId)
          expect(message.usage).toMatchObject({
            input: stubUsage.input,
            output: stubUsage.output,
            cacheRead: stubUsage.cacheRead,
            cacheWrite: stubUsage.cacheWrite,
          })
          expect(message.usage?.cost.total).toBeGreaterThan(0)
        }
        const stats = yield* agent.sessionStats
        expect(stats.tokens).toMatchObject({
          input: 2 * stubUsage.input,
          output: 2 * stubUsage.output,
          cacheRead: 2 * stubUsage.cacheRead,
          cacheWrite: 2 * stubUsage.cacheWrite,
        })
        expect(stats.assistantMessages).toBe(2)
        expect(stats.toolCalls).toBe(2)
      }),
    timeout,
  )
})
