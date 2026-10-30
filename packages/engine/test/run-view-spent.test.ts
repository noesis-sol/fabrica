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
  EngineId,
  ModelName,
  Phase,
  ProjectId,
  ProviderName,
  RunHeader,
  RunId,
  RunMode,
  SessionId,
  TicketId,
  type Tokens,
} from '@fabrica/contracts'

import { makeCostAccount } from '../src/cost'
import { type Caller, ProxyEvent } from '../src/proxy'
import type { RunSnapshot, RunStateShape } from '../src/run'
import { Telemetry } from '../src/telemetry'
import { type RunViewItem, makeRunView } from '../src/view'

// The run view's spending (spec §12.9, §18.3, §18.4, H91): a worker's row carries what its ticket's
// sessions spent and the stats row what the run's workers spent, both as the model proxy counts each
// call, so that the worker view's share of the usage window moves during a turn, with no turn's end.

const run = RunId.make('2026-10-30T09:00:00+01:00')
const ticket = TicketId.make('wk-a1')
const queued = TicketId.make('wk-b2')
const session = SessionId.make('worker-1')
const sonnet = ModelName.make('claude-sonnet-4-5')
const haiku = ModelName.make('claude-haiku-4-5')
const anthropic = ProviderName.make('anthropic')
const interval = Duration.millis(50)

const header = new RunHeader({
  run,
  project: ProjectId.make('work'),
  engine: EngineId.make('engine-1'),
  mode: RunMode.cases.tickets.make({}),
  state: 'running',
  startedAt: DateTime.makeUnsafe(0),
  offline: false,
  autoAnswer: false,
})

const tokens = (input: number, output: number): Tokens => ({
  input,
  output,
  cache_write: 0,
  cache_read: 0,
})

/** A call the proxy counted to the run, of `ticket`'s session where it has one. */
const call = (options: {
  readonly ticket: Option.Option<TicketId>
  readonly model?: ModelName
  readonly tokens: Tokens
}) => {
  const caller: Caller = {
    run,
    ticket: options.ticket,
    session: Option.map(options.ticket, () => session),
    model: options.model ?? sonnet,
  }
  return ProxyEvent.Used({
    provider: anthropic,
    caller,
    tokens: options.tokens,
    latency: Duration.seconds(1),
    firstToken: Option.none(),
  })
}

/** The run's state: `ticket` working, `queued` in the queue. */
const snapshot: RunSnapshot = {
  tickets: new Map([
    [
      ticket,
      {
        ticket,
        title: 'Add the page',
        phase: Phase.cases.working.make({}),
        n: Option.some(1),
        since: { startNanos: BigInt(0) },
      },
    ],
    [
      queued,
      {
        ticket: queued,
        title: 'Fix the link',
        phase: Phase.cases.queued.make({}),
        n: Option.none(),
        since: { startNanos: BigInt(0) },
      },
    ],
  ]),
  dispatched: 1,
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

describe("the run view's spending", () => {
  it.effect(
    "moves a worker's row and the run's total with each call the proxy counts, during a turn",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const cost = yield* makeCostAccount({
          project: header.project,
          run,
          billing: () => 'api_key',
        }).pipe(
          Effect.provideService(
            Telemetry,
            Telemetry.of({ record: () => Effect.void, flush: Effect.void }),
          ),
        )
        const view = yield* makeRunView({
          header: Effect.succeed(header),
          interval,
          flush: interval,
          graph: {
            doneSince: () => Effect.succeed(0),
            changes: Effect.succeed(Stream.never),
          },
          needsYou: () => Effect.void,
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

        yield* view.sources.attach({
          state,
          line: Effect.succeed({ merging: Option.none(), waiting: [] }),
          mergesWait: Effect.succeed(Option.none()),
          slots: 2,
          spent: cost.spent,
        })
        yield* view.sources.workers.enter({ ticket, session, model: sonnet })
        yield* TestClock.adjust(interval)
        const [entered] = yield* patches
        expect(entered?.workers?.upsert).toMatchObject([
          { ticket, tokens: tokens(0, 0) },
        ])
        expect(entered?.totals?.tokens).toEqual(tokens(0, 0))

        // A call mid-turn, then another of a second model: the row sums them, the total with it.
        yield* cost.count(
          call({ ticket: Option.some(ticket), tokens: tokens(100, 20) }),
        )
        yield* TestClock.adjust(interval)
        const [first] = yield* patches
        expect(first?.workers?.upsert).toMatchObject([
          { ticket, tokens: tokens(100, 20) },
        ])
        expect(first?.totals?.tokens).toEqual(tokens(100, 20))

        yield* cost.count(
          call({
            ticket: Option.some(ticket),
            model: haiku,
            tokens: { input: 50, output: 5, cache_write: 7, cache_read: 300 },
          }),
        )
        yield* TestClock.adjust(interval)
        const [second] = yield* patches
        const both = { input: 150, output: 25, cache_write: 7, cache_read: 300 }
        expect(second?.workers?.upsert).toMatchObject([
          { ticket, tokens: both },
        ])
        expect(second?.totals?.tokens).toEqual(both)

        // A call of no ticket's (an organ's, a probe's) is no worker's: neither moves.
        yield* cost.count(call({ ticket: Option.none(), tokens: tokens(9, 9) }))
        yield* TestClock.adjust(interval)
        expect(yield* patches).toEqual([])

        // A ticket with no worker on the view adds to the run's total, no row.
        yield* cost.count(
          call({ ticket: Option.some(queued), tokens: tokens(10, 10) }),
        )
        yield* TestClock.adjust(interval)
        const [other] = yield* patches
        expect(other?.workers).toBeUndefined()
        expect(other?.totals?.tokens).toEqual({
          ...both,
          input: 160,
          output: 35,
        })
        yield* Scope.close(scope, Exit.void)
      }),
  )
})
