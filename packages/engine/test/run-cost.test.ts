import { DateTime, Duration, Effect, Layer, Option } from 'effect'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  ModelName,
  ProjectId,
  RunId,
  SessionId,
  TicketId,
} from '@fabrica/contracts'

import { makeCostAccount, piPriceTable } from '../src/cost'
import { ProxyEvent } from '../src/proxy'
import { type TurnRecorder, makeTurnRecorder } from '../src/run/turns'
import { RunLog, layerRunLog, readEvents } from '../src/runlog'
import { anthropicAnswer } from './proxy-streams'
import {
  file,
  noTelemetry,
  ofKind,
  project,
  runOf,
  setUpRuns,
} from './run-harness'

// The run's records of what it spent (spec §13.12, §14.4): whole runs whose stub worker calls the model
// once through the model proxy, the loopback provider answering with its usage. The run's cost account
// prices the call and each record that carries spend takes its share: the worker's `turn`, its ticket's
// `closed` or `deferred` and `ticket_end`, and the run's `end`. A session's turn records apart, from
// its agent's events as they come.

beforeAll(setUpRuns)

const model = 'anthropic/claude-sonnet-4-5'
const tokens = { [model]: anthropicAnswer.tokens }
/** The call's price at pi-ai's tables, on an API key: money. */
const usd = Option.getOrThrow(
  piPriceTable()({
    provider: 'anthropic',
    model: ModelName.make(model),
    tokens: anthropicAnswer.tokens,
  }),
)
const spent = { tokens, cost_usd: usd }

describe("a run's records of what it spent", () => {
  it.effect(
    "a merged ticket's turn, closed and ticket_end carry its call, and the end its workers'",
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const { end, events, made } = yield* runOf(
          fixture,
          file('Spend once', 'spend', { model }),
        )
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        const turns = ofKind(events, 'turn')
        expect(turns).toHaveLength(1)
        expect(turns[0]).toMatchObject({
          ticket: made.id,
          model,
          turns: 1,
          ...spent,
        })
        expect(turns[0]?.equivalent_usd).toBeUndefined()
        expect(ofKind(events, 'closed')).toEqual([
          expect.objectContaining({ ticket: made.id, ...spent }),
        ])
        expect(ofKind(events, 'ticket_end')).toEqual([
          expect.objectContaining({
            ticket: made.id,
            outcome: 'merged',
            ...spent,
          }),
        ])
        expect(ofKind(events, 'end')).toEqual([expect.objectContaining(spent)])
      }),
  )

  it.effect('a deferred ticket carries what it spent', () =>
    Effect.gen(function* () {
      const fixture = project()
      const { events, made } = yield* runOf(
        fixture,
        file('Spend, then defer', 'spend_defer', { model }),
      )
      expect(ofKind(events, 'deferred')).toEqual([
        expect.objectContaining({ ticket: made.id, ...spent }),
      ])
      expect(ofKind(events, 'ticket_end')).toEqual([
        expect.objectContaining({
          ticket: made.id,
          outcome: 'set_aside',
          ...spent,
        }),
      ])
      expect(ofKind(events, 'end')).toEqual([expect.objectContaining(spent)])
    }),
  )

  it.effect(
    'a run whose worker calls no model writes its turn and its records with nothing spent',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const { events, made } = yield* runOf(
          fixture,
          file('Spend nothing', 'finish'),
        )
        const [turn] = ofKind(events, 'turn')
        expect(turn).toMatchObject({
          ticket: made.id,
          model: 'anthropic/claude-test',
          turns: 0,
        })
        const carrying = events.filter(
          event =>
            'tokens' in event ||
            'cost_usd' in event ||
            'equivalent_usd' in event,
        )
        expect(carrying).toEqual([])
      }),
  )
})

describe("a session's turn records", () => {
  const run = RunId.make('run-turns')
  const ticket = TicketId.make('fa-1')
  const session = SessionId.make('worker-turns')

  /** A turn recorder over a run log of its own and a cost account the call is counted into; its records. */
  const recorded = (
    body: (
      recorder: TurnRecorder & { readonly call: Effect.Effect<void> },
    ) => Effect.Effect<void>,
  ) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fab-turns-')))
    return Effect.gen(function* () {
      const log = yield* RunLog
      const cost = yield* makeCostAccount({
        project: ProjectId.make('p1'),
        run,
        billing: () => 'api_key',
      })
      const recorder = yield* makeTurnRecorder({
        log,
        cost,
        ticket: Option.some(ticket),
        session,
        model: ModelName.make('anthropic/claude-test'),
      })
      yield* body({
        ...recorder,
        call: cost.count(
          ProxyEvent.Used({
            provider: 'anthropic',
            caller: {
              run,
              ticket: Option.some(ticket),
              session: Option.some(session),
              model: ModelName.make(model),
            },
            tokens: anthropicAnswer.tokens,
            latency: Duration.seconds(1),
            firstToken: Option.none(),
          }),
        ),
      })
      const read = yield* readEvents({ root, run: Option.some(run) })
      return ofKind(read.events, 'turn')
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerRunLog({ root, run }).pipe(
            Layer.provide(DateTime.layerCurrentZoneOffset(0)),
          ),
          noTelemetry,
        ),
      ),
    )
  }

  it.effect(
    'a turn takes the model its answer named, its round-trips and the spend since the last',
    () =>
      Effect.gen(function* () {
        const turns = yield* recorded(({ heard, call }) =>
          Effect.gen(function* () {
            yield* heard({ type: 'agent_start' })
            yield* call
            yield* heard({ type: 'turn_end' })
            yield* heard({
              type: 'message_end',
              message: {
                role: 'assistant',
                provider: 'anthropic',
                model: 'claude-sonnet-4-5',
              },
            })
            yield* heard({ type: 'turn_end' })
            yield* heard({ type: 'agent_settled', aborted: false })
            yield* heard({ type: 'agent_start' })
            yield* heard({ type: 'agent_settled', aborted: false })
          }),
        )
        expect(turns).toEqual([
          expect.objectContaining({
            ticket,
            session,
            model,
            turns: 2,
            ...spent,
          }),
          expect.objectContaining({
            session,
            model: 'anthropic/claude-test',
            turns: 0,
          }),
        ])
        expect(turns[1]?.tokens).toBeUndefined()
      }),
  )

  it.effect('a turn its session closes on is written as it closes', () =>
    Effect.gen(function* () {
      const turns = yield* recorded(({ heard, closed, call }) =>
        Effect.gen(function* () {
          yield* heard({ type: 'agent_start' })
          yield* call
          yield* heard({ type: 'turn_end' })
          yield* closed
          yield* closed
        }),
      )
      expect(turns).toEqual([
        expect.objectContaining({ ticket, session, turns: 1, ...spent }),
      ])
    }),
  )
})
