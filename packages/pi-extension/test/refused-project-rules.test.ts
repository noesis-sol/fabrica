import { Effect, Option } from 'effect'
import { execFileSync } from 'node:child_process'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
import { tempFolder } from '@fabrica/testkit'

import type { ExtensionEnvironment } from '../src/environment'
import { makeExtension } from '../src/extension'
import type { PiApi } from '../src/pi'
import {
  ProjectRulesMaxBytes,
  ProjectRulesPath,
  StandingRulesSection,
  standingRules,
} from '../src/rules'

// A project's rules file refused as hostile (spec §12.4, §20.2) costs the worker only the project's
// own rules: Pi only reports a handler's error, so one escaping `before_agent_start` would start the
// agent with no rules at all. A fake Pi fires the handler; nothing here reaches the control channel.

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

const secret = 'BEGIN OPENSSH PRIVATE KEY'

/** The section the extension in a worker gives for a worktree `arrange` set up. */
const sectionFor = (arrange: (rules: string, key: string) => Promise<void>) =>
  Effect.gen(function* () {
    const folder = yield* tempFolder('refused-project-rules')
    const root = join(folder, 'worktree')
    const key = join(folder, 'id_ed25519')
    yield* Effect.promise(async () => {
      await mkdir(join(root, '.fabrica'), { recursive: true })
      await writeFile(key, `${secret}\n`)
      await arrange(join(root, ProjectRulesPath), key)
    })
    const environment: ExtensionEnvironment = {
      control: Option.none(),
      role: 'worker',
      answerTool: Option.none(),
      talkTools: [],
      projectTrusted: false,
      configFolder: Option.none(),
      permissions: 'workspace',
      worktree: root,
      home: Option.none(),
      cdPath: false,
      cdableVariables: false,
    }
    const handlers: Partial<Handlers> = {}
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
      registerTool: () => undefined,
      registerProvider: () => undefined,
      appendEntry: () => undefined,
    }
    yield* Effect.promise(() => makeExtension(environment)(pi))
    const event: BeforeAgentStartEvent = {
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
        cwd: root,
        contextFiles: [],
        skills: [],
      },
    }
    yield* Effect.promise(async () => handlers.before_agent_start?.(event))
    return {
      path: join(root, ProjectRulesPath),
      section: event.systemPromptOptions.sections[StandingRulesSection] ?? '',
    }
  })

const refusals = [
  {
    name: 'a link at its path',
    reason: 'it is a symbolic link',
    arrange: (rules: string, key: string) => symlink(key, rules),
  },
  {
    name: 'a named pipe',
    reason: 'it is not a regular file',
    arrange: async (rules: string) => {
      execFileSync('/usr/bin/mkfifo', [rules], { env: {} })
    },
  },
  {
    name: 'a folder',
    reason: 'it is not a regular file',
    arrange: (rules: string) => mkdir(rules),
  },
  {
    name: 'a file past the cap',
    reason: `it has ${ProjectRulesMaxBytes + 1} bytes, more than the ${ProjectRulesMaxBytes} allowed`,
    arrange: (rules: string) =>
      writeFile(rules, 'a'.repeat(ProjectRulesMaxBytes + 1)),
  },
]

describe('a worker whose project rules are refused', () => {
  it.live.each(refusals)(
    'keeps the standing rules and says why, for $name',
    ({ reason, arrange }) =>
      Effect.gen(function* () {
        const { path, section } = yield* sectionFor(arrange)
        expect(section.startsWith(standingRules(Option.none()))).toBe(true)
        expect(section).toContain(
          `The project's own rules are left out of this prompt: the project's worker rules ${path} couldn't be read: ${reason}.`,
        )
        expect(section).not.toContain(secret)
        expect(section).not.toContain("The project's own rules:")
      }),
  )

  it.live('has no such line where the file is read', () =>
    Effect.gen(function* () {
      const { section } = yield* sectionFor(rules =>
        writeFile(rules, 'Run make lint.\n'),
      )
      expect(section).toBe(standingRules(Option.some('Run make lint.')))
      expect(section).not.toContain('left out')
    }),
  )
})
