import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  PubSub,
  Queue,
  Schedule,
  Stream,
  SubscriptionRef,
} from 'effect'
import { TestClock } from 'effect/testing'

import { describe, expect, it } from '@effect/vitest'
import { RunId, SessionId, TicketId } from '@fabrica/contracts'

import type { ModelChoice, PiEvent } from '../src/agent'
import type { Worktree } from '../src/git'
import type { HandBackClockShape } from '../src/merge/handbacks'
import { ProxyEvent, Refusal } from '../src/proxy'
import {
  type Attempt,
  type SupervisorHolds,
  fallbacksAfter,
  makeSupervision,
  toolFollowUp,
  waitingHolds,
} from '../src/run/supervisor'
import { WorkerEnd, WorkerTurn } from '../src/run/worker'

// Each worker's supervision (spec §12.8, §14.5): the policies of §12.8's table applied to scripted
// attempts on TestClock, the model proxy's events published as the proxy would.

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
const gpt: ModelChoice = { provider: 'openai', modelId: 'gpt' }
const gemini: ModelChoice = { provider: 'google', modelId: 'gemini' }
const done = WorkerEnd.Deferred({ reason: 'done' })

/** The run never holds, unless the test says so. */
const neverHolds: HandBackClockShape = {
  sleep: duration => Effect.sleep(duration),
  held: Stream.concat(Stream.make(false), Stream.never),
}

/** What the holds were told, the waits completing when the test lifts them. */
const recordingHolds = Effect.gen(function* () {
  const told = yield* Queue.unbounded<string>()
  const lift = yield* Deferred.make<void>()
  const holds: SupervisorHolds = {
    usageLimited: ({ provider, resetAt }) =>
      Effect.andThen(
        Queue.offer(told, `usage ${provider} ${DateTime.formatIso(resetAt)}`),
        Deferred.await(lift),
      ),
    credentialRefused: ({ provider, reason }) =>
      Effect.andThen(
        Queue.offer(told, `credential ${provider}: ${reason}`),
        Deferred.await(lift),
      ),
    startFailed: ({ reason }) =>
      Effect.asVoid(Queue.offer(told, `start failed: ${reason}`)),
  }
  return { holds, told, lift }
})

/** What a scripted attempt does with its worker and the proxy. */
interface Kit {
  /** The worker starts: its worktree ready, its agent started on its session file; then `reached`. */
  readonly starts: (attempt: Attempt, n: number) => Effect.Effect<void>
  /** What the proxy saw of the worker's session. */
  readonly proxy: (event: 'used' | Refusal) => Effect.Effect<void>
  /** Each attempt says its number here where the test waits on it. */
  readonly reached: Queue.Queue<number>
}

/** One attempt's script: the `n`th, from 0. */
type Step = (attempt: Attempt, n: number, kit: Kit) => Effect.Effect<WorkerEnd>

/** A supervision on a proxy the test publishes to; its attempts scripted, one step an attempt. */
const supervised = (options: {
  readonly steps: ReadonlyArray<Step>
  readonly holds?: SupervisorHolds
  readonly clock?: HandBackClockShape
  readonly ticketLimit?: Duration.Duration
  readonly fallbacks?: ReadonlyArray<ModelChoice>
  readonly backoff?: Schedule.Schedule<Duration.Duration>
}) =>
  Effect.gen(function* () {
    const bus = yield* PubSub.unbounded<ProxyEvent>()
    // Each wait the supervision starts, in milliseconds, before it waits.
    const slept = yield* Queue.unbounded<number>()
    const base = options.clock ?? neverHolds
    const clock: HandBackClockShape = {
      sleep: duration =>
        Effect.andThen(
          Queue.offer(slept, Duration.toMillis(duration)),
          base.sleep(duration),
        ),
      held: base.held,
    }
    /** Waits for the supervision to start a wait of `millis`. */
    const waits = (millis: number): Effect.Effect<void> =>
      Effect.flatMap(Queue.take(slept), took =>
        took === millis ? Effect.void : waits(millis),
      )
    const subscription = yield* PubSub.subscribe(bus)
    const recorded = yield* recordingHolds
    const supervision = yield* makeSupervision({
      proxy: Stream.fromSubscription(subscription),
      holds: options.holds ?? recorded.holds,
      clock,
      ticketLimit: Option.fromUndefinedOr(options.ticketLimit),
      fallbacks: options.fallbacks ?? [],
      ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
    })
    const tried: Array<Attempt> = []
    const reached = yield* Queue.unbounded<number>()
    const interrupted = yield* Queue.unbounded<number>()
    const watch = (turn: WorkerTurn = WorkerTurn.First(), model = opus) =>
      supervision.watch({
        ticket,
        session,
        turn,
        model: Option.some(model),
        run: attempt =>
          Effect.suspend(() => {
            const n = tried.length
            tried.push(attempt)
            const step =
              options.steps[Math.min(n, options.steps.length - 1)] ??
              (() => Effect.succeed(done))
            return step(attempt, n, { starts, proxy, reached }).pipe(
              Effect.onInterrupt(() => Queue.offer(interrupted, n)),
            )
          }),
      })
    const proxy = (event: 'used' | Refusal): Effect.Effect<void> =>
      Effect.andThen(
        PubSub.publish(
          bus,
          event === 'used'
            ? ProxyEvent.Used({
                provider: 'anthropic',
                caller: {
                  run,
                  ticket: Option.some(ticket),
                  session: Option.some(session),
                  model: 'anthropic/claude-opus',
                },
                tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
                latency: Duration.seconds(1),
                firstToken: Option.none(),
              })
            : ProxyEvent.Refused({
                provider: 'anthropic',
                caller: {
                  run,
                  ticket: Option.some(ticket),
                  session: Option.some(session),
                  model: 'anthropic/claude-opus',
                },
                refusal: event,
              }),
        ),
        // The supervision's feed takes it before the step goes on.
        Effect.repeat(Effect.yieldNow, { times: 9 }),
      )
    const starts = (attempt: Attempt, n: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* attempt.watcher.prepared(worktree)
        yield* attempt.watcher.started(Option.some(sessionFile))
        yield* Queue.offer(reached, n)
      })
    return {
      supervision,
      watch,
      tried,
      reached,
      interrupted,
      waits,
      told: recorded.told,
      lift: recorded.lift,
    }
  })

/** The prompt an attempt resumed its session with. */
const promptOf = (attempt: Attempt | undefined) =>
  attempt !== undefined && WorkerTurn.$is('HandBack')(attempt.turn)
    ? attempt.turn.prompt
    : ''

const event = (record: PiEvent) => record

describe("a worker's supervision", () => {
  it.effect('takes an outcome as it comes', () =>
    Effect.gen(function* () {
      const { watch, tried } = yield* supervised({
        steps: [() => Effect.succeed(done)],
      })
      expect(yield* watch()).toEqual(done)
      expect(tried.length).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.effect(
    'backs off a rate limit exponentially and resumes the session',
    () =>
      Effect.gen(function* () {
        const { watch, tried, reached, waits } = yield* supervised({
          steps: [
            (attempt, n, kit) =>
              Effect.gen(function* () {
                yield* kit.starts(attempt, n)
                yield* kit.proxy(
                  Refusal.RateLimited({ retryAfter: Option.none() }),
                )
                return WorkerEnd.Unfinished()
              }),
            (attempt, n, kit) =>
              Effect.gen(function* () {
                yield* Queue.offer(kit.reached, n)
                yield* kit.proxy(
                  Refusal.RateLimited({ retryAfter: Option.none() }),
                )
                return WorkerEnd.Unfinished()
              }),
            () => Effect.succeed(done),
          ],
        })
        const watching = yield* Effect.forkChild(watch())
        expect(yield* Queue.take(reached)).toBe(0)
        yield* waits(30_000)
        yield* TestClock.adjust('29 seconds')
        expect(tried.length).toBe(1)
        yield* TestClock.adjust('1 second')
        expect(yield* Queue.take(reached)).toBe(1)
        const resumed = tried[1]?.turn
        expect(resumed).toEqual(
          WorkerTurn.HandBack({
            worktree,
            session: Option.some(sessionFile),
            prompt: promptOf(tried[1]),
          }),
        )
        expect(promptOf(tried[1])).toContain("anthropic's rate limit")
        // The second wait is twice the first.
        yield* waits(60_000)
        yield* TestClock.adjust('59 seconds')
        expect(tried.length).toBe(2)
        yield* TestClock.adjust('1 second')
        expect(yield* Fiber.join(watching)).toEqual(done)
        expect(tried.length).toBe(3)
        expect(tried[2]?.model).toEqual(Option.some(opus))
      }).pipe(Effect.scoped),
  )

  it.effect("waits as long as the provider's retry-after asks", () =>
    Effect.gen(function* () {
      const { watch, tried, waits } = yield* supervised({
        steps: [
          (attempt, n, kit) =>
            Effect.gen(function* () {
              yield* kit.starts(attempt, n)
              yield* kit.proxy(
                Refusal.RateLimited({
                  retryAfter: Option.some(Duration.minutes(5)),
                }),
              )
              return WorkerEnd.Unfinished()
            }),
          () => Effect.succeed(done),
        ],
      })
      const watching = yield* Effect.forkChild(watch())
      yield* waits(300_000)
      yield* TestClock.adjust('4 minutes')
      expect(tried.length).toBe(1)
      yield* TestClock.adjust('1 minute')
      expect(yield* Fiber.join(watching)).toEqual(done)
    }).pipe(Effect.scoped),
  )

  it.effect('sets the ticket aside once its backoff runs out', () =>
    Effect.gen(function* () {
      const { watch, waits } = yield* supervised({
        backoff: Schedule.exponential('1 second').pipe(
          Schedule.upTo({ times: 2 }),
        ),
        steps: [
          (attempt, n, kit) =>
            Effect.gen(function* () {
              yield* kit.starts(attempt, n)
              yield* kit.proxy(
                Refusal.RateLimited({ retryAfter: Option.none() }),
              )
              return WorkerEnd.Unfinished()
            }),
        ],
      })
      const watching = yield* Effect.forkChild(watch())
      yield* waits(1000)
      yield* TestClock.adjust('1 second')
      yield* waits(2000)
      yield* TestClock.adjust('2 seconds')
      const end = yield* Fiber.join(watching)
      expect(end).toMatchObject({ _tag: 'SetAside', reason: 'UNFINISHED' })
      expect(WorkerEnd.$is('SetAside')(end) && end.note).toContain(
        "anthropic's rate limit, past its backoff",
      )
    }).pipe(Effect.scoped),
  )

  it.effect(
    'takes a turn that settled twice with no outcome as unfinished',
    () =>
      Effect.gen(function* () {
        const { watch, tried } = yield* supervised({
          steps: [
            (attempt, n, kit) =>
              Effect.gen(function* () {
                yield* kit.starts(attempt, n)
                // A refusal a later call went past doesn't explain the turn's end.
                yield* kit.proxy(
                  Refusal.RateLimited({ retryAfter: Option.none() }),
                )
                yield* kit.proxy('used')
                return WorkerEnd.Unfinished()
              }),
          ],
        })
        expect(yield* watch()).toEqual(WorkerEnd.Unfinished())
        expect(tried.length).toBe(1)
      }).pipe(Effect.scoped),
  )

  it.effect('routes a usage limit to its hold and resumes once it lifts', () =>
    Effect.gen(function* () {
      const resetAt = DateTime.makeUnsafe('2026-10-30T18:00:00Z')
      const { watch, tried, told, lift } = yield* supervised({
        steps: [
          (attempt, n, kit) =>
            Effect.gen(function* () {
              yield* kit.starts(attempt, n)
              yield* kit.proxy(Refusal.UsageLimited({ resetAt }))
              return WorkerEnd.Unfinished()
            }),
          () => Effect.succeed(done),
        ],
      })
      const watching = yield* Effect.forkChild(watch())
      expect(yield* Queue.take(told)).toBe(
        'usage anthropic 2026-10-30T18:00:00.000Z',
      )
      yield* TestClock.adjust('6 hours')
      expect(tried.length).toBe(1)
      yield* Deferred.succeed(lift, undefined)
      expect(yield* Fiber.join(watching)).toEqual(done)
      expect(promptOf(tried[1])).toContain(
        "anthropic's usage limit, which has lifted",
      )
    }).pipe(Effect.scoped),
  )

  it.effect(
    'routes a refused credential to its hold, setting nothing aside',
    () =>
      Effect.gen(function* () {
        const { watch, tried, told, lift } = yield* supervised({
          steps: [
            (attempt, n, kit) =>
              Effect.gen(function* () {
                yield* kit.starts(attempt, n)
                yield* kit.proxy(
                  Refusal.CredentialRefused({ reason: 'HTTP 401' }),
                )
                return WorkerEnd.Unfinished()
              }),
            () => Effect.succeed(done),
          ],
        })
        const watching = yield* Effect.forkChild(watch())
        expect(yield* Queue.take(told)).toBe('credential anthropic: HTTP 401')
        yield* Deferred.succeed(lift, undefined)
        expect(yield* Fiber.join(watching)).toEqual(done)
        expect(tried[1]?.turn._tag).toBe('HandBack')
      }).pipe(Effect.scoped),
  )

  it.effect(
    'restarts a stuck worker once with a summary, then sets it aside',
    () =>
      Effect.gen(function* () {
        const { watch, tried, reached, interrupted } = yield* supervised({
          steps: [
            (attempt, n, kit) =>
              Effect.gen(function* () {
                yield* kit.starts(attempt, n)
                yield* attempt.watcher.heard(
                  event({
                    type: 'tool_execution_start',
                    toolCallId: 'call-1',
                    toolName: 'bash',
                    args: { command: 'npm test' },
                  }),
                )
                return yield* Effect.never
              }),
            (attempt, n, kit) =>
              Effect.andThen(
                Effect.andThen(
                  attempt.watcher.started(Option.some(sessionFile)),
                  Queue.offer(kit.reached, n),
                ),
                Effect.never,
              ),
          ],
        })
        const watching = yield* Effect.forkChild(watch())
        yield* Queue.take(reached)
        yield* TestClock.adjust('9 minutes')
        expect(tried.length).toBe(1)
        yield* TestClock.adjust('1 minute')
        expect(yield* Queue.take(interrupted)).toBe(0)
        expect(yield* Queue.take(reached)).toBe(1)
        expect(tried[1]?.turn).toMatchObject({
          _tag: 'HandBack',
          worktree,
          session: Option.some(sessionFile),
        })
        expect(promptOf(tried[1])).toContain(
          'it gave no events for 10m, running its bash tool: npm test',
        )
        yield* TestClock.adjust('10 minutes')
        expect(yield* Queue.take(interrupted)).toBe(1)
        const end = yield* Fiber.join(watching)
        expect(end).toMatchObject({ _tag: 'SetAside', reason: 'AGENT_STUCK' })
        expect(tried.length).toBe(2)
      }).pipe(Effect.scoped),
  )

  it.effect("doesn't count a long tool's quiet, nor a worker heard from", () =>
    Effect.gen(function* () {
      const toolEnded = yield* Deferred.make<void>()
      const { watch, tried, reached, interrupted } = yield* supervised({
        steps: [
          (attempt, n, kit) =>
            Effect.gen(function* () {
              yield* kit.starts(attempt, n)
              yield* attempt.watcher.heard(
                event({
                  type: 'tool_execution_start',
                  toolCallId: 'call-1',
                  toolName: 'check_own',
                }),
              )
              yield* Deferred.await(toolEnded)
              yield* attempt.watcher.heard(
                event({
                  type: 'tool_execution_end',
                  toolCallId: 'call-1',
                  toolName: 'check_own',
                  isError: false,
                }),
              )
              // Heard every 5 minutes for half an hour.
              for (let beat = 0; beat < 6; beat++) {
                yield* Effect.sleep('5 minutes')
                yield* attempt.watcher.heard(event({ type: 'turn_start' }))
              }
              yield* Queue.offer(kit.reached, n)
              return yield* Effect.never
            }),
        ],
      })
      const watching = yield* Effect.forkChild(watch())
      yield* Queue.take(reached)
      yield* TestClock.adjust('30 minutes')
      yield* Deferred.succeed(toolEnded, undefined)
      yield* TestClock.adjust('30 minutes')
      yield* Queue.take(reached)
      expect(yield* Queue.size(interrupted)).toBe(0)
      yield* TestClock.adjust('10 minutes')
      expect(yield* Queue.take(interrupted)).toBe(0)
      expect(tried.length).toBe(2)
      yield* Fiber.interrupt(watching)
    }).pipe(Effect.scoped),
  )

  it.effect("doesn't count a worker's quiet while the run holds", () =>
    Effect.gen(function* () {
      const held = yield* SubscriptionRef.make(false)
      const { watch, reached, interrupted } = yield* supervised({
        clock: { ...neverHolds, held: SubscriptionRef.changes(held) },
        steps: [
          (attempt, n, kit) =>
            Effect.andThen(kit.starts(attempt, n), Effect.never),
        ],
      })
      const watching = yield* Effect.forkChild(watch())
      yield* Queue.take(reached)
      yield* TestClock.adjust('5 minutes')
      yield* SubscriptionRef.set(held, true)
      yield* TestClock.adjust('1 hour')
      expect(yield* Queue.size(interrupted)).toBe(0)
      yield* SubscriptionRef.set(held, false)
      yield* TestClock.adjust('9 minutes')
      expect(yield* Queue.size(interrupted)).toBe(0)
      yield* TestClock.adjust('1 minute')
      expect(yield* Queue.take(interrupted)).toBe(0)
      yield* Fiber.interrupt(watching)
    }).pipe(Effect.scoped),
  )

  it.effect("passes a tool's defect on, for the follow-up and set-aside", () =>
    Effect.gen(function* () {
      const failed = WorkerEnd.ToolFailed({
        tool: 'file_ticket',
        reason: 'the work graph is locked',
      })
      const { watch, tried } = yield* supervised({
        steps: [() => Effect.succeed(failed)],
      })
      expect(yield* watch()).toEqual(failed)
      expect(tried.length).toBe(1)
      const followUp = toolFollowUp({
        ticket,
        tool: 'file_ticket',
        reason: 'the work graph is locked',
      })
      expect(followUp.title).toBe('Tool file_ticket failed in the engine')
      expect(followUp.description).toContain('the work graph is locked')
      expect(
        toolFollowUp({ ticket, tool: 'x'.repeat(80), reason: 'r' }).title
          .length,
      ).toBe(60)
    }).pipe(Effect.scoped),
  )

  it.effect(
    'starts on the next fallback when a model fails to start, and keeps it for a hand-back',
    () =>
      Effect.gen(function* () {
        const { watch, tried, reached, interrupted, told } = yield* supervised({
          fallbacks: [opus, gpt, gemini],
          steps: [
            (attempt, n, kit) =>
              Effect.gen(function* () {
                yield* kit.starts(attempt, n)
                yield* kit.proxy(
                  Refusal.StartFailed({ reason: 'no credential' }),
                )
                return yield* Effect.never
              }),
            (attempt, n, kit) => Effect.as(kit.starts(attempt, n), done),
            (attempt, n, kit) =>
              Effect.gen(function* () {
                yield* kit.starts(attempt, n)
                yield* kit.proxy(
                  Refusal.StartFailed({ reason: 'no credential' }),
                )
                return yield* Effect.never
              }),
          ],
        })
        expect(yield* watch()).toEqual(done)
        expect(yield* Queue.take(interrupted)).toBe(0)
        yield* Queue.take(reached)
        yield* Queue.take(reached)
        expect(tried.map(({ model }) => model)).toEqual([
          Option.some(opus),
          Option.some(gpt),
        ])
        expect(tried[1]?.turn).toEqual(WorkerTurn.Again({ worktree }))
        // Its hand-back starts on the model that wrote it, and tries no other.
        const end = yield* watch(
          WorkerTurn.HandBack({
            worktree,
            session: Option.some(sessionFile),
            prompt: 'verifier round 1: FAIL',
          }),
        )
        yield* Queue.take(reached)
        expect(tried[2]?.model).toEqual(Option.some(gpt))
        expect(tried.length).toBe(3)
        expect(end).toEqual(
          WorkerEnd.Failed({ reason: 'anthropic: no credential' }),
        )
        expect(yield* Queue.take(told)).toBe(
          'start failed: anthropic: no credential',
        )
      }).pipe(Effect.scoped),
  )

  it.effect(
    'counts a start failure for the environment hold once no model is left',
    () =>
      Effect.gen(function* () {
        const { watch, tried, told } = yield* supervised({
          fallbacks: [gpt],
          steps: [
            (attempt, n, kit) =>
              Effect.gen(function* () {
                yield* kit.starts(attempt, n)
                yield* kit.proxy(Refusal.StartFailed({ reason: 'HTTP 401' }))
                return yield* Effect.never
              }),
          ],
        })
        expect(yield* watch()).toEqual(
          WorkerEnd.Failed({ reason: 'anthropic: HTTP 401' }),
        )
        expect(tried.length).toBe(2)
        expect(yield* Queue.take(told)).toBe(
          'start failed: anthropic: HTTP 401',
        )
      }).pipe(Effect.scoped),
  )

  it.effect("doesn't change models when Pi itself didn't start", () =>
    Effect.gen(function* () {
      const { watch, tried, told } = yield* supervised({
        fallbacks: [gpt],
        steps: [
          attempt =>
            Effect.andThen(
              attempt.watcher.prepared(worktree),
              Effect.succeed(WorkerEnd.NotStarted({ reason: 'spawn failed' })),
            ),
        ],
      })
      expect(yield* watch()).toEqual(
        WorkerEnd.Failed({ reason: 'spawn failed' }),
      )
      expect(tried.length).toBe(1)
      expect(yield* Queue.take(told)).toBe('start failed: spawn failed')
    }).pipe(Effect.scoped),
  )

  it.effect('interrupts a ticket over its budget and sets it aside', () =>
    Effect.gen(function* () {
      const { supervision, watch, reached, interrupted } = yield* supervised({
        steps: [
          (attempt, n, kit) =>
            Effect.andThen(kit.starts(attempt, n), Effect.never),
        ],
      })
      const watching = yield* Effect.forkChild(watch())
      yield* Queue.take(reached)
      yield* supervision.overBudget({ ticket, detail: '$5.00 of $5.00' })
      const end = yield* Fiber.join(watching)
      expect(yield* Queue.take(interrupted)).toBe(0)
      expect(end).toEqual(
        WorkerEnd.SetAside({
          reason: 'BUDGET_EXCEEDED',
          note: 'it went over its budget: $5.00 of $5.00',
        }),
      )
    }).pipe(Effect.scoped),
  )

  it.effect(
    'sets aside a ticket past ticket_limit, its time counted across its turns',
    () =>
      Effect.gen(function* () {
        const { watch, tried, reached, interrupted } = yield* supervised({
          ticketLimit: Duration.hours(1),
          steps: [
            (attempt, n, kit) =>
              Effect.gen(function* () {
                yield* kit.starts(attempt, n)
                // Heard from, so not stuck: it only takes long.
                for (let beat = 0; beat < 8; beat++) {
                  yield* Effect.sleep('5 minutes')
                  yield* attempt.watcher.heard(event({ type: 'turn_end' }))
                }
                return done
              }),
            (attempt, n, kit) =>
              Effect.gen(function* () {
                yield* kit.starts(attempt, n)
                while (true) {
                  yield* Effect.sleep('5 minutes')
                  yield* attempt.watcher.heard(event({ type: 'turn_end' }))
                }
              }),
          ],
        })
        const first = yield* Effect.forkChild(watch())
        yield* Queue.take(reached)
        yield* TestClock.adjust('40 minutes')
        expect(yield* Fiber.join(first)).toEqual(done)
        const handBack = yield* Effect.forkChild(
          watch(
            WorkerTurn.HandBack({
              worktree,
              session: Option.some(sessionFile),
              prompt: 'fix it',
            }),
          ),
        )
        yield* Queue.take(reached)
        yield* TestClock.adjust('19 minutes')
        expect(yield* Queue.size(interrupted)).toBe(0)
        yield* TestClock.adjust('1 minute')
        expect(yield* Queue.take(interrupted)).toBe(1)
        expect(yield* Fiber.join(handBack)).toEqual(
          WorkerEnd.SetAside({
            reason: 'TICKET_LIMIT',
            note: 'its worker ran past ticket_limit, 1h: interrupted; its worktree and session are kept for review',
          }),
        )
        // Past it, a later turn isn't started at all.
        expect(
          yield* watch(
            WorkerTurn.HandBack({
              worktree,
              session: Option.some(sessionFile),
              prompt: 'fix it',
            }),
          ),
        ).toMatchObject({ _tag: 'SetAside', reason: 'TICKET_LIMIT' })
        expect(tried.length).toBe(2)
      }).pipe(Effect.scoped),
  )

  it.effect("takes a worker's end as it comes once supervision stops", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const { supervision, watch, tried, reached, interrupted } =
        yield* supervised({
          ticketLimit: Duration.minutes(30),
          steps: [
            (attempt, n, kit) =>
              Effect.gen(function* () {
                yield* kit.starts(attempt, n)
                yield* Deferred.await(release)
                yield* kit.proxy(
                  Refusal.RateLimited({ retryAfter: Option.none() }),
                )
                return WorkerEnd.Unfinished()
              }),
          ],
        })
      const watching = yield* Effect.forkChild(watch())
      yield* Queue.take(reached)
      yield* supervision.stop
      yield* TestClock.adjust('1 hour')
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(watching)).toEqual(WorkerEnd.Unfinished())
      expect(yield* Queue.size(interrupted)).toBe(0)
      expect(tried.length).toBe(1)
    }).pipe(Effect.scoped),
  )
})

describe('the holds until they are one state', () => {
  it.effect('wait a usage limit out to its reset, one past as unknown', () =>
    Effect.gen(function* () {
      const holds = waitingHolds(Duration.minutes(15))
      const now = yield* DateTime.now
      const waiting = yield* Effect.forkChild(
        holds.usageLimited({
          ticket,
          provider: 'anthropic',
          resetAt: DateTime.add(now, { hours: 2 }),
        }),
      )
      yield* TestClock.adjust('119 minutes')
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust('1 minute')
      yield* Fiber.join(waiting)
      const past = yield* Effect.forkChild(
        holds.usageLimited({
          ticket,
          provider: 'anthropic',
          resetAt: DateTime.subtract(yield* DateTime.now, { minutes: 1 }),
        }),
      )
      yield* TestClock.adjust('14 minutes')
      expect(past.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust('1 minute')
      yield* Fiber.join(past)
    }),
  )
})

describe('the fallbacks after a model', () => {
  it('leave out the model and repeats, in order', () => {
    expect(fallbacksAfter(Option.some(opus), [opus, gpt, gpt, gemini])).toEqual(
      [gpt, gemini],
    )
    expect(fallbacksAfter(Option.none(), [gpt])).toEqual([gpt])
  })
})
