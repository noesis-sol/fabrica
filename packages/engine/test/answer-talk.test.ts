import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Scope,
  Stream,
} from 'effect'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  Actor,
  AnswerTalkTools,
  AttentionAnswer,
  Edge,
  ProjectId,
  ProjectNotFound,
  QuestionAnswer,
  QuestionChoices,
  QuestionOption,
  SessionId,
  type TicketId,
  type ToolRefusal,
  decodeProjectSettings,
  toolJsonSchema,
} from '@fabrica/contracts'

import type { PiEvent } from '../src/agent'
import {
  AttentionRequests,
  type AttentionRequestsShape,
  make as makeAttention,
} from '../src/attention'
import { type ProjectRecord, Projects } from '../src/projects'
import { RunMode, makeRunControl, runProject } from '../src/run'
import {
  type TalkAgentStart,
  TalkAgents,
  Talks,
  type TalksShape,
  registeredModes,
  layer as talksLayer,
} from '../src/talks'
import {
  WorkGraph,
  type WorkGraphShape,
  makeWorkGraph,
  storeLayer,
} from '../src/workgraph'
import {
  configOf,
  eventsOf,
  file,
  ofKind,
  options,
  project as runFixture,
  setUpRuns,
  withRuns,
} from './run-harness'

// The answer talk (spec §15.3, §13.1): the mode the engine registers, on a scripted Pi session in place
// of a talk's agent, an in-memory work graph and the live attention requests. The test plays the talk's
// model, making its tool calls through the engine's side of the call, as an agent hands a call over.
// The questions come with their options, the tickets they block and the ticket they were asked from;
// answers close them and free what they block; drafted options are marked, wherever they are shown; a
// consequential question is never answered in a batch, and a new question queues into the talk. Then
// whole runs, on the run harness: one with nothing ready but questions asks for the talk rather than
// end, and takes up what an answer frees.

let root = ''

beforeAll(() => {
  root = realpathSync(mkdtempSync(NodePath.join(tmpdir(), 'fabrica-answer-')))
  setUpRuns()
})

const project = ProjectId.make('work')
const maintainer = Actor.cases.maintainer.make({})
const worker = Actor.cases.worker.make({ session: SessionId.make('w-1') })

/** What the scripted agents were started with and told. */
interface Script {
  readonly started: Ref.Ref<ReadonlyArray<TalkAgentStart>>
  /** Each prompt or steer, as it comes. */
  readonly said: Queue.Queue<string>
}

/** Talks' agents whose every prompt settles at once: the test makes the talk's calls. */
const scriptedAgents = (script: Script) =>
  Layer.succeed(TalkAgents)({
    start: options =>
      Effect.gen(function* () {
        yield* Ref.update(script.started, all => [...all, options])
        const events = yield* PubSub.unbounded<PiEvent>()
        yield* Effect.addFinalizer(() => PubSub.shutdown(events))
        const heard = (message: string) => Queue.offer(script.said, message)
        return {
          session: {
            id: SessionId.make(`s-${options.talk}`),
            file: Option.none(),
          },
          events: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
          prompt: message =>
            Effect.andThen(
              heard(message),
              PubSub.publish(events, { type: 'agent_settled', aborted: false }),
            ),
          steer: heard,
        }
      }),
  })

/** Projects with one, `work`, its work graph `graph`; nothing else is asked of them. */
const oneProject = (graph: WorkGraphShape) =>
  Effect.gen(function* () {
    const settings = yield* Effect.orDie(
      decodeProjectSettings({ model: 'anthropic/claude-opus-5-5' }),
    )
    const record: ProjectRecord = {
      id: project,
      name: 'Work',
      path: root,
      origin: 'registered',
      url: Option.none(),
      base: 'main',
      trusted: true,
    }
    const unused = Effect.die('not asked of the projects by talks')
    const ours = <A>(id: ProjectId, value: A) =>
      id === project
        ? Effect.succeed(value)
        : Effect.fail(new ProjectNotFound({ project: id }))
    return Layer.succeed(Projects)({
      add: () => unused,
      list: unused,
      remove: () => unused,
      find: id => ours(id, record),
      setTrusted: () => unused,
      setRun: () => unused,
      worktreeHome: () => unused,
      settings: id => ours(id, settings),
      setSettings: () => unused,
      workGraph: id => ours(id, graph),
      onBase: () => unused,
      ticketsSync: () => unused,
      watchStatus: () => Stream.die('not asked of the projects by talks'),
    })
  })

/** The attention requests over the one project, whose work graph is `graph`. */
const attentionOver = (graph: WorkGraphShape) =>
  Layer.effect(
    AttentionRequests,
    makeAttention({
      list: Effect.succeed([project]),
      changed: Stream.never,
      graph: () => Effect.succeed(graph),
      events: () => Effect.succeed([]),
    }),
  )

interface Engine {
  readonly graph: WorkGraphShape
  readonly attention: AttentionRequestsShape
  readonly script: Script
  readonly talks: TalksShape
}

/** An engine's talks, with the registered modes, on a new work graph. */
const newEngine = Effect.gen(function* () {
  const graph = Context.get(
    yield* Layer.build(
      Layer.effect(WorkGraph, makeWorkGraph({ prefix: 'fa' })).pipe(
        Layer.provide(storeLayer(':memory:')),
      ),
    ),
    WorkGraph,
  )
  const attentionContext = yield* Layer.build(attentionOver(graph))
  const script: Script = {
    started: yield* Ref.make<ReadonlyArray<TalkAgentStart>>([]),
    said: yield* Queue.unbounded<string>(),
  }
  const talks = Context.get(
    yield* Layer.build(
      talksLayer({
        data: mkdtempSync(NodePath.join(root, 'data-')),
        scope: yield* Scope.Scope,
        flush: Effect.succeed(Duration.millis(0)),
      }).pipe(
        Layer.provide([
          yield* oneProject(graph),
          scriptedAgents(script),
          registeredModes.pipe(
            Layer.provide(Layer.succeedContext(attentionContext)),
          ),
        ]),
      ),
    ),
    Talks,
  )
  const engine: Engine = {
    graph,
    attention: Context.get(attentionContext, AttentionRequests),
    script,
    talks,
  }
  return engine
})

const twoOptions = {
  options: [
    { label: 'SQLite', tradeOff: 'One file, nothing to run.' },
    { label: 'Postgres', tradeOff: 'A server to run.' },
  ],
  recommended: 0,
}

/** A task, and a question asked about it, blocking it and linked to it as `ask_question` links it. */
const asked = (
  graph: WorkGraphShape,
  fields: {
    readonly title: string
    readonly consequential?: boolean
    readonly maintainerOnly?: boolean
    readonly filedWithOptions?: boolean
  },
) =>
  Effect.gen(function* () {
    const task = yield* graph.create({
      ticket: { type: 'task', title: `Waits on ${fields.title}` },
      actor: maintainer,
    })
    const choices = new QuestionChoices({
      options: twoOptions.options.map(option => new QuestionOption(option)),
      recommended: twoOptions.recommended,
    })
    const question = yield* graph.ask({
      question: {
        title: fields.title,
        description: `Why ${fields.title} matters.`,
        ...(fields.filedWithOptions === false ? {} : { choices }),
        consequential: fields.consequential ?? false,
        maintainerOnly: fields.maintainerOnly ?? false,
        blocks: [task.id],
      },
      actor: worker,
    })
    yield* graph.addDependency({
      edge: new Edge({
        from: question.id,
        to: task.id,
        kind: 'discovered_from',
      }),
      actor: worker,
    })
    return { task: task.id, question: question.id }
  })

/** A talk open on `questions` (every open one when none), and how the test plays its model. */
const openTalk = (engine: Engine, questions: ReadonlyArray<TicketId> = []) =>
  Effect.gen(function* () {
    const opened = yield* engine.talks.open({
      project,
      context: { _tag: 'answer', questions },
      model: Option.none(),
    })
    const started = yield* Ref.get(engine.script.started)
    const start = started.find(({ talk }) => talk === opened.talk)
    if (start === undefined) return yield* Effect.die('the talk has no agent')
    return {
      talk: opened.talk,
      start,
      call: (tool: string, input: unknown) =>
        Effect.exit(start.call({ tool, input })),
      /** The maintainer's message to the talk. */
      says: (text: string) => engine.talks.send({ talk: opened.talk, text }),
    }
  })

const answerWith = (question: TicketId, index: number) => ({
  question,
  answer: { _tag: 'option', index },
})

/** What the call answered, where it was answered. */
const answerOf = (exit: Exit.Exit<unknown, ToolRefusal>): unknown =>
  Exit.isSuccess(exit) ? exit.value : expect.fail(Cause.pretty(exit.cause))

/** Why the call was refused, in words, where it was. */
const refusalOf = (exit: Exit.Exit<unknown, ToolRefusal>): string => {
  if (Exit.isSuccess(exit)) return expect.fail('the call was not refused')
  const [refusal] = exit.cause.reasons.filter(Cause.isFailReason)
  return refusal?.error._tag === 'invalid'
    ? refusal.error.issue
    : expect.fail(Cause.pretty(exit.cause))
}

const statusOf = (graph: WorkGraphShape, id: TicketId) =>
  Effect.map(graph.show(id), ({ ticket }) => ticket.status)

describe('the answer talk', () => {
  it.effect(
    'opens on each question with its options, what it blocks and where it came from',
    () =>
      Effect.gen(function* () {
        const engine = yield* newEngine
        const { task, question } = yield* asked(engine.graph, {
          title: 'Which store?',
        })
        yield* engine.graph.note({
          id: task,
          body: 'Tried a flat file first.',
          actor: worker,
        })
        const { start } = yield* openTalk(engine)
        const opening = yield* Queue.take(engine.script.said)
        expect(opening).toContain(`Question ${question}: Which store?`)
        expect(opening).toContain('Why Which store? matters.')
        expect(opening).toContain(
          '0. SQLite: One file, nothing to run. (recommended)',
        )
        expect(opening).toContain('1. Postgres: A server to run.')
        expect(opening).toContain(`It blocks:\n  ${task} (open)`)
        expect(opening).toContain(`Asked from:\n  ${task} (open)`)
        expect(opening).toContain('note: Tried a flat file first.')
        // Read-only tools plus the question tools: nothing that releases, closes or defers a ticket.
        expect(start.tools.map(({ name }) => name)).toEqual([
          'list_questions',
          'draft_options',
          'put_question',
          'answer_question',
        ])
      }).pipe(Effect.scoped),
  )

  it.effect(
    'records an answer: the question closes, the design has it, the ticket is freed',
    () =>
      Effect.gen(function* () {
        const engine = yield* newEngine
        const { task, question } = yield* asked(engine.graph, {
          title: 'Which store?',
        })
        const other = yield* asked(engine.graph, { title: 'Which port?' })
        const { call, says } = yield* openTalk(engine)
        const ready = Effect.map(
          engine.graph.ready({ onBase: () => Effect.succeed(true) }),
          tickets => tickets.map(({ id }) => id),
        )
        expect(yield* ready).not.toContain(task)
        yield* says('SQLite, please')
        expect(
          answerOf(yield* call('answer_question', answerWith(question, 0))),
        ).toEqual({
          question,
          answer: 'SQLite',
          left: [other.question],
        })
        const { ticket } = yield* engine.graph.show(question)
        expect(ticket.resolution).toEqual(Option.some('answered'))
        const blocked = yield* engine.graph.show(task)
        expect(Option.getOrThrow(blocked.ticket.design)).toContain('SQLite')
        expect(yield* ready).toContain(task)
        // The first answer wins (§8.5): the talk hears it isn't open any more.
        expect(
          refusalOf(yield* call('answer_question', answerWith(question, 1))),
        ).toContain("isn't an open question")
      }).pipe(Effect.scoped),
  )

  it.effect('refuses an answer the maintainer has not given', () =>
    Effect.gen(function* () {
      const engine = yield* newEngine
      const { question } = yield* asked(engine.graph, { title: 'Which store?' })
      const { call } = yield* openTalk(engine)
      expect(
        refusalOf(yield* call('answer_question', answerWith(question, 0))),
      ).toContain('the maintainer has said nothing yet')
      expect(yield* statusOf(engine.graph, question)).toBe('open')
    }).pipe(Effect.scoped),
  )

  it.effect('drafts options for a question filed without, marked so', () =>
    Effect.gen(function* () {
      const engine = yield* newEngine
      const { question } = yield* asked(engine.graph, {
        title: 'Which store?',
        filedWithOptions: false,
      })
      const { call, says } = yield* openTalk(engine)
      const opening = yield* Queue.take(engine.script.said)
      expect(opening).toContain('Options: none were filed')
      const drafted = answerOf(
        yield* call('draft_options', { question, choices: twoOptions }),
      )
      expect(drafted).toMatchObject({ id: question, drafted: true })
      // Every client sees the mark: the attention requests carry it.
      const [request] = yield* engine.attention.list(Option.some(project))
      expect(request).toMatchObject({ _tag: 'question', drafted: true })
      expect(answerOf(yield* call('list_questions', {}))).toMatchObject({
        questions: [{ id: question, drafted: true }],
      })
      // A later talk is told they are drafted, not given by who asked.
      yield* openTalk(engine, [question])
      expect(yield* Queue.take(engine.script.said)).toContain(
        'Options (DRAFTED by a talk, not given by who asked):',
      )
      // Their numbers answer it, as a filed option's do.
      yield* says('The drafted SQLite')
      expect(
        answerOf(yield* call('answer_question', answerWith(question, 0))),
      ).toMatchObject({ answer: 'SQLite' })
    }).pipe(Effect.scoped),
  )

  it.effect('leaves options a question was filed with as they are', () =>
    Effect.gen(function* () {
      const engine = yield* newEngine
      const { question } = yield* asked(engine.graph, { title: 'Which store?' })
      const { call } = yield* openTalk(engine)
      expect(
        refusalOf(
          yield* call('draft_options', { question, choices: twoOptions }),
        ),
      ).toContain('was filed with options')
      const [request] = yield* engine.attention.list(Option.some(project))
      expect(request).toMatchObject({ drafted: false })
    }).pipe(Effect.scoped),
  )

  it.effect(
    'marks a question consequential by the options drafted for it',
    () =>
      Effect.gen(function* () {
        const engine = yield* newEngine
        const { question } = yield* asked(engine.graph, {
          title: 'What of the old store?',
          filedWithOptions: false,
        })
        const { call } = yield* openTalk(engine)
        yield* call('draft_options', {
          question,
          choices: {
            options: [
              { label: 'Keep it', tradeOff: 'Nothing changes.' },
              { label: 'Close the ticket', tradeOff: 'Less to do.' },
            ],
            recommended: 0,
          },
        })
        const [request] = yield* engine.attention.list(Option.some(project))
        expect(request).toMatchObject({ drafted: true, consequential: true })
      }).pipe(Effect.scoped),
  )

  it.effect('never answers a consequential question in a batch', () =>
    Effect.gen(function* () {
      const engine = yield* newEngine
      const ordinary = yield* asked(engine.graph, { title: 'Which port?' })
      const heavy = yield* asked(engine.graph, {
        title: 'Freeze the old API?',
        consequential: true,
      })
      const other = yield* asked(engine.graph, { title: 'Which log level?' })
      const { call, says } = yield* openTalk(engine)
      const opening = yield* Queue.take(engine.script.said)
      expect(opening).toContain(
        'CONSEQUENTIAL: nothing is chosen for the maintainer',
      )
      // One message, "all the recommended ones": the ordinary question goes, the consequential one doesn't.
      yield* says('Take all the recommended ones')
      answerOf(yield* call('answer_question', answerWith(ordinary.question, 0)))
      expect(
        refusalOf(
          yield* call('answer_question', answerWith(heavy.question, 0)),
        ),
      ).toContain('never answered in a batch')
      expect(yield* statusOf(engine.graph, heavy.question)).toBe('open')
      // Put alone, its own message picks it; that message answers nothing else with it.
      answerOf(yield* call('put_question', { question: heavy.question }))
      yield* says('For the API: keep it, the second option')
      answerOf(yield* call('answer_question', answerWith(heavy.question, 1)))
      expect(yield* statusOf(engine.graph, heavy.question)).toBe('closed')
      expect(
        refusalOf(
          yield* call('answer_question', answerWith(other.question, 0)),
        ),
      ).toContain('goes alone')
      expect(yield* statusOf(engine.graph, other.question)).toBe('open')
      yield* says('And the first for the log level')
      answerOf(yield* call('answer_question', answerWith(other.question, 0)))
      expect(yield* statusOf(engine.graph, other.question)).toBe('closed')
    }).pipe(Effect.scoped),
  )

  it.effect('refuses a consequential question taken first in a batch', () =>
    Effect.gen(function* () {
      const engine = yield* newEngine
      const heavy = yield* asked(engine.graph, {
        title: 'Freeze the old API?',
        consequential: true,
      })
      const ordinary = yield* asked(engine.graph, { title: 'Which port?' })
      const { call, says } = yield* openTalk(engine)
      yield* says('Take all the recommended ones')
      expect(
        refusalOf(
          yield* call('answer_question', answerWith(heavy.question, 0)),
        ),
      ).toContain('never answered in a batch')
      expect(yield* statusOf(engine.graph, heavy.question)).toBe('open')
      // Putting it now is no answer: the message that came before it can't answer it.
      answerOf(yield* call('put_question', { question: heavy.question }))
      expect(
        refusalOf(
          yield* call('answer_question', answerWith(heavy.question, 0)),
        ),
      ).toContain('put_question')
      expect(yield* statusOf(engine.graph, heavy.question)).toBe('open')
      // The ordinary one can still go on the blanket message.
      answerOf(yield* call('answer_question', answerWith(ordinary.question, 0)))
    }).pipe(Effect.scoped),
  )

  it.effect('takes only the very next message as its answer', () =>
    Effect.gen(function* () {
      const engine = yield* newEngine
      const heavy = yield* asked(engine.graph, {
        title: 'Freeze the old API?',
        consequential: true,
      })
      yield* asked(engine.graph, { title: 'Which port?' })
      const { call, says } = yield* openTalk(engine)
      answerOf(yield* call('put_question', { question: heavy.question }))
      // Something else first: a later blanket message doesn't answer what was put before it.
      yield* says('Hold on, what is the port question about?')
      yield* says('OK. Take all the recommended ones')
      expect(
        refusalOf(
          yield* call('answer_question', answerWith(heavy.question, 0)),
        ),
      ).toContain('put it again')
      expect(yield* statusOf(engine.graph, heavy.question)).toBe('open')
      answerOf(yield* call('put_question', { question: heavy.question }))
      yield* says('Keep it open: the first option')
      answerOf(yield* call('answer_question', answerWith(heavy.question, 0)))
      expect(yield* statusOf(engine.graph, heavy.question)).toBe('closed')
    }).pipe(Effect.scoped),
  )

  it.effect(
    'answers only the question put last, and only as its options stood',
    () =>
      Effect.gen(function* () {
        const engine = yield* newEngine
        const first = yield* asked(engine.graph, {
          title: 'Freeze the old API?',
          consequential: true,
        })
        const second = yield* asked(engine.graph, {
          title: 'Close the old ticket?',
          consequential: true,
        })
        const bare = yield* asked(engine.graph, {
          title: 'What of the old store?',
          filedWithOptions: false,
          consequential: true,
        })
        const { call, says } = yield* openTalk(engine)
        // Two put in a row: one message can't answer both.
        answerOf(yield* call('put_question', { question: first.question }))
        answerOf(yield* call('put_question', { question: second.question }))
        yield* says('The first of each')
        expect(
          refusalOf(
            yield* call('answer_question', answerWith(first.question, 0)),
          ),
        ).toContain('put_question')
        answerOf(yield* call('answer_question', answerWith(second.question, 0)))
        // Drafted again after it was put, it is put again.
        answerOf(
          yield* call('draft_options', {
            question: bare.question,
            choices: twoOptions,
          }),
        )
        answerOf(yield* call('put_question', { question: bare.question }))
        answerOf(
          yield* call('draft_options', {
            question: bare.question,
            choices: twoOptions,
          }),
        )
        yield* says('The first')
        expect(
          refusalOf(
            yield* call('answer_question', answerWith(bare.question, 0)),
          ),
        ).toContain('put_question')
      }).pipe(Effect.scoped),
  )

  it.effect('takes a maintainer-only question alone too', () =>
    Effect.gen(function* () {
      const engine = yield* newEngine
      const ordinary = yield* asked(engine.graph, { title: 'Which port?' })
      const theirs = yield* asked(engine.graph, {
        title: 'Publish under your name?',
        maintainerOnly: true,
      })
      const { call, says } = yield* openTalk(engine)
      yield* says('Yes to all')
      expect(
        refusalOf(
          yield* call('answer_question', answerWith(theirs.question, 0)),
        ),
      ).toContain('maintainer-only')
      answerOf(yield* call('answer_question', answerWith(ordinary.question, 0)))
      answerOf(yield* call('put_question', { question: theirs.question }))
      yield* says('Yes, publish it')
      answerOf(yield* call('answer_question', answerWith(theirs.question, 0)))
      expect(yield* statusOf(engine.graph, theirs.question)).toBe('closed')
    }).pipe(Effect.scoped),
  )

  it('gives its tools to Pi as JSON Schema', () => {
    expect(AnswerTalkTools.map(tool => toolJsonSchema(tool).name)).toEqual([
      'list_questions',
      'draft_options',
      'put_question',
      'answer_question',
    ])
  })

  it.effect('takes a new question into the talk as it arrives', () =>
    Effect.gen(function* () {
      const engine = yield* newEngine
      const { question } = yield* asked(engine.graph, { title: 'Which store?' })
      const { call } = yield* openTalk(engine)
      const late = yield* asked(engine.graph, { title: 'Which port?' })
      const queued = yield* Stream.fromQueue(engine.script.said).pipe(
        Stream.filter(text => text.startsWith('Another question arrived')),
        Stream.runHead,
      )
      expect(Option.getOrThrow(queued)).toContain(
        `Question ${late.question}: Which port?`,
      )
      expect(answerOf(yield* call('list_questions', {}))).toMatchObject({
        questions: [{ id: question }, { id: late.question }],
      })
    }).pipe(Effect.scoped),
  )

  it.effect('on named questions, has those alone', () =>
    Effect.gen(function* () {
      const engine = yield* newEngine
      const { question } = yield* asked(engine.graph, { title: 'Which store?' })
      const other = yield* asked(engine.graph, { title: 'Which port?' })
      const { call, says } = yield* openTalk(engine, [question])
      const opening = yield* Queue.take(engine.script.said)
      expect(opening).not.toContain(other.question)
      yield* says('The first')
      expect(
        refusalOf(
          yield* call('answer_question', answerWith(other.question, 0)),
        ),
      ).toContain("isn't an open question in this talk")
      answerOf(yield* call('answer_question', answerWith(question, 0)))
    }).pipe(Effect.scoped),
  )

  it.effect('refuses to open on a question that is not open', () =>
    Effect.gen(function* () {
      const engine = yield* newEngine
      const { question } = yield* asked(engine.graph, { title: 'Which store?' })
      yield* engine.attention.answer({
        answer: AttentionAnswer.cases.question.make({
          project,
          ticket: question,
          answer: QuestionAnswer.cases.text.make({ text: 'SQLite' }),
        }),
        by: 'the app',
      })
      const refused = yield* Effect.flip(
        engine.talks.open({
          project,
          context: { _tag: 'answer', questions: [question] },
          model: Option.none(),
        }),
      )
      expect(refused).toMatchObject({
        _tag: 'TalkNotOpened',
        reason: `no open question has the ID ${question}`,
      })
    }).pipe(Effect.scoped),
  )

  it.effect('mentions deferred tickets, with no tool to release them', () =>
    Effect.gen(function* () {
      const engine = yield* newEngine
      const parked = yield* engine.graph.create({
        ticket: { type: 'task', title: 'Parked work' },
        actor: maintainer,
      })
      yield* engine.graph.defer({
        id: parked.id,
        until: Option.none(),
        actor: maintainer,
      })
      yield* asked(engine.graph, { title: 'Which store?' })
      const { call } = yield* openTalk(engine)
      const opening = yield* Queue.take(engine.script.said)
      expect(opening).toContain('none is yours to release')
      expect(opening).toContain(`${parked.id}: Parked work`)
      expect(answerOf(yield* call('list_questions', {}))).toMatchObject({
        deferred: [{ id: parked.id, title: 'Parked work' }],
      })
      expect(yield* statusOf(engine.graph, parked.id)).toBe('deferred')
    }).pipe(Effect.scoped),
  )
})

// Whole runs, on the run harness.

/** The run's control, saying when the run first asks for the answer talk, and what it was told each time. */
const controlOf = Effect.gen(function* () {
  const made = yield* makeRunControl
  const asking = yield* Deferred.make<void>()
  return {
    asking,
    control: {
      ...made,
      setAsking: (now: boolean) =>
        Effect.andThen(
          made.setAsking(now),
          now ? Deferred.succeed(asking, undefined) : Effect.void,
        ),
    },
  }
})

const plainQuestion = (
  graph: WorkGraphShape,
  title: string,
  blocks: ReadonlyArray<TicketId>,
) =>
  graph.ask({
    question: { title, consequential: false, maintainerOnly: false, blocks },
    actor: worker,
  })

describe('a run with nothing ready but questions', () => {
  it.effect(
    'asks for the answer talk instead of ending, and takes up what the answer frees',
    () =>
      Effect.gen(function* () {
        const fixture = runFixture()
        const end = yield* withRuns(
          fixture,
          Effect.gen(function* () {
            const made = yield* file('Drop the flag', 'ask')
            const { control, asking } = yield* controlOf
            const running = yield* Effect.forkScoped(
              runProject(configOf(fixture, options()), control),
            )
            yield* Deferred.await(asking)
            expect(yield* control.state).toBe('asking')
            const events = yield* eventsOf(fixture)
            const [question] = ofKind(events, 'asked')
            if (question === undefined)
              return yield* Effect.die('no question was asked')
            expect(
              ofKind(events, 'info').map(({ text }) => text),
            ).toContainEqual(
              expect.stringContaining(
                `QUESTIONS_WAITING: nothing is ready but the questions ${question.question}`,
              ),
            )
            expect(ofKind(events, 'end')).toEqual([])
            const graph = yield* WorkGraph
            yield* Effect.provide(
              Effect.flatMap(AttentionRequests, attention =>
                attention.answer({
                  answer: AttentionAnswer.cases.question.make({
                    project,
                    ticket: question.question,
                    answer: QuestionAnswer.cases.option.make({ index: 1 }),
                  }),
                  by: 'the answer talk',
                }),
              ),
              attentionOver(graph),
            )
            const ended = yield* Fiber.join(running)
            const { ticket } = yield* graph.show(made.id)
            expect(ticket.status).toBe('closed')
            return ended
          }),
        )
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
      }),
  )

  it.effect('ends on a drain, saying which questions wait', () =>
    Effect.gen(function* () {
      const fixture = runFixture()
      const end = yield* withRuns(
        fixture,
        Effect.gen(function* () {
          yield* file('Drop the flag', 'ask')
          const { control, asking } = yield* controlOf
          const running = yield* Effect.forkScoped(
            runProject(configOf(fixture, options()), control),
          )
          yield* Deferred.await(asking)
          yield* control.drain
          return yield* Fiber.join(running)
        }),
      )
      expect(end).toEqual({ kind: 'DRAINED', code: 0 })
      expect(
        readFileSync(join(fixture.checkout, '.fabrica/fabrica.log'), 'utf8'),
      ).toContain('waits on the question')
    }),
  )

  it.effect('ends as ever on questions no answer would free work by', () =>
    Effect.gen(function* () {
      const fixture = runFixture()
      const end = yield* withRuns(
        fixture,
        Effect.gen(function* () {
          const graph = yield* WorkGraph
          // One blocks a deferred ticket, one a maintainer task, and one nothing.
          const parked = yield* graph.create({
            ticket: { type: 'task', title: 'Parked' },
            actor: maintainer,
          })
          yield* graph.defer({
            id: parked.id,
            until: Option.none(),
            actor: maintainer,
          })
          const task = yield* graph.create({
            ticket: { type: 'manual', title: 'Buy the domain' },
            actor: maintainer,
          })
          yield* plainQuestion(graph, 'About the parked', [parked.id])
          yield* plainQuestion(graph, 'About the task', [task.id])
          yield* plainQuestion(graph, 'About nothing', [])
          return yield* runProject(configOf(fixture, options()))
        }),
      )
      expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
    }),
  )

  it.effect('ends as ever on a question outside its scope', () =>
    Effect.gen(function* () {
      const fixture = runFixture()
      const end = yield* withRuns(
        fixture,
        Effect.gen(function* () {
          const graph = yield* WorkGraph
          const own = yield* file('Does its work', 'finish')
          const away = yield* graph.create({
            ticket: { type: 'task', title: 'Elsewhere' },
            actor: maintainer,
          })
          yield* plainQuestion(graph, 'About elsewhere', [away.id])
          return yield* runProject(
            configOf(
              fixture,
              options({ mode: RunMode.Ticket({ ticket: own.id }) }),
            ),
          )
        }),
      )
      expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
    }),
  )
})
