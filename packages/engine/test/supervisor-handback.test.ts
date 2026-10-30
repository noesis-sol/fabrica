import {
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Option,
  PubSub,
  Queue,
  Stream,
  SubscriptionRef,
} from 'effect'

import { describe, expect, it } from '@effect/vitest'
import { RunId, SessionId, TicketId } from '@fabrica/contracts'

import { OwnCheck } from '../src/control'
import type { Worktree } from '../src/git'
import { WorkerAnswer } from '../src/merge/handbacks'
import { ProxyEvent, Refusal } from '../src/proxy'
import { answerOf } from '../src/run/handback-worker'
import {
  type Attempt,
  HandBackEnd,
  type SupervisorHolds,
  makeSupervision,
} from '../src/run/supervisor'
import { WorkerEnd, WorkerTurn } from '../src/run/worker'

// A hand-back's worker under the run's supervision (spec §12.8, §13.7): watched as the run's other
// workers are, but its turn ends on the usage limit once the run holds for it, for the merge queue to
// take its work where git shows it done; and its end told to the queue as the worker's answer.

const ticket = TicketId.make('fab-1')
const session = SessionId.make('worker-1')
const run = RunId.make('run-1')
const worktree: Worktree = {
  ticket,
  path: '/work/fab-1',
  branch: 'fabrica/fab-1',
}
const handBack = WorkerTurn.HandBack({
  worktree,
  session: Option.some('/sessions/fab-1/s-1.jsonl'),
  prompt: 'Fix the merge check.',
})
const resetAt = DateTime.makeUnsafe('2026-10-30T18:00:00Z')

/**
 * A supervision whose holds raise the run's hold on a usage limit (unless `raises` is false) and wait
 * for the test to lift it; each attempt runs `step`.
 */
const supervised = (
  step: (
    attempt: Attempt,
    refuse: Effect.Effect<void>,
  ) => Effect.Effect<WorkerEnd>,
  raises = true,
) =>
  Effect.gen(function* () {
    const bus = yield* PubSub.unbounded<ProxyEvent>()
    const subscription = yield* PubSub.subscribe(bus)
    const held = yield* SubscriptionRef.make(false)
    const told = yield* Queue.unbounded<string>()
    const lift = yield* Deferred.make<void>()
    const holds: SupervisorHolds = {
      usageLimited: ({ provider }) =>
        Effect.gen(function* () {
          yield* Queue.offer(told, `usage ${provider}`)
          if (!raises) return
          yield* SubscriptionRef.set(held, true)
          yield* Deferred.await(lift)
          yield* SubscriptionRef.set(held, false)
        }),
      credentialRefused: () => Effect.void,
      startFailed: () => Effect.void,
    }
    const supervision = yield* makeSupervision({
      proxy: Stream.fromSubscription(subscription),
      holds,
      clock: {
        sleep: duration => Effect.sleep(duration),
        held: SubscriptionRef.changes(held),
      },
      ticketLimit: Option.none(),
      fallbacks: [],
    })
    const refuse = Effect.andThen(
      PubSub.publish(
        bus,
        ProxyEvent.Refused({
          provider: 'anthropic',
          caller: {
            run,
            ticket: Option.some(ticket),
            session: Option.some(session),
            model: 'anthropic/claude-opus',
          },
          refusal: Refusal.UsageLimited({ resetAt }),
        }),
      ),
      // The supervision's feed takes it before the step goes on.
      Effect.repeat(Effect.yieldNow, { times: 9 }),
    )
    const tried: Array<Attempt> = []
    const given = supervision.handBack({
      ticket,
      session,
      turn: handBack,
      model: Option.none(),
      run: attempt =>
        Effect.suspend(() => {
          tried.push(attempt)
          return step(attempt, refuse)
        }),
    })
    return { given, tried, told, lift, held }
  })

/** A turn that ends on its provider's usage limit. */
const limited = (attempt: Attempt, refuse: Effect.Effect<void>) =>
  Effect.gen(function* () {
    yield* attempt.watcher.prepared(worktree)
    yield* attempt.watcher.started(Option.some('/sessions/fab-1/s-1.jsonl'))
    yield* refuse
    return WorkerEnd.Unfinished()
  })

describe("a hand-back's supervision", () => {
  it.effect('ends a turn refused at the usage limit once the run holds', () =>
    Effect.gen(function* () {
      const { given, tried, told, lift, held } = yield* supervised(limited)
      const end = yield* given
      expect(end).toEqual(HandBackEnd.AtLimit())
      expect(yield* Queue.take(told)).toBe('usage anthropic')
      expect(yield* SubscriptionRef.get(held)).toBe(true)
      // Its session isn't resumed: the merge queue gives it the hand-back again once the hold lifts.
      expect(tried.map(attempt => attempt.turn)).toEqual([handBack])
      // The hold's wait goes on in the supervision's scope, to its lift.
      yield* Deferred.succeed(lift, undefined)
      yield* SubscriptionRef.changes(held).pipe(
        Stream.filter(holding => !holding),
        Stream.runHead,
      )
    }).pipe(Effect.scoped),
  )

  it.effect('ends at the limit where its hold has lifted already', () =>
    Effect.gen(function* () {
      const { given, told } = yield* supervised(limited, false)
      expect(yield* given).toEqual(HandBackEnd.AtLimit())
      expect(yield* Queue.take(told)).toBe('usage anthropic')
    }).pipe(Effect.scoped),
  )

  it.effect("takes the worker's outcome as it comes", () =>
    Effect.gen(function* () {
      const deferred = WorkerEnd.Deferred({ reason: 'needs a decision' })
      const { given, tried } = yield* supervised(() => Effect.succeed(deferred))
      const watching = yield* Effect.forkChild(given)
      expect(yield* Fiber.join(watching)).toEqual(
        HandBackEnd.Ended({ end: deferred }),
      )
      expect(tried).toHaveLength(1)
    }).pipe(Effect.scoped),
  )
})

describe("a hand-back's answer", () => {
  it('settles a finish, and the outcomes git alone can judge', () => {
    for (const end of [
      WorkerEnd.Finished({
        worktree,
        checkOwn: OwnCheck.Unchecked(),
        session: Option.none(),
      }),
      WorkerEnd.Unfinished(),
      WorkerEnd.WaitsFor({ ticket: TicketId.make('fab-2'), needs: 'its API' }),
      WorkerEnd.Asked({ question: TicketId.make('fab-3') }),
    ])
      expect(answerOf(HandBackEnd.Ended({ end }))).toEqual(
        WorkerAnswer.Settled(),
      )
  })

  it('defers a defer, and holds at the limit', () => {
    expect(
      answerOf(
        HandBackEnd.Ended({
          end: WorkerEnd.Deferred({ reason: 'needs a decision' }),
        }),
      ),
    ).toEqual(WorkerAnswer.Deferred({ reason: 'needs a decision' }))
    expect(answerOf(HandBackEnd.AtLimit())).toEqual(WorkerAnswer.AtLimit())
  })

  it("is unavailable where its session couldn't resume or was stopped", () => {
    expect(
      answerOf(
        HandBackEnd.Ended({
          end: WorkerEnd.NotStarted({ reason: 'Pi exited' }),
        }),
      ),
    ).toEqual(
      WorkerAnswer.Unavailable({
        reason: "its worker's session didn't resume: Pi exited",
      }),
    )
    expect(
      answerOf(
        HandBackEnd.Ended({
          end: WorkerEnd.SetAside({
            reason: 'AGENT_STUCK',
            note: 'it gave no events again',
          }),
        }),
      ),
    ).toEqual(
      WorkerAnswer.Unavailable({
        reason: 'its supervision stopped its worker: it gave no events again',
      }),
    )
  })
})
