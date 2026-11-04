import { Duration, Effect, Fiber, Layer, Option, Queue } from 'effect'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  BudgetCap,
  ModelName,
  ProjectId,
  ProviderName,
  Retention as RetentionSetting,
  RunId,
  SessionId,
  TicketId,
  tokenTotal,
} from '@fabrica/contracts'

import { makeCostAccount } from '../src/cost'
import { type Budgets, makeBudgetWatch, overCap } from '../src/holds'
import type { HoldsSnapshot } from '../src/holds'
import { ProxyEvent } from '../src/proxy'
import { runProject } from '../src/run'
import { keepsRun } from '../src/run/holds'
import {
  Telemetry,
  TelemetryRow,
  makeTelemetry,
  nothingMeasured,
  prune,
  telemetryStoreLayer,
} from '../src/telemetry'
import { anthropicAnswer } from './proxy-streams'
import {
  configOf,
  eventsOf,
  file,
  ofKind,
  options,
  project,
  runOf,
  setUpRuns,
  settings,
  withRuns,
} from './run-harness'

// The budgets (spec §14.4, H21): what the run's cost account has counted, measured against each budget
// set, and whole runs whose stub workers call the model through the proxy: a ticket over its budget
// interrupted and set aside, a run over its budget dispatching no more (`HOLD: BUDGET`) and ending once
// its running workers have.

beforeAll(setUpRuns)

const projectId = ProjectId.make('p1')
const run = RunId.make('run-1')
const ticketA = TicketId.make('fa-a')
const ticketB = TicketId.make('fa-b')
const model = 'anthropic/claude-sonnet-4-5'
const anthropic = ProviderName.make('anthropic')
const off: Budgets = {
  project: Option.none(),
  run: Option.none(),
  ticket: Option.none(),
}
const tokensCap = (tokens: number) =>
  Option.some(BudgetCap.cases.Tokens.make({ tokens }))
const moneyCap = (usd: number) =>
  Option.some(BudgetCap.cases.Money.make({ usd }))

/** A call of `ticket` (none for an organ's), of 100 tokens, 40 of them its cache's, at $1. */
const call = (ticket: Option.Option<TicketId>) =>
  ProxyEvent.Used({
    provider: anthropic,
    caller: {
      run,
      ticket,
      session: Option.some(SessionId.make('s-1')),
      model: ModelName.make(model),
    },
    tokens: { input: 50, output: 10, cache_write: 15, cache_read: 25 },
    latency: Duration.seconds(1),
    firstToken: Option.none(),
  })

/** A budget watch over a cost account, telemetry having `before` of the project. */
const watching = (
  budgets: Budgets,
  setup: {
    readonly before?: { readonly tokens: number; readonly usd: number }
    readonly billing?: 'api_key' | 'subscription'
  } = {},
) =>
  Effect.gen(function* () {
    const reads = yield* Queue.unbounded<ProjectId>()
    const raised = yield* Queue.unbounded<string>()
    const over = yield* Queue.unbounded<string>()
    const telemetry = Layer.succeed(Telemetry)(
      Telemetry.of({
        record: () => Effect.void,
        flush: Effect.void,
        projectSpent: read =>
          Effect.as(Queue.offer(reads, read), setup.before ?? nothingMeasured),
      }),
    )
    const cost = yield* makeCostAccount({
      project: projectId,
      run,
      billing: () => setup.billing ?? 'api_key',
      prices: () => Option.some(1),
    }).pipe(Effect.provide(telemetry))
    const watch = makeBudgetWatch({
      budgets,
      project: projectId,
      cost,
      holds: {
        raise: ({ hold, why }) =>
          Effect.as(Queue.offer(raised, `${hold}: ${why}`), true),
      },
      ticketOver: ({ ticket, detail }) =>
        Effect.asVoid(Queue.offer(over, `${ticket}: ${detail}`)),
    }).pipe(Effect.provide(telemetry))
    return { reads, raised, over, cost, watch }
  })

describe('what a budget measures', () => {
  it('reaches a cap at it, not before, and says how far in its own unit', () => {
    const tokens = BudgetCap.cases.Tokens.make({ tokens: 100 })
    const usd = BudgetCap.cases.Money.make({ usd: 5 })
    expect(overCap(tokens, { tokens: 99, usd: 900 })).toEqual(Option.none())
    expect(overCap(tokens, { tokens: 100, usd: 0 })).toEqual(
      Option.some('100 of 100 tokens'),
    )
    expect(overCap(usd, { tokens: 900, usd: 4.99 })).toEqual(Option.none())
    expect(overCap(usd, { tokens: 0, usd: 5.014 })).toEqual(
      Option.some('$5.01 of $5.00'),
    )
  })

  it.effect('with every budget off, reads nothing and acts on nothing', () =>
    Effect.gen(function* () {
      const { reads, raised, over, cost, watch } = yield* watching(off)
      yield* cost.count(call(Option.some(ticketA)))
      yield* yield* watch
      expect(yield* Queue.size(reads)).toBe(0)
      expect(yield* Queue.size(raised)).toBe(0)
      expect(yield* Queue.size(over)).toBe(0)
    }),
  )

  it.effect(
    "a ticket budget tells the ticket over it alone, its cache's tokens counted",
    () =>
      Effect.gen(function* () {
        const { raised, over, cost, watch } = yield* watching({
          ...off,
          ticket: tokensCap(150),
        })
        yield* cost.count(call(Option.some(ticketA)))
        yield* cost.count(call(Option.some(ticketA)))
        yield* cost.count(call(Option.some(ticketB)))
        yield* Effect.asVoid(watch)
        expect(yield* Queue.clear(over)).toEqual([
          `${ticketA}: 200 of 150 tokens`,
        ])
        expect(yield* Queue.size(raised)).toBe(0)
      }),
  )

  it.effect('a run budget counts its organs’ calls beside its workers’', () =>
    Effect.gen(function* () {
      const { raised, over, cost, watch } = yield* watching({
        ...off,
        run: moneyCap(2),
      })
      yield* cost.count(call(Option.some(ticketA)))
      yield* cost.count(call(Option.none()))
      yield* Effect.asVoid(watch)
      expect(yield* Queue.clear(raised)).toEqual([
        'BUDGET: the run went over its budget: $2.00 of $2.00',
      ])
      expect(yield* Queue.size(over)).toBe(0)
    }),
  )

  it.effect('a run under its budget is left alone', () =>
    Effect.gen(function* () {
      const { raised, cost, watch } = yield* watching({
        ...off,
        run: moneyCap(2.5),
      })
      yield* cost.count(call(Option.some(ticketA)))
      yield* cost.count(call(Option.none()))
      yield* Effect.asVoid(watch)
      expect(yield* Queue.size(raised)).toBe(0)
    }),
  )

  it.effect(
    "a project budget adds the run's to what telemetry recorded, read once",
    () =>
      Effect.gen(function* () {
        const { reads, raised, cost, watch } = yield* watching(
          { ...off, project: tokensCap(1_000) },
          { before: { tokens: 950, usd: 0 } },
        )
        const follow = yield* watch
        expect(yield* Queue.size(raised)).toBe(0)
        const following = yield* Effect.forkChild(follow)
        yield* cost.count(call(Option.some(ticketA)))
        expect(yield* Queue.take(raised)).toBe(
          'BUDGET: the project went over its budget: 1050 of 1000 tokens',
        )
        yield* Fiber.interrupt(following)
        expect(yield* Queue.clear(reads)).toEqual([projectId])
      }),
  )

  it.effect(
    'a project already over its budget holds as the watch is made',
    () =>
      Effect.gen(function* () {
        const { raised, watch } = yield* watching(
          { ...off, project: moneyCap(10) },
          { before: { tokens: 0, usd: 12 } },
        )
        yield* Effect.asVoid(watch)
        expect(yield* Queue.clear(raised)).toEqual([
          'BUDGET: the project went over its budget: $12.00 of $10.00',
        ])
      }),
  )

  it.effect(
    "a subscription's calls spend tokens but no money, whatever their equivalent",
    () =>
      Effect.gen(function* () {
        const money = yield* watching(
          { ...off, run: moneyCap(1), ticket: moneyCap(1) },
          { billing: 'subscription' },
        )
        yield* money.cost.count(call(Option.some(ticketA)))
        yield* Effect.asVoid(money.watch)
        expect(yield* Queue.size(money.raised)).toBe(0)
        expect(yield* Queue.size(money.over)).toBe(0)

        const tokens = yield* watching(
          { ...off, run: tokensCap(100) },
          { billing: 'subscription' },
        )
        yield* tokens.cost.count(call(Option.some(ticketA)))
        yield* Effect.asVoid(tokens.watch)
        expect(yield* Queue.size(tokens.raised)).toBe(1)
      }),
  )

  it.effect('a ticket going over during the run is told as it does', () =>
    Effect.gen(function* () {
      const { over, cost, watch } = yield* watching({
        ...off,
        ticket: tokensCap(100),
      })
      const following = yield* Effect.forkChild(yield* watch)
      yield* cost.count(call(Option.some(ticketA)))
      expect(yield* Queue.take(over)).toBe(`${ticketA}: 100 of 100 tokens`)
      yield* Fiber.interrupt(following)
    }),
  )
})

describe('what a project has spent, as telemetry has it', () => {
  const forever = RetentionSetting.cases.Forever.make({})
  const modelCall = (of: ProjectId, costUsd?: number) =>
    TelemetryRow.ModelCall({
      project: of,
      run,
      ticket: ticketA,
      provider: anthropic,
      model: ModelName.make(model),
      tokens: { input: 100, output: 50, cache_write: 10, cache_read: 40 },
      costUsd,
      latency: Duration.seconds(1),
      outcome: 'answered',
    })

  it.effect(
    'adds its raw rows and those retention rolled up, and no other project’s',
    () =>
      Effect.gen(function* () {
        const telemetry = yield* makeTelemetry({
          retention: { raw: forever, daily: forever },
        })
        yield* telemetry.record(modelCall(projectId, 1.5))
        yield* telemetry.record(modelCall(projectId, 0.5))
        yield* telemetry.flush
        yield* prune(
          {
            raw: RetentionSetting.cases.For.make({
              duration: Duration.days(1),
            }),
            daily: forever,
          },
          Number.MAX_SAFE_INTEGER,
        ).pipe(Effect.orDie)
        yield* telemetry.record(modelCall(projectId))
        yield* telemetry.record(modelCall(ProjectId.make('p2'), 9))
        expect(yield* telemetry.projectSpent(projectId)).toEqual({
          tokens: 600,
          usd: 2,
        })
        expect(yield* telemetry.projectSpent(ProjectId.make('p3'))).toEqual(
          nothingMeasured,
        )
      }).pipe(Effect.provide(telemetryStoreLayer(':memory:')), Effect.scoped),
  )
})

describe('a hold for a budget', () => {
  const held = (...kinds: ReadonlyArray<'BUDGET' | 'USAGE_LIMIT'>) =>
    ({
      on: kinds.map(hold => ({
        hold,
        provider: Option.none(),
        why: 'it holds',
        since: 0,
        lifts: Option.none(),
      })),
      gaveUp: Option.none(),
    }) satisfies HoldsSnapshot

  it('keeps no run waiting, as another hold would', () => {
    const budget = held('BUDGET')
    expect(keepsRun({ holds: budget, heard: budget })).toBe(false)
    const both = held('USAGE_LIMIT', 'BUDGET')
    expect(keepsRun({ holds: both, heard: both })).toBe(false)
    const usage = held('USAGE_LIMIT')
    expect(keepsRun({ holds: usage, heard: usage })).toBe(true)
  })
})

describe('a run with budgets', () => {
  const callTokens = tokenTotal(anthropicAnswer.tokens)

  it.effect(
    'a ticket over its budget is interrupted and set aside, and the run goes on',
    () =>
      Effect.gen(function* () {
        const fixture = project({
          ...settings,
          concurrent: 1,
          budgets: { ticket: { tokens: 1 } },
        })
        const { end, events, made, ticketOf } = yield* runOf(
          fixture,
          Effect.all({
            over: file('Spend past it', 'spend_hang', { model, priority: 0 }),
            next: file('Then this', 'finish', { priority: 1 }),
          }),
        )
        const note = `it went over its budget: ${callTokens} of 1 tokens`
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        expect(ofKind(events, 'ticket_end')).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              ticket: made.over.id,
              outcome: 'set_aside',
              why: 'BUDGET_EXCEEDED',
            }),
            expect.objectContaining({
              ticket: made.next.id,
              outcome: 'merged',
            }),
          ]),
        )
        expect(ofKind(events, 'hold')).toEqual([])
        expect(ticketOf(made.over.id).status).toBe('deferred')
        expect(JSON.stringify(ofKind(events, 'deferred'))).toContain(note)
      }),
  )

  it.effect(
    'a run over its budget dispatches no more, its running ticket merging, and ends',
    () =>
      Effect.gen(function* () {
        const fixture = project({
          ...settings,
          concurrent: 1,
          budgets: { run: { tokens: 1 } },
        })
        const { end, events, made, ticketOf } = yield* runOf(
          fixture,
          Effect.all([
            file('One', 'spend', { model }),
            file('Two', 'spend', { model }),
          ]),
        )
        expect(end).toEqual({ kind: 'LIMIT_REACHED', code: 0 })
        expect(ofKind(events, 'hold')).toEqual([
          expect.objectContaining({
            hold: 'BUDGET',
            text: expect.stringContaining(
              `HOLD: BUDGET: the run went over its budget: ${callTokens} of 1 tokens`,
            ),
          }),
        ])
        expect(ofKind(events, 'dispatch')).toHaveLength(1)
        const statuses = made.map(ticket => ticketOf(ticket.id).status)
        expect(statuses.toSorted()).toEqual(['closed', 'open'])
      }),
  )

  it.effect('a run within its budgets goes on as one with none', () =>
    Effect.gen(function* () {
      const fixture = project({
        ...settings,
        budgets: {
          project: { tokens: 1_000_000_000 },
          run: { usd: 1_000 },
          ticket: { tokens: 1_000_000_000 },
        },
      })
      const { end, events } = yield* runOf(
        fixture,
        file('Within', 'spend', { model }),
      )
      expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
      expect(ofKind(events, 'hold')).toEqual([])
    }),
  )

  it.effect('a project over its budget from before takes no ticket', () =>
    Effect.gen(function* () {
      const fixture = project({
        ...settings,
        budgets: { project: { usd: 10 } },
      })
      const { end, events } = yield* withRuns(
        fixture,
        Effect.gen(function* () {
          yield* file('Never started', 'finish')
          const telemetry = yield* Telemetry
          const end = yield* runProject(configOf(fixture, options())).pipe(
            Effect.provideService(
              Telemetry,
              Telemetry.of({
                ...telemetry,
                projectSpent: () => Effect.succeed({ tokens: 0, usd: 11 }),
              }),
            ),
          )
          return { end, events: yield* eventsOf(fixture) }
        }),
      )
      expect(end).toEqual({ kind: 'LIMIT_REACHED', code: 0 })
      expect(ofKind(events, 'dispatch')).toEqual([])
      expect(ofKind(events, 'hold')).toEqual([
        expect.objectContaining({
          hold: 'BUDGET',
          text: 'HOLD: BUDGET: the project went over its budget: $11.00 of $10.00',
        }),
      ])
    }),
  )
})
