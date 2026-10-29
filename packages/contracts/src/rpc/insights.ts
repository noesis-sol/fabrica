import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import { CheckSuite, HandBacks, TokensByModel } from '../events'
import { ProjectId, RunId, TicketId } from '../ids'
import { Text } from '../ticket'
import { Count, Millis, Moment, Usd, optional } from './common'
import { ProjectNotFound } from './errors'

// The Insights group (spec §8.1, §21): the engine's telemetry, summarised, and its named queries. A
// client names a query and gives its parameters; no SQL crosses, so the store behind them (SQLite
// now, DuckDB later) changes without a client knowing.

/** The time a query looks at: from `since` (all time when left out) to now. */
const since = optional(Moment)

/** A project's, or every project's when left out. */
const project = optional(ProjectId)

/** The named queries (§21) and their parameters. */
export const InsightsQuery = Schema.TaggedUnion({
  /** Where a ticket's time goes: phases, waiting by reason, the merge queue, checks by suite, hand-backs, waiting on the maintainer. */
  ticket_time: {
    project: ProjectId,
    ticket: optional(TicketId),
    run: optional(RunId),
  },
  /** How long questions and permission requests waited. */
  waits: { project, since },
  check_durations: { project, suite: optional(CheckSuite), since },
  /** Tests that failed and passed on the same tree, by test. */
  flaky_tests: { project, since },
  cost_per_merged_ticket: { project, since },
  /** Tokens and cost per model, by run, ticket or project. */
  tokens_by_model: {
    project,
    since,
    by: Schema.Literals(['run', 'ticket', 'project']),
  },
  /** Hand-back and set-aside rates. */
  hand_back_rates: { project, since },
  /** Models compared on similar tickets. */
  models_compared: { project, since },
})
export type InsightsQuery = typeof InsightsQuery.Type

/** The named queries' names. */
export type InsightsQueryName = InsightsQuery['_tag']

/** What a column's numbers are. */
export const ColumnUnit = Schema.Literals([
  'text',
  'count',
  'millis',
  'usd',
  'tokens',
  'share',
  'time',
])
export type ColumnUnit = typeof ColumnUnit.Type

/** A column of a query's answer. */
export class InsightsColumn extends Schema.Class<InsightsColumn>(
  'InsightsColumn',
)({
  name: Text,
  unit: ColumnUnit,
}) {}

/** A cell: a number (a `time` in milliseconds since the epoch), text, or `null` where the row has none. */
export const InsightsCell = Schema.OptionFromNullOr(
  Schema.Union([Schema.Finite, Schema.String]),
)
export type InsightsCell = typeof InsightsCell.Type

/** A named query's answer: its columns and its rows, a cell per column. */
export class InsightsTable extends Schema.Class<InsightsTable>('InsightsTable')(
  Schema.Struct({
    columns: Schema.NonEmptyArray(InsightsColumn),
    rows: Schema.Array(Schema.Array(InsightsCell)),
  }).check(
    Schema.makeFilter(({ columns, rows }) =>
      rows.every(row => row.length === columns.length)
        ? undefined
        : {
            path: ['rows'],
            issue: `every row must have a cell for each of the ${columns.length} columns`,
          },
    ),
  ),
) {}

/** The Insights screen's summary (§18.4). */
export class InsightsSummary extends Schema.Class<InsightsSummary>(
  'InsightsSummary',
)({
  runs: Count,
  merged: Count,
  setAside: Count,
  handBacks: HandBacks,
  tokens: TokensByModel,
  costUsd: Schema.OptionFromNullOr(Usd),
  /** The median time from ready to merged, over the tickets merged. */
  readyToMerged: Schema.OptionFromNullOr(Millis),
}) {}

export const InsightsRpcs = RpcGroup.make(
  Rpc.make('insights.summary', {
    payload: { project, since },
    success: InsightsSummary,
    error: ProjectNotFound,
  }),
  Rpc.make('insights.query', {
    payload: { query: InsightsQuery },
    success: InsightsTable,
    error: ProjectNotFound,
  }),
)
