import {
  Console,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Stdio,
  Stream,
} from 'effect'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import {
  Actor,
  EngineHost,
  PermissionShown,
  ProjectId,
  QuestionChoices,
  QuestionOption,
  SessionId,
  ToolCallId,
  type TicketId,
} from '@fabrica/contracts'
import { Agent, Daemon, Talks } from '@fabrica/engine'
import {
  Toolbox,
  layerHost,
  layerToolbox,
  makeGitRepo,
  tempFolder,
} from '@fabrica/testkit'

import {
  AttentionRequests,
  type AttentionRequestsShape,
} from '../../../packages/engine/src/attention'
import {
  WorkGraph,
  type WorkGraphShape,
  makeWorkGraph,
  storeLayer,
} from '../../../packages/engine/src/workgraph'
import { LocalEngine } from '../src/cli/connect'
import { runCli } from '../src/cli/main'
import { gitOf, onlyJson } from './tickets-engine'

// `fabrica answer` (spec §19, §15.1, §15.2): run as the CLI's entry runs it, against an engine started in
// a temporary data folder with one project, `work`, and the live attention requests, the answer talk
// on a scripted Pi session. Lines come on stdin. The questions are filed on the project's work graph,
// as a worker's are; the permission requests through a run's side of the attention requests.

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test',
  cores: 4,
})

const project = ProjectId.make('work')
const worker = Actor.cases.worker.make({ session: SessionId.make('w-1') })

/** `fabrica <args>` with the local engine at `socket` and `input` on stdin: its exit and what it printed. */
const fabrica = (
  socket: string,
  input: string,
  ...args: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    const out: Array<string> = []
    const err: Array<string> = []
    const console: Console.Console = Object.assign(
      Object.create(globalThis.console),
      {
        log: (...parts: ReadonlyArray<unknown>) => out.push(parts.join(' ')),
        error: (...parts: ReadonlyArray<unknown>) => err.push(parts.join(' ')),
      },
    )
    const exit = yield* runCli(args).pipe(
      Effect.provideService(Console.Console, console),
      Effect.provide(
        Stdio.layerTest({
          stdin: Stream.make(input).pipe(
            Stream.map(text => new TextEncoder().encode(text)),
          ),
        }),
      ),
      Effect.provide([
        NodeServices.layer,
        Layer.succeed(LocalEngine)({ socket: Effect.succeed(socket) }),
        layerHost(),
      ]),
      Effect.exit,
    )
    return { exit, out, err }
  })

/** Talks' agents whose every prompt says it heard, then settles. */
const scriptedAgents = Layer.succeed(Talks.TalkAgents)({
  start: () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<Agent.PiEvent>()
      yield* Effect.addFinalizer(() => PubSub.shutdown(events))
      return {
        session: { id: SessionId.make('s-1'), file: Option.none() },
        events: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
        prompt: () =>
          PubSub.publishAll(events, [
            { type: 'message_start', message: { role: 'assistant' } },
            {
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: 'Heard.' },
            },
            { type: 'agent_settled', aborted: false },
          ]).pipe(Effect.asVoid),
        steer: () => Effect.void,
      }
    }),
})

interface TestEngine {
  readonly socket: string
  readonly graph: WorkGraphShape
  readonly attention: AttentionRequestsShape
}

/** An engine with one project, `work`, the registered modes on scripted agents. */
const answerEngine = Effect.gen(function* () {
  const tools = yield* Toolbox
  const root = yield* tempFolder('answer-cli')
  const paths = Daemon.pathsIn({
    data: NodePath.join(root, 'd'),
    socketFolder: NodePath.join(root, 'd'),
  })
  const captured = yield* Deferred.make<AttentionRequestsShape>()
  yield* Daemon.startEngine({
    paths,
    host,
    release: '1.2.3',
    git: gitOf(tools),
    talks: Layer.mergeAll(
      Talks.registeredModes,
      scriptedAgents,
      Layer.effectDiscard(
        Effect.flatMap(AttentionRequests, attention =>
          Deferred.succeed(captured, attention),
        ),
      ),
    ),
  })
  const repo = yield* makeGitRepo(tools)
  const added = yield* fabrica(paths.socket, '', 'project', 'add', repo.work)
  expect(added.exit).toStrictEqual(Exit.void)
  // The project's work graph, a connection of the test's own: the engine reads it again for each list.
  const graph = Context.get(
    yield* Layer.build(
      Layer.effect(WorkGraph, makeWorkGraph({ prefix: 'wo' })).pipe(
        Layer.provide(
          storeLayer(NodePath.join(repo.work, '.fabrica', 'work.db')),
        ),
      ),
    ),
    WorkGraph,
  )
  const engine: TestEngine = {
    socket: paths.socket,
    graph,
    attention: yield* Deferred.await(captured),
  }
  return engine
})

const choices = new QuestionChoices({
  options: [
    new QuestionOption({ label: 'SQLite', tradeOff: 'One file.' }),
    new QuestionOption({ label: 'Postgres', tradeOff: 'A server to run.' }),
  ],
  recommended: 1,
})

/** A task, and a question asked about it. */
const asked = (
  graph: WorkGraphShape,
  fields: {
    readonly title: string
    readonly consequential?: boolean
    readonly withOptions?: boolean
  },
) =>
  Effect.gen(function* () {
    const task = yield* graph.create({
      ticket: { type: 'task', title: `Waits on ${fields.title}` },
      actor: worker,
    })
    const question = yield* graph.ask({
      question: {
        title: fields.title,
        description: 'Say which.\nIt matters.',
        ...(fields.withOptions === false ? {} : { choices }),
        consequential: fields.consequential ?? false,
        maintainerOnly: false,
        blocks: [task.id],
      },
      actor: worker,
    })
    return { task: task.id, question: question.id }
  })

const answerOf = (graph: WorkGraphShape, id: TicketId) =>
  Effect.map(graph.show(id), ({ ticket }) =>
    Option.flatMap(ticket.question, ({ answer }) => answer),
  )

/** A permission request from a run's worker, waiting for its answer; its ID once listed. */
const permission = (engine: TestEngine) =>
  Effect.gen(function* () {
    const side = yield* engine.attention.forRun
    const decision = yield* Effect.forkScoped(
      side.permission({
        project,
        ticket: yield* Effect.map(
          engine.graph.create({
            ticket: { type: 'task', title: 'Clean up' },
            actor: worker,
          }),
          ({ id }) => id,
        ),
        session: SessionId.make('w-1'),
        toolCall: ToolCallId.make('call-1'),
        tool: 'bash',
        input: { command: 'rm -rf build' },
        shown: PermissionShown.cases.command.make({
          lines: ['rm -rf build', 'mkdir build'],
        }),
        why: 'it removes files',
      }),
    )
    const listed = yield* engine.attention
      .watch({ project: Option.some(project), resume: Option.none() })
      .pipe(
        Stream.flatMap(item =>
          Stream.fromIterable(
            item._tag === 'snapshot' ? item.value : item.value.upsert,
          ),
        ),
        Stream.filter(request => request._tag === 'permission'),
        Stream.runHead,
      )
    const request = Option.getOrThrow(listed)
    return {
      id: request._tag === 'permission' ? request.id : '',
      decision,
    }
  })

// The engine runs on the live clock: its sockets and its git's time limits are real.
layer(layerToolbox({ tools: ['git'] }), { excludeTestServices: true })(
  'fabrica answer',
  it => {
    it.effect('says so where nothing waits', () =>
      Effect.gen(function* () {
        const { socket } = yield* answerEngine
        const { exit, out } = yield* fabrica(
          socket,
          '',
          'answer',
          '--project',
          'work',
        )
        expect(exit).toStrictEqual(Exit.void)
        expect(out).toStrictEqual(['Nothing waits on you.'])
      }).pipe(Effect.scoped),
    )

    it.effect('asks a question with its options, its number answering it', () =>
      Effect.gen(function* () {
        const engine = yield* answerEngine
        const { task, question } = yield* asked(engine.graph, {
          title: 'Which store?',
        })
        const { exit, out, err } = yield* fabrica(
          engine.socket,
          '2\n',
          'answer',
          '--project',
          'work',
        )
        expect(err).toStrictEqual([])
        expect(exit).toStrictEqual(Exit.void)
        expect(out).toStrictEqual([
          `Question ${question}: Which store?`,
          '  Say which.',
          '  It matters.',
          `  Blocks: ${task}`,
          '  1. SQLite: One file.',
          '  2. Postgres: A server to run. (recommended)',
          'Answer with its number or your own words, t to talk it through, Enter to pass:',
        ])
        expect(yield* answerOf(engine.graph, question)).toStrictEqual(
          Option.some('Postgres'),
        )
      }).pipe(Effect.scoped),
    )

    it.effect(
      'passes on Enter, takes the maintainer’s own words, and asks again past the last option',
      () =>
        Effect.gen(function* () {
          const engine = yield* answerEngine
          const first = yield* asked(engine.graph, { title: 'Which store?' })
          const second = yield* asked(engine.graph, { title: 'Which port?' })
          const third = yield* asked(engine.graph, { title: 'Which host?' })
          const { exit, out } = yield* fabrica(
            engine.socket,
            '\n7\nthe usual one\n1\n',
            'answer',
            '--project',
            'work',
          )
          expect(exit).toStrictEqual(Exit.void)
          expect(out).toContain('It has no option 7.')
          expect(yield* answerOf(engine.graph, first.question)).toStrictEqual(
            Option.none(),
          )
          expect(yield* answerOf(engine.graph, second.question)).toStrictEqual(
            Option.some('the usual one'),
          )
          expect(yield* answerOf(engine.graph, third.question)).toStrictEqual(
            Option.some('SQLite'),
          )
        }).pipe(Effect.scoped),
    )

    it.effect(
      'chooses nothing for a consequential question, and marks drafted options',
      () =>
        Effect.gen(function* () {
          const engine = yield* answerEngine
          const heavy = yield* asked(engine.graph, {
            title: 'Freeze the API?',
            consequential: true,
          })
          const bare = yield* asked(engine.graph, {
            title: 'Which port?',
            withOptions: false,
          })
          const { out } = yield* fabrica(
            engine.socket,
            '\n\n',
            'answer',
            '--project',
            'work',
          )
          expect(out).toContain(
            '  Consequential: nothing is chosen for you. Pick one deliberately.',
          )
          expect(out).toContain(
            '  Filed without options: the answer talk can draft them.',
          )
          // Enter passed each by: nothing was chosen.
          expect(yield* answerOf(engine.graph, heavy.question)).toStrictEqual(
            Option.none(),
          )
          yield* engine.graph.draftOptions({
            id: bare.question,
            choices,
            actor: worker,
          })
          const again = yield* fabrica(
            engine.socket,
            '\n',
            'answer',
            bare.question,
            '--project',
            'work',
          )
          expect(again.out).toContain(
            '  Options drafted by the answer talk, not by who asked:',
          )
        }).pipe(Effect.scoped),
    )

    it.effect(
      'asks only the request it names, and stops at the end of stdin',
      () =>
        Effect.gen(function* () {
          const engine = yield* answerEngine
          const first = yield* asked(engine.graph, { title: 'Which store?' })
          yield* asked(engine.graph, { title: 'Which port?' })
          const { exit, out } = yield* fabrica(
            engine.socket,
            '1\n',
            'answer',
            first.question,
            '--project',
            'work',
          )
          expect(exit).toStrictEqual(Exit.void)
          expect(out.join('\n')).not.toContain('Which port?')
          const nothing = yield* fabrica(
            engine.socket,
            '',
            'answer',
            '--project',
            'work',
          )
          expect(nothing.exit).toStrictEqual(Exit.void)
          expect(nothing.out[0]).toContain('Which port?')
        }).pipe(Effect.scoped),
    )

    it.effect('shows a permission request whole, its number answering it', () =>
      Effect.gen(function* () {
        const engine = yield* answerEngine
        const { id, decision } = yield* permission(engine)
        const { exit, out } = yield* fabrica(
          engine.socket,
          '2\n',
          'answer',
          '--project',
          'work',
        )
        expect(exit).toStrictEqual(Exit.void)
        expect(out).toContain('  $ rm -rf build')
        expect(out).toContain('  $ mkdir build')
        expect(out).toContain('  Why it asks: it removes files')
        expect(out).toContain('  2. Allow for this run')
        expect(out[0]).toContain(`Permission ${id} for `)
        expect(yield* Fiber.join(decision)).toMatchObject({
          _tag: 'allow_run',
        })
      }).pipe(Effect.scoped),
    )

    it.effect('refuses a permission request with its note', () =>
      Effect.gen(function* () {
        const engine = yield* answerEngine
        const { decision } = yield* permission(engine)
        yield* fabrica(
          engine.socket,
          'yes\n3 keep the build\n',
          'answer',
          '--project',
          'work',
        )
        expect(yield* Fiber.join(decision)).toMatchObject({
          _tag: 'refuse',
          note: Option.some('keep the build'),
        })
      }).pipe(Effect.scoped),
    )

    it.effect('answers by its flags, asking nothing, for an agent', () =>
      Effect.gen(function* () {
        const engine = yield* answerEngine
        const first = yield* asked(engine.graph, { title: 'Which store?' })
        const second = yield* asked(engine.graph, { title: 'Which port?' })
        const listed = yield* fabrica(
          engine.socket,
          '',
          'answer',
          '--project',
          'work',
          '--json',
        )
        expect(onlyJson(listed.out)).toMatchObject([
          { _tag: 'question', ticket: first.question },
          { _tag: 'question', ticket: second.question },
        ])
        const byOption = yield* fabrica(
          engine.socket,
          '',
          'answer',
          first.question,
          '--option',
          '1',
          '--project',
          'work',
        )
        expect(byOption.exit).toStrictEqual(Exit.void)
        expect(byOption.out).toStrictEqual([`answered ${first.question}`])
        const byWords = yield* fabrica(
          engine.socket,
          '',
          'answer',
          second.question,
          '--text',
          'Port 80',
          '--project',
          'work',
          '--json',
        )
        expect(onlyJson(byWords.out)).toMatchObject({ by: expect.any(String) })
        expect(yield* answerOf(engine.graph, second.question)).toStrictEqual(
          Option.some('Port 80'),
        )
        const { id, decision } = yield* permission(engine)
        const allowed = yield* fabrica(
          engine.socket,
          '',
          'answer',
          id,
          '--allow',
          'once',
          '--project',
          'work',
        )
        expect(allowed.out).toStrictEqual([`answered ${id}`])
        expect(yield* Fiber.join(decision)).toMatchObject({
          _tag: 'allow_once',
        })
      }).pipe(Effect.scoped),
    )

    it.effect(
      'says who answered first, and revises an answer with --revise',
      () =>
        Effect.gen(function* () {
          const engine = yield* answerEngine
          const { question } = yield* asked(engine.graph, {
            title: 'Which store?',
          })
          const answering = (...flags: ReadonlyArray<string>) =>
            fabrica(
              engine.socket,
              '',
              'answer',
              question,
              ...flags,
              '--project',
              'work',
            )
          expect((yield* answering('--option', '1')).exit).toStrictEqual(
            Exit.void,
          )
          const late = yield* answering('--option', '2')
          expect(Exit.isFailure(late.exit)).toBe(true)
          expect(late.err[0]).toContain('answered it first')
          expect(late.err[0]).toContain('--revise')
          const revised = yield* answering('--revise', '--option', '2')
          expect(revised.exit).toStrictEqual(Exit.void)
          expect(revised.out[0]).toBe(`revised ${question}`)
          expect(yield* answerOf(engine.graph, question)).toStrictEqual(
            Option.some('Postgres'),
          )
        }).pipe(Effect.scoped),
    )

    it.effect(
      'refuses flags that do not hold together, and a request not open',
      () =>
        Effect.gen(function* () {
          const { socket } = yield* answerEngine
          const refusal = (...args: ReadonlyArray<string>) =>
            Effect.map(
              fabrica(socket, '', 'answer', ...args, '--project', 'work'),
              ({ exit, err }) => {
                expect(Exit.isFailure(exit)).toBe(true)
                return err[0]
              },
            )
          expect(yield* refusal('wo-1', '--option', '1', '--refuse')).toContain(
            'give one answer',
          )
          expect(yield* refusal('wo-1', '--note', 'why')).toContain(
            '--note goes with --refuse',
          )
          expect(yield* refusal('wo-1', '--revise')).toContain(
            '--revise takes the new answer',
          )
          expect(yield* refusal('--option', '1')).toContain(
            'name the request an answer is for',
          )
          expect(yield* refusal('wo-1', '--option', '0')).toContain('from 1')
          expect(yield* refusal('wo-1', '--talk', '--option', '1')).toContain(
            '--talk asks in the talk',
          )
          expect(yield* refusal('wo-1')).toContain(
            "isn't an open question or permission request",
          )
        }).pipe(Effect.scoped),
    )

    it.effect(
      'opens the answer talk with --talk, and on t for a question',
      () =>
        Effect.gen(function* () {
          const engine = yield* answerEngine
          const { question } = yield* asked(engine.graph, {
            title: 'Which store?',
          })
          const talked = yield* fabrica(
            engine.socket,
            '',
            'answer',
            '--talk',
            '--project',
            'work',
            '--model',
            'anthropic/claude-opus-5-5',
          )
          expect(talked.exit).toStrictEqual(Exit.void)
          expect(talked.out.join('\n')).toContain(
            `Question ${question}: Which store?`,
          )
          expect(talked.out).toContain('Heard.')
          const through = yield* fabrica(
            engine.socket,
            't\nTell me more\n',
            'answer',
            '--project',
            'work',
            '--model',
            'anthropic/claude-opus-5-5',
          )
          expect(through.exit).toStrictEqual(Exit.void)
          expect(through.out).toContain('> Tell me more')
          expect(through.out).toContain('Heard.')
        }).pipe(Effect.scoped),
    )
  },
)
