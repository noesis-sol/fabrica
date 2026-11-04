import { Duration, Effect, Fiber, Layer, Option, Schema, Stream } from 'effect'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from '@effect/vitest'
import {
  AgentRoleVariable,
  ControlSocketVariable,
  ControlTokenVariable,
  ProjectId,
  TalkId,
  TalkToolsVariable,
  ToolRefusal,
} from '@fabrica/contracts'
import { Agent, Process } from '@fabrica/engine'
import { tempFolder } from '@fabrica/testkit'

import { Reply, model, stubModel, systemText } from './contract-model'
import { type Call, answers, serve, token } from './control-server'

// The Pi contract for a talk (spec §15.4, §24): the real pinned Pi in RPC mode, as `TalkAgents` starts
// it: in the project's checkout, its sessions in the talk's folder, with the mode's instructions
// appended to its system prompt, and the mode's tools alone through the first-party extension, with
// Pi's readers beside them where the mode reads code. A call reaches the engine by the tool's name, a
// refusal comes back to the model, a turn with no outcome tool settles with no nudge, and a resumed
// session keeps its messages and its instructions. Run on every Pi upgrade:
// `pnpm --filter @fabrica/pi-extension test:contract`.

const piPackage = fileURLToPath(
  new URL('../node_modules/@earendil-works/pi-coding-agent/', import.meta.url),
)
const extension = fileURLToPath(new URL('../src/index.ts', import.meta.url))

const PiManifest = Schema.Struct({ bin: Schema.Struct({ pi: Schema.String }) })

const piCli = Effect.map(
  Effect.promise(() => readFile(join(piPackage, 'package.json'), 'utf8')),
  text =>
    join(
      piPackage,
      Schema.decodeUnknownSync(PiManifest)(JSON.parse(text)).bin.pi,
    ),
)

const talk = TalkId.make('talk-contract')
const instructions = 'You are talking a feature through with the maintainer.'

/** The mode's one tool, as the engine gives it at spawn. */
const modeTools = JSON.stringify([
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
])

const readers = ['read', 'grep', 'find', 'ls']

/** A talk's setting: its checkout, the stub model with `replies`, and `start`, which starts its agent. */
const setting = Effect.fn(function* (
  replies: ReadonlyArray<Reply>,
  refuses = false,
) {
  const root = yield* tempFolder('pi-talk')
  const checkout = join(root, 'checkout')
  const home = join(root, 'home')
  yield* Effect.promise(async () => {
    await mkdir(checkout)
    await mkdir(home)
  })
  const calls: Array<Call> = []
  const base = answers(calls, { dirty: false })
  const socket = yield* serve(root, {
    ...base,
    talk_tool: (payload, options) =>
      refuses
        ? Effect.fail(
            ToolRefusal.cases.confirm_first.make({ action: 'File the tree' }),
          )
        : base.talk_tool(payload, options),
  })
  const stub = yield* stubModel(replies)
  const context = yield* Layer.build(
    Agent.layer({
      node: process.execPath,
      cli: yield* piCli,
      extension,
      data: join(root, 'data'),
      configRoot: join(root, 'agents'),
      limits: {
        handshake: Duration.seconds(30),
        answer: Duration.seconds(30),
        abort: Duration.seconds(5),
        reap: Duration.seconds(5),
      },
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
    ),
  )
  const sessions = join(root, 'talks', 'sessions')
  const start = (
    tools: ReadonlyArray<string>,
    resume: Option.Option<string> = Option.none(),
  ) =>
    Effect.flatMap(Agent.PiAgent, agents =>
      agents.start({
        owner: Agent.AgentOwner.Talk({ talk, sessions }),
        project: ProjectId.make('p1'),
        worktree: checkout,
        providers: [{ provider: model.provider, baseUrl: stub.baseUrl }],
        token: 'agent-token-1',
        model: Option.some(model),
        tools: Option.some(tools),
        resume,
        instructions,
        env: {
          [ControlSocketVariable]: socket,
          [ControlTokenVariable]: token,
          [AgentRoleVariable]: 'talk',
          [TalkToolsVariable]: modeTools,
        },
        projectTrusted: false,
        nice: Option.none(),
      }),
    ).pipe(Effect.provide(context))
  return { calls, stub, start, sessions }
})

const namesOf = (tools: ReadonlyArray<{ readonly name: string }> | undefined) =>
  (tools ?? []).map(({ name }) => name).sort()

/** A real Pi starts, loads its extension and the model, and runs a model call: allow for a loaded machine. */
const timeout = 60_000

describe('Pi in a talk', () => {
  it.live(
    "runs on the mode's instructions and tools, hands a call to the engine, and settles with no nudge",
    () =>
      Effect.gen(function* () {
        const { calls, stub, start, sessions } = yield* setting([
          Reply.Call({
            id: 'call-1',
            name: 'file_tree',
            input: { title: 'Dark mode' },
          }),
          Reply.Text({ text: 'Filed it. Anything else?' }),
        ])
        const agent = yield* start([...readers, 'file_tree'])
        expect(Option.getOrThrow(agent.session.file).startsWith(sessions)).toBe(
          true,
        )
        const settled = yield* agent.prompt('File it.')
        expect(settled.aborted).toBe(false)
        expect(calls).toEqual([
          {
            rpc: 'talk_tool',
            payload: { tool: 'file_tree', input: { title: 'Dark mode' } },
          },
        ])
        // The model's answer ended the turn: no third call, as a nudge would have made.
        expect(stub.calls).toHaveLength(2)
        const [first, second] = stub.calls
        if (first === undefined || second === undefined)
          return yield* Effect.die('the model was called fewer than twice')
        expect(namesOf(first.body.tools)).toEqual(
          [...readers, 'file_tree'].sort(),
        )
        expect(systemText(first)).toContain(instructions)
        // A worker's rules aren't a talk's.
        expect(systemText(first)).not.toContain("Fabrica's standing rules")
        expect(JSON.stringify(second.body.messages)).toContain('echoed')
      }),
    timeout,
  )

  it.live(
    "has only the mode's tools where it doesn't read code",
    () =>
      Effect.gen(function* () {
        const { stub, start } = yield* setting([Reply.Text({ text: 'Yes.' })])
        const agent = yield* start(['file_tree'])
        yield* agent.prompt('Are you there?')
        expect(namesOf(stub.calls[0]?.body.tools)).toEqual(['file_tree'])
      }),
    timeout,
  )

  it.live(
    "gives the engine's refusal back to the model, which can go on",
    () =>
      Effect.gen(function* () {
        const { stub, start } = yield* setting(
          [
            Reply.Call({
              id: 'call-1',
              name: 'file_tree',
              input: { title: 'Dark mode' },
            }),
            Reply.Text({ text: 'Shall I file the tree?' }),
          ],
          true,
        )
        const agent = yield* start(['file_tree'])
        yield* agent.prompt('File it.')
        expect(stub.calls).toHaveLength(2)
        expect(JSON.stringify(stub.calls[1]?.body.messages)).toContain(
          'ask the maintainer in one line first',
        )
      }),
    timeout,
  )

  it.live(
    'ends on what the provider said where the model call is refused, with nothing reported',
    () =>
      Effect.gen(function* () {
        // No reply is left to give: the stub refuses the call with a client error.
        const { calls, start } = yield* setting([])
        const agent = yield* start(['file_tree'])
        const heard = yield* (yield* agent.events).pipe(
          Stream.takeUntil(event => event.type === 'agent_settled'),
          Stream.runCollect,
          Effect.forkScoped,
        )
        const settled = yield* agent.prompt('Are you there?')
        const events = yield* Fiber.join(heard)
        expect(settled.aborted).toBe(false)
        const [failed] = events.flatMap(event =>
          event.type === 'message_end' && event.message.role === 'assistant'
            ? [event.message]
            : [],
        )
        // What the talk's transcript says of it (`talks/core.ts`).
        expect(failed?.stopReason).toBe('error')
        expect(failed?.errorMessage).toContain("the stub can't serve")
        expect(calls).toEqual([])
      }),
    timeout,
  )

  it.live(
    'keeps its messages and its instructions when resumed from the file it kept',
    () =>
      Effect.gen(function* () {
        const { stub, start } = yield* setting([
          Reply.Text({ text: 'Noted.' }),
          Reply.Text({ text: 'Still here.' }),
        ])
        const file = yield* Effect.scoped(
          Effect.gen(function* () {
            const agent = yield* start(['file_tree'])
            yield* agent.prompt('Remember the dark mode.')
            return Option.getOrThrow(agent.session.file)
          }),
        )
        const resumed = yield* start(['file_tree'], Option.some(file))
        expect(resumed.session.file).toEqual(Option.some(file))
        yield* resumed.prompt('What did I say?')
        const last = stub.calls[1]
        if (last === undefined)
          return yield* Effect.die('the model was called once')
        expect(JSON.stringify(last.body.messages)).toContain(
          'Remember the dark mode.',
        )
        expect(systemText(last)).toContain(instructions)
      }),
    timeout,
  )
})
