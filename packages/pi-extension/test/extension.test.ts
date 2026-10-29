import { Data, Effect, Layer, Option, Schema } from 'effect'
import { Headers } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { SocketServer } from 'effect/socket'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  AgentSettledEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ProjectTrustEvent,
  ProjectTrustEventResult,
  ProviderConfig,
  SessionShutdownEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent'
import * as NodeSocketServer from '@effect/platform-node-shared/NodeSocketServer'
import { describe, expect, it } from '@effect/vitest'
import {
  CheckOwnRan,
  ControlRpcs,
  ControlSocketVariable,
  ControlToken,
  ControlTokenHeader,
  ControlTokenVariable,
  ControlUnauthorized,
  Filed,
  NoteId,
  Noted,
  PermissionsVariable,
  ProjectTrustedVariable,
  TicketId,
  TicketView,
  ToolRefusal,
  WorkerTools,
  parametersJsonSchema,
} from '@fabrica/contracts'
import { tempFolder } from '@fabrica/testkit'

import { type ExtensionEnvironment, readEnvironment } from '../src/environment'
import { makeExtension } from '../src/extension'
import type { PiApi, PiTool } from '../src/pi'
import {
  StandingRulesSection,
  StandingRulesVersion,
  standingRules,
} from '../src/rules'
import { NudgeText, NudgeType, SettledType } from '../src/settle'

// The first-party extension (spec §12.2, §12.3, §12.4) against Pi's extension API types: a fake Pi at
// the outermost boundary records what the extension registers and fires its events, and a control
// server on a real Unix socket answers the worker's tools as the engine would, recording each call.

type Handler<E, R> = (event: E) => Promise<R | undefined> | R | undefined

interface Handlers {
  project_trust: Handler<ProjectTrustEvent, ProjectTrustEventResult>
  before_agent_start: Handler<
    BeforeAgentStartEvent,
    BeforeAgentStartEventResult
  >
  tool_call: Handler<ToolCallEvent, ToolCallEventResult>
  agent_before_settle: Handler<
    AgentBeforeSettleEvent,
    AgentBeforeSettleEventResult
  >
  agent_settled: Handler<AgentSettledEvent, never>
  session_shutdown: Handler<SessionShutdownEvent, never>
}

/** A fake of Pi's extension API: what the extension registered, and its handlers to fire. */
const fakePi = () => {
  const handlers: Partial<Handlers> = {}
  const tools: Array<PiTool> = []
  const providers: Array<{ name: string; config: ProviderConfig }> = []
  const entries: Array<{ customType: string; data: unknown }> = []
  function on<Event extends keyof Handlers>(
    event: Event,
    handler: Handlers[Event],
  ): () => void {
    handlers[event] = handler
    return () => {
      delete handlers[event]
    }
  }
  const pi: PiApi = {
    on,
    registerTool: tool => {
      tools.push(tool)
    },
    registerProvider: (name, config) => {
      providers.push({ name, config })
    },
    appendEntry: (customType, data) => {
      entries.push({ customType, data })
    },
  }
  const handler = <Event extends keyof Handlers>(
    event: Event,
  ): Handlers[Event] => {
    const registered = handlers[event]
    if (registered === undefined) throw new Error(`no ${event} handler`)
    return registered
  }
  const tool = (name: string): PiTool => {
    const registered = tools.find(each => each.name === name)
    if (registered === undefined) throw new Error(`no ${name} tool`)
    return registered
  }
  return { pi, handlers, tools, providers, entries, handler, tool }
}

const own = TicketId.make('fab-own.1')
const other = TicketId.make('fab-other.2')

/** The worker's ticket, as `get_ticket` shows it. */
const ownView = Schema.decodeUnknownSync(TicketView)({
  ticket: {
    id: own,
    type: 'task',
    title: 'Build the extension',
    description: null,
    design: null,
    acceptance: null,
    status: 'in_progress',
    resolution: null,
    priority: 1,
    deferUntil: null,
    assignee: null,
    model: null,
    metadata: {},
    result: null,
    question: null,
    mergedCommit: null,
    closeReason: null,
    createdAt: 0,
    updatedAt: 0,
  },
  labels: [],
  notes: [],
  edges: [],
  dependencies: [],
})

/** A call the control server answered: the request's tag and its payload. */
interface Call {
  readonly rpc: string
  readonly payload: unknown
}

type Answers = Parameters<typeof ControlRpcs.of>[0]

/** The engine's answers, each call recorded in `calls`; `finish` refused when `dirty`. */
const answers = (
  calls: Array<Call>,
  { dirty }: { readonly dirty: boolean },
): Answers => {
  const record = (rpc: string, payload: unknown) =>
    Effect.sync(() => {
      calls.push({ rpc, payload })
    })
  const ended = (rpc: string) => (payload: unknown) =>
    Effect.as(record(rpc, payload), {})
  return {
    get_ticket: payload => Effect.as(record('get_ticket', payload), ownView),
    file_ticket: payload =>
      Effect.as(
        record('file_ticket', payload),
        new Filed({ id: TicketId.make('fab-new.1') }),
      ),
    ask_question: payload =>
      Effect.as(
        record('ask_question', payload),
        new Filed({ id: TicketId.make('fab-question.1') }),
      ),
    add_note: payload =>
      Effect.as(
        record('add_note', payload),
        new Noted({ id: NoteId.make('note-1') }),
      ),
    check_own: payload =>
      Effect.as(
        record('check_own', payload),
        CheckOwnRan.cases.not_run.make({ reason: 'no check_own is set' }),
      ),
    finish: payload =>
      dirty
        ? Effect.andThen(
            record('finish', payload),
            Effect.fail(
              ToolRefusal.cases.worktree_dirty.make({
                uncommitted: ['src/a.ts'],
                untracked: ['notes.txt'],
              }),
            ),
          )
        : ended('finish')(payload),
    defer: ended('defer'),
    wait_for: ended('wait_for'),
    ask_and_wait: payload =>
      Effect.as(record('ask_and_wait', payload), {
        _tag: 'unanswered' as const,
        question: TicketId.make('fab-question.1'),
      }),
    request_permission: () => Effect.die('no call here is asked about'),
    merge_standing: () => Effect.succeed('not_queued'),
    report_gate_decision: () => Effect.void,
    report_unfinished: payload =>
      Effect.asVoid(record('report_unfinished', payload)),
  }
}

const token = 'session-token'

/** A control server on a socket in `folder`, checking `token`, answering as `answers` does. */
const serve = Effect.fn(function* (folder: string, handlers: Answers) {
  const socket = join(folder, 'control.sock')
  const server = yield* NodeSocketServer.make({ path: socket })
  const checkToken = Layer.succeed(ControlToken)((effect, { headers }) =>
    Option.contains(Headers.get(headers, ControlTokenHeader), token)
      ? effect
      : Effect.fail(new ControlUnauthorized()),
  )
  yield* RpcServer.make(ControlRpcs, {
    concurrency: 'unbounded',
    disableFatalDefects: true,
  }).pipe(
    Effect.provide(
      ControlRpcs.toLayer(ControlRpcs.of(handlers)).pipe(
        Layer.provideMerge(checkToken),
        Layer.provideMerge(
          RpcServer.layerProtocolSocketServer.pipe(
            Layer.provide(RpcSerialization.layerNdjson),
            Layer.provide(Layer.succeed(SocketServer.SocketServer)(server)),
          ),
        ),
      ),
    ),
    Effect.forkScoped,
  )
  return socket
})

/** The extension loaded into a fake Pi, its control channel a server answering as the engine would. */
const loaded = Effect.fn(function* (
  options: {
    readonly dirty?: boolean
    readonly token?: string
    readonly projectTrusted?: boolean
    readonly configFolder?: string
  } = {},
) {
  const folder = yield* tempFolder('pi-extension')
  const calls: Array<Call> = []
  const socket = yield* serve(
    folder,
    answers(calls, { dirty: options.dirty ?? false }),
  )
  const environment: ExtensionEnvironment = {
    control: Option.some({ socket, token: options.token ?? token }),
    projectTrusted: options.projectTrusted ?? false,
    configFolder: Option.fromUndefinedOr(options.configFolder),
    permissions: 'workspace',
    worktree: folder,
    home: Option.none(),
  }
  const fake = fakePi()
  yield* Effect.promise(() => makeExtension(environment)(fake.pi))
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await fake.handler('session_shutdown')({
        type: 'session_shutdown',
        reason: 'quit',
      })
    }),
  )
  return { ...fake, calls, folder }
})

/** A registered tool's failure, as Pi shows it. */
class ToolFailed extends Data.TaggedError('ToolFailed')<{
  readonly message: string
}> {}

/** Calls a registered tool as Pi would, with `params` past Pi's own check. */
const execute = (tool: PiTool, params: unknown) =>
  Effect.tryPromise({
    try: () => tool.execute('call-1', params, undefined),
    catch: error =>
      new ToolFailed({
        message: error instanceof Error ? error.message : String(error),
      }),
  })

/** Pi about to settle a turn that ended as `outcome`. */
const settling = (
  outcome: AgentBeforeSettleEvent['outcome'] = 'completed',
): AgentBeforeSettleEvent => ({
  type: 'agent_before_settle',
  entries: [],
  continue: false,
  outcome,
  context: {
    contextEntries: [],
    contextMessages: [],
    llmMessages: [],
    pendingMessages: [],
    canContinue: true,
  },
})

/** Pi starting a run from a prompt, in `cwd`. */
const starting = (cwd: string): BeforeAgentStartEvent => ({
  type: 'before_agent_start',
  messageType: 'user',
  prompt: 'Work on your ticket.',
  systemPrompt: '',
  systemPromptOptions: {
    selectedTools: ['read', 'bash', 'edit', 'write'],
    hiddenTools: [],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: '',
    sections: {},
    cwd,
    contextFiles: [],
    skills: [],
  },
})

const finishing = {
  checkOwn: {
    tree: 'a'.repeat(40),
    commit: 'b'.repeat(40),
    output: '.fabrica/run/check-own.log',
  },
  result: { _tag: 'summary', summary: 'Built it.' },
}

describe('the first-party extension', () => {
  it.live('registers the worker tools with their contracts’ JSON Schema', () =>
    Effect.gen(function* () {
      const { tools, handlers, providers } = yield* loaded()
      expect(tools.map(tool => tool.name)).toEqual(
        WorkerTools.map(tool => tool.name),
      )
      for (const [index, tool] of WorkerTools.entries()) {
        const registered = tools[index]
        expect(registered?.description).toBe(tool.description)
        // TypeBox marks the wrapped schema with symbols; the JSON Schema is the contracts' as given.
        expect(JSON.parse(JSON.stringify(registered?.parameters))).toEqual(
          parametersJsonSchema(tool),
        )
      }
      expect(Object.keys(handlers).toSorted()).toEqual([
        'agent_before_settle',
        'agent_settled',
        'before_agent_start',
        'project_trust',
        'session_shutdown',
        'tool_call',
      ])
      expect(providers).toEqual([])
    }),
  )

  it.live('fails a call whose arguments don’t decode, reaching no engine', () =>
    Effect.gen(function* () {
      const { tool, calls } = yield* loaded()
      const restated = yield* Effect.flip(
        execute(tool('file_ticket'), {
          title: 'Split the gate',
          description: 'Split the gate into its own module.',
          type: 'task',
          files: ['src/gate.ts'],
          link: 'blocks',
        }),
      )
      expect(restated.message).toContain('file_ticket failed')
      expect(restated.message).toContain('opens with the detail')
      const extra = yield* Effect.flip(
        execute(tool('add_note'), { body: 'Noted.', urgent: true }),
      )
      expect(extra.message).toContain('add_note failed')
      expect(extra.message).toContain('urgent')
      expect(calls).toEqual([])
    }),
  )

  it.live('forwards a call over the socket and answers with the engine’s', () =>
    Effect.gen(function* () {
      const { tool, calls } = yield* loaded()
      const result = yield* execute(tool('add_note'), { body: 'Chose X.' })
      expect(calls).toEqual([
        { rpc: 'add_note', payload: { body: 'Chose X.' } },
      ])
      expect(result.details).toEqual({ id: 'note-1' })
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify({ id: 'note-1' }, null, 2) },
      ])
      expect(result.terminate).toBeUndefined()
    }),
  )

  it.live('fails a call the engine refuses, saying why', () =>
    Effect.gen(function* () {
      const { tool, calls } = yield* loaded({ dirty: true })
      const refused = yield* Effect.flip(execute(tool('finish'), finishing))
      expect(refused.message).toContain('finish failed')
      expect(refused.message).toContain('uncommitted: src/a.ts')
      expect(refused.message).toContain('untracked: notes.txt')
      expect(calls.map(call => call.rpc)).toEqual(['finish'])
    }),
  )

  it.live('carries the session’s token: a wrong one fails the call', () =>
    Effect.gen(function* () {
      const { tool, calls } = yield* loaded({ token: 'not-the-token' })
      const refused = yield* Effect.flip(
        execute(tool('add_note'), { body: 'Chose X.' }),
      )
      expect(refused.message).toContain('add_note failed')
      expect(refused.message).toContain('refused the control token')
      expect(calls).toEqual([])
    }),
  )

  it.live(
    'nudges a turn with no outcome once, then reports it unfinished',
    () =>
      Effect.gen(function* () {
        const { handler, calls, entries } = yield* loaded()
        const settle = handler('agent_before_settle')
        const first = yield* Effect.promise(async () => settle(settling()))
        expect(first).toEqual({
          continue: true,
          entries: [
            {
              type: 'custom_message',
              customType: NudgeType,
              content: NudgeText,
              display: false,
            },
          ],
        })
        expect(calls).toEqual([])
        const second = yield* Effect.promise(async () => settle(settling()))
        expect(second).toBeUndefined()
        expect(calls).toEqual([{ rpc: 'report_unfinished', payload: {} }])
        yield* Effect.promise(async () =>
          handler('agent_settled')({ type: 'agent_settled', aborted: false }),
        )
        expect(entries).toEqual([
          {
            customType: SettledType,
            data: { outcome: null, nudged: true, aborted: false },
          },
        ])
        // The next turn starts afresh: a hand-back gets its own nudge.
        const next = yield* Effect.promise(async () => settle(settling()))
        expect(next).toMatchObject({ continue: true })
      }),
  )

  it.live(
    'an outcome tool ends the turn: Pi stops, and nothing is nudged',
    () =>
      Effect.gen(function* () {
        const { tool, handler, calls, entries } = yield* loaded()
        const deferred = yield* execute(tool('defer'), {
          reason: 'Needs a decision.',
        })
        expect(deferred.terminate).toBe(true)
        const settled = yield* Effect.promise(async () =>
          handler('agent_before_settle')(settling()),
        )
        expect(settled).toBeUndefined()
        yield* Effect.promise(async () =>
          handler('agent_settled')({ type: 'agent_settled', aborted: false }),
        )
        expect(entries).toEqual([
          {
            customType: SettledType,
            data: { outcome: 'defer', nudged: false, aborted: false },
          },
        ])
        expect(calls.map(call => call.rpc)).toEqual(['defer'])
      }),
  )

  it.live(
    'a question about another ticket, or an aborted turn, ends nothing',
    () =>
      Effect.gen(function* () {
        const { tool, handler, calls } = yield* loaded()
        const asked = yield* execute(tool('ask_question'), {
          title: 'Which store for the cache?',
          description: 'The cache needs a store. SQLite is recommended.',
          choices: {
            options: [
              { label: 'SQLite', tradeOff: 'One file, already in use.' },
              { label: 'Memory', tradeOff: 'Fast, lost on restart.' },
            ],
            recommended: 0,
          },
          consequential: false,
          maintainerOnly: false,
          blocks: other,
        })
        expect(asked.terminate).toBeUndefined()
        expect(calls.map(call => call.rpc)).toEqual([
          'get_ticket',
          'ask_question',
        ])
        const aborted = yield* Effect.promise(async () =>
          handler('agent_before_settle')(settling('aborted')),
        )
        expect(aborted).toBeUndefined()
        const completed = yield* Effect.promise(async () =>
          handler('agent_before_settle')(settling()),
        )
        expect(completed).toMatchObject({ continue: true })
        // Asked about its own ticket, the question is the turn's outcome.
        const own = yield* execute(tool('ask_and_wait'), {
          title: 'Which store for the cache?',
          description: 'The cache needs a store. SQLite is recommended.',
          choices: {
            options: [
              { label: 'SQLite', tradeOff: 'One file, already in use.' },
              { label: 'Memory', tradeOff: 'Fast, lost on restart.' },
            ],
            recommended: 0,
          },
          consequential: false,
          maintainerOnly: false,
        })
        expect(own.terminate).toBe(true)
      }),
  )

  it.live(
    'puts the standing rules in the system prompt, the project’s appended',
    () =>
      Effect.gen(function* () {
        const { handler, folder } = yield* loaded()
        const plain = starting(folder)
        yield* Effect.promise(async () => handler('before_agent_start')(plain))
        const rules = plain.systemPromptOptions.sections[StandingRulesSection]
        expect(rules).toBe(standingRules(Option.none()))
        expect(rules).toContain(`version ${StandingRulesVersion}`)
        expect(rules).toContain('Never push.')

        yield* Effect.promise(async () => {
          await mkdir(join(folder, '.fabrica'))
          await writeFile(
            join(folder, '.fabrica', 'worker-rules.md'),
            'Run make lint before you commit.\n',
          )
        })
        const withProject = starting(folder)
        yield* Effect.promise(async () =>
          handler('before_agent_start')(withProject),
        )
        const appended =
          withProject.systemPromptOptions.sections[StandingRulesSection] ?? ''
        expect(appended.startsWith(rules ?? '')).toBe(true)
        expect(appended.endsWith('Run make lint before you commit.')).toBe(true)
      }),
  )

  it.live('refuses the project’s own extensions until it is trusted', () =>
    Effect.gen(function* () {
      const refused = yield* loaded()
      const event: ProjectTrustEvent = { type: 'project_trust', cwd: '/p' }
      expect(refused.handler('project_trust')(event)).toEqual({
        trusted: 'no',
        remember: false,
      })
      const trusted = yield* loaded({ projectTrusted: true })
      expect(trusted.handler('project_trust')(event)).toEqual({
        trusted: 'yes',
        remember: false,
      })
    }),
  )

  it.live(
    'the gate allows the extension’s own tools, and a command in the worktree',
    () =>
      Effect.gen(function* () {
        const { handler } = yield* loaded()
        const gate = handler('tool_call')
        const own = yield* Effect.promise(async () =>
          gate({
            type: 'tool_call',
            toolCallId: 'call-1',
            toolName: 'finish',
            input: finishing,
          }),
        )
        expect(own).toBeUndefined()
        const bash = yield* Effect.promise(async () =>
          gate({
            type: 'tool_call',
            toolCallId: 'call-2',
            toolName: 'bash',
            input: { command: 'ls' },
          }),
        )
        expect(bash).toBeUndefined()
      }),
  )

  it.live('registers Copilot’s OAuth at the proxy’s URL from models.json', () =>
    Effect.gen(function* () {
      const config = yield* tempFolder('pi-config')
      yield* Effect.promise(() =>
        writeFile(
          join(config, 'models.json'),
          JSON.stringify({
            providers: {
              anthropic: { baseUrl: 'http://127.0.0.1:4100/anthropic' },
              'github-copilot': {
                baseUrl: 'http://127.0.0.1:4100/github-copilot',
                apiKey: 'agent-token',
              },
            },
          }),
        ),
      )
      const { providers } = yield* loaded({ configFolder: config })
      expect(
        providers.map(({ name, config }) => [name, config.baseUrl]),
      ).toEqual([['github-copilot', 'http://127.0.0.1:4100/github-copilot']])
      const oauth = providers[0]?.config.oauth
      expect(oauth?.isSubscription).toBe(true)
      expect(
        oauth?.getApiKey({ access: 'placeholder', refresh: '', expires: 0 }),
      ).toBe('placeholder')

      const none = yield* tempFolder('pi-config')
      yield* Effect.promise(() =>
        writeFile(join(none, 'models.json'), JSON.stringify({ providers: {} })),
      )
      const without = yield* loaded({ configFolder: none })
      expect(without.providers).toEqual([])
    }),
  )

  it('reads its facts from the agent’s environment', () => {
    expect(
      readEnvironment(
        {
          [ControlSocketVariable]: '/run/a.sock',
          [ControlTokenVariable]: 'secret',
          [ProjectTrustedVariable]: '1',
          [PermissionsVariable]: 'full',
          PI_CODING_AGENT_DIR: '/data/agent-1',
          HOME: '/home/agent',
        },
        '/work/fa-1',
      ),
    ).toEqual({
      control: Option.some({ socket: '/run/a.sock', token: 'secret' }),
      projectTrusted: true,
      configFolder: Option.some('/data/agent-1'),
      permissions: 'full',
      worktree: '/work/fa-1',
      home: Option.some('/home/agent'),
    })
    expect(
      readEnvironment(
        {
          [ControlSocketVariable]: '/run/a.sock',
          [PermissionsVariable]: 'all',
        },
        '/work/fa-1',
      ),
    ).toEqual({
      control: Option.none(),
      projectTrusted: false,
      configFolder: Option.none(),
      permissions: 'workspace',
      worktree: '/work/fa-1',
      home: Option.none(),
    })
  })
})
