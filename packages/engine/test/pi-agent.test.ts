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
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { ProjectId, TicketId } from '@fabrica/contracts'

import {
  AgentOwner,
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
import { PI_STUB } from './pi-stub'

// The live PiAgent over a scripted Pi RPC stream (spec §24, H78): the only stand-in is the process at
// the boundary, a stub of Pi's CLI that speaks its RPC protocol as Pi 1.4.0 does, run by the Node
// running the tests. What the stub saw (its arguments, environment, the commands it read, the
// signals it got) it writes to a log the test reads.

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
  writeFileSync(stub, PI_STUB)
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
  // Made before the stub writes to it, so a wait can watch the file itself (see `logged`).
  const log = join(base, 'stub.log')
  writeFileSync(log, '')
  return {
    data: join(base, 'data'),
    configRoot: join(base, 'agents'),
    log,
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
  owner: AgentOwner.Ticket({ ticket: TICKET }),
  project: PROJECT,
  worktree,
  providers: [
    { provider: 'anthropic', baseUrl: 'http://127.0.0.1:9/anthropic' },
    { provider: 'openai', baseUrl: 'http://127.0.0.1:9/openai' },
  ],
  token: 'agent-token-1',
  model: Option.some({ provider: 'anthropic', modelId: 'claude-x' }),
  tools: Option.none(),
  resume: Option.none(),
  env: { STUB_MODE: mode, STUB_LOG: log, FABRICA_SOCKET: '/tmp/s.sock' },
  projectTrusted: false,
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
        .flatMap((line): ReadonlyArray<Entry> => {
          // A line the stub is still writing is read whole on the next change.
          try {
            return [JSON.parse(line)]
          } catch {
            return []
          }
        })
    : []

/**
 * Completes with what `look` finds, looking every 20 ms. Not on `fs.watch`, which can miss the change
 * waited for, with nothing written after it to tell of it: macOS arms a file's watch again only after its
 * event, so a line written in between goes unseen (1 run of 100 here, waiting out the limit on what came
 * of the line; fab-i1w), and starts a folder's watch a while after it is asked for.
 */
const looking = <A>(look: () => Option.Option<A>): Effect.Effect<A> =>
  Effect.callback<A>(resume => {
    const tryIt = () => {
      const found = look()
      if (Option.isNone(found)) return
      clearInterval(timer)
      resume(Effect.succeed(found.value))
    }
    const timer = setInterval(tryIt, 20)
    tryIt()
    return Effect.sync(() => clearInterval(timer))
  })

/** Waits for the log file to hold an entry `found` matches. */
const logged = (
  log: string,
  found: (entry: Entry) => boolean,
): Effect.Effect<Entry> =>
  looking(() => Option.fromUndefinedOr(entries(log).find(found)))

/** Completes once `file` exists. */
const appears = (file: string): Effect.Effect<void> =>
  looking(() => (existsSync(file) ? Option.some(undefined) : Option.none()))

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
      const text = '{"a":"x\u2028y"}\n{"b":"é"}\n{"c":1}'
      const bytes = Buffer.from(text, 'utf8')
      const cut = bytes.indexOf(Buffer.from('é')) + 1
      const lines = yield* Stream.make(
        bytes.subarray(0, 5),
        bytes.subarray(5, cut),
        bytes.subarray(cut),
      ).pipe(splitRecords, Stream.runCollect)
      expect(lines).toEqual(['{"a":"x\u2028y"}', '{"b":"é"}', '{"c":1}'])
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
    'returns at once from a prompt an extension handled, no turn run',
    () => {
      const config = agentConfig('handled')
      return Effect.gen(function* () {
        const { start } = yield* PiAgent
        const agent = yield* start(startOptions(config.log, 'handled'))
        expect(yield* agent.prompt('/ext-command')).toEqual({
          disposition: 'handled',
          aborted: false,
        })
        expect(yield* agent.steer('Still open')).toBe('queued')
      }).pipe(Effect.scoped, Effect.provide(services(config)))
    },
  )

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
      yield* close(AgentOwner.Ticket({ ticket: TICKET }))
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
      // Pi stays silent, so the abort the interruption sends waits out its limit. The handshake's limit
      // is out of reach, so it is the interruption that ends the start.
      const config = agentConfig('interrupted', {
        abort: Duration.millis(300),
        handshake: Duration.minutes(5),
      })
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
        expect(Exit.hasInterrupts(yield* Fiber.await(starting))).toBe(true)
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
