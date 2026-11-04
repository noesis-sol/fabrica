import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Redacted,
  Schedule,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { TestClock } from 'effect/testing'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import {
  type IncomingHttpHeaders,
  type ServerResponse,
  createServer,
} from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { NodeSocket } from '@effect/platform-node'
import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  CommandSetting,
  ControlRpcs,
  ControlTokenVariable,
  type ModelChoice,
  ModelName,
  PermissionDecision,
  ProjectId,
  type ProjectSettings,
  type RunEvent,
  RunId,
  SessionId,
  TicketId,
  controlTokenClient,
} from '@fabrica/contracts'

import { layer as agentLayer } from '../src/agent'
import { layer as checksLayer } from '../src/checks'
import {
  Attention,
  ControlRole,
  ControlServer,
  checkOwnPassesLayer,
  layer as controlLayer,
} from '../src/control'
import { countProxyCalls, makeCostAccount, tokensOf } from '../src/cost'
import { type GitConfig, layer as gitLayer } from '../src/git'
import {
  CREDENTIALS_PROBE,
  type HoldKey,
  heldProviders,
  isOn,
  makeCredentialsHold,
  makeHolds,
} from '../src/holds'
import {
  type OrganConfig,
  type OrganHolds,
  OrganOutcome,
  type OrganQuestion,
  makeOrganRuntime,
  organSessionTools,
} from '../src/organs'
import {
  Deadlines,
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import {
  Authentication,
  ModelProxy,
  Permits,
  type ProviderRoute,
  layerHeld,
  make as makeProxy,
} from '../src/proxy'
import { makeRunLog } from '../src/runlog'
import { Held, Kept, SecretName, Secrets } from '../src/secrets'
import { Telemetry, type TelemetryRow, nothingMeasured } from '../src/telemetry'
import { layerWake, noSleepCauses } from '../src/time'
import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'
import { anthropicAnswer, anthropicBadKey } from './proxy-streams'

// The organs' runtime (spec §16, H18, H86): organs' questions over recorded provider responses, through
// `pi-ai` and the live model proxy, its permits and the run's live credentials hold; the only stand-in
// is the provider on loopback. Sessions run the live PiAgent and control channel over a stub of Pi's
// CLI, which calls `answer` on the real socket as its prompt says, and logs what it was started with.

const run = RunId.make('run-organs')
const project = ProjectId.make('p1')
const one = TicketId.make('fa-o1')
const two = TicketId.make('fa-o2')
const three = TicketId.make('fa-o3')
const anthropicModel = 'anthropic/claude-sonnet-4-5'
const realKey = 'sk-ant-real-key'

const sse = (events: ReadonlyArray<readonly [string, unknown]>) =>
  events
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join('')

const messageStart = (input: number) =>
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_01Organ',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: input,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 100,
          output_tokens: 1,
        },
      },
    },
  ] as const

const messageEnd = (stop: string, output: number) =>
  [
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: output },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ] as const

/** A provider's reply. */
interface Reply {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** Anthropic's stream of a call to `answer` with `input`, as its API sends it. */
const called = (input: unknown): Reply => ({
  status: 200,
  headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  body: sse([
    messageStart(25),
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_01Answer',
          name: 'answer',
          input: {},
        },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(input),
        },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ...messageEnd('tool_use', 50),
  ]),
})

/** Anthropic's stream of a reply that calls no tool. */
const spoke: Reply = {
  status: 200,
  headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  body: sse([
    messageStart(25),
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'It is the ticket.' },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ...messageEnd('end_turn', 5),
  ]),
}

const serverError: Reply = {
  status: 400,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'prompt is too long' },
  }),
}

const badKey: Reply = {
  status: 401,
  headers: { 'content-type': 'application/json' },
  body: anthropicBadKey,
}

/** What a recorded provider was asked. */
interface Seen {
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: Readonly<Record<string, unknown>>
}

const Body = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/** The hold's probes, which the provider answers apart: their one prompt is `Say OK.`. */
const isProbe = (body: string) => body.includes('Say OK.')

/**
 * A loopback provider answering each call that isn't a probe with the next of `replies`, or never
 * where it is `hang`; its probes as `probes` says.
 */
const recorded = (
  replies: Array<Reply | 'hang'>,
  probes: { accepted: boolean } = { accepted: true },
) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly url: string
      readonly seen: Array<Seen>
      /** Completed by each call as it comes, `seen`'s next. */
      readonly came: Array<() => void>
      readonly close: () => void
    }>(resume => {
      const seen: Array<Seen> = []
      const came: Array<() => void> = []
      const write = (response: ServerResponse, reply: Reply) => {
        response.writeHead(reply.status, reply.headers)
        response.end(reply.body)
      }
      const server = createServer((request, response) => {
        const chunks: Array<Buffer> = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (isProbe(text))
            return write(
              response,
              probes.accepted
                ? {
                    status: 200,
                    headers: { 'content-type': anthropicAnswer.contentType },
                    body: anthropicAnswer.body,
                  }
                : badKey,
            )
          seen.push({
            url: request.url ?? '',
            headers: request.headers,
            body: Schema.decodeSync(Body)(text),
          })
          came.shift()?.()
          const reply = replies.shift()
          if (reply === undefined) return write(response, serverError)
          if (reply !== 'hang') write(response, reply)
        })
      })
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        const address = server.address()
        const port =
          typeof address === 'object' && address !== null ? address.port : 0
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}`,
            seen,
            came,
            close: () => {
              server.close()
              server.closeAllConnections()
            },
          }),
        )
      })
    }),
    provider => Effect.sync(provider.close),
  )

const secrets = Secrets.of({
  store: 'file',
  set: () => Effect.void,
  list: Effect.succeed([]),
  get: () => Effect.succeed(Held.Key({ key: Redacted.make(realKey) })),
  read: () => Effect.succeedNone,
  modify: () => Effect.succeedNone,
  remove: () => Effect.succeed(false),
})

/** The store with every provider signed in to: a subscription's, as the proxy reads it for a grant. */
const signedIn = Secrets.of({
  ...secrets,
  read: () =>
    Effect.succeed(
      Option.some(
        Kept.OAuth({ provider: 'anthropic', credential: Redacted.make('{}') }),
      ),
    ),
})

const routesAt = (url: string): ReadonlyArray<ProviderRoute> => [
  {
    provider: 'anthropic',
    upstream: url,
    api: 'anthropic-messages',
    authentication: Authentication.Header({
      header: 'x-api-key',
      credential: SecretName.make('anthropic'),
    }),
  },
  {
    provider: 'openai',
    upstream: url,
    api: 'openai-responses',
    authentication: Authentication.Bearer({
      credential: SecretName.make('openai'),
    }),
  },
  {
    provider: 'openrouter',
    upstream: url,
    api: 'openai-completions',
    authentication: Authentication.Bearer({
      credential: SecretName.make('openrouter'),
    }),
  },
  {
    provider: 'google',
    upstream: url,
    api: 'google-generative-ai',
    authentication: Authentication.Header({
      header: 'x-goog-api-key',
      credential: SecretName.make('google'),
    }),
  },
]

// --- The boundaries the sessions' stub stands at ---------------------------------------------------

/**
 * A stub of `pi --mode rpc` that logs how it was started, and answers as its prompt's first word says:
 * `good` answers; `bad-then-good` gives an answer that doesn't decode, then one that does; `bad-twice`
 * two that don't, then waits; `pi-refuses-twice` reports two calls Pi's own check refused, which never
 * reach the engine, then waits; `hang-please` calls the model proxy, then answers;
 * `settles-held` calls the model proxy, then settles with none once the test writes its `release` file; `silent` settles with none; `unfinished` reports the session unfinished; `refused`
 * calls the model proxy, then settles with none, and answers on the prompt after; `tools` tries a
 * worker's tool and the verifier's, then answers.
 */
const STUB = `import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
const args = process.argv.slice(2)
const sessions = args[args.indexOf('--session-dir') + 1]
const note = entry => appendFileSync(join(sessions, '..', 'stub.jsonl'), JSON.stringify(entry) + '\\n')
note({
  event: 'start',
  cwd: process.cwd(),
  tools: args[args.indexOf('--tools') + 1],
  provider: args[args.indexOf('--provider') + 1],
  model: args[args.indexOf('--model') + 1],
  role: process.env.FABRICA_AGENT_ROLE,
  cores: process.env.FABRICA_CORES,
  goflags: process.env.GOFLAGS,
  answerTool: process.env.FABRICA_ANSWER_TOOL,
})
const out = record => process.stdout.write(JSON.stringify(record) + '\\n')
const respond = (id, command, data) =>
  out({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) })
const sessionId = 's-' + process.pid
process.on('SIGTERM', () => process.exit(0))
let socket
let pending = ''
let next = 0
const waiting = new Map()
const control = () => {
  if (socket !== undefined) return socket
  socket = connect(process.env.FABRICA_CONTROL_SOCKET)
  socket.setEncoding('utf8')
  socket.on('data', chunk => {
    pending += chunk
    for (let at = pending.indexOf('\\n'); at !== -1; at = pending.indexOf('\\n')) {
      const message = JSON.parse(pending.slice(0, at))
      pending = pending.slice(at + 1)
      if (message._tag !== 'Exit') continue
      const resolve = waiting.get(String(message.requestId))
      waiting.delete(String(message.requestId))
      resolve?.(message.exit)
    }
  })
  return socket
}
const toolEnd = (toolName, isError) =>
  out({ type: 'tool_execution_end', toolCallId: 'call-' + next, toolName, isError })
const answering = input =>
  call('answer', input).then(exit => toolEnd('answer', exit._tag !== 'Success'))
const call = (tag, payload) =>
  new Promise(resolve => {
    const id = String(next++)
    waiting.set(id, resolve)
    control().write(JSON.stringify({
      _tag: 'Request', id, tag, payload,
      headers: [['x-fabrica-control-token', process.env.FABRICA_CONTROL_TOKEN]],
    }) + '\\n')
  }).then(exit => {
    note({ event: 'call', tag, exit: exit._tag, cause: exit.cause })
    return exit
  })
const good = { answer: { cause: 'ticket' } }
const bad = { answer: { cause: 42 } }
const callProxy = async () => {
  const { providers } = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8'))
  const { baseUrl, apiKey } = providers.anthropic
  const response = await fetch(baseUrl + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
  })
  await response.text()
  note({ event: 'proxied', status: response.status })
}
let prompts = 0
const work = async message => {
  prompts += 1
  note({ event: 'prompt', message })
  if (/\\bgood-please\\b/.test(message)) return answering(good)
  if (/\\bbad-then-good\\b/.test(message)) {
    await answering(bad)
    return answering(good)
  }
  if (/\\bbad-twice\\b/.test(message)) {
    await answering(bad)
    await answering(bad)
    return new Promise(() => undefined)
  }
  if (/\\bpi-refuses-twice\\b/.test(message)) {
    toolEnd('answer', true)
    toolEnd('answer', true)
    return new Promise(() => undefined)
  }
  if (/\\bsettles-held\\b/.test(message)) {
    await callProxy()
    const release = join(sessions, '..', 'release')
    return new Promise(resolve => {
      const polling = setInterval(() => {
        if (!existsSync(release)) return
        clearInterval(polling)
        note({ event: 'released' })
        resolve()
      }, 10)
    })
  }
  if (/\\bhang-please\\b/.test(message)) {
    await callProxy()
    return answering(good)
  }
  if (/\\bunfinished-please\\b/.test(message)) return call('report_unfinished', {})
  if (/\\brefused-please\\b/.test(message)) return prompts > 1 ? answering(good) : callProxy()
  if (/carry on/.test(message)) return answering(good)
  if (/\\btools-please\\b/.test(message)) {
    await call('add_note', { body: 'an organ writes nothing' })
    await call('verdict', { verdict: { _tag: 'PASS', summary: 'Mine.', findings: [] } })
    return answering(good)
  }
}
const handle = command => {
  switch (command.type) {
    case 'get_state':
      return respond(command.id, 'get_state', { sessionId, sessionFile: join(sessions, sessionId + '.jsonl'), isStreaming: false, messageCount: 0 })
    case 'get_session_stats':
      return respond(command.id, 'get_session_stats', {
        sessionId,
        userMessages: 1,
        assistantMessages: 3,
        toolCalls: 2,
        totalMessages: 4,
        tokens: { input: 7, output: 8, cacheRead: 9, cacheWrite: 10, total: 34 },
        cost: 0,
      })
    case 'prompt':
      respond(command.id, 'prompt', { disposition: 'started' })
      return work(command.message)
        .catch(error => note({ event: 'error', message: String(error) }))
        .finally(() => out({ type: 'agent_settled', aborted: false }))
    case 'abort':
      note({ event: 'abort' })
      return respond(command.id, 'abort')
    default:
      return respond(command.id, command.type)
  }
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let at = buffer.indexOf('\\n'); at !== -1; at = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => process.exit(0))
`

const fixtures = { root: '', home: '', gitFolder: '', stub: '', extension: '' }
let counter = 0

beforeAll(() => {
  // Short, so the sockets' paths stay under the 103 bytes every platform takes.
  fixtures.root = realpathSync(mkdtempSync(join(tmpdir(), 'fab-org-')))
  fixtures.home = join(fixtures.root, 'home')
  mkdirSync(fixtures.home)
  fixtures.gitFolder = execFileSync('git', ['--exec-path'], {
    encoding: 'utf8',
  }).trim()
  fixtures.stub = join(fixtures.root, 'pi-stub.mjs')
  writeFileSync(fixtures.stub, STUB)
  fixtures.extension = join(fixtures.root, 'extension.mjs')
  writeFileSync(fixtures.extension, 'export default function () {}\n')
})

/** A project's folders of its own. */
const folders = () => {
  counter += 1
  const base = join(fixtures.root, `p${counter}`)
  const checkout = join(base, 'co')
  const sockets = join(base, 's')
  const data = join(base, 'd')
  mkdirSync(checkout, { recursive: true })
  return { checkout, sockets, data, agents: join(base, 'a') }
}

const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: {
    PATH: `${fixtures.gitFolder}:/usr/bin:/bin`,
    HOME: fixtures.home,
  },
  enginePriority: 0,
  priority: hostPriority,
  listProcesses,
  pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
  self: process.pid,
  killGrace: Duration.seconds(2),
  outputGrace: Duration.millis(200),
})

const gitConfig: GitConfig = {
  timeLimit: Duration.minutes(1),
  readRetries: { times: 2, spacing: Duration.zero },
}

/** The telemetry rows the runtime wrote. */
const telemetryOf = () => {
  const rows: Array<TelemetryRow> = []
  return {
    rows,
    layer: Layer.succeed(Telemetry)(
      Telemetry.of({
        record: row =>
          Effect.sync(() => {
            rows.push(row)
          }),
        flush: Effect.void,
        projectSpent: () => Effect.succeed(nothingMeasured),
      }),
    ),
  }
}

/** Every service the runtime runs on, live, the provider at `url`. */
const services = (input: {
  readonly url: string
  readonly place: ReturnType<typeof folders>
  readonly telemetry: Layer.Layer<Telemetry>
  readonly secrets?: typeof secrets
}) => {
  const runner = Layer.provideMerge(runnerLayer(runnerConfig()), layerClock)
  const git = Layer.provide(gitLayer(gitConfig), runner)
  const graph = Layer.effect(WorkGraph, makeWorkGraph({ prefix: 'fa' })).pipe(
    Layer.provideMerge(storeLayer(':memory:')),
  )
  const proxy = Layer.effect(
    ModelProxy,
    makeProxy({ routes: routesAt(input.url) }),
  ).pipe(
    Layer.provide(Layer.succeed(Secrets)(input.secrets ?? secrets)),
    Layer.provideMerge(layerHeld),
  )
  const agents = agentLayer({
    node: process.execPath,
    cli: fixtures.stub,
    extension: fixtures.extension,
    data: input.place.data,
    configRoot: input.place.agents,
    limits: {
      handshake: Duration.seconds(10),
      answer: Duration.seconds(10),
      abort: Duration.seconds(5),
      reap: Duration.seconds(5),
    },
    reaperPoll: Duration.millis(200),
    reaperGrace: Duration.millis(500),
  }).pipe(Layer.provide(runner))
  const attention = Layer.succeed(Attention)(
    Attention.of({
      permission: () =>
        Effect.succeed(PermissionDecision.cases.allow_run.make({})),
      autoAnswer: () => Effect.succeedNone,
    }),
  )
  const control = controlLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        checkOwnPassesLayer.pipe(Layer.provideMerge(graph)),
        git,
        Layer.provide(checksLayer, Layer.merge(runner, git)),
        Layer.provide(layerWake, noSleepCauses),
        attention,
      ),
    ),
  )
  return Layer.mergeAll(proxy, agents, control, input.telemetry, layerClock)
}

/** The project's settings, its organs as `organs` has them, each else on and on the project's model. */
const settingsOf = (
  overrides: Partial<ProjectSettings['organs']> = {},
  model: Option.Option<ModelChoice> = Option.some(choice(anthropicModel)),
): Pick<ProjectSettings, 'model' | 'organs'> => {
  const on = { enabled: true, model: Option.none() }
  return {
    model,
    organs: {
      triage: on,
      predictor: on,
      reviewer: on,
      scout: on,
      breakdown: on,
      ...overrides,
    },
  }
}

function choice(name: string): ModelChoice {
  const slash = name.indexOf('/')
  return {
    provider: name.slice(0, slash),
    model: name.slice(slash + 1),
    thinking: Option.none(),
  }
}

const Verdict = Schema.Struct({
  cause: Schema.Literals(['ticket', 'environment']),
})

const question = (
  ticket: TicketId,
  overrides: Partial<OrganQuestion<typeof Verdict.Type>> = {},
): OrganQuestion<typeof Verdict.Type> => ({
  organ: 'triage',
  ticket: Option.some(ticket),
  answer: Verdict,
  description: 'Why the ticket was set aside.',
  instructions: 'You triage set-aside tickets.',
  prompt: Effect.succeed(`Why was ${ticket} set aside?`),
  ...overrides,
})

/** A question through a session starts a process, on a machine others share. */
const sessionTimeout = 30_000

const goodAnswer = { answer: { cause: 'ticket' } }

/** A line stream that keeps nothing: the records are read from the log's subscription. */
const nowhere = (path: string) => ({ path, append: () => Effect.void })

/** The run's log in memory, and the records it has written. */
const memoryLog = Effect.gen(function* () {
  const log = yield* makeRunLog({
    run,
    events: nowhere('events.jsonl'),
    log: nowhere('run.log'),
  })
  const written = yield* log.subscribe
  return {
    log,
    records: Effect.map(
      PubSub.takeUpTo(written, 1_000),
      (taken): ReadonlyArray<RunEvent> => taken,
    ),
  }
}).pipe(Effect.provide(DateTime.layerCurrentZoneOffset(0)))

/** The runtime over the project's settings. */
const runtimeOf = (
  place: ReturnType<typeof folders>,
  overrides: Partial<OrganConfig> = {},
) =>
  makeOrganRuntime({
    project,
    run,
    checkout: place.checkout,
    projectTrusted: false,
    sockets: place.sockets,
    settings: settingsOf(),
    log: Option.none(),
    holds: Option.none(),
    billing: () => 'api_key',
    ...overrides,
  })

/** The provider, the services over it, and the telemetry they write. */
const setting = (replies: Array<Reply | 'hang'>, store = secrets) =>
  Effect.gen(function* () {
    const provider = yield* recorded(replies)
    const place = folders()
    const telemetry = telemetryOf()
    const context = yield* Layer.build(
      services({
        url: provider.url,
        place,
        telemetry: telemetry.layer,
        secrets: store,
      }),
    )
    return { provider, place, telemetry, context }
  })

const organRecords = (written: ReadonlyArray<RunEvent>) =>
  written.flatMap(event => (event.kind === 'organ' ? [event] : []))

/** How many of an outcome's questions have come to what. */
const tags = (outcomes: ReadonlyArray<{ readonly _tag: string }>) =>
  outcomes.map(({ _tag }) => _tag)

/** What the stub logged in the project's sessions folder. */
const stubLog = (place: ReturnType<typeof folders>) =>
  readFileSync(
    join(place.data, 'projects', project, 'sessions', 'stub.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map(line => Schema.decodeSync(Body)(line))

describe('an organ asking through pi-ai', () => {
  it.live(
    "decodes the forced answer tool's arguments, through the model proxy's accounting",
    () =>
      Effect.gen(function* () {
        const { provider, place, telemetry, context } = yield* setting([
          called(goodAnswer),
        ])
        const { log, records } = yield* memoryLog
        const account = yield* makeCostAccount({
          project,
          run,
          billing: () => 'api_key',
        }).pipe(Effect.provide(context))
        yield* countProxyCalls(account).pipe(Effect.provide(context))
        const runtime = yield* runtimeOf(place, {
          log: Option.some(log),
        }).pipe(Effect.provide(context))
        const outcome = yield* runtime.ask(question(one))
        if (!OrganOutcome.$is('Answered')(outcome))
          throw new Error(`expected an answer, got ${outcome._tag}`)
        expect(outcome.answer).toEqual({ cause: 'ticket' })
        expect(tokensOf(outcome.spend)).toEqual({
          input: 25,
          output: 50,
          cache_write: 10,
          cache_read: 100,
        })
        expect(Option.isSome(outcome.spend.costUsd)).toBe(true)
        // One forced tool, the organ's schema in its envelope, and no thinking beside it.
        const [asked] = provider.seen
        expect(asked?.url).toContain('/v1/messages')
        expect(asked?.headers['x-api-key']).toBe(realKey)
        expect(asked?.body['tool_choice']).toEqual({
          type: 'tool',
          name: 'answer',
        })
        expect(asked?.body['thinking']).toBeUndefined()
        expect(asked?.body['tools']).toMatchObject([
          {
            name: 'answer',
            description: 'Why the ticket was set aside.',
            input_schema: {
              properties: {
                answer: {
                  type: 'object',
                  properties: { cause: { enum: ['ticket', 'environment'] } },
                },
              },
            },
          },
        ])
        expect(JSON.stringify(asked?.body['system'])).toContain(
          'You triage set-aside tickets.',
        )
        const firstRecords = organRecords(yield* records)
        expect(firstRecords).toMatchObject([
          {
            organ: 'triage',
            ticket: one,
            outcome: 'answered',
            model: anthropicModel,
            tokens: {
              [anthropicModel]: {
                input: 25,
                output: 50,
                cache_write: 10,
                cache_read: 100,
              },
            },
            turns: 1,
          },
        ])
        expect(firstRecords[0]?.cost_usd).toBeGreaterThan(0)
        expect(
          telemetry.rows.filter(row => row._tag === 'OrganCall'),
        ).toMatchObject([
          {
            _tag: 'OrganCall',
            organ: 'triage',
            outcome: 'answered',
            ticket: one,
            run,
          },
        ])
        // The run's account counts the call as it does a worker's, to no ticket.
        expect(
          yield* account.run.pipe(
            Effect.map(({ untied, workers }) => [
              tokensOf(untied).output,
              tokensOf(workers).output,
            ]),
            Effect.repeat({
              until: ([untied]) => untied === 50,
            }),
          ),
        ).toEqual([50, 0])
      }),
  )

  it.live(
    'retries once with the decode error, and takes the second answer',
    () =>
      Effect.gen(function* () {
        const { provider, place, context } = yield* setting([
          called({ answer: { cause: 'weather' } }),
          called(goodAnswer),
        ])
        const { log, records } = yield* memoryLog
        const runtime = yield* runtimeOf(place, { log: Option.some(log) }).pipe(
          Effect.provide(context),
        )
        const outcome = yield* runtime.ask(question(one))
        expect(outcome).toMatchObject({
          _tag: 'Answered',
          answer: { cause: 'ticket' },
        })
        expect(provider.seen).toHaveLength(2)
        const messages = provider.seen[1]?.body['messages']
        expect(JSON.stringify(messages)).toContain('"is_error":true')
        expect(JSON.stringify(messages)).toContain('The answer was refused')
        expect(JSON.stringify(messages)).toContain('weather')
        expect(provider.seen[1]?.body['tool_choice']).toEqual({
          type: 'tool',
          name: 'answer',
        })
        expect(organRecords(yield* records)).toMatchObject([
          {
            outcome: 'answered',
            turns: 2,
            tokens: { [anthropicModel]: { output: 100 } },
          },
        ])
      }),
  )

  it.live('retries a reply that calls no tool, saying so', () =>
    Effect.gen(function* () {
      const { provider, place, context } = yield* setting([
        spoke,
        called(goodAnswer),
      ])
      const runtime = yield* runtimeOf(place).pipe(Effect.provide(context))
      expect(yield* runtime.ask(question(one))).toMatchObject({
        _tag: 'Answered',
      })
      expect(JSON.stringify(provider.seen[1]?.body['messages'])).toContain(
        "it didn't call answer",
      )
    }),
  )

  it.live(
    'retries no more than once: a second answer that fails to decode is lost',
    () =>
      Effect.gen(function* () {
        const { provider, place, telemetry, context } = yield* setting([
          called({ answer: { cause: 'weather' } }),
          called({ answer: 'not even an object' }),
          called(goodAnswer),
        ])
        const { log, records } = yield* memoryLog
        const runtime = yield* runtimeOf(place, {
          log: Option.some(log),
        }).pipe(Effect.provide(context))
        const outcome = yield* runtime.ask(question(one))
        expect(outcome).toMatchObject({ _tag: 'NoResult' })
        if (OrganOutcome.$is('NoResult')(outcome)) {
          expect(outcome.reason).toContain('failed to decode twice')
          expect(tokensOf(outcome.spend).output).toBe(100)
        }
        expect(provider.seen).toHaveLength(2)
        expect(organRecords(yield* records)).toMatchObject([
          { outcome: 'no_result', ticket: one, turns: 2 },
        ])
        expect(telemetry.rows).toMatchObject([
          { _tag: 'OrganCall', outcome: 'no_result' },
        ])
      }),
  )

  it.live(
    "a failure loses only its ticket's answer: the provider's, or a defect's; the queue goes on",
    () =>
      Effect.gen(function* () {
        const { provider, place, context } = yield* setting([
          called(goodAnswer),
          serverError,
          called(goodAnswer),
        ])
        const { log, records } = yield* memoryLog
        const runtime = yield* runtimeOf(place, {
          log: Option.some(log),
        }).pipe(Effect.provide(context))
        const defect = TicketId.make('fa-o4')
        const queue = [
          question(one),
          question(two),
          question(defect, {
            prompt: Effect.die(new Error('the ticket could not be read')),
          }),
          question(three),
        ]
        const outcomes = yield* Effect.forEach(queue, asked =>
          runtime.ask(asked),
        )
        expect(tags(outcomes)).toEqual([
          'Answered',
          'NoResult',
          'NoResult',
          'Answered',
        ])
        expect(outcomes[1]).toMatchObject({
          reason: expect.stringContaining('prompt is too long'),
        })
        expect(outcomes[2]).toMatchObject({
          reason: 'the ticket could not be read',
        })
        // The defect reached no model.
        expect(provider.seen).toHaveLength(3)
        expect(
          organRecords(yield* records).map(({ ticket, outcome }) => [
            ticket,
            outcome,
          ]),
        ).toEqual([
          [one, 'answered'],
          [two, 'no_result'],
          [defect, 'no_result'],
          [three, 'answered'],
        ])
      }),
  )

  it.live('calls nothing and records nothing for a disabled organ', () =>
    Effect.gen(function* () {
      const { provider, place, telemetry, context } = yield* setting([
        called(goodAnswer),
      ])
      const { log, records } = yield* memoryLog
      const runtime = yield* runtimeOf(place, {
        log: Option.some(log),
        settings: settingsOf({
          triage: { enabled: false, model: Option.none() },
        }),
      }).pipe(Effect.provide(context))
      const outcome = yield* runtime.ask(question(one))
      expect(outcome).toEqual(OrganOutcome.Disabled())
      const inSession = yield* runtime.session({ ...question(one), cores: 1 })
      expect(inSession).toEqual(OrganOutcome.Disabled())
      expect(provider.seen).toEqual([])
      expect(yield* records).toEqual([])
      expect(telemetry.rows).toEqual([])
    }),
  )

  it.live(
    "calls organs.<name>.model where it is set, else the project's; with neither, its answer is lost",
    () =>
      Effect.gen(function* () {
        const { provider, place, context } = yield* setting([
          called(goodAnswer),
          called(goodAnswer),
        ])
        const named = 'anthropic/claude-opus-4-5'
        const runtime = yield* runtimeOf(place, {
          settings: settingsOf({
            predictor: { enabled: true, model: Option.some(choice(named)) },
          }),
        }).pipe(Effect.provide(context))
        yield* runtime.ask(question(one, { organ: 'predictor' }))
        yield* runtime.ask(question(one))
        expect(provider.seen.map(({ body }) => body['model'])).toEqual([
          'claude-opus-4-5',
          'claude-sonnet-4-5',
        ])
        const none = yield* runtimeOf(place, {
          settings: settingsOf({}, Option.none()),
        }).pipe(Effect.provide(context))
        expect(yield* none.ask(question(one))).toMatchObject({
          _tag: 'NoResult',
          reason: expect.stringContaining('organs.triage.model'),
        })
        const unknown = yield* runtimeOf(place, {
          settings: settingsOf({}, Option.some(choice('anthropic/no-such'))),
        }).pipe(Effect.provide(context))
        expect(yield* unknown.ask(question(one))).toMatchObject({
          _tag: 'NoResult',
          reason: expect.stringContaining('catalog'),
        })
        expect(provider.seen).toHaveLength(2)
      }),
  )

  it.live(
    "tells each API the proxy passes to force the tool, in that API's words",
    () =>
      Effect.gen(function* () {
        const { provider, place, context } = yield* setting([])
        const on = (name: 'openai' | 'openrouter' | 'google', api: string) => {
          const found = getBuiltinModels(name).find(model => model.api === api)
          if (found === undefined) throw new Error(`no ${api} model of ${name}`)
          return `${name}/${found.id}`
        }
        const forcedOn = (model: string) =>
          Effect.gen(function* () {
            const runtime = yield* runtimeOf(place, {
              settings: settingsOf({}, Option.some(choice(model))),
            }).pipe(Effect.provide(context))
            // The provider has no replies left: what matters here is what it was asked.
            yield* runtime.ask(question(one))
            return provider.seen.at(-1)
          })
        const responses = yield* forcedOn(on('openai', 'openai-responses'))
        expect(responses?.url).toContain('/responses')
        expect(responses?.body['tool_choice']).toEqual({
          type: 'function',
          name: 'answer',
        })
        const completions = yield* forcedOn(
          on('openrouter', 'openai-completions'),
        )
        expect(completions?.url).toContain('/chat/completions')
        expect(completions?.body['tool_choice']).toEqual({
          type: 'function',
          function: { name: 'answer' },
        })
        const google = yield* forcedOn(on('google', 'google-generative-ai'))
        expect(JSON.stringify(google?.body)).toContain('"mode":"ANY"')
        expect(JSON.stringify(google?.body)).toContain('"name":"answer"')
      }),
  )

  it.live(
    "on a subscription, sends what an agent's Pi would: the placeholder, so the request is the subscription's",
    () =>
      Effect.gen(function* () {
        const { provider, place, context } = yield* setting(
          [called(goodAnswer)],
          signedIn,
        )
        const runtime = yield* runtimeOf(place).pipe(Effect.provide(context))
        expect(yield* runtime.ask(question(one))).toMatchObject({
          _tag: 'Answered',
        })
        expect(provider.seen[0]?.headers['anthropic-beta']).toContain('oauth-')
        expect(provider.seen[0]?.headers['x-api-key']).toBe(realKey)
      }),
  )

  it.effect(
    'loses the answer of a call past its limit, counted by the deadlines, and goes on',
    () =>
      Effect.gen(function* () {
        const { provider, place, context } = yield* setting([
          'hang',
          called(goodAnswer),
        ])
        const runtime = yield* runtimeOf(place, {
          limits: {
            call: Duration.minutes(1),
            session: Duration.minutes(1),
          },
        }).pipe(Effect.provide(context))
        const reached = yield* Deferred.make<void>()
        provider.came.push(() => Deferred.doneUnsafe(reached, Exit.void))
        const hanging = yield* Effect.forkChild(runtime.ask(question(one)))
        yield* Deferred.await(reached)
        yield* TestClock.adjust(Duration.minutes(1))
        expect(yield* Fiber.join(hanging)).toMatchObject({
          _tag: 'NoResult',
          reason: expect.stringContaining('within'),
        })
        expect(yield* runtime.ask(question(two))).toMatchObject({
          _tag: 'Answered',
        })
      }),
    sessionTimeout,
  )
})

describe("an organ's refused call", () => {
  const anthropic = 'anthropic'
  const key: HoldKey = { hold: 'CREDENTIALS', provider: anthropic }

  it.effect(
    'a refused credential holds the run as a worker’s does: no answer lost, no further call until it lifts',
    () =>
      Effect.gen(function* () {
        const probes = { accepted: false }
        const provider = yield* recorded(
          [called(goodAnswer), badKey, called(goodAnswer), called(goodAnswer)],
          probes,
        )
        const place = folders()
        const telemetry = telemetryOf()
        const context = yield* Layer.build(
          services({ url: provider.url, place, telemetry: telemetry.layer }),
        )
        const { log, records } = yield* memoryLog
        const holds = yield* makeHolds({ log, running: Effect.succeed(1) })
        const proxy = yield* Effect.provide(ModelProxy, context)
        const credentials = yield* makeCredentialsHold({
          holds,
          log,
          run,
          wait: Duration.hours(6),
          events: yield* proxy.events,
          probe: call => proxy.probe({ ...call, run }),
          modelFor: () => Option.some(ModelName.make(anthropicModel)),
        })
        const permits = yield* Effect.provide(Permits, context)
        yield* permits.hold({
          run,
          held: holds.changes.pipe(Stream.map(heldProviders)),
        })
        const organHolds: OrganHolds = {
          usage: { waitOut: () => Effect.void },
          credentials,
          held: holds.changes.pipe(Stream.map(heldProviders)),
        }
        const runtime = yield* runtimeOf(place, {
          log: Option.some(log),
          holds: Option.some(organHolds),
        }).pipe(Effect.provide(context))
        // A call goes through, so that the next one refused is the credentials hold's (§12.9).
        expect(yield* runtime.ask(question(one))).toMatchObject({
          _tag: 'Answered',
        })
        const refused = yield* Effect.forkChild(runtime.ask(question(two)))
        yield* holds.changes.pipe(
          Stream.filter(current => isOn(current, key)),
          Stream.runHead,
        )
        expect(provider.seen).toHaveLength(2)
        // Another ticket's question waits on the hold, spending no call to find it.
        const waiting = yield* Effect.forkChild(runtime.ask(question(three)))
        yield* TestClock.adjust(CREDENTIALS_PROBE)
        expect(provider.seen).toHaveLength(2)
        expect(refused.pollUnsafe()).toBeUndefined()
        expect(waiting.pollUnsafe()).toBeUndefined()
        probes.accepted = true
        yield* TestClock.adjust(CREDENTIALS_PROBE)
        expect(yield* Fiber.join(refused)).toMatchObject({ _tag: 'Answered' })
        expect(yield* Fiber.join(waiting)).toMatchObject({ _tag: 'Answered' })
        expect(provider.seen).toHaveLength(4)
        expect(
          organRecords(yield* records).map(({ outcome }) => outcome),
        ).not.toContain('no_result')
      }),
    sessionTimeout,
  )

  it.live(
    'a usage limit waits out its hold with the reset it named, then goes again',
    () =>
      Effect.gen(function* () {
        const resetSeconds = Math.floor(Date.now() / 1000) + 3600
        const { provider, place, context } = yield* setting([
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'anthropic-ratelimit-unified-reset': String(resetSeconds),
            },
            body: JSON.stringify({
              type: 'error',
              error: { type: 'rate_limit_error', message: 'usage limit' },
            }),
          },
          called(goodAnswer),
        ])
        const waits: Array<unknown> = []
        const runtime = yield* runtimeOf(place, {
          holds: Option.some({
            usage: {
              waitOut: input =>
                Effect.sync(() => {
                  waits.push(input)
                }),
            },
            credentials: { waitOut: () => Effect.void },
            held: Stream.make(new Set<string>()),
          }),
        }).pipe(Effect.provide(context))
        expect(yield* runtime.ask(question(one))).toMatchObject({
          _tag: 'Answered',
        })
        expect(waits).toEqual([
          {
            ticket: Option.none(),
            provider: 'anthropic',
            resetAt: DateTime.makeUnsafe(resetSeconds * 1000),
          },
        ])
        expect(provider.seen).toHaveLength(2)
      }),
  )

  const rateLimited = (headers: Readonly<Record<string, string>>): Reply => ({
    status: 429,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down' },
    }),
  })

  /** Deadlines that never pass a limit of `limit`, and let any other wait through at once, keeping it. */
  const slept = (limit: Duration.Duration) => {
    const waits: Array<Duration.Duration> = []
    return {
      waits,
      deadlines: Deadlines.of({
        sleep: duration =>
          Duration.equals(Duration.fromInputUnsafe(duration), limit)
            ? Effect.never
            : Effect.sync(() => {
                waits.push(Duration.fromInputUnsafe(duration))
              }),
      }),
    }
  }

  it.live(
    'a rate limit backs off as a worker’s does, as long as the provider asks, then goes again',
    () =>
      Effect.gen(function* () {
        const { provider, place, context } = yield* setting([
          rateLimited({ 'retry-after': '120' }),
          rateLimited({}),
          called(goodAnswer),
        ])
        const limit = Duration.minutes(10)
        const clock = slept(limit)
        const runtime = yield* runtimeOf(place, {
          limits: { call: limit, session: limit },
        }).pipe(
          Effect.provideService(Deadlines, clock.deadlines),
          Effect.provide(context),
        )
        expect(yield* runtime.ask(question(one))).toMatchObject({
          _tag: 'Answered',
        })
        expect(provider.seen).toHaveLength(3)
        // The provider's 120 s over the backoff's first 30 s; then the backoff's second, 60 s.
        expect(clock.waits.map(Duration.toSeconds)).toEqual([120, 60])
      }),
  )

  it.live('a rate limit past its backoff loses that answer alone', () =>
    Effect.gen(function* () {
      const { provider, place, context } = yield* setting([
        rateLimited({}),
        rateLimited({}),
        called(goodAnswer),
      ])
      const limit = Duration.minutes(10)
      const runtime = yield* runtimeOf(place, {
        limits: { call: limit, session: limit },
        backoff: Schedule.exponential(Duration.seconds(1)).pipe(
          Schedule.upTo({ times: 1 }),
        ),
      }).pipe(
        Effect.provideService(Deadlines, slept(limit).deadlines),
        Effect.provide(context),
      )
      const outcomes = yield* Effect.forEach(
        [question(one), question(two)],
        asked => runtime.ask(asked),
      )
      expect(tags(outcomes)).toEqual(['NoResult', 'Answered'])
      expect(provider.seen).toHaveLength(3)
    }),
  )

  /** The holds' held providers, which a test changes, as a run's holds do. */
  const heldBy = Effect.gen(function* () {
    const held = yield* SubscriptionRef.make<ReadonlySet<string>>(new Set())
    const holds: OrganHolds = {
      usage: { waitOut: () => Effect.void },
      credentials: { waitOut: () => Effect.void },
      held: SubscriptionRef.changes(held),
    }
    return { held, holds }
  })

  /** Lets the fibers waiting on what just changed see it, before the clock moves. */
  const settled = Effect.repeat(Effect.yieldNow, { times: 20 })

  it.effect(
    "a call's limit doesn't count while its provider is held, and counts again from the lift",
    () =>
      Effect.gen(function* () {
        const { provider, place, context } = yield* setting(['hang'])
        const { held, holds } = yield* heldBy
        const limit = Duration.minutes(1)
        const runtime = yield* runtimeOf(place, {
          holds: Option.some(holds),
          limits: { call: limit, session: limit },
        }).pipe(Effect.provide(context))
        const reached = yield* Deferred.make<void>()
        provider.came.push(() => Deferred.doneUnsafe(reached, Exit.void))
        const asking = yield* Effect.forkChild(runtime.ask(question(one)))
        yield* Deferred.await(reached)
        yield* settled
        yield* SubscriptionRef.set(held, new Set(['anthropic']))
        yield* settled
        yield* TestClock.adjust(Duration.hours(5))
        expect(asking.pollUnsafe()).toBeUndefined()
        yield* SubscriptionRef.set(held, new Set<string>())
        yield* settled
        yield* TestClock.adjust(Duration.seconds(59))
        expect(asking.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust(Duration.seconds(1))
        expect(yield* Fiber.join(asking)).toMatchObject({
          _tag: 'NoResult',
          reason: expect.stringContaining('within'),
        })
      }),
    sessionTimeout,
  )

  it.live(
    "a session's turn outlasts a hold on its provider: no limit waits during it, and one waits again from the lift",
    () =>
      Effect.gen(function* () {
        const { provider, place, context } = yield* setting(['hang'])
        const { held, holds } = yield* heldBy
        const sleepers = new Set<Deferred.Deferred<void>>()
        const sleeping = (count: number) =>
          Effect.repeat(
            Effect.sync(() => sleepers.size),
            { until: size => size === count },
          )
        const passLimit = Effect.sync(() => {
          for (const sleeper of sleepers)
            Deferred.doneUnsafe(sleeper, Exit.void)
        })
        const runtime = yield* runtimeOf(place, {
          holds: Option.some(holds),
        }).pipe(
          Effect.provideService(
            Deadlines,
            Deadlines.of({
              sleep: () =>
                Effect.acquireUseRelease(
                  Effect.tap(Deferred.make<void>(), sleeper =>
                    Effect.sync(() => sleepers.add(sleeper)),
                  ),
                  Deferred.await,
                  sleeper => Effect.sync(() => sleepers.delete(sleeper)),
                ),
            }),
          ),
          Effect.provide(context),
        )
        const reached = yield* Deferred.make<void>()
        provider.came.push(() => Deferred.doneUnsafe(reached, Exit.void))
        const asking = yield* Effect.forkChild(
          runtime.session({
            ...question(one, { prompt: Effect.succeed('hang-please') }),
            cores: 1,
          }),
        )
        yield* Deferred.await(reached)
        yield* sleeping(1)
        yield* SubscriptionRef.set(held, new Set(['anthropic']))
        // The hold stops the turn's limit: nothing is left to pass.
        yield* sleeping(0)
        yield* passLimit
        expect(asking.pollUnsafe()).toBeUndefined()
        yield* SubscriptionRef.set(held, new Set<string>())
        yield* sleeping(1)
        yield* passLimit
        expect(yield* Fiber.join(asking)).toMatchObject({
          _tag: 'NoResult',
          reason: expect.stringContaining('within'),
        })
      }),
    sessionTimeout,
  )

  it.live(
    "a session's turn that a hold outlasts settles with no refusal of its own: it waits for the lift and carries on",
    () =>
      Effect.gen(function* () {
        const { provider, place, context } = yield* setting([
          called(goodAnswer),
        ])
        const { held, holds } = yield* heldBy
        yield* (yield* Effect.provide(Permits, context)).hold({
          run,
          held: holds.held,
        })
        const runtime = yield* runtimeOf(place, {
          holds: Option.some(holds),
        }).pipe(Effect.provide(context))
        const reached = yield* Deferred.make<void>()
        provider.came.push(() => Deferred.doneUnsafe(reached, Exit.void))
        const asking = yield* Effect.forkChild(
          runtime.session({
            ...question(one, { prompt: Effect.succeed('settles-held') }),
            cores: 1,
          }),
        )
        yield* Deferred.await(reached)
        yield* settled
        yield* SubscriptionRef.set(held, new Set(['anthropic']))
        yield* settled
        const sessions = join(place.data, 'projects', project, 'sessions')
        writeFileSync(join(sessions, 'release'), '')
        // Its turn is ending, and the session waits on the hold, not giving up its answer.
        yield* Effect.repeat(
          Effect.sync(() =>
            stubLog(place).some(entry => entry['event'] === 'released'),
          ),
          { until: released => released },
        )
        expect(asking.pollUnsafe()).toBeUndefined()
        expect(
          stubLog(place).filter(entry => entry['event'] === 'prompt'),
        ).toHaveLength(1)
        yield* SubscriptionRef.set(held, new Set<string>())
        expect(yield* Fiber.join(asking)).toMatchObject({
          _tag: 'Answered',
          answer: { cause: 'ticket' },
        })
        const prompts = stubLog(place).filter(
          entry => entry['event'] === 'prompt',
        )
        expect(prompts).toHaveLength(2)
        expect(prompts[1]?.['message']).toContain('carry on')
        // With no hold in its turn, a session that settles with no answer has lost it.
        expect(
          yield* runtime.session({
            ...question(two, { prompt: Effect.succeed('silent') }),
            cores: 1,
          }),
        ).toMatchObject({
          _tag: 'NoResult',
          reason: 'its session settled with no answer',
        })
      }),
    sessionTimeout,
  )

  it.live(
    'outside a run, with no holds to wait on, a refusal loses the answer',
    () =>
      Effect.gen(function* () {
        const { place, context } = yield* setting([called(goodAnswer), badKey])
        const runtime = yield* runtimeOf(place).pipe(Effect.provide(context))
        yield* runtime.ask(question(one))
        expect(yield* runtime.ask(question(two))).toMatchObject({
          _tag: 'NoResult',
        })
      }),
  )
})

describe('an organ asking through a short Pi session', () => {
  const sessionQuestion = (word: string) => ({
    ...question(one, {
      prompt: Effect.succeed(`${word}: why was it set aside?`),
    }),
    cores: 3,
  })

  it.live(
    'runs read-only in the checkout on its model, its core share in its environment, and takes the answer',
    () =>
      Effect.gen(function* () {
        const { place, telemetry, context } = yield* setting([])
        const { log, records } = yield* memoryLog
        const runtime = yield* runtimeOf(place, {
          log: Option.some(log),
        }).pipe(Effect.provide(context))
        const outcome = yield* runtime.session(sessionQuestion('good-please'))
        if (!OrganOutcome.$is('Answered')(outcome))
          throw new Error(`expected an answer, got ${JSON.stringify(outcome)}`)
        expect(outcome.answer).toEqual({ cause: 'ticket' })
        const [start, prompt] = stubLog(place)
        expect(start).toMatchObject({
          event: 'start',
          cwd: realpathSync(place.checkout),
          tools: organSessionTools.join(','),
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          role: 'organ',
          cores: '3',
          goflags: '-p=3',
        })
        expect(organSessionTools).not.toContain('bash')
        expect(organSessionTools).not.toContain('write')
        expect(organSessionTools).not.toContain('edit')
        expect(
          Schema.decodeUnknownSync(Body)(start?.['answerTool']),
        ).toMatchObject({
          name: 'answer',
          description: 'Why the ticket was set aside.',
          parameters: { properties: { answer: { type: 'object' } } },
        })
        expect(prompt?.['message']).toContain('You triage set-aside tickets.')
        expect(prompt?.['message']).toContain('good-please: why')
        expect(organRecords(yield* records)).toMatchObject([
          {
            organ: 'triage',
            outcome: 'answered',
            turns: 3,
            tokens: {
              [anthropicModel]: {
                input: 7,
                output: 8,
                cache_read: 9,
                cache_write: 10,
              },
            },
          },
        ])
        expect(telemetry.rows).toHaveLength(1)
      }),
    sessionTimeout,
  )

  it.live(
    'gives back an answer that fails to decode, once, and takes the next',
    () =>
      Effect.gen(function* () {
        const { place, context } = yield* setting([])
        const runtime = yield* runtimeOf(place).pipe(Effect.provide(context))
        expect(
          yield* runtime.session(sessionQuestion('bad-then-good')),
        ).toMatchObject({ _tag: 'Answered', answer: { cause: 'ticket' } })
        const calls = stubLog(place).filter(entry => entry['event'] === 'call')
        expect(calls.map(({ exit }) => exit)).toEqual(['Failure', 'Success'])
      }),
    sessionTimeout,
  )

  it.live(
    "counts the calls Pi's own check refuses, which the engine never hears of",
    () =>
      Effect.gen(function* () {
        const { place, context } = yield* setting([])
        const runtime = yield* runtimeOf(place).pipe(Effect.provide(context))
        expect(
          yield* runtime.session(sessionQuestion('pi-refuses-twice')),
        ).toMatchObject({
          _tag: 'NoResult',
          reason: 'its answer was refused twice',
        })
        expect(
          stubLog(place).filter(entry => entry['event'] === 'call'),
        ).toEqual([])
      }),
    sessionTimeout,
  )

  it.live(
    'loses the answer of a second that fails to decode, and of a session that settles with none',
    () =>
      Effect.gen(function* () {
        const { place, context } = yield* setting([])
        const runtime = yield* runtimeOf(place).pipe(Effect.provide(context))
        const outcomes = yield* Effect.forEach(
          ['bad-twice', 'silent', 'unfinished-please'],
          word => runtime.session(sessionQuestion(word)),
        )
        expect(tags(outcomes)).toEqual(['NoResult', 'NoResult', 'NoResult'])
        expect(outcomes[0]).toMatchObject({
          reason: 'its answer was refused twice',
        })
        expect(outcomes[1]).toMatchObject({
          reason: 'its session settled with no answer',
        })
        expect(outcomes[2]).toMatchObject({
          reason: expect.stringMatching(/settled (twice )?with no answer/u),
        })
      }),
    sessionTimeout,
  )

  it.live(
    "refuses a worker's tool and the verifier's to it",
    () =>
      Effect.gen(function* () {
        const { place, context } = yield* setting([])
        const runtime = yield* runtimeOf(place).pipe(Effect.provide(context))
        expect(
          yield* runtime.session(sessionQuestion('tools-please')),
        ).toMatchObject({ _tag: 'Answered' })
        const calls = stubLog(place).filter(entry => entry['event'] === 'call')
        expect(calls.map(({ tag, exit }) => [tag, exit])).toEqual([
          ['add_note', 'Failure'],
          ['verdict', 'Failure'],
          ['answer', 'Success'],
        ])
        expect(JSON.stringify(calls[0])).toContain("an organ's session")
      }),
    sessionTimeout,
  )

  it.live(
    'a refused turn waits out its hold, and the session carries on to its answer',
    () =>
      Effect.gen(function* () {
        const { provider, place, context } = yield* setting([
          called(goodAnswer),
          badKey,
        ])
        const waits: Array<unknown> = []
        const runtime = yield* runtimeOf(place, {
          holds: Option.some({
            usage: { waitOut: () => Effect.void },
            credentials: {
              waitOut: input =>
                Effect.sync(() => {
                  waits.push(input)
                }),
            },
            held: Stream.make(new Set<string>()),
          }),
        }).pipe(Effect.provide(context))
        // A call goes through first, so that the session's refused one is the credentials hold's.
        yield* runtime.ask(question(two))
        expect(
          yield* runtime.session(sessionQuestion('refused-please')),
        ).toMatchObject({ _tag: 'Answered' })
        expect(waits).toMatchObject([
          { provider: 'anthropic', ticket: Option.none() },
        ])
        expect(provider.seen).toHaveLength(2)
        const prompts = stubLog(place).filter(
          entry => entry['event'] === 'prompt',
        )
        expect(prompts).toHaveLength(2)
        expect(prompts[1]?.['message']).toContain('carry on')
      }),
    sessionTimeout,
  )
})

describe('the answer tool on the control channel', () => {
  const callAs = (role: ControlRole) =>
    Effect.gen(function* () {
      const { place, context } = yield* setting([])
      const control = yield* (yield* Effect.provide(
        ControlServer,
        context,
      )).open({
        project,
        ticket: one,
        session: SessionId.make('s-answer'),
        role,
        worktree: place.checkout,
        folder: place.sockets,
        questionWait: Duration.zero,
        checkOwn: {
          command: CommandSetting.cases.Unset.make({}),
          checkout: place.checkout,
          timeLimit: Duration.minutes(1),
          cores: 1,
          nice: Option.none(),
        },
        mergeStanding: Effect.succeed('not_queued'),
      })
      const clientContext = yield* Layer.build(
        Layer.mergeAll(
          RpcClient.layerProtocolSocket().pipe(
            Layer.provide(NodeSocket.layerNet({ path: control.socket })),
            Layer.provide(RpcSerialization.layerNdjson),
          ),
          controlTokenClient(control.environment[ControlTokenVariable] ?? ''),
        ),
      )
      const client = yield* Effect.provide(
        RpcClient.make(ControlRpcs),
        clientContext,
      )
      return yield* Effect.exit(client.answer({ answer: { cause: 'ticket' } }))
    })

  it.live(
    "is refused to a worker and to a verifier, and is an organ's to take",
    () =>
      Effect.gen(function* () {
        const worker = yield* callAs(ControlRole.Worker())
        expect(JSON.stringify(worker)).toContain("answer is an organ's tool")
        const verifier = yield* callAs(ControlRole.Verifier({ round: 1 }))
        expect(JSON.stringify(verifier)).toContain("answer is an organ's tool")
        const taken: Array<unknown> = []
        const organ = yield* callAs(
          ControlRole.Organ({
            answer: given =>
              Effect.sync(() => {
                taken.push(given)
              }),
          }),
        )
        expect(organ._tag).toBe('Success')
        expect(taken).toEqual([{ cause: 'ticket' }])
      }),
  )
})
