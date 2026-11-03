import {
  DateTime,
  Duration,
  Effect,
  Exit,
  Option,
  Queue,
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
  RunHeader,
  RunId,
  RunMode,
  StreamEpoch,
  TicketId,
} from '@fabrica/contracts'

import { AttentionItem } from '../src/attention'
import { noSpend } from '../src/cost'
import type { RunSnapshot, RunStateShape } from '../src/run'
import { type RunViewItem, makeRunView } from '../src/view'

// The run view's attention requests (spec §8.3, §15.1, §18.3): the project's open requests, followed
// from the attention service as they change, are the view's attention part and its patches, and the
// project's row is told how many things wait on the maintainer: the requests and the asked tickets,
// a question an asked ticket waits on counted once.

const project = ProjectId.make('work')
const asking = TicketId.make('wk-a1')
const working = TicketId.make('wk-b2')
const question = TicketId.make('wk-q1')
const other = TicketId.make('wk-q2')
const task = TicketId.make('wk-t1')
const interval = Duration.millis(50)
const at = DateTime.makeUnsafe(0)

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

const questionOf = (ticket: TicketId, askedFrom: Option.Option<TicketId>) =>
  AttentionRequest.cases.question.make({
    project,
    ticket,
    title: 'Which route?',
    description: Option.none(),
    choices: Option.none(),
    consequential: false,
    maintainerOnly: false,
    blocks: Option.toArray(askedFrom),
    askedFrom,
    openedAt: at,
  })

const asked = questionOf(question, Option.some(asking))
const yourTask = AttentionRequest.cases.task.make({
  project,
  ticket: task,
  title: 'Make the key',
  openedAt: at,
})

/** The run's state: `asking` waiting on `question`, `working` at work. */
const snapshot: RunSnapshot = {
  tickets: new Map([
    [
      asking,
      {
        ticket: asking,
        title: 'Add the page',
        phase: Phase.cases.asked.make({ question }),
        n: Option.some(1),
        since: { startNanos: BigInt(0) },
      },
    ],
    [
      working,
      {
        ticket: working,
        title: 'Fix the link',
        phase: Phase.cases.working.make({}),
        n: Option.some(2),
        since: { startNanos: BigInt(0) },
      },
    ],
  ]),
  dispatched: 2,
  ending: false,
}

const state: RunStateShape = {
  current: Effect.succeed(snapshot),
  enter: () => Effect.succeed(false),
  dispatch: () => Effect.succeed(Option.none()),
  move: () => Effect.succeed(Option.none()),
  end: Effect.succeed(snapshot),
  endLeft: Effect.void,
}

describe("the run view's attention requests", () => {
  it.effect(
    'carries the open requests as they change, and counts what needs the maintainer once each',
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const requests = yield* Queue.unbounded<AttentionItem>()
        const told = yield* Queue.unbounded<number>()
        const view = yield* makeRunView({
          header: Effect.succeed(header),
          interval,
          flush: interval,
          graph: {
            doneSince: () => Effect.succeed(0),
            changes: Effect.succeed(Stream.never),
          },
          attention: Stream.fromQueue(requests),
          needsYou: count => Queue.offer(told, count),
          reviews: () => Effect.void,
          scope,
        }).pipe(
          Effect.provideService(
            DateTime.CurrentTimeZone,
            DateTime.zoneMakeOffset(0),
          ),
        )
        const items = yield* Queue.unbounded<RunViewItem>()
        yield* view.watch(Option.none()).pipe(
          Stream.runForEach(item => Queue.offer(items, item)),
          Effect.forkIn(scope),
        )
        yield* Effect.yieldNow
        const patches = Effect.map(Queue.clear(items), all =>
          all.flatMap(item => (item._tag === 'patch' ? [item.value] : [])),
        )
        const counts = Effect.map(Queue.clear(told), all => [...all])
        yield* view.sources.attach({
          state,
          holds: Effect.succeed({ on: [], gaveUp: Option.none() }),
          line: Effect.succeed({ merging: Option.none(), waiting: [] }),
          mergesWait: Effect.succeed(Option.none()),
          slots: 2,
          spent: Effect.succeed({
            tickets: new Map(),
            run: { workers: noSpend, untied: noSpend },
          }),
        })

        // The asked ticket alone: it needs the maintainer.
        yield* TestClock.adjust(interval)
        yield* patches
        expect(yield* counts).toEqual([1])

        // Its question and a task come: the question is the asked ticket's, counted once.
        yield* Queue.offer(
          requests,
          AttentionItem.cases.snapshot.make({
            epoch: StreamEpoch.make('attention-1'),
            seq: 0,
            value: [asked, yourTask],
          }),
        )
        yield* TestClock.adjust(interval)
        const [came] = yield* patches
        expect(came?.attention?.upsert).toStrictEqual([asked, yourTask])
        expect(yield* counts).toEqual([2])

        // Another question is asked, of no ticket of the run's: it needs the maintainer too.
        const another = questionOf(other, Option.none())
        yield* Queue.offer(
          requests,
          AttentionItem.cases.patch.make({
            seq: 1,
            value: { upsert: [another], remove: [] },
          }),
        )
        yield* TestClock.adjust(interval)
        const [more] = yield* patches
        expect(more?.attention?.upsert).toStrictEqual([another])
        expect(yield* counts).toEqual([3])

        // The task is closed: it leaves the view.
        const closed = AttentionRef.cases.task.make({ project, ticket: task })
        yield* Queue.offer(
          requests,
          AttentionItem.cases.patch.make({
            seq: 2,
            value: {
              upsert: [],
              remove: [
                new AttentionClosed({
                  ref: closed,
                  by: Option.some('the maintainer'),
                  at,
                }),
              ],
            },
          }),
        )
        yield* TestClock.adjust(interval)
        const [left] = yield* patches
        expect(left?.attention?.upsert).toStrictEqual([])
        expect(left?.attention?.remove.map(({ ref }) => ref)).toStrictEqual([
          closed,
        ])
        expect(yield* counts).toEqual([2])

        // Nothing changes: nothing is told again.
        yield* TestClock.adjust(interval)
        expect(yield* patches).toEqual([])
        expect(yield* counts).toEqual([])
        yield* Scope.close(scope, Exit.void)
      }),
  )
})
