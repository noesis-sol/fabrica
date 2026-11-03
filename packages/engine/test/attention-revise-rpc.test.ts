import { Effect, Layer, Option, Stream } from 'effect'
import { RpcTest } from 'effect/rpc'

import { describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  AlreadyAnswered,
  AttentionAnswer,
  AttentionNotFound,
  AttentionRef,
  AttentionRpcs,
  Edge,
  InvalidAnswer,
  ProjectId,
  ProjectNotFound,
  QuestionAnswer,
  QuestionChoices,
  QuestionOption,
  Revised,
  SessionId,
  TicketId,
} from '@fabrica/contracts'

import { AttentionRequests, make } from '../src/attention'
import { attentionHandlers } from '../src/rpc/attention'
import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'

// attention.revise (spec §15.2, H53) as clients ask it: the app answers a question, a client revises
// the answer, named as the revising client, the question and the blocked ticket's design taking the new
// answer; a question not yet answered, or no question at all, is refused as the request's errors say.

const project = ProjectId.make('app')
const worker: Actor = { _tag: 'worker', session: SessionId.make('session-1') }
const maintainer: Actor = { _tag: 'maintainer' }

const graphLayer = Layer.effect(
  WorkGraph,
  makeWorkGraph({ prefix: 'fa' }),
).pipe(Layer.provide(storeLayer(':memory:')))

/** The attention requests on the one project's work graph, and two clients of the Attention group they serve. */
const clients = Effect.gen(function* () {
  const graph = yield* WorkGraph
  const attention = yield* make({
    list: Effect.succeed([project]),
    changed: Stream.never,
    graph: id =>
      id === project
        ? Effect.succeed(graph)
        : Effect.fail(new ProjectNotFound({ project: id })),
  })
  const handlers = attentionHandlers.pipe(
    Layer.provide(Layer.succeed(AttentionRequests)(attention)),
  )
  const app = yield* RpcTest.makeClient(AttentionRpcs).pipe(
    Effect.provide(handlers),
  )
  const cli = yield* RpcTest.makeClient(AttentionRpcs).pipe(
    Effect.provide(handlers),
  )
  return { attention, app, cli }
})

/** A task, and a question its worker asked about it, blocking it. */
const asked = Effect.gen(function* () {
  const graph = yield* WorkGraph
  const task = yield* graph.create({
    ticket: { type: 'task', title: 'Store the runs' },
    actor: maintainer,
  })
  const question = yield* graph.ask({
    question: {
      title: 'Which store?',
      choices: new QuestionChoices({
        options: [
          new QuestionOption({
            label: 'SQLite',
            tradeOff: 'One file, nothing to run.',
          }),
          new QuestionOption({
            label: 'Postgres',
            tradeOff: 'A server to run.',
          }),
        ],
        recommended: 0,
      }),
      consequential: false,
      maintainerOnly: false,
      blocks: [task.id],
    },
    actor: worker,
  })
  yield* graph.addDependency({
    edge: new Edge({ from: question.id, to: task.id, kind: 'discovered_from' }),
    actor: worker,
  })
  return { task: task.id, question: question.id }
})

const option = (index: number) => QuestionAnswer.cases.option.make({ index })

describe('attention.revise', () => {
  it.effect(
    'revises a question the app answered, named as the client that revised it',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const { attention, app, cli } = yield* clients
        const { task, question } = yield* asked
        yield* attention.answer({
          answer: AttentionAnswer.cases.question.make({
            project,
            ticket: question,
            answer: option(0),
          }),
          by: 'Fabrica app',
        })

        const revised = yield* cli['attention.revise']({
          project,
          ticket: question,
          answer: option(1),
        })

        expect(revised).toBeInstanceOf(Revised)
        // A test client gives no hello: it is named by its connection's number.
        expect(revised.answered.by).toBe('client 0')
        expect(revised.undone).toStrictEqual([])
        expect(revised.kept).toStrictEqual([])
        const { ticket } = yield* graph.show(question)
        expect(ticket.resolution).toStrictEqual(Option.some('answered'))
        expect(
          Option.flatMap(ticket.question, ({ answer }) => answer),
        ).toStrictEqual(Option.some('Postgres'))
        const design = Option.getOrThrow(
          (yield* graph.show(task)).ticket.design,
        )
        expect(design).toContain(
          `The maintainer answered ${question} (Which store?): Postgres`,
        )
        expect(design).not.toContain('SQLite')
        // A later answer is still told the revision came first (§8.5).
        const late = yield* Effect.flip(
          app['attention.answer']({
            answer: AttentionAnswer.cases.question.make({
              project,
              ticket: question,
              answer: option(0),
            }),
          }),
        )
        expect(late).toBeInstanceOf(AlreadyAnswered)
        expect(late).toMatchObject({
          by: revised.answered.by,
          at: revised.answered.at,
        })
      }).pipe(Effect.provide(graphLayer), Effect.scoped),
  )

  it.effect(
    'refuses a question not yet answered, an option it hasn’t, and a ticket that is no question',
    () =>
      Effect.gen(function* () {
        const { app, cli } = yield* clients
        const { task, question } = yield* asked
        const unanswered = yield* Effect.flip(
          cli['attention.revise']({
            project,
            ticket: question,
            answer: option(0),
          }),
        )
        expect(unanswered).toBeInstanceOf(InvalidAnswer)
        yield* app['attention.answer']({
          answer: AttentionAnswer.cases.question.make({
            project,
            ticket: question,
            answer: option(0),
          }),
        })
        expect(
          yield* Effect.flip(
            cli['attention.revise']({
              project,
              ticket: question,
              answer: option(2),
            }),
          ),
        ).toBeInstanceOf(InvalidAnswer)
        for (const ticket of [task, TicketId.make('fa-none')]) {
          const notFound = yield* Effect.flip(
            cli['attention.revise']({ project, ticket, answer: option(0) }),
          )
          expect(notFound).toBeInstanceOf(AttentionNotFound)
          expect(notFound).toMatchObject({
            ref: AttentionRef.cases.question.make({ project, ticket }),
          })
        }
      }).pipe(Effect.provide(graphLayer), Effect.scoped),
  )
})
