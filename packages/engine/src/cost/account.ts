import { Effect, Option, Ref, Stream } from 'effect'

import type {
  ProjectId,
  ProviderName,
  RunId,
  SessionId,
  TicketId,
} from '@fabrica/contracts'

import { ModelProxy, ProxyEvent } from '../proxy'
import { Telemetry, TelemetryRow } from '../telemetry'
import {
  type Billing,
  Price,
  type PriceTable,
  piPriceTable,
  priceOf,
} from './pricing'
import { type Spend, addCall, noSpend } from './spend'

// A run's cost account (spec §14.4, §21): every model call the model proxy counted to the run is
// priced, recorded in telemetry as a model-call row tied to the run's project, the run and the call's
// ticket, and added to what its ticket, its session and the run have spent, for the event stream's
// records: a `turn`'s share of its session's totals, what a ticket spent on `closed`, `deferred` and
// `ticket_end`, the run's workers' on `end` (§13.12). A call's usage is published once its response
// has ended, so a turn ended just as its last call did may find that call's share in its next turn;
// the ticket's and the run's totals hold it either way.

export interface CostAccountOptions {
  readonly project: ProjectId
  readonly run: RunId
  /** How each provider's calls are paid for, read as each call is priced. */
  readonly billing: (provider: ProviderName) => Billing
  /** pi-ai's tables (`piPriceTable`), unless another is given. */
  readonly prices?: PriceTable
}

/** What a run spent. */
export interface RunSpend {
  /** Its workers' calls, those counted to a ticket, as `end` carries them. */
  readonly workers: Spend
  /** Its calls counted to no ticket: organs' and the proxy's probes. */
  readonly untied: Spend
}

export interface CostAccount {
  /** Prices a call the proxy counted to the run and records it; another run's, and a refusal, are left. */
  readonly count: (event: ProxyEvent) => Effect.Effect<void>
  /** What `session` spent since its last turn was taken, for its `turn` record. */
  readonly takeTurn: (session: SessionId) => Effect.Effect<Spend>
  /** What `ticket` spent in the run so far. */
  readonly ticket: (ticket: TicketId) => Effect.Effect<Spend>
  /** What the run spent so far. */
  readonly run: Effect.Effect<RunSpend>
}

interface State {
  readonly tickets: ReadonlyMap<TicketId, Spend>
  /** Each session's spend since its last turn was taken. */
  readonly turns: ReadonlyMap<SessionId, Spend>
  readonly run: RunSpend
}

const added = <K>(
  map: ReadonlyMap<K, Spend>,
  key: Option.Option<K>,
  add: (spend: Spend) => Spend,
): ReadonlyMap<K, Spend> =>
  Option.match(key, {
    onNone: () => map,
    onSome: key => new Map(map).set(key, add(map.get(key) ?? noSpend)),
  })

/** A cost account for `options.run`, recording into telemetry. */
export const makeCostAccount = Effect.fn('CostAccount.make')(function* (
  options: CostAccountOptions,
) {
  const telemetry = yield* Telemetry
  const prices = options.prices ?? piPriceTable()
  const state = yield* Ref.make<State>({
    tickets: new Map(),
    turns: new Map(),
    run: { workers: noSpend, untied: noSpend },
  })

  const count = (event: ProxyEvent): Effect.Effect<void> =>
    ProxyEvent.$match(event, {
      Refused: () => Effect.void,
      Used: used => {
        const { caller, provider, tokens } = used
        if (caller.run !== options.run) return Effect.void
        const price = priceOf(prices, {
          provider,
          model: caller.model,
          tokens,
          billing: options.billing(provider),
        })
        const add = (spend: Spend) =>
          addCall(spend, { model: caller.model, tokens, price })
        const row = TelemetryRow.ModelCall({
          project: options.project,
          run: options.run,
          ticket: Option.getOrUndefined(caller.ticket),
          provider,
          model: caller.model,
          tokens,
          ...Price.$match(price, {
            Paid: ({ usd }) => ({ costUsd: usd }),
            Equivalent: ({ usd }) => ({ equivalentUsd: usd }),
            Unpriced: () => ({}),
          }),
          latency: used.latency,
          firstToken: Option.getOrUndefined(used.firstToken),
          outcome: 'answered',
        })
        return Effect.andThen(
          Ref.update(state, current => ({
            tickets: added(current.tickets, caller.ticket, add),
            turns: added(current.turns, caller.session, add),
            run: Option.isSome(caller.ticket)
              ? { ...current.run, workers: add(current.run.workers) }
              : { ...current.run, untied: add(current.run.untied) },
          })),
          telemetry.record(row),
        )
      },
    })

  const takeTurn = (session: SessionId) =>
    Ref.modify(state, current => {
      const turns = new Map(current.turns)
      turns.delete(session)
      return [current.turns.get(session) ?? noSpend, { ...current, turns }]
    })

  return {
    count,
    takeTurn,
    ticket: ticket =>
      Effect.map(
        Ref.get(state),
        current => current.tickets.get(ticket) ?? noSpend,
      ),
    run: Effect.map(Ref.get(state), current => current.run),
  } satisfies CostAccount
})

/** Counts into `account` every call the model proxy sees from now on, for as long as the scope is open. */
export const countProxyCalls = Effect.fn('CostAccount.countProxyCalls')(
  function* (account: CostAccount) {
    const proxy = yield* ModelProxy
    const events = yield* proxy.events
    yield* Effect.forkScoped(Stream.runForEach(events, account.count))
  },
)
