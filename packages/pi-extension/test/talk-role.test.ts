import { Effect, Option } from 'effect'

import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  AgentSettledEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ProjectTrustEvent,
  ProjectTrustEventResult,
  SessionShutdownEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentRoleVariable,
  TalkToolsGiven,
  TalkToolsVariable,
  ToolRefusal,
} from '@fabrica/contracts'
import { tempFolder } from '@fabrica/testkit'

import { ControlEndpoint, readEnvironment } from '../src/environment'
import { makeExtension } from '../src/extension'
import type { PiApi, PiTool } from '../src/pi'
import { StandingRulesSection } from '../src/rules'
import {
  type Answers,
  type Call,
  answers,
  serve,
  token,
} from './control-server'

// The extension in a talk's session (spec §15.4): read from `FABRICA_AGENT_ROLE` and
// `FABRICA_TALK_TOOLS`, it registers the mode's tools as the engine gave them, each call forwarded by
// the tool's name for the engine to decode, and ending no turn. It gives no standing rules, as the
// engine appends the mode's instructions to the system prompt, and no nudge, as a talk's turn has no
// outcome to give. The gate allows the mode's tools and Pi's readers, and asks the engine about the
// rest. A fake Pi records what the extension registers; a control server on a real Unix socket answers
// as the engine would.

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

const given: TalkToolsGiven = [
  {
    name: 'file_tree',
    description: 'Files the tree of tickets.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
  },
  { name: 'run_view', description: 'Reads the run.', parameters: {} },
]

/** Pi about to settle a turn that completed. */
const settling: AgentBeforeSettleEvent = {
  type: 'agent_before_settle',
  entries: [],
  continue: false,
  outcome: 'completed',
  context: {
    contextEntries: [],
    contextMessages: [],
    llmMessages: [],
    pendingMessages: [],
    canContinue: true,
  },
}

/** Pi starting a run from a prompt, in `cwd`, its sections `sections`. */
const starting = (
  cwd: string,
  sections: Record<string, string>,
): BeforeAgentStartEvent => ({
  type: 'before_agent_start',
  messageType: 'user',
  prompt: 'Which files?',
  systemPrompt: '',
  systemPromptOptions: {
    selectedTools: ['read', 'file_tree'],
    hiddenTools: [],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: '',
    sections,
    cwd,
    contextFiles: [],
    skills: [],
  },
})

/** The extension loaded into a fake Pi as a talk's session, its control channel answering as `change` says. */
const loadedTalk = Effect.fn(function* (
  change: (base: Answers) => Partial<Answers> = () => ({}),
) {
  const folder = yield* tempFolder('pi-talk-role')
  const calls: Array<Call> = []
  const base = answers(calls, { dirty: false })
  const socket = yield* serve(folder, { ...base, ...change(base) })
  const handlers: Partial<Handlers> = {}
  const tools: Array<PiTool> = []
  function on<Event extends keyof Handlers>(
    event: Event,
    handler: Handlers[Event],
  ): () => void {
    handlers[event] = handler
    return () => undefined
  }
  const pi: PiApi = {
    on,
    registerTool: tool => {
      tools.push(tool)
    },
    registerProvider: () => undefined,
    appendEntry: () => undefined,
  }
  yield* Effect.promise(() =>
    makeExtension({
      control: Option.some({
        endpoint: ControlEndpoint.Unix({ socket }),
        token,
      }),
      role: 'talk',
      answerTool: Option.none(),
      talkTools: given,
      projectTrusted: false,
      configFolder: Option.none(),
      permissions: 'workspace',
      worktree: folder,
      home: Option.none(),
      cdPath: false,
      cdableVariables: false,
    })(pi),
  )
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await handlers.session_shutdown?.({
        type: 'session_shutdown',
        reason: 'quit',
      })
    }),
  )
  const toolCall = (toolName: string, input: Record<string, unknown>) =>
    Effect.promise(async () =>
      handlers.tool_call?.({
        type: 'tool_call',
        toolCallId: 'call-1',
        toolName,
        input,
      }),
    )
  return { tools, handlers, calls, folder, toolCall }
})

const toolNamed = (tools: ReadonlyArray<PiTool>, name: string) => {
  const tool = tools.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return tool
}

describe("the extension in a talk's session", () => {
  it('reads its role and its tools from the environment', () => {
    const read = readEnvironment(
      {
        [AgentRoleVariable]: 'talk',
        [TalkToolsVariable]: JSON.stringify(given),
      },
      '/checkout',
    )
    expect(read.role).toBe('talk')
    expect(read.talkTools).toEqual(given)
    expect(readEnvironment({}, '/checkout').talkTools).toEqual([])
    expect(
      readEnvironment({ [TalkToolsVariable]: 'not json' }, '/checkout')
        .talkTools,
    ).toEqual([])
  })

  it.effect(
    "registers the mode's tools alone, showing the schema the engine gave",
    () =>
      Effect.gen(function* () {
        const { tools } = yield* loadedTalk()
        expect(tools.map(({ name }) => name)).toEqual(['file_tree', 'run_view'])
        expect(toolNamed(tools, 'file_tree').parameters).toEqual(
          given[0]?.parameters,
        )
      }).pipe(Effect.scoped),
  )

  it.live(
    "forwards a call by the tool's name, for the engine to decode, and ends no turn",
    () =>
      Effect.gen(function* () {
        const { tools, calls } = yield* loadedTalk()
        const result = yield* Effect.promise(() =>
          toolNamed(tools, 'file_tree').execute(
            'call-1',
            { title: 'Dark mode' },
            undefined,
          ),
        )
        expect(calls).toEqual([
          {
            rpc: 'talk_tool',
            payload: { tool: 'file_tree', input: { title: 'Dark mode' } },
          },
        ])
        expect(result.details).toEqual({ echoed: { title: 'Dark mode' } })
        expect(result).not.toHaveProperty('terminate')
      }).pipe(Effect.scoped),
  )

  it.live(
    "fails the call with the engine's refusal, as the agent reads it",
    () =>
      Effect.gen(function* () {
        const { tools } = yield* loadedTalk(() => ({
          talk_tool: () =>
            Effect.fail(
              ToolRefusal.cases.confirm_first.make({ action: 'Stop the run' }),
            ),
        }))
        const failed = yield* Effect.promise(() =>
          toolNamed(tools, 'file_tree')
            .execute('call-1', { title: 'x' }, undefined)
            .then(
              () => 'it went through',
              (error: unknown) =>
                error instanceof Error ? error.message : String(error),
            ),
        )
        expect(failed).toContain(
          'ask the maintainer in one line first, and call this again once they say yes: Stop the run?',
        )
      }).pipe(Effect.scoped),
  )

  it.live('gives no standing rules, and never nudges a turn', () =>
    Effect.gen(function* () {
      const { handlers, calls, folder } = yield* loadedTalk()
      const sections: Record<string, string> = {}
      yield* Effect.promise(async () => {
        await handlers.before_agent_start?.(starting(folder, sections))
      })
      expect(sections[StandingRulesSection]).toBeUndefined()
      for (const _ of [1, 2])
        expect(
          yield* Effect.promise(async () =>
            handlers.agent_before_settle?.(settling),
          ),
        ).toBeUndefined()
      // Not even the second settle reports it unfinished.
      expect(calls).toEqual([])
    }).pipe(Effect.scoped),
  )

  it.live(
    "lets the mode's tools and Pi's readers through the gate, and what it asks about is refused",
    () =>
      Effect.gen(function* () {
        const { calls, toolCall } = yield* loadedTalk()
        expect(yield* toolCall('run_view', {})).toBeUndefined()
        expect(calls).toEqual([])
        expect(yield* toolCall('read', { path: 'a.ts' })).toBeUndefined()
        const asked = yield* toolCall('some_other_tool', {})
        expect(asked).toMatchObject({ block: true })
        expect(calls.map(({ rpc }) => rpc)).toContain('request_permission')
      }).pipe(Effect.scoped),
  )
})
