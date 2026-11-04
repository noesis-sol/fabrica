import { Effect, Option, Stream } from 'effect'

import {
  BudgetCap,
  type ProjectId,
  type TicketId,
  tokenTotal,
} from '@fabrica/contracts'

import { type CostAccount, type Spend, type Spent, tokensOf } from '../cost'
import { type Measured, Telemetry, nothingMeasured } from '../telemetry'
import type { HoldsShape } from './state'

// The budgets (spec §14.4, H21): optional, off by default, per project, run or ticket, in tokens or
// money. Each is measured against what the run's cost account has counted, so against calls whose
// responses have ended, and a call can pass it by what it spent. A ticket at its budget is interrupted
// and set aside through its supervision, whenever a figure changes and it has a worker to interrupt. A
// run or project at its budget stops dispatching (`HOLD: BUDGET`), its running workers going on to
// finish; a budget spent stays spent, so the hold never lifts, and the run ends once they have.
//
// Tokens count all of a call's, its cache's included, as the console shows them. Money is money: a
// subscription's API-price equivalent isn't spent, so it counts against no budget in money, nor does an
// unpriced call. A ticket's and a run's figures are those of this run, so a ticket undeferred in a later
// run has its budget again; a project's add this run's to what telemetry has recorded of it before.

/** The budgets as the settings have them: `budgets` (§13.13). */
export interface Budgets {
  readonly project: Option.Option<BudgetCap>
  readonly run: Option.Option<BudgetCap>
  readonly ticket: Option.Option<BudgetCap>
}

const measuredOf = (spend: Spend): Measured => ({
  tokens: tokenTotal(tokensOf(spend)),
  usd: Option.getOrElse(spend.costUsd, () => 0),
})

const plus = (a: Measured, b: Measured): Measured => ({
  tokens: a.tokens + b.tokens,
  usd: a.usd + b.usd,
})

/** `measured` where it has reached `cap`, in words: `$5.01 of $5.00`, `2000123 of 2000000 tokens`. */
export const overCap = (
  cap: BudgetCap,
  measured: Measured,
): Option.Option<string> =>
  BudgetCap.match(cap, {
    Tokens: ({ tokens }) =>
      measured.tokens >= tokens
        ? Option.some(`${measured.tokens} of ${tokens} tokens`)
        : Option.none(),
    Money: ({ usd }) =>
      measured.usd >= usd
        ? Option.some(`$${measured.usd.toFixed(2)} of $${usd.toFixed(2)}`)
        : Option.none(),
  })

/**
 * Measures `input.budgets` against the account, as it stands now, the project's read from telemetry;
 * the effect it gives measures them again each time the account's figures change, for as long as it
 * runs. With no budget set, nothing is read and that effect ends at once.
 */
export const makeBudgetWatch = Effect.fn('Budgets.watch')(function* (input: {
  readonly budgets: Budgets
  readonly project: ProjectId
  readonly cost: Pick<CostAccount, 'spent' | 'changes'>
  readonly holds: Pick<HoldsShape, 'raise'>
  /** The ticket went over its budget: its supervision interrupts it and sets it aside. */
  readonly ticketOver: (over: {
    readonly ticket: TicketId
    readonly detail: string
  }) => Effect.Effect<void>
}) {
  const { budgets, holds } = input
  const telemetry = yield* Telemetry
  const before = Option.isSome(budgets.project)
    ? yield* telemetry.projectSpent(input.project)
    : nothingMeasured

  const hold = (
    what: string,
    budget: Option.Option<BudgetCap>,
    measured: Measured,
  ) =>
    Option.match(
      Option.flatMap(budget, cap => overCap(cap, measured)),
      {
        onNone: () => Effect.void,
        onSome: detail =>
          Effect.asVoid(
            holds.raise({
              hold: 'BUDGET',
              why: `the ${what} went over its budget: ${detail}`,
            }),
          ),
      },
    )

  const measure = ({ tickets, run }: Spent) =>
    Effect.gen(function* () {
      const inRun = plus(measuredOf(run.workers), measuredOf(run.untied))
      yield* hold('project', budgets.project, plus(before, inRun))
      yield* hold('run', budgets.run, inRun)
      if (Option.isNone(budgets.ticket)) return
      const cap = budgets.ticket.value
      yield* Effect.forEach(
        tickets,
        ([ticket, spend]) =>
          Option.match(overCap(cap, measuredOf(spend)), {
            onNone: () => Effect.void,
            onSome: detail => input.ticketOver({ ticket, detail }),
          }),
        { discard: true },
      )
    })

  const anySet = [budgets.project, budgets.run, budgets.ticket].some(
    Option.isSome,
  )
  if (!anySet) return Effect.void
  yield* measure(yield* input.cost.spent)
  return Stream.runForEach(input.cost.changes, measure)
})
