import { Effect, Option, Schema } from 'effect'

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
  VerdictParameters,
  VerdictTool,
  parametersJsonSchema,
} from '@fabrica/contracts'
import { tempFolder } from '@fabrica/testkit'

import { type ExtensionEnvironment, readEnvironment } from '../src/environment'
import { makeExtension } from '../src/extension'
import type { PiApi, PiTool } from '../src/pi'
import { StandingRulesSection, verifierRules } from '../src/rules'
import { NudgeType, SettledType, VerifierNudgeText } from '../src/settle'
import { type Call, answers, serve, token } from './control-server'

// The extension in a verifier's Pi (spec §13.6): read from `FABRICA_AGENT_ROLE`, it registers the
// verifier's one tool, `verdict`, forwarded to the engine and ending the turn, gives the verifier's
// standing rules in place of the worker's, and nudges a turn with no verdict towards one. A fake Pi
// records what the extension registers; a control server on a real Unix socket answers as the engine
// would.

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

/** The extension loaded into a fake Pi as a verifier, its control channel answering as the engine would. */
const loadedVerifier = Effect.fn(function* () {
  const folder = yield* tempFolder('pi-verifier')
  const calls: Array<Call> = []
  const socket = yield* serve(folder, answers(calls, { dirty: false }))
  const environment: ExtensionEnvironment = {
    control: Option.some({ socket, token }),
    role: 'verifier',
    projectTrusted: false,
    configFolder: Option.none(),
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
  prompt: 'Verify the change.',
  systemPrompt: '',
  systemPromptOptions: {
    selectedTools: ['read', 'bash'],
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

const failing = {
  verdict: {
    _tag: 'FAIL',
    summary: 'A gap.',
    findings: [
      { gap: 'src/a.ts:3 has no test', blocking: true, disagreesWithRound: 1 },
    ],
  },
}

describe('the extension in a verifier', () => {
  it('reads its role from the environment, a worker where none is given', () => {
    expect(
      readEnvironment({ [AgentRoleVariable]: 'verifier' }, '/work/fa-1').role,
    ).toBe('verifier')
    expect(readEnvironment({}, '/work/fa-1').role).toBe('worker')
    expect(
      readEnvironment({ [AgentRoleVariable]: 'boss' }, '/work/fa-1').role,
    ).toBe('worker')
  })

  it.live(
    "registers verdict alone, and gives the verifier's standing rules",
    () =>
      Effect.gen(function* () {
        const { tools, handler, folder } = yield* loadedVerifier()
        expect(tools.map(tool => tool.name)).toEqual(['verdict'])
        expect(tools[0]?.parameters).toEqual(parametersJsonSchema(VerdictTool))
        const event = starting(folder)
        yield* Effect.promise(async () => handler('before_agent_start')(event))
        expect(event.systemPromptOptions.sections[StandingRulesSection]).toBe(
          verifierRules,
        )
        expect(verifierRules).toContain('Change nothing')
        // The gate lets the agent's own tool through without asking the engine.
        const decided = yield* Effect.promise(async () =>
          handler('tool_call')({
            type: 'tool_call',
            toolCallId: 'call-1',
            toolName: 'verdict',
            input: failing,
          }),
        )
        expect(decided).toBeUndefined()
      }),
  )

  it.live(
    'forwards its verdict to the engine, and the verdict ends the turn',
    () =>
      Effect.gen(function* () {
        const { tools, handler, calls, entries } = yield* loadedVerifier()
        const verdict = tools[0]
        if (verdict === undefined) throw new Error('no verdict tool')
        const answer = yield* Effect.promise(() =>
          verdict.execute('call-1', failing, undefined),
        )
        expect(answer.terminate).toBe(true)
        expect(calls.map(({ rpc }) => rpc)).toEqual(['verdict'])
        expect(
          Schema.encodeUnknownSync(VerdictParameters)(calls[0]?.payload),
        ).toEqual(failing)
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
            data: { outcome: 'verdict', nudged: false, aborted: false },
          },
        ])
      }),
  )

  it.live('nudges a turn with no verdict towards one', () =>
    Effect.gen(function* () {
      const { handler } = yield* loadedVerifier()
      const nudged = yield* Effect.promise(async () =>
        handler('agent_before_settle')(settling),
      )
      expect(nudged).toEqual({
        continue: true,
        entries: [
          {
            type: 'custom_message',
            customType: NudgeType,
            content: VerifierNudgeText,
            display: false,
          },
        ],
      })
    }),
  )
})
