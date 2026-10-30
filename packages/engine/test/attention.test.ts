import { Effect, Exit, Fiber, Layer, Option, Result, Stream } from 'effect'
import { RpcTest } from 'effect/rpc'

import { describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  AlreadyAnswered,
  Assignee,
  AttentionAnswer,
  AttentionRequest,
  AttentionRpcs,
  CommitHash,
  Edge,
  EngineId,
  PermissionDecision,
  PermissionShown,
  ProjectId,
  ProjectNotFound,
  QuestionAnswer,
  QuestionChoices,
  QuestionOption,
  SessionId,
  TicketId,
  ToolCallId,
} from '@fabrica/contracts'

import {
  type AttentionItem,
  AttentionRequests,
  consequentialChoices,
  make,
} from '../src/attention'
import type { PermissionRequest } from '../src/control'
import { attentionHandlers } from '../src/rpc/attention'
import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'

// The attention requests (spec §15.1, §15.2, §8.5) over a project's in-memory work graph: two clients
// answering one question, the first winning and the second told by whom and when; a permission
// allowed for the run, its rule reused by the run's later calls and by no other run's; an answer
// written into the blocked ticket's design, readying it and reaching the session that waits on it; a
// consequential question known from its options; and a revised answer undoing what the old one did
// where it can and listing what it can't.

const project = ProjectId.make('app')
const engine = EngineId.make('engine-1')
const session = SessionId.make('session-1')
const worker: Actor = { _tag: 'worker', session }
const maintainer: Actor = { _tag: 'maintainer' }

const graphLayer = Layer.effect(
  WorkGraph,
  makeWorkGraph({ prefix: 'fa' }),
).pipe(Layer.provide(storeLayer(':memory:')))

/** The attention requests over the one project's work graph. */
const attentionOn = Effect.gen(function* () {
  const graph = yield* WorkGraph
  return yield* make({
    list: Effect.succeed([project]),
    changed: Stream.never,
    graph: id =>
      id === project
        ? Effect.succeed(graph)
        : Effect.fail(new ProjectNotFound({ project: id })),
  })
})

const option = (label: string, tradeOff: string) =>
  new QuestionOption({ label, tradeOff })

/** A task, and a question its worker asked about it: blocking it, linked to it as `ask_question` links it. */
const asked = (
  options: ReadonlyArray<QuestionOption> = [
    option('SQLite', 'One file, nothing to run.'),
    option('Postgres', 'A server to run.'),
  ],
) =>
  Effect.gen(function* () {
    const graph = yield* WorkGraph
    const task = yield* graph.create({
      ticket: { type: 'task', title: 'Store the runs' },
      actor: maintainer,
    })
    const question = yield* graph.ask({
      question: {
        title: 'Which store?',
        choices: new QuestionChoices({ options, recommended: 0 }),
        consequential: false,
        maintainerOnly: false,
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

const answerWith = (ticket: TicketId, index: number) =>
  AttentionAnswer.cases.question.make({
    project,
    ticket,
    answer: QuestionAnswer.cases.option.make({ index }),
  })

/** The requests an attention stream's item brings. */
const broughtBy = (item: AttentionItem): ReadonlyArray<AttentionRequest> =>
  item._tag === 'snapshot' ? item.value : item.value.upsert

const permissionRequest = (command: string): PermissionRequest => ({
  project,
  ticket: TicketId.make('fa-work'),
  session,
  toolCall: ToolCallId.make(`call-${command.length}`),
  tool: 'bash',
  input: { command },
  shown: PermissionShown.cases.command.make({ lines: [command] }),
  why: 'a network-reaching command not on the list',
})

describe('attention requests', () => {
  it.effect(
    'takes the first of two clients’ answers and tells the second who answered and when',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const attention = yield* attentionOn
        const { question } = yield* asked()
        const services = Layer.succeed(AttentionRequests)(attention)
        const handlers = attentionHandlers.pipe(Layer.provide(services))
        const app = yield* RpcTest.makeClient(AttentionRpcs).pipe(
          Effect.provide(handlers),
        )
        const cli = yield* RpcTest.makeClient(AttentionRpcs).pipe(
          Effect.provide(handlers),
        )
        const listed = yield* cli['attention.list']({
          project: Option.some(project),
        })
        expect(listed.map(request => request._tag)).toStrictEqual(['question'])
        // The second client watches as the first answers.
        const closing = yield* cli['attention.watch']({
          project: Option.none(),
          resume: Option.none(),
        }).pipe(
          Stream.filter(
            item => item._tag === 'patch' && item.value.remove.length > 0,
          ),
          Stream.runHead,
          Effect.forkChild,
        )
        yield* Effect.yieldNow
        const [first, second] = yield* Effect.all(
          [
            Effect.result(
              app['attention.answer']({ answer: answerWith(question, 0) }),
            ),
            Effect.result(
              cli['attention.answer']({ answer: answerWith(question, 1) }),
            ),
          ],
          { concurrency: 'unbounded' },
        )
        const won = Result.getOrThrow(first)
        expect(Result.isFailure(second)).toBe(true)
        if (Result.isFailure(second)) {
          expect(second.failure).toBeInstanceOf(AlreadyAnswered)
          expect(second.failure).toMatchObject({ by: won.by, at: won.at })
        }
        const { ticket } = yield* graph.show(question)
        expect(
          Option.flatMap(ticket.question, ({ answer }) => answer),
        ).toStrictEqual(Option.some('SQLite'))
        const closed = yield* Fiber.join(closing)
        expect(
          Option.map(closed, item =>
            item._tag === 'patch' ? item.value.remove.map(gone => gone.by) : [],
          ),
        ).toStrictEqual(Option.some([Option.some(won.by)]))
        expect(
          yield* app['attention.list']({ project: Option.none() }),
        ).toStrictEqual([])
      }).pipe(Effect.provide(graphLayer), Effect.scoped),
  )

  it.effect(
    'reuses a permission allowed for the run for the run’s same call, and for no other run',
    () =>
      Effect.gen(function* () {
        const attention = yield* attentionOn
        const firstRun = yield* attention.forRun
        const secondRun = yield* attention.forRun
        const curl = permissionRequest('curl https://example.com')
        /** The next permission request listed, from a watch begun now. */
        const nextListed = attention
          .watch({ project: Option.some(project), resume: Option.none() })
          .pipe(
            Stream.flatMap(item => Stream.fromIterable(broughtBy(item))),
            Stream.filter(AttentionRequest.guards.permission),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          )

        const asking = yield* Effect.forkChild(firstRun.permission(curl))
        const listed = yield* nextListed
        expect(listed).toMatchObject({
          tool: 'bash',
          input: { command: 'curl https://example.com' },
          why: 'a network-reaching command not on the list',
        })
        yield* attention.answer({
          answer: AttentionAnswer.cases.permission.make({
            project,
            id: listed.id,
            decision: PermissionDecision.cases.allow_run.make({}),
          }),
          by: 'app',
        })
        expect(yield* Fiber.join(asking)).toStrictEqual(
          PermissionDecision.cases.allow_run.make({}),
        )
        // The run's same call again: allowed by its rule, never listed.
        expect(yield* firstRun.permission(curl)).toStrictEqual(
          PermissionDecision.cases.allow_run.make({}),
        )
        expect(yield* attention.list(Option.some(project))).toStrictEqual([])

        // Another run has no such rule: it asks.
        const other = yield* Effect.forkChild(secondRun.permission(curl))
        const otherListed = yield* nextListed
        yield* attention.answer({
          answer: AttentionAnswer.cases.permission.make({
            project,
            id: otherListed.id,
            decision: PermissionDecision.cases.refuse.make({
              note: Option.some('not from this run'),
            }),
          }),
          by: 'cli',
        })
        expect(yield* Fiber.join(other)).toStrictEqual(
          PermissionDecision.cases.refuse.make({
            note: Option.some('not from this run'),
          }),
        )
        // An answered request answered again: who answered it first.
        const again = yield* Effect.exit(
          attention.answer({
            answer: AttentionAnswer.cases.permission.make({
              project,
              id: otherListed.id,
              decision: PermissionDecision.cases.allow_once.make({}),
            }),
            by: 'app',
          }),
        )
        expect(Exit.findErrorOption(again)).toMatchObject(
          Option.some({ _tag: 'AlreadyAnswered', by: 'cli' }),
        )

        // A call the rule doesn't name asks, and leaves the list when its agent stops waiting.
        const rm = yield* Effect.forkChild(
          firstRun.permission(permissionRequest('rm -rf ../elsewhere')),
        )
        yield* nextListed
        yield* Fiber.interrupt(rm)
        expect(yield* attention.list(Option.some(project))).toStrictEqual([])
      }).pipe(Effect.provide(graphLayer), Effect.scoped),
  )

  it.effect(
    'writes an answer into the blocked ticket’s design, readies it and gives the asking session the answer',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const attention = yield* attentionOn
        const { task, question } = yield* asked()
        const onBase = () => Effect.succeed(true)
        expect(
          (yield* graph.ready({ onBase })).map(ticket => ticket.id),
        ).not.toContain(task)
        // The session that asked waits on the answer as `ask_and_wait` does, from before it is given.
        const changes = yield* graph.changes
        const waiting = yield* changes.pipe(
          Stream.filter(
            event =>
              Option.contains(event.ticketId, question) &&
              event.change._tag === 'answered',
          ),
          Stream.runHead,
          Effect.forkChild,
        )
        yield* Effect.yieldNow

        yield* attention.answer({ answer: answerWith(question, 1), by: 'app' })

        const heard = Option.getOrThrow(yield* Fiber.join(waiting))
        expect(heard.change).toStrictEqual({
          _tag: 'answered',
          answer: 'Postgres',
        })
        // The maintainer's change: the run, which wakes on every change but its own, wakes on it.
        expect(heard.actor).toStrictEqual(Option.some(maintainer))
        const { ticket } = yield* graph.show(task)
        expect(Option.getOrThrow(ticket.design)).toContain(
          `The maintainer answered ${question} (Which store?): Postgres`,
        )
        expect(
          (yield* graph.ready({ onBase })).map(ready => ready.id),
        ).toContain(task)
        const shown = yield* graph.show(question)
        expect(shown.ticket.resolution).toStrictEqual(Option.some('answered'))
      }).pipe(Effect.provide(graphLayer), Effect.scoped),
  )

  it.effect(
    'marks a question consequential where its options would close, cancel, defer or freeze work',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const attention = yield* attentionOn
        const { question } = yield* asked([
          option('Freeze the API', 'Nothing changes until the review.'),
          option('Keep going', 'The API may move under its users.'),
        ])
        const plain = yield* asked()
        const listed = yield* attention.list(Option.some(project))
        const consequential = new Map<TicketId, boolean>(
          listed.flatMap(request =>
            request._tag === 'question'
              ? [[request.ticket, request.consequential]]
              : [],
          ),
        )
        expect(consequential.get(question)).toBe(true)
        expect(consequential.get(plain.question)).toBe(false)
        // Marked as it was asked, though its asker didn't say so.
        const { ticket } = yield* graph.show(question)
        expect(
          Option.map(ticket.question, ({ consequential }) => consequential),
        ).toStrictEqual(Option.some(true))
        for (const label of [
          'Close it as done',
          'Cancel the epic',
          'Defer until the spike',
          'Leave it frozen',
        ])
          expect(
            consequentialChoices(
              Option.some(
                new QuestionChoices({
                  options: [
                    option(label, 'A trade-off.'),
                    option('No', 'None.'),
                  ],
                  recommended: 1,
                }),
              ),
            ),
          ).toBe(true)
        expect(consequentialChoices(Option.none())).toBe(false)
      }).pipe(Effect.provide(graphLayer), Effect.scoped),
  )

  it.effect(
    'revises an answer, reopening what the old one closed and listing what it can’t undo',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const attention = yield* attentionOn
        const { task, question } = yield* asked([
          option('Keep the feature', 'More to maintain.'),
          option('Drop the feature', 'Its tickets go.'),
        ])
        const sibling = yield* graph.create({
          ticket: { type: 'task', title: 'Document the feature' },
          actor: maintainer,
        })
        const later = yield* graph.create({
          ticket: { type: 'task', title: 'Polish the feature' },
          actor: maintainer,
        })
        const merged = yield* graph.create({
          ticket: { type: 'task', title: 'Hide the feature' },
          actor: maintainer,
        })
        const untouched = yield* graph.create({
          ticket: { type: 'task', title: 'Unrelated work' },
          actor: maintainer,
        })
        yield* attention.answer({ answer: answerWith(question, 1), by: 'app' })
        // The asking ticket's worker takes it up again on the old answer and acts on it.
        yield* graph.claim({
          id: task,
          assignee: new Assignee({ engine, session }),
          actor: { _tag: 'engine', engine },
        })
        yield* graph.close({
          id: sibling.id,
          resolution: 'cancelled',
          actor: worker,
        })
        yield* graph.defer({
          id: later.id,
          until: Option.none(),
          actor: worker,
        })
        yield* graph.close({ id: merged.id, resolution: 'done', actor: worker })
        yield* graph.update({
          id: merged.id,
          changes: {
            mergedCommit: Option.some(CommitHash.make('a'.repeat(40))),
          },
          actor: { _tag: 'engine', engine },
        })
        const filed = yield* graph.fileDiscovered({
          from: task,
          link: 'discovered_from',
          ticket: { type: 'task', title: 'Remove the feature flag' },
          actor: worker,
        })
        yield* graph.close({
          id: untouched.id,
          resolution: 'cancelled',
          actor: maintainer,
        })

        const revised = yield* attention.revise({
          project,
          ticket: question,
          answer: QuestionAnswer.cases.option.make({ index: 0 }),
          by: 'cli',
        })

        expect(revised.answered.by).toBe('cli')
        expect([...revised.undone].sort()).toStrictEqual(
          [
            `${sibling.id} (Document the feature) reopened`,
            `${later.id} (Polish the feature) undeferred`,
          ].sort(),
        )
        expect(revised.kept).toEqual(
          expect.arrayContaining([
            `${task}'s worker was given the old answer, and worked on it`,
            `${merged.id} (Hide the feature) merged as ${'a'.repeat(40)}: its change stays on Base`,
            `${filed.id} (Remove the feature flag) was filed on the old answer: it stays`,
          ]),
        )
        const status = (id: TicketId) =>
          Effect.map(graph.show(id), ({ ticket }) => ticket.status)
        expect(yield* status(sibling.id)).toBe('open')
        expect(yield* status(later.id)).toBe('open')
        expect(yield* status(untouched.id)).toBe('closed')
        const { ticket } = yield* graph.show(question)
        expect(ticket.resolution).toStrictEqual(Option.some('answered'))
        expect(
          Option.flatMap(ticket.question, ({ answer }) => answer),
        ).toStrictEqual(Option.some('Keep the feature'))
        const design = Option.getOrThrow(
          (yield* graph.show(task)).ticket.design,
        )
        expect(design).toContain(
          `The maintainer answered ${question} (Which store?): Keep the feature`,
        )
        expect(design).not.toContain('Drop the feature')
      }).pipe(Effect.provide(graphLayer), Effect.scoped),
  )
})
