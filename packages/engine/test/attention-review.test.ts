import {
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
  Stream,
} from 'effect'
import { TestClock } from 'effect/testing'

import { describe, expect, it } from '@effect/vitest'
import {
  AttentionClosed,
  AttentionRef,
  AttentionRequest,
  EngineId,
  Phase,
  ProjectId,
  ProjectNotFound,
  type ReviewRequest,
  RunHeader,
  RunId,
  RunMode,
  type SetAsideReason,
  StreamEpoch,
  TicketId,
} from '@fabrica/contracts'

import { AttentionItem, make } from '../src/attention'
import { noSpend } from '../src/cost'
import type { RunSnapshot, RunStateShape } from '../src/run'
import { makeRunView } from '../src/view'
import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'

// Review requests (spec §15.1, §18.3): the tickets a run has set aside. The attention service holds a
// project's as it is told them, beside what it reads from the work graph, and the run's view tells them
// from its rows as they change, each with its reason and when it was set aside; while open, they count
// on the project's row.

const project = ProjectId.make('app')
const other = ProjectId.make('other')
const first = TicketId.make('fa-a1')
const second = TicketId.make('fa-b2')
const at = DateTime.makeUnsafe(0)

const reviewOf = (
  ticket: TicketId,
  reason: SetAsideReason,
  of: ProjectId = project,
): ReviewRequest =>
  AttentionRequest.cases.review.make({
    project: of,
    ticket,
    title: 'Add the page',
    reason,
    openedAt: at,
  })

const graphLayer = Layer.effect(
  WorkGraph,
  makeWorkGraph({ prefix: 'fa' }),
).pipe(Layer.provide(storeLayer(':memory:')))

/** The attention requests over the one project's work graph; the other project has an empty one. */
const attentionOn = Effect.gen(function* () {
  const graph = yield* WorkGraph
  return yield* make({
    list: Effect.succeed([project, other]),
    changed: Stream.never,
    graph: id =>
      id === project || id === other
        ? Effect.succeed(graph)
        : Effect.fail(new ProjectNotFound({ project: id })),
    events: () => Effect.succeed([]),
  })
})

describe("the attention service's review requests", () => {
  it.effect(
    'lists what it is told, and keeps it as the work graph is read again',
    () =>
      Effect.gen(function* () {
        const attention = yield* attentionOn
        const review = reviewOf(first, 'CHECKS_FAILED')
        yield* attention.reviews({ project, open: [review] })

        // Listing reads the work graph again, which has no such request.
        expect(yield* attention.list(Option.some(project))).toStrictEqual([
          review,
        ])
        yield* (yield* WorkGraph).create({
          ticket: { type: 'manual', title: 'Make the key' },
          actor: { _tag: 'maintainer' },
        })
        const listed = yield* attention.list(Option.some(project))
        expect(listed.map(({ _tag }) => _tag).toSorted()).toEqual([
          'review',
          'task',
        ])
        expect(yield* attention.list(Option.none())).toContainEqual(review)
      }).pipe(Effect.scoped, Effect.provide(graphLayer)),
  )

  it.effect(
    "closes those it is no longer told, one project's alone, and patches watchers with each",
    () =>
      Effect.gen(function* () {
        const attention = yield* attentionOn
        const items = yield* Queue.unbounded<AttentionItem>()
        yield* attention
          .watch({ project: Option.some(project), resume: Option.none() })
          .pipe(
            Stream.runForEach(item => Queue.offer(items, item)),
            Effect.forkScoped,
          )
        const snapshot = yield* Queue.take(items)
        expect(snapshot._tag).toBe('snapshot')
        expect(snapshot.value).toEqual([])

        const one = reviewOf(first, 'MERGE_CONFLICT')
        const two = reviewOf(second, 'DEFERRED')
        const elsewhere = reviewOf(first, 'TICKET_LIMIT', other)
        yield* attention.reviews({ project: other, open: [elsewhere] })
        yield* attention.reviews({ project, open: [one, two] })
        const opened = [yield* Queue.take(items), yield* Queue.take(items)]
        expect(
          opened.flatMap(item =>
            item._tag === 'patch' ? item.value.upsert : [],
          ),
        ).toStrictEqual([one, two])

        // Told the same again: no patch. The first back in progress: its request closes, by no one.
        yield* attention.reviews({ project, open: [one, two] })
        yield* attention.reviews({ project, open: [two] })
        const closed = yield* Queue.take(items)
        if (closed._tag !== 'patch') return expect.fail('a snapshot came')
        expect(closed.value.upsert).toEqual([])
        expect(closed.value.remove.map(({ ref }) => ref)).toStrictEqual([
          AttentionRef.cases.review.make({ project, ticket: first }),
        ])
        expect(closed.value.remove.map(({ by }) => by)).toEqual([Option.none()])

        // The run's end: none are left of the project's, and the other project's stay.
        yield* attention.reviews({ project, open: [] })
        expect(yield* attention.list(Option.some(project))).toEqual([])
        expect(yield* attention.list(Option.some(other))).toStrictEqual([
          elsewhere,
        ])
      }).pipe(Effect.scoped, Effect.provide(graphLayer)),
  )
})

const interval = Duration.millis(50)

const header = new RunHeader({
  run: RunId.make('2026-10-30T09:00:00+01:00'),
  project,
  engine: EngineId.make('engine-1'),
  mode: RunMode.cases.tickets.make({}),
  state: 'running',
  startedAt: at,
  offline: false,
  autoAnswer: false,
})

const taken = (ticket: TicketId, title: string, phase: Phase) =>
  [
    ticket,
    {
      ticket,
      title,
      phase,
      n: Option.some(1),
      since: { startNanos: BigInt(0) },
    },
  ] as const

/** The run's state, read from `current`. */
const stateOf = (
  current: Effect.Effect<RunSnapshot['tickets']>,
): RunStateShape => {
  const snapshot = Effect.map(current, (tickets): RunSnapshot => ({
    tickets,
    dispatched: 2,
    ending: false,
  }))
  return {
    current: snapshot,
    enter: () => Effect.succeed(false),
    dispatch: () => Effect.succeed(Option.none()),
    move: () => Effect.succeed(Option.none()),
    end: snapshot,
    endLeft: Effect.void,
  }
}

describe("the run view's set-aside tickets", () => {
  it.effect(
    'are told as review requests as they enter and leave set aside, with their reason and when',
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const told = yield* Queue.unbounded<ReadonlyArray<ReviewRequest>>()
        const view = yield* makeRunView({
          header: Effect.succeed(header),
          interval,
          flush: interval,
          graph: {
            doneSince: () => Effect.succeed(0),
            changes: Effect.succeed(Stream.never),
          },
          attention: Stream.never,
          needsYou: () => Effect.void,
          reviews: requests => Queue.offer(told, requests),
          scope,
        }).pipe(
          Effect.provideService(
            DateTime.CurrentTimeZone,
            DateTime.zoneMakeOffset(0),
          ),
        )
        const tickets = yield* Ref.make<RunSnapshot['tickets']>(new Map())
        yield* view.sources.attach({
          state: stateOf(Ref.get(tickets)),
          holds: Effect.succeed({ on: [], gaveUp: Option.none() }),
          line: Effect.succeed({ merging: Option.none(), waiting: [] }),
          mergesWait: Effect.succeed(Option.none()),
          slots: 2,
          spent: Effect.succeed({
            tickets: new Map(),
            run: { workers: noSpend, untied: noSpend },
          }),
        })
        const tellings = Effect.map(Queue.clear(told), all => [...all])

        // No ticket yet: nothing to tell.
        yield* TestClock.adjust(interval)
        expect(yield* tellings).toEqual([])

        // At work, then set aside: told once it is, as of the write that saw it.
        yield* Ref.set(
          tickets,
          new Map([taken(first, 'Add the page', Phase.cases.working.make({}))]),
        )
        yield* TestClock.adjust(interval)
        expect((yield* tellings).flat()).toEqual([])

        yield* Ref.set(
          tickets,
          new Map([
            taken(
              first,
              'Add the page',
              Phase.cases.set_aside.make({ reason: 'CHECKS_FAILED' }),
            ),
            taken(second, 'Fix the link', Phase.cases.working.make({})),
          ]),
        )
        yield* TestClock.adjust(interval)
        const setAsideAt = yield* DateTime.now
        expect(yield* tellings).toStrictEqual([
          [
            AttentionRequest.cases.review.make({
              project,
              ticket: first,
              title: 'Add the page',
              reason: 'CHECKS_FAILED',
              openedAt: setAsideAt,
            }),
          ],
        ])

        // Nothing changes: nothing is told again, and it stays set aside since then.
        yield* TestClock.adjust(interval)
        expect(yield* tellings).toEqual([])

        // Back in the queue: no request is left.
        yield* Ref.set(
          tickets,
          new Map([
            taken(first, 'Add the page', Phase.cases.queued.make({})),
            taken(second, 'Fix the link', Phase.cases.working.make({})),
          ]),
        )
        yield* TestClock.adjust(interval)
        expect(yield* tellings).toEqual([[]])
        yield* Scope.close(scope, Exit.void)
      }),
  )

  it.effect("count on the project's row while their requests are open", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const requests = yield* Queue.unbounded<AttentionItem>()
      const counts = yield* Queue.unbounded<number>()
      yield* makeRunView({
        header: Effect.succeed(header),
        interval,
        flush: interval,
        graph: {
          doneSince: () => Effect.succeed(0),
          changes: Effect.succeed(Stream.never),
        },
        attention: Stream.fromQueue(requests),
        needsYou: count => Queue.offer(counts, count),
        reviews: () => Effect.void,
        scope,
      }).pipe(
        Effect.provideService(
          DateTime.CurrentTimeZone,
          DateTime.zoneMakeOffset(0),
        ),
      )
      const review = reviewOf(first, 'CHECKS_FAILED')
      yield* Queue.offer(
        requests,
        AttentionItem.cases.snapshot.make({
          epoch: StreamEpoch.make('attention-1'),
          seq: 0,
          value: [review],
        }),
      )
      yield* TestClock.adjust(interval)
      expect([...(yield* Queue.clear(counts))]).toEqual([1])
      yield* Queue.offer(
        requests,
        AttentionItem.cases.patch.make({
          seq: 1,
          value: {
            upsert: [],
            remove: [
              new AttentionClosed({
                ref: AttentionRef.cases.review.make({ project, ticket: first }),
                by: Option.none(),
                at,
              }),
            ],
          },
        }),
      )
      yield* TestClock.adjust(interval)
      expect([...(yield* Queue.clear(counts))]).toEqual([0])
      yield* Scope.close(scope, Exit.void)
    }),
  )
})
