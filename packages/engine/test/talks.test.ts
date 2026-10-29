import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Stream,
} from 'effect'
import { RpcTest } from 'effect/rpc'
import { TestClock } from 'effect/testing'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type AnyTool,
  FileTicketTool,
  GetTicketTool,
  type ModelChoice,
  ProjectId,
  ProjectNotFound,
  type ProjectSettings,
  Resume,
  SessionId,
  type TalkContext,
  TalkId,
  type TalkMode,
  TalkNotFound,
  TalkNotOpened,
  TalkRpcs,
  TranscriptEntry,
  type TranscriptItem,
  decodeProjectSettings,
} from '@fabrica/contracts'

import type { PiEvent } from '../src/agent'
import { engineDatabaseLayer } from '../src/engine/database'
import { EngineFiles, pathsIn } from '../src/engine/paths'
import { engineScopesLayer } from '../src/engine/scopes'
import { type ProjectRecord, Projects } from '../src/projects'
import { talksHandlers } from '../src/rpc/talks'
import {
  TalkAgentFailed,
  type TalkAgentStart,
  TalkAgents,
  TalkModes,
  type TalkModesShape,
  type TalkTool,
} from '../src/talks'

// Talks over RPC (spec §15.4, §8.3): the Talks group's handlers, as the daemon builds them, on a scripted
// Pi session in place of a talk's agent. The script answers each prompt with a model's message streamed
// in deltas, a tool call with its output, and the turn's end with what it spent; a prompt with "wait"
// in it holds its turn open until the test lets it settle, one with "fail" in it is refused. A talk is
// opened in a mode with its context, sent messages, its transcript streamed (and resumed), and closed;
// a kept mode's talk is the same talk when opened again, and after a restart resumes its session.

let root = ''

beforeAll(() => {
  root = realpathSync(mkdtempSync(NodePath.join(tmpdir(), 'fabrica-talks-')))
})

const project = ProjectId.make('work')

const usage = {
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 18,
  cost: { total: 0.01 },
}

/** The scripted model's answer to `message`. */
const reply = (message: string): ReadonlyArray<PiEvent> => [
  { type: 'agent_start' },
  // Pi's echo of the prompt: the transcript has the maintainer's message already.
  { type: 'message_start', message: { role: 'user' } },
  { type: 'message_start', message: { role: 'assistant' } },
  {
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: 'Reading it' },
  },
  {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'On ' },
  },
  {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: message },
  },
  {
    type: 'message_end',
    message: { role: 'assistant', provider: 'anthropic', model: 'x', usage },
  },
  {
    type: 'tool_execution_start',
    toolCallId: 'call-1',
    toolName: 'get_ticket',
    args: { id: 'fa-a1b2' },
  },
  {
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: 'get_ticket',
    isError: false,
    result: { content: [{ type: 'text', text: 'fa-a1b2: Dark mode' }] },
  },
]

/** What the scripted agents were asked, and the hold on a "wait" turn. */
interface Script {
  readonly started: Ref.Ref<ReadonlyArray<TalkAgentStart>>
  readonly prompts: Ref.Ref<ReadonlyArray<string>>
  readonly steers: Ref.Ref<ReadonlyArray<string>>
  /** Lets a held turn settle. */
  readonly settle: Deferred.Deferred<void>
  /** Completed as a held turn has written its deltas. */
  readonly held: Deferred.Deferred<void>
}

/** Talks' agents that play the script; a talk named `refused` is refused. */
const scriptedAgents = (script: Script) =>
  Layer.succeed(TalkAgents)({
    start: options =>
      Effect.gen(function* () {
        yield* Ref.update(script.started, all => [...all, options])
        if (options.instructions === 'refuse')
          return yield* new TalkAgentFailed({
            talk: options.talk,
            reason: 'pi exited with status 3: no model configured',
          })
        const events = yield* PubSub.unbounded<PiEvent>()
        yield* Effect.addFinalizer(() => PubSub.shutdown(events))
        const publish = (all: ReadonlyArray<PiEvent>) =>
          PubSub.publishAll(events, all)
        return {
          session: {
            id: SessionId.make(`s-${options.talk}`),
            file: Option.some(
              NodePath.join(options.sessions, `${options.talk}.jsonl`),
            ),
          },
          events: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
          prompt: message =>
            Effect.gen(function* () {
              yield* Ref.update(script.prompts, all => [...all, message])
              if (message.includes('fail'))
                return yield* new TalkAgentFailed({
                  talk: options.talk,
                  reason: 'Pi exited',
                })
              if (message.includes('wait')) {
                yield* publish([
                  { type: 'message_start', message: { role: 'assistant' } },
                  {
                    type: 'message_update',
                    assistantMessageEvent: { type: 'text_delta', delta: '…' },
                  },
                ])
                yield* Deferred.succeed(script.held, undefined)
                yield* Deferred.await(script.settle)
              } else yield* publish(reply(message))
              yield* publish([{ type: 'agent_settled', aborted: false }])
            }),
          steer: message => Ref.update(script.steers, all => [...all, message]),
        }
      }),
  })

/** A tool the scripted agents never call. */
const uncalled = <M extends TalkMode>(tool: AnyTool): TalkTool<M> => ({
  tool,
  call: () => Effect.die(`${tool.name} isn't called here`),
})

/** A mode for each of the tests: `feature` opens with its text, `run` is kept and waits. */
const modes: TalkModesShape = {
  feature: {
    keep: false,
    instructions: 'Talk the feature through; file an epic and its tickets.',
    tools: [uncalled(GetTicketTool), uncalled(FileTicketTool)],
    opening: ({ context, project: { name } }) =>
      Effect.succeed(Option.map(context.text, text => `In ${name}: ${text}`)),
  },
  run: {
    keep: true,
    instructions: 'Read the run; act on the maintainer’s word.',
    tools: [uncalled(GetTicketTool)],
    opening: () => Effect.succeed(Option.none()),
  },
  refine: {
    keep: false,
    instructions: 'refuse',
    tools: [],
    opening: () => Effect.succeed(Option.none()),
  },
}

const record = (checkout: string): ProjectRecord => ({
  id: project,
  name: 'Work',
  path: checkout,
  origin: 'registered',
  url: Option.none(),
  base: 'main',
  trusted: true,
})

/** Projects with one, `work`, at `checkout`, its settings `settings`; nothing else is asked of them. */
const oneProject = (checkout: string, settings: ProjectSettings) => {
  const unused = Effect.die('not asked of the projects by talks')
  return Layer.succeed(Projects)({
    add: () => unused,
    list: unused,
    remove: () => unused,
    find: id =>
      id === project
        ? Effect.succeed(record(checkout))
        : Effect.fail(new ProjectNotFound({ project: id })),
    setTrusted: () => unused,
    worktreeHome: () => unused,
    settings: id =>
      id === project
        ? Effect.succeed(settings)
        : Effect.fail(new ProjectNotFound({ project: id })),
    setSettings: () => unused,
    workGraph: () => unused,
    onBase: () => unused,
    watchStatus: () => Stream.die('not asked of the projects by talks'),
  })
}

const settingsOf = (written: unknown) =>
  Effect.orDie(decodeProjectSettings(written))

/** A new script. */
const newScript = Effect.gen(function* () {
  const script: Script = {
    started: yield* Ref.make<ReadonlyArray<TalkAgentStart>>([]),
    prompts: yield* Ref.make<ReadonlyArray<string>>([]),
    steers: yield* Ref.make<ReadonlyArray<string>>([]),
    settle: yield* Deferred.make<void>(),
    held: yield* Deferred.make<void>(),
  }
  return script
})

/** The Talks client of an engine on the data folder `data`, its project's settings written as `written`. */
const engineOn = (options: {
  readonly data: string
  readonly script: Script
  readonly written?: unknown
}) =>
  Effect.gen(function* () {
    const settings = yield* settingsOf(
      options.written ?? { model: 'anthropic/claude-opus-5-5' },
    )
    const services = yield* Layer.build(
      talksHandlers.pipe(
        Layer.provide([
          oneProject(NodePath.join(root, 'checkout'), settings),
          scriptedAgents(options.script),
          Layer.succeed(TalkModes)(modes),
          engineScopesLayer,
          engineDatabaseLayer(':memory:'),
          Layer.succeed(EngineFiles)(
            pathsIn({ data: options.data, socketFolder: options.data }),
          ),
        ]),
      ),
    )
    return yield* RpcTest.makeClient(TalkRpcs).pipe(Effect.provide(services))
  })

/** A new engine in a data folder of its own. */
const newEngine = (written?: unknown) =>
  Effect.gen(function* () {
    const data = mkdtempSync(NodePath.join(root, 'data-'))
    const script = yield* newScript
    const client = yield* engineOn({
      data,
      script,
      ...(written === undefined ? {} : { written }),
    })
    return { client, script, data }
  })

const featureContext = (text: string): TalkContext => ({
  _tag: 'feature',
  text: Option.some(text),
})

/** An entry as a line, its drawn IDs and times left out. */
const line: (entry: TranscriptEntry) => string = TranscriptEntry.match({
  message: ({ role, text }) => `${role}: ${text}`,
  text: ({ delta }) => `text ${delta}`,
  thinking: ({ delta }) => `thinking ${delta}`,
  tool_call: ({ id, tool, input }) =>
    `call ${id} ${tool} ${JSON.stringify(input)}`,
  tool_output: ({ id, chunk }) => `output ${id} ${chunk}`,
  tool_end: ({ id, ok }) => `end ${id} ${ok ? 'ok' : 'failed'}`,
  turn_end: ({ tokens }) => `turn ${JSON.stringify(Option.getOrNull(tokens))}`,
})

/** The entries of an item. */
const entriesOf = (item: TranscriptItem): ReadonlyArray<TranscriptEntry> =>
  item.value

/** A watch of the talk's transcript: its items, taken as they come. */
const watch = (
  client: Effect.Success<ReturnType<typeof engineOn>>,
  talk: TalkId,
  resume: Option.Option<Resume> = Option.none(),
) =>
  Effect.gen(function* () {
    const items = yield* Queue.unbounded<TranscriptItem>()
    const fiber = yield* client['talk.watchTranscript']({ talk, resume }).pipe(
      Stream.runForEach(item => Queue.offer(items, item)),
      Effect.forkScoped,
    )
    /** The lines of the items taken until one holds a turn's end. */
    const untilTurnEnd = Effect.gen(function* () {
      const lines: Array<string> = []
      for (;;) {
        const item = yield* Queue.take(items)
        lines.push(...entriesOf(item).map(line))
        if (entriesOf(item).some(TranscriptEntry.guards.turn_end)) return lines
      }
    })
    return { items, fiber, untilTurnEnd }
  })

const answered = (message: string): ReadonlyArray<string> => [
  'assistant: ',
  'thinking Reading it',
  'text On ',
  `text ${message}`,
  'call call-1 get_ticket {"id":"fa-a1b2"}',
  'output call-1 fa-a1b2: Dark mode',
  'end call-1 ok',
  'turn {"input":10,"output":5,"cache_write":1,"cache_read":2}',
]

/** The error `exit` failed with. */
const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : expect.fail('it succeeded')

describe('talks', () => {
  it.effect(
    'opens a talk on the project’s model, in its checkout, with its mode’s opening, and streams its turn',
    () =>
      Effect.gen(function* () {
        const { client, script, data } = yield* newEngine()
        const opened = yield* client['talk.open']({
          project,
          context: featureContext('Dark mode'),
          model: Option.none(),
        })
        expect(opened.model).toBe('anthropic/claude-opus-5-5')
        expect(opened.session).toBe(`s-${opened.talk}`)
        const { untilTurnEnd } = yield* watch(client, opened.talk)
        expect(yield* untilTurnEnd).toStrictEqual([
          'engine: In Work: Dark mode',
          ...answered('In Work: Dark mode'),
        ])

        const [started] = yield* Ref.get(script.started)
        expect(started).toMatchObject({
          talk: opened.talk,
          mode: 'feature',
          project,
          checkout: NodePath.join(root, 'checkout'),
          projectTrusted: true,
          model: { provider: 'anthropic', model: 'claude-opus-5-5' },
          instructions:
            'Talk the feature through; file an epic and its tickets.',
          sessions: NodePath.join(
            data,
            'projects',
            'work',
            'talks',
            opened.talk,
          ),
          resume: Option.none(),
        })
        expect(started?.tools.map(tool => tool.name)).toStrictEqual([
          'get_ticket',
          'file_ticket',
        ])
        expect(yield* Ref.get(script.prompts)).toStrictEqual([
          'In Work: Dark mode',
        ])
      }).pipe(Effect.scoped),
  )

  it.effect(
    'sends the maintainer’s messages, streams the answers, and resumes a watch after its last patch',
    () =>
      Effect.gen(function* () {
        const { client, script } = yield* newEngine()
        const { talk } = yield* client['talk.open']({
          project,
          context: { _tag: 'feature', text: Option.none() },
          model: Option.none(),
        })
        // No opening without a text: the talk waits for the maintainer.
        const first = yield* watch(client, talk)
        const snapshot = yield* Queue.take(first.items)
        expect(snapshot._tag).toBe('snapshot')
        expect(entriesOf(snapshot)).toStrictEqual([])

        yield* client['talk.send']({ talk, text: 'Add a toggle' })
        expect(yield* first.untilTurnEnd).toStrictEqual([
          'user: Add a toggle',
          ...answered('Add a toggle'),
        ])
        expect(yield* Ref.get(script.prompts)).toStrictEqual(['Add a toggle'])

        // A late watch gets the transcript whole in its snapshot.
        const late = yield* watch(client, talk)
        const whole = yield* Queue.take(late.items)
        expect(whole._tag).toBe('snapshot')
        expect(entriesOf(whole).map(line)).toStrictEqual([
          'user: Add a toggle',
          ...answered('Add a toggle'),
        ])

        // A watch resumed where the late one stood gets only what came since.
        const at =
          whole._tag === 'snapshot'
            ? new Resume({ epoch: whole.epoch, after: whole.seq })
            : expect.fail('not a snapshot')
        yield* client['talk.send']({ talk, text: 'And a shortcut' })
        const resumed = yield* watch(client, talk, Option.some(at))
        const next = yield* resumed.untilTurnEnd
        expect(next).toStrictEqual([
          'user: And a shortcut',
          ...answered('And a shortcut'),
        ])
        expect(yield* Queue.poll(resumed.items)).toStrictEqual(Option.none())
      }).pipe(Effect.scoped),
  )

  it.effect(
    'sends a message into a running turn, and batches the turn’s deltas until the flush',
    () =>
      Effect.gen(function* () {
        const { client, script } = yield* newEngine()
        const { talk } = yield* client['talk.open']({
          project,
          context: featureContext('wait for it'),
          model: Option.none(),
        })
        const { items, untilTurnEnd } = yield* watch(client, talk)
        expect(entriesOf(yield* Queue.take(items)).map(line)).toStrictEqual([
          'engine: In Work: wait for it',
        ])
        yield* Deferred.await(script.held)
        // The deltas wait for the flush, 50 ms after the first of them.
        expect(yield* Queue.size(items)).toBe(0)
        yield* TestClock.adjust('50 millis')
        expect(entriesOf(yield* Queue.take(items)).map(line)).toStrictEqual([
          'assistant: ',
          'text …',
        ])

        yield* client['talk.send']({ talk, text: 'Make it blue' })
        expect(yield* Ref.get(script.steers)).toStrictEqual(['Make it blue'])
        expect(yield* Ref.get(script.prompts)).toStrictEqual([
          'In Work: wait for it',
        ])
        yield* Deferred.succeed(script.settle, undefined)
        expect(yield* untilTurnEnd).toStrictEqual([
          'user: Make it blue',
          'turn null',
        ])

        // Settled, the next message is a prompt of its own.
        yield* client['talk.send']({ talk, text: 'Thanks' })
        expect(yield* untilTurnEnd).toStrictEqual([
          'user: Thanks',
          ...answered('Thanks'),
        ])
        expect(yield* Ref.get(script.prompts)).toStrictEqual([
          'In Work: wait for it',
          'Thanks',
        ])
      }).pipe(Effect.scoped),
  )

  it.effect('closes a talk: its watches end, and it is no longer found', () =>
    Effect.gen(function* () {
      const { client } = yield* newEngine()
      const { talk } = yield* client['talk.open']({
        project,
        context: featureContext('Dark mode'),
        model: Option.none(),
      })
      const { fiber, untilTurnEnd } = yield* watch(client, talk)
      yield* untilTurnEnd
      yield* client['talk.close']({ talk })
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)

      const notFound = new TalkNotFound({ talk })
      expect(
        failureOf(yield* Effect.exit(client['talk.close']({ talk }))),
      ).toStrictEqual(notFound)
      expect(
        failureOf(
          yield* Effect.exit(client['talk.send']({ talk, text: 'Hello?' })),
        ),
      ).toStrictEqual(notFound)
      expect(
        failureOf(
          yield* Effect.exit(
            Stream.runCollect(
              client['talk.watchTranscript']({
                talk,
                resume: Option.none(),
              }),
            ),
          ),
        ),
      ).toStrictEqual(notFound)
    }).pipe(Effect.scoped),
  )

  it.effect(
    'says in the transcript that a message wasn’t delivered, and ends its turn',
    () =>
      Effect.gen(function* () {
        const { client } = yield* newEngine()
        const { talk } = yield* client['talk.open']({
          project,
          context: { _tag: 'feature', text: Option.none() },
          model: Option.none(),
        })
        const { untilTurnEnd } = yield* watch(client, talk)
        yield* client['talk.send']({ talk, text: 'fail now' })
        expect(yield* untilTurnEnd).toStrictEqual([
          'user: fail now',
          "engine: The message wasn't delivered: Pi exited",
          'turn null',
        ])
      }).pipe(Effect.scoped),
  )

  it.effect('runs a talk on the model it is given over the project’s', () =>
    Effect.gen(function* () {
      const { client, script } = yield* newEngine({})
      const model: ModelChoice = {
        provider: 'openai',
        model: 'gpt-6',
        thinking: Option.some('high'),
      }
      const opened = yield* client['talk.open']({
        project,
        context: featureContext('Dark mode'),
        model: Option.some(model),
      })
      expect(opened.model).toBe('openai/gpt-6')
      expect((yield* Ref.get(script.started))[0]?.model).toStrictEqual(model)
    }).pipe(Effect.scoped),
  )

  it.effect('says why a talk couldn’t be opened', () =>
    Effect.gen(function* () {
      const { client } = yield* newEngine({})
      const open = (context: TalkContext, on = project) =>
        Effect.exit(
          client['talk.open']({ project: on, context, model: Option.none() }),
        ).pipe(Effect.map(failureOf))
      expect(yield* open(featureContext('Dark mode'))).toStrictEqual(
        new TalkNotOpened({
          reason: "the project's settings name no model: give the talk one",
        }),
      )
      expect(yield* open({ _tag: 'answer', questions: [] })).toStrictEqual(
        new TalkNotOpened({
          reason: "the answer talk isn't in this engine's release yet",
        }),
      )
      expect(
        yield* open(featureContext('Dark mode'), ProjectId.make('gone')),
      ).toStrictEqual(new ProjectNotFound({ project: ProjectId.make('gone') }))

      const given = yield* newEngine()
      expect(
        failureOf(
          yield* Effect.exit(
            given.client['talk.open']({
              project,
              context: { _tag: 'refine', spec: 'docs/spec.md' },
              model: Option.none(),
            }),
          ),
        ),
      ).toStrictEqual(
        new TalkNotOpened({
          reason: 'pi exited with status 3: no model configured',
        }),
      )
    }).pipe(Effect.scoped),
  )

  it.effect(
    'gives the kept mode’s open talk again, and resumes its session after a restart',
    () =>
      Effect.gen(function* () {
        const data = mkdtempSync(NodePath.join(root, 'data-'))
        const before = yield* newScript
        const sessionsFolder = NodePath.join(
          data,
          'projects',
          'work',
          'talks',
          'run',
        )
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* engineOn({ data, script: before })
            const opened = yield* client['talk.open']({
              project,
              context: { _tag: 'run' },
              model: Option.none(),
            })
            const again = yield* client['talk.open']({
              project,
              context: { _tag: 'run' },
              model: Option.none(),
            })
            expect(again).toStrictEqual(opened)
            expect(yield* Ref.get(before.started)).toHaveLength(1)
            return opened
          }),
        )
        const [started] = yield* Ref.get(before.started)
        expect(started?.sessions).toBe(sessionsFolder)
        expect(started?.resume).toStrictEqual(Option.none())
        expect(
          JSON.parse(
            readFileSync(
              NodePath.join(data, 'projects', 'work', 'talks', 'run.json'),
              'utf8',
            ),
          ),
        ).toStrictEqual({
          talk: first.talk,
          session: NodePath.join(sessionsFolder, `${first.talk}.jsonl`),
        })

        // The engine restarts on the same data folder.
        const after = yield* newScript
        const client = yield* engineOn({ data, script: after })
        const resumed = yield* client['talk.open']({
          project,
          context: { _tag: 'run' },
          model: Option.none(),
        })
        expect(resumed.talk).toBe(first.talk)
        expect((yield* Ref.get(after.started))[0]?.resume).toStrictEqual(
          Option.some(NodePath.join(sessionsFolder, `${first.talk}.jsonl`)),
        )
        expect(yield* Ref.get(after.prompts)).toStrictEqual([])

        // Closed, the kept talk opens again on its kept session.
        yield* client['talk.close']({ talk: resumed.talk })
        const reopened = yield* client['talk.open']({
          project,
          context: { _tag: 'run' },
          model: Option.none(),
        })
        expect(reopened.talk).toBe(first.talk)
        expect(yield* Ref.get(after.started)).toHaveLength(2)
      }).pipe(Effect.scoped),
  )
})
