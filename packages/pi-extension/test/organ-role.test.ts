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
  type AnswerToolGiven,
  AnswerToolVariable,
} from '@fabrica/contracts'
import { tempFolder } from '@fabrica/testkit'

import {
  ControlEndpoint,
  type ExtensionEnvironment,
  readEnvironment,
} from '../src/environment'
import { makeExtension } from '../src/extension'
import type { PiApi, PiTool } from '../src/pi'
import { StandingRulesSection, organRules } from '../src/rules'
import { NudgeType, OrganNudgeText, SettledType } from '../src/settle'
import { type Call, answers, serve, token } from './control-server'

// The extension in an organ's session (spec §16): read from `FABRICA_AGENT_ROLE` and
// `FABRICA_ANSWER_TOOL`, it registers the organ's one tool, `answer`, showing the model the schema the
// engine gave and forwarding the arguments to the engine, which decodes them; the call ends the turn.
// It gives an organ's standing rules, and nudges a turn with no answer towards one. A fake Pi records
// what the extension registers; a control server on a real Unix socket answers as the engine would.

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
    registerProvider: () => undefined,
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
  return { pi, tools, entries, handler }
}

const given: AnswerToolGiven = {
  description: 'The files the ticket will likely change.',
  parameters: {
    type: 'object',
    properties: { answer: { type: 'array', items: { type: 'string' } } },
    required: ['answer'],
    additionalProperties: false,
  },
}

/** The extension loaded into a fake Pi as an organ's session, its control channel answering as the engine would. */
const loadedOrgan = Effect.fn(function* (
  answerTool: Option.Option<AnswerToolGiven> = Option.some(given),
) {
  const folder = yield* tempFolder('pi-organ')
  const calls: Array<Call> = []
  const socket = yield* serve(folder, answers(calls, { dirty: false }))
  const environment: ExtensionEnvironment = {
    control: Option.some({ endpoint: ControlEndpoint.Unix({ socket }), token }),
    role: 'organ',
    answerTool,
    talkTools: [],
    projectTrusted: false,
    configFolder: Option.none(),
    permissions: 'workspace',
    worktree: folder,
    home: Option.none(),
    cdPath: false,
    cdableVariables: false,
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

/** Pi starting a run from a prompt, in `cwd`. */
const starting = (cwd: string): BeforeAgentStartEvent => ({
  type: 'before_agent_start',
  messageType: 'user',
  prompt: 'Which files?',
  systemPrompt: '',
  systemPromptOptions: {
    selectedTools: ['read', 'answer'],
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

describe("the extension in an organ's session", () => {
  it('reads its role and its answer tool from the environment', () => {
    const read = readEnvironment(
      {
        [AgentRoleVariable]: 'organ',
        [AnswerToolVariable]: JSON.stringify({ name: 'answer', ...given }),
      },
      '/checkout',
    )
    expect(read.role).toBe('organ')
    expect(read.answerTool).toEqual(Option.some(given))
    expect(readEnvironment({}, '/checkout').answerTool).toEqual(Option.none())
    expect(
      readEnvironment({ [AnswerToolVariable]: 'not json' }, '/checkout')
        .answerTool,
    ).toEqual(Option.none())
  })

  it.live(
    "registers answer alone, as the engine gave it, and gives an organ's standing rules",
    () =>
      Effect.gen(function* () {
        const { tools, handler, folder } = yield* loadedOrgan()
        expect(tools.map(tool => tool.name)).toEqual(['answer'])
        expect(tools[0]?.description).toBe(given.description)
        expect(tools[0]?.parameters).toEqual(given.parameters)
        const event = starting(folder)
        yield* Effect.promise(async () => handler('before_agent_start')(event))
        expect(event.systemPromptOptions.sections[StandingRulesSection]).toBe(
          organRules,
        )
        expect(organRules).toContain('Change nothing')
        // The gate lets the agent's own tool through without asking the engine.
        const decided = yield* Effect.promise(async () =>
          handler('tool_call')({
            type: 'tool_call',
            toolCallId: 'call-1',
            toolName: 'answer',
            input: { answer: ['src/a.ts'] },
          }),
        )
        expect(decided).toBeUndefined()
      }),
  )

  it.live('registers no tool where the engine gave none it reads', () =>
    Effect.gen(function* () {
      const { tools } = yield* loadedOrgan(Option.none())
      expect(tools).toEqual([])
    }),
  )

  it.live(
    'forwards the arguments to the engine, and answering ends the turn',
    () =>
      Effect.gen(function* () {
        const { tools, handler, calls, entries } = yield* loadedOrgan()
        const answer = tools[0]
        if (answer === undefined) throw new Error('no answer tool')
        const result = yield* Effect.promise(() =>
          answer.execute('call-1', { answer: ['src/a.ts'] }, undefined),
        )
        expect(result.terminate).toBe(true)
        expect(calls).toEqual([
          { rpc: 'answer', payload: { answer: ['src/a.ts'] } },
        ])
        const settled = yield* Effect.promise(async () =>
          handler('agent_before_settle')(settling),
        )
        expect(settled).toBeUndefined()
        yield* Effect.promise(async () =>
          handler('agent_settled')({ type: 'agent_settled', aborted: false }),
        )
        expect(entries).toEqual([
          {
            customType: SettledType,
            data: { outcome: 'answer', nudged: false, aborted: false },
          },
        ])
      }),
  )

  it.live('nudges a turn with no answer towards one', () =>
    Effect.gen(function* () {
      const { handler } = yield* loadedOrgan()
      const nudged = yield* Effect.promise(async () =>
        handler('agent_before_settle')(settling),
      )
      expect(nudged).toEqual({
        continue: true,
        entries: [
          {
            type: 'custom_message',
            customType: NudgeType,
            content: OrganNudgeText,
            display: false,
          },
        ],
      })
    }),
  )
})
