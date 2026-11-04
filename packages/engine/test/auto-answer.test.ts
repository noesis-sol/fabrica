import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Stream,
} from 'effect'
import { TestClock } from 'effect/testing'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  AlreadyAnswered,
  AttentionAnswer,
  AutoAnswer,
  EngineId,
  ProjectId,
  QuestionAnswer,
  QuestionChoices,
  QuestionOption,
  type TicketId,
} from '@fabrica/contracts'

import { sessionFolder } from '../src/agent'
import {
  autoAnswerFields,
  autoAnsweredLabel,
  make as makeAttention,
  makeAutoAnswers,
} from '../src/attention'
import type { AutoAnswered } from '../src/control/ports'
import { runProject } from '../src/run'
import { Wake, layerWake, noSleepCauses } from '../src/time'
import {
  TransitionRefused,
  WorkGraph,
  makeWorkGraph,
  storeLayer,
} from '../src/workgraph'
import {
  type Project,
  configOf,
  eventsOf,
  file,
  ofKind,
  options,
  project as runProjectFixture,
  setUpRuns,
  withRuns,
} from './run-harness'

// `--auto-answer` (spec §15.2, H82), on TestClock: at once and after a wait in time awake, the
// maintainer answering first, the questions it leaves to the maintainer, its label, its words in the
// blocked ticket's design and on the question, and a revised answer. Then whole runs: the worker told
// on its resume, the `start` and `auto_answered` records, and a wait keeping the run from ending.

const project = ProjectId.make('app')
const engine: Actor = { _tag: 'engine', engine: EngineId.make('engine-1') }
const worker: Actor = { _tag: 'maintainer' }
const fromAutoAnswer =
  'SQLite (the recommended option, chosen by --auto-answer, not by the maintainer)'

const services = Layer.mergeAll(
  Layer.effect(WorkGraph, makeWorkGraph({ prefix: 'fa' })).pipe(
    Layer.provide(storeLayer(':memory:')),
  ),
  Layer.provide(layerWake, noSleepCauses),
)

const sqlite = new QuestionOption({
  label: 'SQLite',
  tradeOff: 'One file, nothing to run.',
})
const postgres = new QuestionOption({
  label: 'Postgres',
  tradeOff: 'A server to run.',
})

/** A task and a question blocking it, filed as `ask_question` files them. */
const asked = (
  fields: {
    readonly options?: ReadonlyArray<QuestionOption> | 'none'
    readonly consequential?: boolean
    readonly maintainerOnly?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    const graph = yield* WorkGraph
    const task = yield* graph.create({
      ticket: { type: 'task', title: 'Store the runs' },
      actor: worker,
    })
    const question = yield* graph.ask({
      question: {
        title: 'Which store?',
        ...(fields.options === 'none'
          ? {}
          : {
              choices: new QuestionChoices({
                options: fields.options ?? [sqlite, postgres],
                recommended: 0,
              }),
            }),
        consequential: fields.consequential ?? false,
        maintainerOnly: fields.maintainerOnly ?? false,
        blocks: [task.id],
      },
      actor: worker,
    })
    return { task: task.id, question: question.id }
  })

/** The attention requests and a run's auto answers as `setting` says, each answer said and each wake counted. */
const started = (setting: AutoAnswer) =>
  Effect.gen(function* () {
    const graph = yield* WorkGraph
    const requests = yield* makeAttention({
      list: Effect.succeed([project]),
      changed: Stream.never,
      graph: () => Effect.succeed(graph),
    })
    const said = yield* Ref.make<ReadonlyArray<AutoAnswered>>([])
    const wakes = yield* Queue.unbounded<void>()
    const answers = yield* makeAutoAnswers({
      setting,
      project,
      actor: engine,
      graph,
      attention: yield* requests.forRun,
      wake: yield* Wake,
      answered: answered => Ref.update(said, all => [...all, answered]),
      woken: Queue.offer(wakes, undefined).pipe(Effect.asVoid),
      guarded: Effect.orDie,
    })
    return { graph, requests, said, wakes, answers }
  })

/** The question's answer on the work graph, if any. */
const answerOf = (question: TicketId) =>
  Effect.gen(function* () {
    const graph = yield* WorkGraph
    const { ticket } = yield* graph.show(question)
    return Option.flatMap(ticket.question, ({ answer }) => answer)
  })

const labelsOf = (question: TicketId) =>
  Effect.gen(function* () {
    const graph = yield* WorkGraph
    return (yield* graph.show(question)).labels
  })

/** Past the wait: the fiber asleep on it has run as far as it goes. */
const past = (by: Duration.Input) =>
  Effect.andThen(TestClock.adjust(by), Effect.yieldNow)

const after10m = AutoAnswer.cases.After.make({ wait: Duration.minutes(10) })

describe('--auto-answer', () => {
  it.effect(
    'bare, answers a question filed during the run at once, with its recommended option labelled',
    () =>
      Effect.gen(function* () {
        const { answers, said, wakes, graph } = yield* started(
          AutoAnswer.cases.AtOnce.make({}),
        )
        const { task, question } = yield* asked()

        yield* answers.sweep
        yield* Queue.take(wakes)

        expect(yield* answerOf(question)).toEqual(Option.some(fromAutoAnswer))
        expect(yield* labelsOf(question)).toEqual([autoAnsweredLabel])
        expect((yield* graph.show(question)).ticket.resolution).toEqual(
          Option.some('answered'),
        )
        expect(yield* Ref.get(said)).toEqual([
          {
            ticket: task,
            question,
            title: 'Which store?',
            option: 'SQLite',
          },
        ])
        // What waits on it reads who chose it, and that it was no one's word but the option's.
        const { ticket } = yield* graph.show(task)
        expect(Option.getOrThrow(ticket.design)).toContain(
          `--auto-answer answered ${question} (Which store?): ${fromAutoAnswer}`,
        )
        expect(Option.getOrThrow(ticket.design)).not.toContain(
          'The maintainer answered',
        )
        // As the engine's change, which doesn't wake the run: it is woken by name.
        const history = yield* graph.history(question)
        expect(
          history.find(event => event.change._tag === 'answered')?.actor,
        ).toEqual(Option.some(engine))
        // The look it woke is yet to read the ready set; once that has, nothing waits.
        expect(yield* answers.awaited).toBe(true)
        yield* answers.sweep
        expect(yield* answers.awaited).toBe(false)
      }).pipe(Effect.scoped, Effect.provide(services)),
  )

  it.effect('with a duration, answers what has waited that long', () =>
    Effect.gen(function* () {
      const { answers, wakes, said } = yield* started(after10m)
      const { question } = yield* asked()

      // It keeps the run from ending all the while.
      expect(yield* answers.awaited).toBe(true)
      yield* past('9 minutes')
      expect(yield* answerOf(question)).toEqual(Option.none())
      expect(yield* answers.awaited).toBe(true)
      expect(yield* Ref.get(said)).toEqual([])

      yield* past('1 minute')
      yield* Queue.take(wakes)
      expect(yield* answerOf(question)).toEqual(Option.some(fromAutoAnswer))
      expect(yield* labelsOf(question)).toEqual([autoAnsweredLabel])
      expect((yield* Ref.get(said)).length).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(services)),
  )

  it.effect(
    'the maintainer answering first leaves nothing to answer, and the run free to end',
    () =>
      Effect.gen(function* () {
        const { answers, requests, said } = yield* started(after10m)
        const { question } = yield* asked()
        yield* answers.sweep

        yield* requests.answer({
          answer: AttentionAnswer.cases.question.make({
            project,
            ticket: question,
            answer: QuestionAnswer.cases.option.make({ index: 1 }),
          }),
          by: 'the app',
        })
        expect(yield* answers.awaited).toBe(false)

        yield* past('10 minutes')
        expect(yield* answerOf(question)).toEqual(Option.some('Postgres'))
        expect(yield* labelsOf(question)).toEqual([])
        expect(yield* Ref.get(said)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(services)),
  )

  it.effect('a question closed while it waits is not answered', () =>
    Effect.gen(function* () {
      const { answers, requests, said, graph } = yield* started(after10m)
      const attention = yield* requests.forRun
      const { question } = yield* asked()
      yield* answers.sweep

      yield* graph.close({
        id: question,
        resolution: 'cancelled',
        actor: worker,
      })
      expect(yield* answers.awaited).toBe(false)
      yield* past('10 minutes')

      expect(yield* answerOf(question)).toEqual(Option.none())
      expect(yield* Ref.get(said)).toEqual([])
      // Nor would an answer already on its way take it: the service reads it again.
      expect(
        yield* attention.autoAnswer({
          project,
          ticket: question,
          actor: engine,
        }),
      ).toEqual(Option.none())
    }).pipe(Effect.scoped, Effect.provide(services)),
  )

  it.effect(
    'an answer the work graph refuses leaves it to whoever came first, the design as it was',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const requests = yield* makeAttention({
          list: Effect.succeed([project]),
          changed: Stream.never,
          // Closed by a hand outside the attention requests, just as the answer is given.
          graph: () =>
            Effect.succeed({
              ...graph,
              answer: ({ id }) =>
                Effect.fail(
                  new TransitionRefused({
                    id,
                    operation: 'answer',
                    status: 'closed',
                  }),
                ),
            }),
        })
        const attention = yield* requests.forRun
        const { task, question } = yield* asked()

        expect(
          yield* attention.autoAnswer({
            project,
            ticket: question,
            actor: engine,
          }),
        ).toEqual(Option.none())
        expect(yield* labelsOf(question)).toEqual([])
        expect((yield* graph.show(task)).ticket.design).toEqual(Option.none())
      }).pipe(Effect.scoped, Effect.provide(services)),
  )

  it.effect.each([
    ['a consequential one, as its asker marked it', { consequential: true }],
    [
      'a consequential one, known from its options',
      {
        options: [
          new QuestionOption({ label: 'Close it', tradeOff: 'It goes.' }),
          postgres,
        ],
      },
    ],
    ['a maintainer_only one', { maintainerOnly: true }],
    ['one with no options', { options: 'none' as const }],
  ] as const)('leaves %s to the maintainer', ([, fields]) =>
    Effect.gen(function* () {
      const { answers, said } = yield* started(AutoAnswer.cases.AtOnce.make({}))
      const { question } = yield* asked(fields)

      expect(yield* answers.awaited).toBe(false)
      yield* past('1 hour')

      expect(yield* answerOf(question)).toEqual(Option.none())
      expect(yield* labelsOf(question)).toEqual([])
      expect(yield* Ref.get(said)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(services)),
  )

  it.effect('leaves a question open before the run to the maintainer', () =>
    Effect.gen(function* () {
      const { question } = yield* asked()
      const { answers, said } = yield* started(AutoAnswer.cases.AtOnce.make({}))

      expect(yield* answers.awaited).toBe(false)
      yield* past('1 hour')

      expect(yield* answerOf(question)).toEqual(Option.none())
      expect(yield* Ref.get(said)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(services)),
  )

  it.effect('does nothing where it is off', () =>
    Effect.gen(function* () {
      const { answers, said } = yield* started(AutoAnswer.cases.Off.make({}))
      const { question } = yield* asked()

      expect(yield* answers.awaited).toBe(false)
      yield* past('1 hour')

      expect(yield* answerOf(question)).toEqual(Option.none())
      expect(yield* Ref.get(said)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(services)),
  )

  it.effect('answers nothing once it has stopped', () =>
    Effect.gen(function* () {
      const { answers, said } = yield* started(after10m)
      const { question } = yield* asked()
      yield* answers.sweep

      yield* answers.stop
      yield* past('1 hour')

      expect(yield* answerOf(question)).toEqual(Option.none())
      expect(yield* Ref.get(said)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(services)),
  )

  it.effect(
    "answers a question once: reopened afterwards, it is the maintainer's",
    () =>
      Effect.gen(function* () {
        const { answers, wakes, graph, said } = yield* started(
          AutoAnswer.cases.AtOnce.make({}),
        )
        const { question } = yield* asked()
        yield* answers.sweep
        yield* Queue.take(wakes)

        yield* graph.reopen({ id: question, actor: worker })
        yield* answers.sweep
        yield* past('1 hour')

        expect((yield* Ref.get(said)).length).toBe(1)
        expect((yield* graph.show(question)).ticket.status).toBe('open')
      }).pipe(Effect.scoped, Effect.provide(services)),
  )

  it.effect(
    "a client answering later hears it was --auto-answer, and a revised answer is the maintainer's",
    () =>
      Effect.gen(function* () {
        const { answers, wakes, requests, graph } = yield* started(
          AutoAnswer.cases.AtOnce.make({}),
        )
        const { task, question } = yield* asked()
        yield* answers.sweep
        yield* Queue.take(wakes)

        const late = yield* requests
          .answer({
            answer: AttentionAnswer.cases.question.make({
              project,
              ticket: question,
              answer: QuestionAnswer.cases.option.make({ index: 1 }),
            }),
            by: 'the app',
          })
          .pipe(Effect.flip)
        expect(late).toBeInstanceOf(AlreadyAnswered)
        expect(late).toMatchObject({ by: '--auto-answer' })

        yield* requests.revise({
          project,
          ticket: question,
          answer: QuestionAnswer.cases.option.make({ index: 1 }),
          by: 'the app',
        })
        expect(yield* answerOf(question)).toEqual(Option.some('Postgres'))
        expect(yield* labelsOf(question)).toEqual([])
        const { ticket } = yield* graph.show(task)
        expect(Option.getOrThrow(ticket.design)).toContain(
          `The maintainer answered ${question} (Which store?): Postgres`,
        )
      }).pipe(Effect.scoped, Effect.provide(services)),
  )

  it.effect('says its wait on the start record, in ms, 0 for at once', () =>
    Effect.sync(() => {
      expect(autoAnswerFields(AutoAnswer.cases.Off.make({}))).toEqual({})
      expect(autoAnswerFields(AutoAnswer.cases.AtOnce.make({}))).toEqual({
        auto_answer: 0,
      })
      expect(autoAnswerFields(after10m)).toEqual({ auto_answer: 600_000 })
    }),
  )
})

describe('--auto-answer in a run', () => {
  beforeAll(setUpRuns)

  /** The config of a run with `--auto-answer`'s `value`. */
  const answering = (fixture: Project, value: string) => ({
    ...configOf(fixture, options()),
    settings: {
      flags: { auto_answer: value },
      environment: {},
      engineSettings: {},
    },
  })

  /** What the ticket's stub was prompted with and called, as it noted them. */
  const notesOf = (fixture: Project, ticket: TicketId) =>
    readFileSync(
      join(
        sessionFolder({
          data: fixture.data,
          project: ProjectId.make('p1'),
          ticket,
        }),
        'stub.jsonl',
      ),
      'utf8',
    )

  it.effect(
    'bare: the ticket resumes told which option was chosen and by whom, and merges',
    () =>
      Effect.gen(function* () {
        const fixture = runProjectFixture()
        yield* withRuns(
          fixture,
          Effect.gen(function* () {
            const made = yield* file('Ask it', 'ask')
            const end = yield* runProject(answering(fixture, 'true'))
            const events = yield* eventsOf(fixture)
            const graph = yield* WorkGraph

            expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
            expect(ofKind(events, 'start')).toEqual([
              expect.objectContaining({ auto_answer: 0 }),
            ])
            const [answered] = ofKind(events, 'auto_answered')
            expect(answered).toMatchObject({
              ticket: made.id,
              title: 'Keep the old flag?',
              option: 'Keep it',
            })
            expect(answered?.text).toContain('answered by --auto-answer')
            const { ticket, labels } = yield* graph.show(answered!.question)
            expect(labels).toEqual([autoAnsweredLabel])
            expect(ticket.resolution).toEqual(Option.some('answered'))
            expect(ofKind(events, 'closed')).toEqual([
              expect.objectContaining({ ticket: made.id }),
            ])
            expect(notesOf(fixture, made.id)).toContain(
              `your question ${answered!.question} was answered: Keep it (the recommended option, chosen by --auto-answer, not by the maintainer)`,
            )
          }),
        )
      }),
  )

  it.effect(
    'with a duration: the question keeps the run from ending until it is answered, then its ticket merges',
    () =>
      Effect.gen(function* () {
        const fixture = runProjectFixture()
        yield* withRuns(
          fixture,
          Effect.gen(function* () {
            const graph = yield* WorkGraph
            const changes = yield* graph.changes
            const released = yield* Deferred.make<void>()
            const answered = yield* Deferred.make<void>()
            yield* changes.pipe(
              Stream.runForEach(event =>
                event.change._tag === 'answered'
                  ? Deferred.succeed(answered, undefined)
                  : event.change._tag === 'released'
                    ? Deferred.succeed(released, undefined)
                    : Effect.void,
              ),
              Effect.ignore,
              Effect.forkScoped,
            )
            const made = yield* file('Ask it', 'ask')
            const run = yield* runProject(answering(fixture, '10m')).pipe(
              Effect.forkScoped,
            )
            yield* Deferred.await(released)
            // The question has waited from when the run saw it, which time doesn't pass till now.
            while (!(yield* Deferred.isDone(answered)))
              yield* TestClock.adjust('10 minutes')
            const end = yield* Fiber.await(run)
            const events = yield* eventsOf(fixture)

            expect(end._tag).toBe('Success')
            expect(ofKind(events, 'start')).toEqual([
              expect.objectContaining({ auto_answer: 600_000 }),
            ])
            expect(ofKind(events, 'auto_answered').length).toBe(1)
            expect(ofKind(events, 'closed')).toEqual([
              expect.objectContaining({ ticket: made.id }),
            ])
          }),
        )
      }),
  )
})
