import {
  DateTime,
  Effect,
  Fiber,
  Option,
  PubSub,
  Queue,
  Stream,
  SubscriptionRef,
} from 'effect'

import { describe, expect, it } from '@effect/vitest'
import {
  type ProviderName,
  RunId,
  SessionId,
  TicketId,
} from '@fabrica/contracts'

import type { ModelChoice, PiEvent } from '../src/agent'
import type { Worktree } from '../src/git'
import { heldProviders, makeHolds } from '../src/holds'
import { ProxyEvent, Refusal } from '../src/proxy'
import {
  type Attempt,
  HandBackEnd,
  type SupervisorHolds,
  makeSupervision,
} from '../src/run/supervisor'
import { WorkerEnd, WorkerTurn } from '../src/run/worker'
import { makeRunLog } from '../src/runlog'

// A hold raised on another caller's refusal keeps a worker's model call at the proxy's permit, with no
// response head: Pi's idle timeout ends the call, its retries run out, and its turn settles on the error
// with no refusal of its session's (spec §12.9, §14.2, §14.6). Its supervision waits for the lift and
// carries on, where a worker that settled twice with no outcome, or a call that failed with no hold, is
// the failure it was. The real Pi's side of this is held in `pi-extension`'s contract suite.

const ticket = TicketId.make('fab-1')
const session = SessionId.make('worker-1')
const run = RunId.make('run-1')
const worktree: Worktree = {
  ticket,
  path: '/work/fab-1',
  branch: 'fabrica/fab-1',
}
const sessionFile = '/sessions/fab-1/s-1.jsonl'
const opus: ModelChoice = { provider: 'anthropic', modelId: 'claude-opus' }
const done = WorkerEnd.Deferred({ reason: 'done' })
const nothingHeld: ReadonlySet<ProviderName> = new Set()
const anthropicHeld: ReadonlySet<ProviderName> = new Set(['anthropic'])

/** A model's message ending as `stopReason` says, as Pi tells it. */
const replied = (stopReason: string): PiEvent => ({
  type: 'message_end',
  message: { role: 'assistant', provider: 'anthropic', stopReason },
})

/** What an attempt does, the kit it has to do it with. */
type Step = (attempt: Attempt, kit: Kit) => Effect.Effect<WorkerEnd>

interface Kit {
  /** Sets the providers the run's holds hold, and lets the supervision take it. */
  readonly hold: (held: ReadonlySet<ProviderName>) => Effect.Effect<void>
  readonly refuse: (refusal: Refusal) => Effect.Effect<void>
  /** Its worker starts in its worktree, on its session file. */
  readonly starts: (attempt: Attempt) => Effect.Effect<void>
  /** A turn of its worker's that ends on `stopReason`, the session's turn over with no outcome. */
  readonly settles: (
    attempt: Attempt,
    stopReason: string,
  ) => Effect.Effect<WorkerEnd>
  /** Stops every ticket's supervision. */
  readonly stop: Effect.Effect<void>
}

/** A line stream that keeps nothing. */
const nowhere = (path: string) => ({ path, append: () => Effect.void })

const yields = Effect.repeat(Effect.yieldNow, { times: 9 })

/** A supervision whose attempts are scripted, one step an attempt, over providers the test holds. */
const supervised = (steps: ReadonlyArray<Step>) =>
  Effect.gen(function* () {
    const bus = yield* PubSub.unbounded<ProxyEvent>()
    const subscription = yield* PubSub.subscribe(bus)
    const held = yield* SubscriptionRef.make(nothingHeld)
    const told = yield* Queue.unbounded<string>()
    const holds: SupervisorHolds = {
      usageLimited: ({ provider }) =>
        Effect.asVoid(Queue.offer(told, `usage ${provider}`)),
      credentialRefused: ({ provider }) =>
        Effect.asVoid(Queue.offer(told, `credential ${provider}`)),
      startFailed: () => Effect.void,
    }
    const supervision = yield* makeSupervision({
      proxy: Stream.fromSubscription(subscription),
      holds,
      clock: {
        sleep: duration => Effect.sleep(duration),
        held: Stream.concat(Stream.make(false), Stream.never),
      },
      heldProviders: SubscriptionRef.changes(held),
      ticketLimit: Option.none(),
      fallbacks: [],
    })
    const kit: Kit = {
      hold: providers =>
        Effect.andThen(SubscriptionRef.set(held, providers), yields),
      refuse: refusal =>
        Effect.andThen(
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
              refusal,
            }),
          ),
          yields,
        ),
      starts: attempt =>
        Effect.andThen(
          attempt.watcher.prepared(worktree),
          attempt.watcher.started(Option.some(sessionFile)),
        ),
      settles: (attempt, stopReason) =>
        Effect.gen(function* () {
          yield* attempt.watcher.heard(replied(stopReason))
          return WorkerEnd.Unfinished()
        }),
      stop: supervision.stop,
    }
    const tried: Array<Attempt> = []
    const input = (model: Option.Option<ModelChoice>) => ({
      ticket,
      session,
      turn: WorkerTurn.First(),
      model,
      run: (attempt: Attempt) =>
        Effect.suspend(() => {
          const step = steps[tried.length]
          tried.push(attempt)
          return step === undefined ? Effect.succeed(done) : step(attempt, kit)
        }),
    })
    return {
      kit,
      tried,
      told,
      watch: (model: Option.Option<ModelChoice> = Option.some(opus)) =>
        supervision.watch(input(model)),
      handBack: supervision.handBack(input(Option.some(opus))),
    }
  })

/** The prompt an attempt resumed its session with. */
const promptOf = (attempt: Attempt | undefined) =>
  attempt !== undefined && WorkerTurn.$is('HandBack')(attempt.turn)
    ? attempt.turn.prompt
    : ''

/** A turn its provider's hold outlasts: the hold on as its call fails, and on still as it ends. */
const outlasted: Step = (attempt, kit) =>
  Effect.gen(function* () {
    yield* kit.starts(attempt)
    yield* kit.hold(anthropicHeld)
    return yield* kit.settles(attempt, 'error')
  })

describe('a turn a hold outlasts', () => {
  it.effect('waits for the lift, then resumes its session', () =>
    Effect.gen(function* () {
      const { kit, watch, tried, told } = yield* supervised([
        outlasted,
        () => Effect.succeed(done),
      ])
      const watching = yield* Effect.forkChild(watch())
      yield* yields
      expect(tried).toHaveLength(1)
      // It waits on the hold another caller's refusal raised: no hold is raised for it.
      expect(yield* Queue.size(told)).toBe(0)

      yield* kit.hold(nothingHeld)
      expect(yield* Fiber.join(watching)).toEqual(done)
      expect(tried).toHaveLength(2)
      expect(tried[1]?.turn).toEqual(
        WorkerTurn.HandBack({
          worktree,
          session: Option.some(sessionFile),
          prompt: promptOf(tried[1]),
        }),
      )
      expect(promptOf(tried[1])).toContain("anthropic's model call")
      expect(promptOf(tried[1])).toContain('the hold has lifted')
    }).pipe(Effect.scoped),
  )

  it.effect('carries on at once where the hold lifted during the turn', () =>
    Effect.gen(function* () {
      const { watch, tried } = yield* supervised([
        (attempt, kit) =>
          Effect.gen(function* () {
            yield* kit.starts(attempt)
            yield* kit.hold(anthropicHeld)
            yield* kit.hold(nothingHeld)
            return yield* kit.settles(attempt, 'error')
          }),
        () => Effect.succeed(done),
      ])
      expect(yield* watch()).toEqual(done)
      expect(tried).toHaveLength(2)
    }).pipe(Effect.scoped),
  )

  it.effect('counts a hold on before its turn began', () =>
    Effect.gen(function* () {
      const { kit, watch, tried } = yield* supervised([
        (attempt, step) =>
          Effect.gen(function* () {
            yield* step.starts(attempt)
            yield* yields
            return yield* step.settles(attempt, 'error')
          }),
        () => Effect.succeed(done),
      ])
      yield* kit.hold(anthropicHeld)
      const watching = yield* Effect.forkChild(watch())
      yield* yields
      expect(tried).toHaveLength(1)
      yield* kit.hold(nothingHeld)
      expect(yield* Fiber.join(watching)).toEqual(done)
    }).pipe(Effect.scoped),
  )

  it.effect(
    'reads a call that failed since as its own, the next turn afresh',
    () =>
      Effect.gen(function* () {
        const { kit, watch, tried } = yield* supervised([
          outlasted,
          (attempt, step) => step.settles(attempt, 'error'),
        ])
        const watching = yield* Effect.forkChild(watch())
        yield* yields
        yield* kit.hold(nothingHeld)
        expect(yield* Fiber.join(watching)).toEqual(WorkerEnd.Unfinished())
        expect(tried).toHaveLength(2)
      }).pipe(Effect.scoped),
  )

  it.effect('waits on any held provider for Pi’s own model, not known', () =>
    Effect.gen(function* () {
      const { kit, watch, tried } = yield* supervised([
        outlasted,
        () => Effect.succeed(done),
      ])
      const watching = yield* Effect.forkChild(watch(Option.none()))
      yield* yields
      expect(tried).toHaveLength(1)
      yield* kit.hold(nothingHeld)
      expect(yield* Fiber.join(watching)).toEqual(done)
    }).pipe(Effect.scoped),
  )

  it.effect('goes by the refusal where its session has one of its own', () =>
    Effect.gen(function* () {
      const resetAt = DateTime.makeUnsafe(0)
      const { watch, told, tried } = yield* supervised([
        (attempt, kit) =>
          Effect.gen(function* () {
            yield* kit.starts(attempt)
            yield* kit.hold(anthropicHeld)
            yield* kit.refuse(Refusal.UsageLimited({ resetAt }))
            return yield* kit.settles(attempt, 'error')
          }),
        () => Effect.succeed(done),
      ])
      expect(yield* watch()).toEqual(done)
      expect(yield* Queue.take(told)).toBe('usage anthropic')
      expect(promptOf(tried[1])).toContain("anthropic's usage limit")
    }).pipe(Effect.scoped),
  )

  it.effect(
    'ends a hand-back’s turn there, for the merge queue to take its work',
    () =>
      Effect.gen(function* () {
        const { handBack, tried, told } = yield* supervised([outlasted])
        expect(yield* handBack).toEqual(HandBackEnd.AtLimit())
        expect(tried).toHaveLength(1)
        expect(yield* Queue.size(told)).toBe(0)
      }).pipe(Effect.scoped),
  )

  it.effect('ends as it came once supervision has stopped', () =>
    Effect.gen(function* () {
      const { watch, tried } = yield* supervised([
        (attempt, kit) =>
          Effect.gen(function* () {
            yield* kit.starts(attempt)
            yield* kit.hold(anthropicHeld)
            yield* kit.stop
            return yield* kit.settles(attempt, 'error')
          }),
      ])
      expect(yield* watch()).toEqual(WorkerEnd.Unfinished())
      expect(tried).toHaveLength(1)
    }).pipe(Effect.scoped),
  )
})

describe('a turn that ends with no outcome, no hold outlasting it', () => {
  it.effect(
    'stays unfinished where the worker settled twice, its calls answered',
    () =>
      Effect.gen(function* () {
        const { watch, tried } = yield* supervised([
          (attempt, kit) =>
            Effect.gen(function* () {
              yield* kit.starts(attempt)
              yield* kit.hold(anthropicHeld)
              return yield* kit.settles(attempt, 'stop')
            }),
        ])
        expect(yield* watch()).toEqual(WorkerEnd.Unfinished())
        expect(tried).toHaveLength(1)
      }).pipe(Effect.scoped),
  )

  it.effect('stays unfinished where its turn was aborted', () =>
    Effect.gen(function* () {
      const { watch, tried } = yield* supervised([
        (attempt, kit) =>
          Effect.gen(function* () {
            yield* kit.starts(attempt)
            yield* kit.hold(anthropicHeld)
            return yield* kit.settles(attempt, 'aborted')
          }),
      ])
      expect(yield* watch()).toEqual(WorkerEnd.Unfinished())
      expect(tried).toHaveLength(1)
    }).pipe(Effect.scoped),
  )

  it.effect('stays unfinished where a call failed with nothing held', () =>
    Effect.gen(function* () {
      const { watch, tried } = yield* supervised([
        (attempt, kit) =>
          Effect.gen(function* () {
            yield* kit.starts(attempt)
            return yield* kit.settles(attempt, 'error')
          }),
      ])
      expect(yield* watch()).toEqual(WorkerEnd.Unfinished())
      expect(tried).toHaveLength(1)
    }).pipe(Effect.scoped),
  )

  it.effect('stays unfinished where another provider is the one held', () =>
    Effect.gen(function* () {
      const { watch, tried } = yield* supervised([
        (attempt, kit) =>
          Effect.gen(function* () {
            yield* kit.starts(attempt)
            yield* kit.hold(new Set(['openai']))
            return yield* kit.settles(attempt, 'error')
          }),
      ])
      expect(yield* watch()).toEqual(WorkerEnd.Unfinished())
      expect(tried).toHaveLength(1)
    }).pipe(Effect.scoped),
  )

  it.effect('reads its last call, a failed one retried and answered', () =>
    Effect.gen(function* () {
      const { watch, tried } = yield* supervised([
        (attempt, kit) =>
          Effect.gen(function* () {
            yield* kit.starts(attempt)
            yield* kit.hold(anthropicHeld)
            yield* attempt.watcher.heard(replied('error'))
            return yield* kit.settles(attempt, 'stop')
          }),
      ])
      expect(yield* watch()).toEqual(WorkerEnd.Unfinished())
      expect(tried).toHaveLength(1)
    }).pipe(Effect.scoped),
  )
})

describe("the run's holds as a turn's supervision reads them", () => {
  it.effect('waits on the provider a raised hold names, to its lift', () =>
    Effect.gen(function* () {
      const log = yield* makeRunLog({
        run,
        events: nowhere('events.jsonl'),
        log: nowhere('run.log'),
      })
      const holds = yield* makeHolds({ log, running: Effect.succeed(1) })
      const tried: Array<Attempt> = []
      const supervision = yield* makeSupervision({
        proxy: Stream.never,
        holds: {
          usageLimited: () => Effect.void,
          credentialRefused: () => Effect.void,
          startFailed: () => Effect.void,
        },
        clock: {
          sleep: duration => Effect.sleep(duration),
          held: Stream.concat(Stream.make(false), Stream.never),
        },
        heldProviders: holds.changes.pipe(Stream.map(heldProviders)),
        ticketLimit: Option.none(),
        fallbacks: [],
      })
      const key = { hold: 'CREDENTIALS', provider: 'anthropic' } as const
      const watching = yield* Effect.forkChild(
        supervision.watch({
          ticket,
          session,
          turn: WorkerTurn.First(),
          model: Option.some(opus),
          run: attempt =>
            Effect.gen(function* () {
              tried.push(attempt)
              if (tried.length > 1) return done
              yield* attempt.watcher.prepared(worktree)
              yield* attempt.watcher.started(Option.some(sessionFile))
              yield* holds.raise({ ...key, why: "another's refusal" })
              yield* yields
              yield* attempt.watcher.heard(replied('error'))
              return WorkerEnd.Unfinished()
            }),
        }),
      )
      yield* yields
      yield* yields
      expect(tried).toHaveLength(1)
      yield* holds.lift({ ...key, why: 'the probe went through' })
      expect(yield* Fiber.join(watching)).toEqual(done)
      expect(tried).toHaveLength(2)
    }).pipe(Effect.scoped, Effect.provide(DateTime.layerCurrentZoneOffset(0))),
  )
})
