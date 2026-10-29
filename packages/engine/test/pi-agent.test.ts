import {
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Scope,
  Stream,
} from 'effect'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { ProjectId, TicketId } from '@fabrica/contracts'

import {
  type AgentStart,
  PiAgent,
  type PiAgentConfig,
  type PiEvent,
  PiRecord,
  layer as agentLayer,
  readRecord,
  reaperArguments,
  sessionFolder,
  splitRecords,
} from '../src/agent'
import {
  ProcessRunner,
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'

// The live PiAgent over a scripted Pi RPC stream (spec §24, H78): the only stand-in is the process at
// the boundary, a stub of Pi's CLI that speaks its RPC protocol as Pi 1.4.0 does, run by the Node
// running the tests. What the stub saw (its arguments, environment, the commands it read, the
// signals it got) it writes to a log the test reads.

/**
 * A stub of `pi --mode rpc`: answers commands by `id`, writes a prompt's records (an unknown kind and
 * a record missing a field among them, a U+2028 inside a string), and behaves as `STUB_MODE` says:
 * `long` (a turn that runs until aborted), `wedged` (answers no abort, ignores SIGTERM), `slow-exit`
 * (exits a while after SIGTERM), `slow-abort` (answers an abort a while later), `silent` (answers
 * nothing), `exit-at-start`, `with-child` (starts a child in a group of its own, as Pi's bash tool
 * does), `dialog` (an extension asks the UI before the turn settles).
 */
const STUB = `import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const mode = process.env.STUB_MODE ?? 'normal'
const note = entry => appendFileSync(process.env.STUB_LOG, JSON.stringify({ pid: process.pid, ...entry }) + '\\n')
const args = process.argv.slice(2)
const sessions = args[args.indexOf('--session-dir') + 1]
const config = process.env.PI_CODING_AGENT_DIR
note({
  event: 'start',
  args,
  cwd: process.cwd(),
  env: Object.keys(process.env).sort(),
  config,
  models: JSON.parse(readFileSync(join(config, 'models.json'), 'utf8')),
})
if (mode === 'exit-at-start') {
  process.stderr.write('no model configured\\n')
  process.exit(3)
}
if (mode === 'with-child') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  note({ event: 'child', child: child.pid })
}
process.on('SIGTERM', () => {
  note({ event: 'sigterm' })
  if (mode === 'wedged') return
  const exit = () => {
    note({ event: 'exit' })
    process.exit(0)
  }
  if (mode === 'slow-exit') setTimeout(exit, 300)
  else exit()
})
let sessionId = 's-' + process.pid
let sessionFile = join(sessions, sessionId + '.jsonl')
let turn = false
const out = record => process.stdout.write(JSON.stringify(record) + '\\n')
const respond = (id, command, data) =>
  out({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) })
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01 } }
const settle = aborted => {
  turn = false
  out({ type: 'agent_end', messages: [], willRetry: false })
  out({ type: 'agent_settled', aborted })
}
const handle = command => {
  note({ event: 'command', type: command.type, command })
  if (mode === 'silent') return
  switch (command.type) {
    case 'get_state':
      return respond(command.id, 'get_state', { sessionId, sessionFile, isStreaming: turn, messageCount: 0 })
    case 'prompt':
      respond(command.id, 'prompt', { disposition: 'started' })
      turn = true
      out({ type: 'agent_start' })
      if (mode === 'long') return
      out({ type: 'mystery_kind', detail: 1 })
      out({ type: 'mystery_kind', detail: 2 })
      out({ type: 'tool_execution_start', toolCallId: 't1' })
      out({ type: 'message_start', message: { role: 'assistant' } })
      out({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', delta: 'one\\u2028two' } })
      out({ type: 'message_end', message: { role: 'assistant', provider: 'anthropic', model: 'claude-x', usage, content: 'one\\u2028two' } })
      if (mode === 'dialog') {
        out({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Sure?', message: 'Go on?' })
        out({ type: 'extension_ui_request', id: 'ui-2', method: 'notify', message: 'fyi' })
        return
      }
      return settle(false)
    case 'steer':
      return respond(command.id, 'steer', { disposition: 'queued' })
    case 'abort': {
      if (mode === 'wedged') return
      const answer = () => {
        respond(command.id, 'abort')
        if (turn) settle(true)
      }
      if (mode === 'slow-abort') setTimeout(answer, 500)
      else answer()
      return
    }
    case 'set_model':
      return respond(command.id, 'set_model', { provider: command.provider, id: command.modelId })
    case 'switch_session':
      sessionFile = command.sessionPath
      return respond(command.id, 'switch_session', { cancelled: false })
    case 'fork':
      return respond(command.id, 'fork', { text: 'forked at ' + command.entryId, cancelled: false })
    case 'get_session_stats':
      return respond(command.id, 'get_session_stats', {
        sessionId, sessionFile, userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.01,
      })
    case 'extension_ui_response':
      note({ event: 'ui-response', id: command.id, cancelled: command.cancelled === true })
      if (command.id === 'ui-1') settle(false)
      return
    default:
      return out({ id: command.id, type: 'response', command: command.type, success: false, error: 'Unknown command' })
  }
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let index = buffer.indexOf('\\n'); index !== -1; index = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => {
  note({ event: 'stdin-end' })
  if (mode !== 'wedged') process.exit(0)
})
`

/** A process that starts a child in a group of its own and says both pids in `ready`, then waits. */
const PARENT = `import { spawn } from 'node:child_process'
import { renameSync, writeFileSync } from 'node:fs'
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
const ready = process.argv[2]
writeFileSync(ready + '.tmp', process.pid + ' ' + child.pid)
renameSync(ready + '.tmp', ready)
setInterval(() => {}, 1000)
`

let root = ''
let stub = ''
let parent = ''
let worktree = ''
let extension = ''

beforeAll(() => {
  // Real, as the stub's working folder reads it: macOS's temp folder is behind a link.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-pi-agent-')))
  stub = join(root, 'pi-stub.mjs')
  writeFileSync(stub, STUB)
  parent = join(root, 'parent.mjs')
  writeFileSync(parent, PARENT)
  worktree = join(root, 'worktree')
  mkdirSync(worktree)
  extension = join(root, 'extension.js')
  writeFileSync(extension, 'export default function () {}\n')
})

const PATH = () => `${dirname(process.execPath)}:/usr/bin:/bin`

const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: {
    PATH: PATH(),
    HOME: root,
    LANG: 'C',
    ANTHROPIC_API_KEY: 'never passed',
    CLAUDECODE: '1',
  },
  enginePriority: 0,
  priority: hostPriority,
  listProcesses,
  pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
  self: process.pid,
  killGrace: Duration.millis(500),
  outputGrace: Duration.millis(200),
})

/** Each test's own data folder and configuration root, so their files never meet. */
const folders = (name: string) => {
  const base = join(root, name)
  mkdirSync(base)
  return {
    data: join(base, 'data'),
    configRoot: join(base, 'agents'),
    log: join(base, 'stub.log'),
  }
}

const agentConfig = (
  name: string,
  limits: Partial<PiAgentConfig['limits']> = {},
): PiAgentConfig & { readonly log: string } => {
  const { data, configRoot, log } = folders(name)
  return {
    node: process.execPath,
    cli: stub,
    extension,
    data,
    configRoot,
    limits: {
      handshake: Duration.seconds(10),
      answer: Duration.seconds(10),
      abort: Duration.seconds(5),
      reap: Duration.seconds(5),
      ...limits,
    },
    reaperPoll: Duration.millis(200),
    reaperGrace: Duration.millis(500),
    log,
  }
}

const services = (config: PiAgentConfig) =>
  agentLayer(config).pipe(
    Layer.provideMerge(runnerLayer(runnerConfig())),
    Layer.provide(layerClock),
  )

const TICKET: TicketId = TicketId.make('fa-1')
const PROJECT: ProjectId = ProjectId.make('p1')

const startOptions = (
  log: string,
  mode: string,
  overrides: Partial<AgentStart> = {},
): AgentStart => ({
  ticket: TICKET,
  project: PROJECT,
  worktree,
  providers: [
    { provider: 'anthropic', baseUrl: 'http://127.0.0.1:9/anthropic' },
    { provider: 'openai', baseUrl: 'http://127.0.0.1:9/openai' },
  ],
  token: 'agent-token-1',
  model: Option.some({ provider: 'anthropic', modelId: 'claude-x' }),
  resume: Option.none(),
  env: { STUB_MODE: mode, STUB_LOG: log, FABRICA_SOCKET: '/tmp/s.sock' },
  nice: Option.none(),
  ...overrides,
})

/** One line of the stub's log. */
interface Entry {
  readonly pid: number
  readonly event: string
  readonly type?: string
  readonly args?: ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: ReadonlyArray<string>
  readonly config?: string
  readonly models?: unknown
  readonly child?: number
  readonly id?: string
  readonly cancelled?: boolean
}

const entries = (log: string): ReadonlyArray<Entry> =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter(line => line !== '')
        .map((line): Entry => JSON.parse(line))
    : []

/** Waits, on the folder's change events, for the log to hold an entry `found` matches. */
const logged = (
  log: string,
  found: (entry: Entry) => boolean,
): Effect.Effect<Entry> =>
  Effect.callback<Entry>(resume => {
    const look = () => {
      const entry = entries(log).find(found)
      if (entry !== undefined) resume(Effect.succeed(entry))
    }
    const watcher = watch(dirname(log), look)
    look()
    return Effect.sync(() => watcher.close())
  })

/** Completes once `file` exists, on the folder's change events. */
const appears = (file: string): Effect.Effect<void> =>
  Effect.callback<void>(resume => {
    const watcher = watch(dirname(file), () => {
      if (existsSync(file)) resume(Effect.void)
    })
    if (existsSync(file)) resume(Effect.void)
    return Effect.sync(() => watcher.close())
  })

/** Whether `pid` is a live process: listed, and not a zombie. */
const alive = (pid: number) =>
  Effect.map(listProcesses, rows =>
    Option.getOrThrow(rows).some(row => row.pid === pid && !row.zombie),
  )

/** A logger keeping each message's text. */
const capture = () => {
  const messages: Array<string> = []
  const logger = Logger.make(({ message }) => {
    messages.push(Array.isArray(message) ? message.join(' ') : String(message))
  })
  return { messages, layer: Logger.layer([logger]) }
}

describe('Pi RPC records', () => {
  it.effect('are split on LF only, a U+2028 and a split character kept', () =>
    Effect.gen(function* () {
      const text = '{"a":"x y"}\n{"b":"é"}\n{"c":1}'
      const bytes = Buffer.from(text, 'utf8')
      const cut = bytes.indexOf(Buffer.from('é')) + 1
      const lines = yield* Stream.make(
        bytes.subarray(0, 5),
        bytes.subarray(5, cut),
        bytes.subarray(cut),
      ).pipe(splitRecords, Stream.runCollect)
      expect(lines).toEqual(['{"a":"x y"}', '{"b":"é"}', '{"c":1}'])
    }),
  )

  it('are decoded, an unknown kind or a missing field skipped', () => {
    expect(readRecord('{"type":"agent_settled","aborted":false}')).toEqual(
      PiRecord.Event({ event: { type: 'agent_settled', aborted: false } }),
    )
    expect(readRecord('{"type":"mystery","x":1}')).toEqual(
      PiRecord.Skipped({ kind: 'mystery', reason: 'unknown kind' }),
    )
    expect(readRecord('{"type":"agent_settled"}')).toEqual(
      PiRecord.Skipped({ kind: 'agent_settled', reason: 'missing fields' }),
    )
    expect(readRecord('not json')).toEqual(
      PiRecord.Skipped({ kind: '(none)', reason: 'not JSON' }),
    )
    expect(
      readRecord(
        '{"type":"response","id":"1","command":"abort","success":true}',
      ),
    ).toEqual(
      PiRecord.Response({
        response: {
          type: 'response',
          id: '1',
          command: 'abort',
          success: true,
        },
      }),
    )
  })
})

describe('PiAgent', () => {
  it.live(
    'spawns Pi in RPC mode with its own configuration folder and shakes hands',
    () => {
      const config = agentConfig('handshake')
      return Effect.gen(function* () {
        const { start } = yield* PiAgent
        const scope = yield* Scope.make()
        const agent = yield* Scope.provide(
          start(startOptions(config.log, 'normal')),
          scope,
        )
        const sessions = sessionFolder({
          data: config.data,
          project: PROJECT,
          ticket: TICKET,
        })
        expect(agent.session.id).toBe(`s-${agent.pid}`)
        expect(agent.session.file).toEqual(
          Option.some(join(sessions, `s-${agent.pid}.jsonl`)),
        )
        const started = yield* logged(config.log, e => e.event === 'start')
        expect(started.args).toEqual([
          '--mode',
          'rpc',
          '--extension',
          extension,
          '--session-dir',
          sessions,
          '--no-skills',
          '--provider',
          'anthropic',
          '--model',
          'claude-x',
        ])
        expect(started.cwd).toBe(worktree)
        expect(started.models).toEqual({
          providers: {
            anthropic: {
              baseUrl: 'http://127.0.0.1:9/anthropic',
              apiKey: 'agent-token-1',
            },
            openai: {
              baseUrl: 'http://127.0.0.1:9/openai',
              apiKey: 'agent-token-1',
            },
          },
        })
        const env = started.env ?? []
        expect(env).toEqual(
          expect.arrayContaining([
            'PI_CODING_AGENT_DIR',
            'PI_OFFLINE',
            'FABRICA_SOCKET',
            'HOME',
            'PATH',
          ]),
        )
        expect(env).not.toContain('ANTHROPIC_API_KEY')
        expect(env).not.toContain('CLAUDECODE')
        expect(
          entries(config.log).filter(e => e.event === 'command')[0]?.type,
        ).toBe('get_state')

        yield* Scope.close(scope, Exit.void)
        expect(yield* alive(agent.pid)).toBe(false)
        expect(existsSync(started.config ?? '')).toBe(false)
      }).pipe(Effect.provide(services(config)))
    },
  )

  it.live(
    'streams a prompt’s records until it settles, an unknown kind skipped and logged once',
    () => {
      const config = agentConfig('prompt')
      const { messages, layer } = capture()
      return Effect.gen(function* () {
        const { start } = yield* PiAgent
        const agent = yield* start(startOptions(config.log, 'normal'))
        const subscribed = yield* agent.events
        const settled = yield* agent.prompt('Work on fa-1')
        expect(settled).toEqual({ disposition: 'started', aborted: false })
        // Read after the turn settled: the subscription lost nothing meanwhile.
        const events: ReadonlyArray<PiEvent> = yield* subscribed.pipe(
          Stream.takeUntil(event => event.type === 'agent_settled'),
          Stream.runCollect,
        )
        expect(events.map(event => event.type)).toEqual([
          'agent_start',
          'message_start',
          'message_update',
          'message_end',
          'agent_end',
          'agent_settled',
        ])
        const end = events.find(event => event.type === 'message_end')
        expect(
          end?.type === 'message_end' && end.message.usage?.totalTokens,
        ).toBe(15)
        expect(end?.type === 'message_end' && end.message.model).toBe(
          'claude-x',
        )
        expect(messages.filter(m => m.includes('mystery_kind'))).toEqual([
          'Pi record skipped: mystery_kind (unknown kind)',
        ])
        expect(
          messages.filter(m => m.includes('tool_execution_start')),
        ).toEqual(['Pi record skipped: tool_execution_start (missing fields)'])

        // A second prompt's records skip the same kinds without saying so again.
        yield* agent.prompt('Again')
        expect(messages.filter(m => m.includes('mystery_kind'))).toHaveLength(1)
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(services(config), layer)),
      )
    },
  )

  it.live(
    'sends steer, set_model, switch_session, fork and get_session_stats',
    () => {
      const config = agentConfig('commands')
      return Effect.gen(function* () {
        const { start } = yield* PiAgent
        const agent = yield* start(startOptions(config.log, 'normal'))
        expect(yield* agent.steer('Also update the docs')).toBe('queued')
        yield* agent.setModel({ provider: 'openai', modelId: 'gpt-x' })
        expect(yield* agent.switchSession('/sessions/other.jsonl')).toBe(true)
        expect(yield* agent.fork('entry-3')).toEqual({
          text: 'forked at entry-3',
          cancelled: false,
        })
        const stats = yield* agent.sessionStats
        expect(stats.tokens.total).toBe(15)
        expect(stats.sessionFile).toBe('/sessions/other.jsonl')
        const commands = entries(config.log).filter(e => e.event === 'command')
        expect(commands.map(e => e.type)).toEqual([
          'get_state',
          'steer',
          'set_model',
          'switch_session',
          'fork',
          'get_session_stats',
        ])
      }).pipe(Effect.scoped, Effect.provide(services(config)))
    },
  )

  it.live('resumes a session with switch_session before its handshake', () => {
    const config = agentConfig('resume')
    return Effect.gen(function* () {
      const { start } = yield* PiAgent
      const agent = yield* start(
        startOptions(config.log, 'normal', {
          resume: Option.some('/sessions/fa-1/earlier.jsonl'),
        }),
      )
      expect(agent.session.file).toEqual(
        Option.some('/sessions/fa-1/earlier.jsonl'),
      )
      const commands = entries(config.log).filter(e => e.event === 'command')
      expect(commands.map(e => e.type)).toEqual(['switch_session', 'get_state'])
    }).pipe(Effect.scoped, Effect.provide(services(config)))
  })

  it.live(
    'cancels an extension’s dialog, so the turn never waits on it',
    () => {
      const config = agentConfig('dialog')
      return Effect.gen(function* () {
        const { start } = yield* PiAgent
        const agent = yield* start(startOptions(config.log, 'dialog'))
        expect(yield* agent.prompt('Work')).toEqual({
          disposition: 'started',
          aborted: false,
        })
        const answers = entries(config.log).filter(
          e => e.event === 'ui-response',
        )
        expect(answers.map(e => [e.id, e.cancelled])).toEqual([['ui-1', true]])
      }).pipe(Effect.scoped, Effect.provide(services(config)))
    },
  )

  it.live(
    'aborts the turn when its prompt is interrupted, within the limit',
    () => {
      const config = agentConfig('abort', { abort: Duration.seconds(2) })
      return Effect.gen(function* () {
        const { start } = yield* PiAgent
        const agent = yield* start(startOptions(config.log, 'long'))
        const subscribed = yield* agent.events
        const turn = yield* Effect.forkChild(agent.prompt('A long one'))
        yield* logged(
          config.log,
          e => e.event === 'command' && e.type === 'prompt',
        )
        yield* Fiber.interrupt(turn)
        yield* logged(
          config.log,
          e => e.event === 'command' && e.type === 'abort',
        )
        const events = yield* subscribed.pipe(
          Stream.takeUntil(event => event.type === 'agent_settled'),
          Stream.runCollect,
        )
        expect(events.at(-1)).toEqual({ type: 'agent_settled', aborted: true })
        // The agent stays open after an aborted turn.
        expect(yield* agent.steer('Go on')).toBe('queued')
      }).pipe(Effect.scoped, Effect.provide(services(config)))
    },
  )

  it.live(
    'kills a wedged agent: its abort unanswered, its SIGTERM ignored',
    () => {
      const config = agentConfig('wedged', { abort: Duration.millis(300) })
      return Effect.gen(function* () {
        const { start } = yield* PiAgent
        const scope = yield* Scope.make()
        const agent = yield* Scope.provide(
          start(startOptions(config.log, 'wedged')),
          scope,
        )
        yield* agent.close
        expect(yield* alive(agent.pid)).toBe(false)
        const seen = entries(config.log).map(e => e.event + (e.type ?? ''))
        expect(seen).toContain('commandabort')
        expect(seen).toContain('sigterm')
        expect(seen).not.toContain('exit')
        // The scope's end after a close does nothing more.
        yield* Scope.close(scope, Exit.void)
      }).pipe(Effect.provide(services(config)))
    },
  )

  it.live(
    'ends the agent’s whole tree, a child in a group of its own too',
    () => {
      const config = agentConfig('tree')
      return Effect.gen(function* () {
        const { start } = yield* PiAgent
        const scope = yield* Scope.make()
        const agent = yield* Scope.provide(
          start(startOptions(config.log, 'with-child')),
          scope,
        )
        const { child = 0 } = yield* logged(
          config.log,
          e => e.event === 'child',
        )
        expect(yield* alive(child)).toBe(true)
        yield* Scope.close(scope, Exit.void)
        expect(yield* alive(agent.pid)).toBe(false)
        expect(yield* alive(child)).toBe(false)
      }).pipe(Effect.provide(services(config)))
    },
  )

  it.live(
    'starts the ticket again only once its closing session has exited',
    () => {
      const config = agentConfig('restart')
      return Effect.gen(function* () {
        const { start } = yield* PiAgent
        const first = yield* Scope.make()
        const agent = yield* Scope.provide(
          start(startOptions(config.log, 'slow-exit')),
          first,
        )
        const closing = yield* Effect.forkChild(agent.close)
        yield* logged(
          config.log,
          e => e.pid === agent.pid && e.event === 'sigterm',
        )
        const second = yield* Scope.make()
        const next = yield* Scope.provide(
          start(startOptions(config.log, 'normal')),
          second,
        )
        yield* Fiber.join(closing)
        const order = entries(config.log)
          .filter(
            e =>
              (e.pid === agent.pid && e.event === 'exit') ||
              (e.pid === next.pid && e.event === 'start'),
          )
          .map(e => `${e.pid === agent.pid ? 'first' : 'second'} ${e.event}`)
        expect(order).toEqual(['first exit', 'second start'])
        yield* Scope.close(second, Exit.void)
        yield* Scope.close(first, Exit.void)
      }).pipe(Effect.provide(services(config)))
    },
  )

  it.live('fails a command sent to a closing session, never sending it', () => {
    const config = agentConfig('closing')
    return Effect.gen(function* () {
      const { start } = yield* PiAgent
      const agent = yield* start(startOptions(config.log, 'slow-abort'))
      const closing = yield* Effect.forkChild(agent.close)
      yield* logged(
        config.log,
        e => e.event === 'command' && e.type === 'abort',
      )
      const sent = yield* Effect.flip(agent.steer('Too late'))
      expect(sent.reason._tag).toBe('Closing')
      yield* Fiber.join(closing)
      const types = entries(config.log)
        .filter(e => e.event === 'command')
        .map(e => e.type)
      expect(types).not.toContain('steer')
      expect((yield* Effect.flip(agent.prompt('Later'))).reason._tag).toBe(
        'Closing',
      )
    }).pipe(Effect.scoped, Effect.provide(services(config)))
  })

  it.live('refuses a second start of an open session', () => {
    const config = agentConfig('busy')
    return Effect.gen(function* () {
      const { start } = yield* PiAgent
      yield* start(startOptions(config.log, 'normal'))
      const refused = yield* Effect.flip(
        start(startOptions(config.log, 'normal')),
      )
      expect(refused.reason._tag).toBe('Busy')
      expect(entries(config.log).filter(e => e.event === 'start')).toHaveLength(
        1,
      )
    }).pipe(Effect.scoped, Effect.provide(services(config)))
  })

  it.live(
    'fails a start whose Pi exits before its handshake, with its stderr, and frees the ticket',
    () => {
      const config = agentConfig('exits')
      return Effect.gen(function* () {
        const { start } = yield* PiAgent
        const failed = yield* Effect.flip(
          Effect.scoped(start(startOptions(config.log, 'exit-at-start'))),
        )
        if (failed.reason._tag !== 'Exited')
          return yield* Effect.die(failed.reason)
        expect(failed.reason.status).toEqual({ _tag: 'Code', code: 3 })
        expect(failed.reason.stderr).toContain('no model configured')
        const agent = yield* Effect.scoped(
          start(startOptions(config.log, 'normal')),
        )
        expect(agent.session.id).toBe(`s-${agent.pid}`)
      }).pipe(Effect.provide(services(config)))
    },
  )

  it.live('fails a handshake Pi doesn’t answer within its limit', () => {
    const config = agentConfig('silent', { handshake: Duration.millis(300) })
    return Effect.gen(function* () {
      const { start } = yield* PiAgent
      const failed = yield* Effect.flip(
        Effect.scoped(start(startOptions(config.log, 'silent'))),
      )
      if (failed.reason._tag !== 'Handshake')
        return yield* Effect.die(failed.reason)
      expect(failed.reason.command).toBe('get_state')
      expect(failed.reason.reason._tag).toBe('NoAnswer')
      const { pid } = yield* logged(config.log, e => e.event === 'start')
      expect(yield* alive(pid)).toBe(false)
    }).pipe(Effect.provide(services(config)))
  })

  it.live('cancels a start the ticket’s close comes during', () => {
    const config = agentConfig('cancel')
    return Effect.gen(function* () {
      const { start, close } = yield* PiAgent
      const starting = yield* Effect.forkChild(
        Effect.scoped(start(startOptions(config.log, 'silent'))),
      )
      const { pid } = yield* logged(
        config.log,
        e => e.event === 'command' && e.type === 'get_state',
      )
      yield* close(TICKET)
      const exit = yield* Fiber.await(starting)
      expect(
        Exit.isFailure(exit) &&
          Option.map(Exit.findErrorOption(exit), e => e.reason._tag),
      ).toEqual(Option.some('Cancelled'))
      expect(yield* alive(pid)).toBe(false)
    }).pipe(Effect.provide(services(config)))
  })

  it.live(
    'leaves nothing reserved or running when a start is interrupted',
    () => {
      // Pi stays silent, so the abort the interruption sends waits out its limit.
      const config = agentConfig('interrupted', { abort: Duration.millis(300) })
      return Effect.gen(function* () {
        const { start } = yield* PiAgent
        const starting = yield* Effect.forkChild(
          Effect.scoped(start(startOptions(config.log, 'silent'))),
        )
        const { pid } = yield* logged(
          config.log,
          e => e.event === 'command' && e.type === 'get_state',
        )
        yield* Fiber.interrupt(starting)
        expect(yield* alive(pid)).toBe(false)
        const agent = yield* Effect.scoped(
          start(startOptions(config.log, 'normal')),
        )
        expect(agent.pid).not.toBe(pid)
      }).pipe(Effect.provide(services(config)))
    },
  )
})

describe('the reaper', () => {
  it.live(
    'ends the agent’s whole tree once the engine’s end of its stdin closes',
    () => {
      const ready = join(root, 'reaper.ready')
      return Effect.gen(function* () {
        const { start } = yield* ProcessRunner
        const agent = yield* start({
          command: process.execPath,
          args: [parent, ready],
          cwd: root,
          stdin: 'null',
        })
        yield* appears(ready)
        const [, child = 0] = readFileSync(ready, 'utf8').split(' ').map(Number)
        const reaper = yield* start({
          command: process.execPath,
          args: reaperArguments({
            agent: agent.pid,
            poll: Duration.millis(100),
            grace: Duration.millis(300),
          }),
          cwd: root,
          stdin: 'pipe',
        })
        // What the engine's death does to the reaper's stdin.
        yield* reaper.closeStdin
        yield* reaper.exit
        expect(yield* alive(agent.pid)).toBe(false)
        expect(yield* alive(child)).toBe(false)
      }).pipe(
        Effect.scoped,
        Effect.provide(
          runnerLayer(runnerConfig()).pipe(Layer.provide(layerClock)),
        ),
      )
    },
  )
})
