import { Array, DateTime, Effect, Match, Option, Result, Schema } from 'effect'
import { Command, type Update } from 'foldkit'
import * as AsyncData from 'foldkit/asyncData'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'
import { defineView } from 'foldkit/submodel'

import {
  type ColumnUnit,
  type InsightsCell,
  type InsightsColumn,
  InsightsQuery,
  InsightsSummary,
  InsightsTable,
} from '@fabrica/contracts'

import { sayDuration, sayMoment } from '../app/clock'
import { EngineProject } from '../app/engine-project'
import { type EngineServices, requestScope } from '../app/engine-route'
import { sayTokens, tokenTotal } from '../console/stats'

// The Insights screen (spec §18.4, §21): the engine's telemetry for the scope, a project's or every
// project's, over all its time. A summary of its runs, then a panel per named query of the Insights
// group (§8.1): tokens and cost per model by run, ticket or project; cost per merged ticket; time per
// phase; check durations and failures; flaky tests; the maintainer's waits; hand-back and set-aside
// rates; models compared on similar tickets. Each is asked as the screen opens, its scope changes or
// Refresh is pressed, and drawn from the table the engine answers, each cell in its column's unit. An
// answer for a query no longer shown (another scope, another grouping) is dropped.

/** The panels, each one named query's answer. */
export const Panel = Schema.Literals([
  'tokens',
  'cost',
  'phases',
  'checks',
  'flaky',
  'waits',
  'handBacks',
  'models',
])
export type Panel = typeof Panel.Type

/** What tokens and cost are counted by beside the model: a run, a ticket or a project. */
export const TokensBy = InsightsQuery.cases.tokens_by_model.fields.by
export type TokensBy = typeof TokensBy.Type

const tokensByTitle: Record<TokensBy, string> = {
  run: 'Run',
  ticket: 'Ticket',
  project: 'Project',
}

/** A panel's title and what it shows, as the screen says them. */
export const panelTitle: Record<Panel, string> = {
  tokens: 'Tokens and cost',
  cost: 'Cost per merged ticket',
  phases: 'Time per phase',
  checks: 'Check durations and failures',
  flaky: 'Flaky tests',
  waits: 'Waits on you',
  handBacks: 'Hand-back and set-aside rates',
  models: 'Models compared',
}

const panelAbout: Record<Panel, string> = {
  tokens: 'Per model, by run, ticket or project.',
  cost: 'What each merged ticket cost, by run.',
  phases:
    "Where the tickets' time goes: working, checks, the merge queue, hand-backs, holds.",
  checks: 'How long each suite took, and how often it failed.',
  flaky: 'Tests that failed and passed on the same tree.',
  waits: 'How long questions and permission requests waited.',
  handBacks: 'How often tickets were handed back or set aside.',
  models: 'Models side by side on similar tickets.',
}

/** What a panel's query depends on: the project in scope, none for every project, and the tokens' grouping. */
interface Scope {
  readonly project: Option.Option<EngineProject>
  readonly tokensBy: TokensBy
}

const since = Option.none<DateTime.Utc>()

/** The query a panel asks for `scope`; none where it needs a project and every project is in scope. */
export const queryOf = (
  panel: Panel,
  scope: Scope,
): Option.Option<InsightsQuery> => {
  const project = Option.map(scope.project, scoped => scoped.project)
  const { tokensBy } = scope
  return Match.value(panel).pipe(
    Match.when('tokens', () =>
      Option.some(
        InsightsQuery.cases.tokens_by_model.make({
          project,
          since,
          by: tokensBy,
        }),
      ),
    ),
    Match.when('cost', () =>
      Option.some(
        InsightsQuery.cases.cost_per_merged_ticket.make({ project, since }),
      ),
    ),
    Match.when('phases', () =>
      Option.map(project, project =>
        InsightsQuery.cases.ticket_time.make({
          project,
          ticket: Option.none(),
          run: Option.none(),
        }),
      ),
    ),
    Match.when('checks', () =>
      Option.some(
        InsightsQuery.cases.check_durations.make({
          project,
          suite: Option.none(),
          since,
        }),
      ),
    ),
    Match.when('flaky', () =>
      Option.some(InsightsQuery.cases.flaky_tests.make({ project, since })),
    ),
    Match.when('waits', () =>
      Option.some(InsightsQuery.cases.waits.make({ project, since })),
    ),
    Match.when('handBacks', () =>
      Option.some(InsightsQuery.cases.hand_back_rates.make({ project, since })),
    ),
    Match.when('models', () =>
      Option.some(InsightsQuery.cases.models_compared.make({ project, since })),
    ),
    Match.exhaustive,
  )
}

const sameQuery = Schema.toEquivalence(InsightsQuery)
const sameScope = Schema.toEquivalence(Schema.Option(EngineProject))

const TableData = AsyncData.Schema(InsightsTable, Schema.String).schema
type TableData = typeof TableData.Type

export const Model = Schema.Struct({
  /** The project whose telemetry is shown: the scope's as the screen opened; none for every project. */
  project: Schema.Option(EngineProject),
  tokensBy: TokensBy,
  summary: AsyncData.Schema(InsightsSummary, Schema.String).schema,
  tables: Schema.Record(Panel, TableData),
})
export type Model = typeof Model.Type

const eachPanel = <A>(f: (panel: Panel) => A): Record<Panel, A> => ({
  tokens: f('tokens'),
  cost: f('cost'),
  phases: f('phases'),
  checks: f('checks'),
  flaky: f('flaky'),
  waits: f('waits'),
  handBacks: f('handBacks'),
  models: f('models'),
})

export const init = (): Model => ({
  project: Option.none(),
  tokensBy: 'run',
  summary: AsyncData.Idle(),
  tables: eachPanel(() => AsyncData.Idle()),
})

export const Message = defineMessageUnion({
  SelectedTokensBy: { by: TokensBy },
  PressedRefresh: {},
  SucceededLoadSummary: {
    project: Schema.Option(EngineProject),
    summary: InsightsSummary,
  },
  FailedLoadSummary: {
    project: Schema.Option(EngineProject),
    reason: Schema.String,
  },
  SucceededQuery: {
    panel: Panel,
    scope: Schema.Option(EngineProject),
    query: InsightsQuery,
    table: InsightsTable,
  },
  FailedQuery: {
    panel: Panel,
    scope: Schema.Option(EngineProject),
    query: InsightsQuery,
    reason: Schema.String,
  },
})
export type Message = typeof Message.Type

// Commands: each a request to the engine, its failure in words.

export const LoadSummary = Command.define('LoadSummary', {
  args: { project: Schema.Option(EngineProject) },
  messages: [Message.SucceededLoadSummary, Message.FailedLoadSummary],
  execute: ({ project }) =>
    requestScope(project, client =>
      client.rpc['insights.summary']({
        project: Option.map(project, scoped => scoped.project),
        since,
      }),
    ).pipe(
      Effect.map(summary => Message.SucceededLoadSummary({ project, summary })),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedLoadSummary({ project, reason })),
      ),
    ),
})

/** Asks `scope`'s engine `query`, for `panel`. */
export const RunQuery = Command.define('RunQuery', {
  args: {
    panel: Panel,
    scope: Schema.Option(EngineProject),
    query: InsightsQuery,
  },
  messages: [Message.SucceededQuery, Message.FailedQuery],
  execute: ({ panel, scope, query }) =>
    requestScope(scope, client =>
      client.rpc['insights.query']({ query }),
    ).pipe(
      Effect.map(table =>
        Message.SucceededQuery({ panel, scope, query, table }),
      ),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedQuery({ panel, scope, query, reason })),
      ),
    ),
})

/** What the screen's Commands need: the engines' connections. */
export type Requires = EngineServices

type Return = Update.Return<Model, Message, Requires>

/**
 * Asks again for what `model` shows of `scope`: the same scope's data kept meanwhile, another's
 * asked afresh, a request in flight left to answer, and a panel that needs a project left idle.
 */
const asked = (model: Model, scope: Scope): Return => {
  const kept =
    sameScope(model.project, scope.project) && model.tokensBy === scope.tokensBy
  const next = <A>(
    data: AsyncData.AsyncData<A, string>,
  ): Option.Option<AsyncData.AsyncData<A, string>> =>
    kept ? AsyncData.revalidateOrLoad(data) : Option.some(AsyncData.Loading())
  const summary = next(model.summary)
  const tables = eachPanel(panel =>
    Option.match(queryOf(panel, scope), {
      onNone: () => ({ data: AsyncData.Idle(), ask: Option.none() }),
      onSome: query =>
        Option.match(next(model.tables[panel]), {
          onNone: () => ({ data: model.tables[panel], ask: Option.none() }),
          onSome: data => ({ data, ask: Option.some(query) }),
        }),
    }),
  )
  return {
    model: modifyFields(model, {
      project: () => scope.project,
      tokensBy: () => scope.tokensBy,
      summary: current => Option.getOrElse(summary, () => current),
      tables: () => eachPanel((panel): TableData => tables[panel].data),
    }),
    commands: [
      ...(Option.isSome(summary)
        ? [LoadSummary({ project: scope.project })]
        : []),
      ...Panel.literals.flatMap(panel =>
        Option.match(tables[panel].ask, {
          onNone: () => [],
          onSome: query => [
            RunQuery({ panel, scope: scope.project, query }),
          ],
        }),
      ),
    ],
  }
}

/** As the screen opens, or its scope changes while it is shown: everything asked for `scope`. */
export const opened = (
  model: Model,
  scope: Option.Option<EngineProject>,
): Return =>
  asked(model, { project: scope, tokensBy: model.tokensBy })

/** Whether `query`, asked of `scope`'s engine, is still what `panel` shows. */
const shown = (
  model: Model,
  {
    panel,
    scope,
    query,
  }: {
    readonly panel: Panel
    readonly scope: Option.Option<EngineProject>
    readonly query: InsightsQuery
  },
): boolean =>
  sameScope(model.project, scope) &&
  Option.exists(queryOf(panel, model), current => sameQuery(current, query))

const settleTable = (
  model: Model,
  panel: Panel,
  result: Result.Result<InsightsTable, string>,
): Model =>
  modifyFields(model, {
    tables: tables =>
      eachPanel(each =>
        each === panel ? AsyncData.settle(tables[each], result) : tables[each],
      ),
  })

/** The tokens counted by `by` instead: their panel asked afresh, the others kept. */
const regrouped = (model: Model, by: TokensBy): Return => {
  const regroupedModel = modifyFields(model, {
    tokensBy: () => by,
    tables: tables =>
      modifyFields(tables, { tokens: () => AsyncData.Loading() }),
  })
  return {
    model: regroupedModel,
    commands: Option.match(queryOf('tokens', regroupedModel), {
      onNone: () => [],
      onSome: query => [
        RunQuery({ panel: 'tokens', scope: regroupedModel.project, query }),
      ],
    }),
  }
}

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    SelectedTokensBy: ({ by }) =>
      by === model.tokensBy ? { model } : regrouped(model, by),
    PressedRefresh: () => asked(model, model),
    SucceededLoadSummary: ({ project, summary }) => ({
      model: sameScope(model.project, project)
        ? modifyFields(model, {
            summary: current =>
              AsyncData.settle(current, Result.succeed(summary)),
          })
        : model,
    }),
    FailedLoadSummary: ({ project, reason }) => ({
      model: sameScope(model.project, project)
        ? modifyFields(model, {
            summary: current => AsyncData.settle(current, Result.fail(reason)),
          })
        : model,
    }),
    SucceededQuery: ({ panel, scope, query, table }) => ({
      model: shown(model, { panel, scope, query })
        ? settleTable(model, panel, Result.succeed(table))
        : model,
    }),
    FailedQuery: ({ panel, scope, query, reason }) => ({
      model: shown(model, { panel, scope, query })
        ? settleTable(model, panel, Result.fail(reason))
        : model,
    }),
  })

// The figures, each in its unit.

/** Dollars as the screen writes them: `$4.20`, `<$0.01` for a cost under a cent, `$0` for none. */
export const sayUsd = (usd: number): string =>
  usd === 0 ? '$0' : usd < 0.005 ? '<$0.01' : `$${usd.toFixed(2)}`

/** A length of time in milliseconds: `340ms` under a second, else as the console says one (`3m 05s`). */
export const sayMillis = (millis: number): string =>
  millis < 1000
    ? `${Math.round(millis)}ms`
    : sayDuration(Math.floor(millis / 1000))

/** A share from 0 to 1, as a whole percentage. */
export const sayShare = (share: number): string => `${Math.round(share * 100)}%`

/** A number in `unit`; a `time`, milliseconds since the epoch, in the viewer's zone where it is known. */
const sayNumber = (
  value: number,
  unit: ColumnUnit,
  today: Option.Option<DateTime.Zoned>,
): string =>
  Match.value(unit).pipe(
    Match.when('text', () => String(value)),
    Match.when('count', () => String(value)),
    Match.when('millis', () => sayMillis(value)),
    Match.when('usd', () => sayUsd(value)),
    Match.when('tokens', () => sayTokens(value)),
    Match.when('share', () => sayShare(value)),
    Match.when('time', () => {
      const at = DateTime.makeUnsafe(value)
      return Option.match(today, {
        onNone: () => DateTime.formatIso(at),
        onSome: now => sayMoment(at, now),
      })
    }),
    Match.exhaustive,
  )

/** A cell in its column's unit: text as it is, a missing value as a dash. */
export const sayCell = (
  cell: InsightsCell,
  unit: ColumnUnit,
  today: Option.Option<DateTime.Zoned>,
): string =>
  Option.match(cell, {
    onNone: () => '—',
    onSome: value =>
      typeof value === 'string' ? value : sayNumber(value, unit, today),
  })

// The view.

/** What the screen draws beside its own Model: the scope's name and the time now. */
export interface ViewInputs {
  /** The scoped project's name; none for every project. */
  readonly projectName: Option.Option<string>
  /** The time now in the viewer's zone, for the moments a table holds. */
  readonly today: Option.Option<DateTime.Zoned>
}

const card =
  'flex min-w-0 flex-col gap-10 rounded-card border border-line bg-panel'
const cardStyle = { padding: '12px 16px' }

const problemLine = <M>(text: string, h: HtmlBuilder<M>): Html =>
  h.p([h.Role('alert'), h.Class('text-xs text-c3')], [text])

const quiet = <M>(text: string, h: HtmlBuilder<M>): Html =>
  h.p([h.Class('text-xs text-muted')], [text])

/** Where asking again failed and the last answer is still shown: why, beside it. */
const staleLine = <A, M>(
  data: AsyncData.AsyncData<A, string>,
  h: HtmlBuilder<M>,
): Html =>
  AsyncData.isStale(data)
    ? problemLine(`It couldn't be read again: ${data.error}`, h)
    : h.empty

const numeric = (unit: ColumnUnit): boolean => unit !== 'text'

/** A query's answer as a table: its columns as headers, each cell in its column's unit. */
const tableView = <M>(
  label: string,
  table: InsightsTable,
  today: Option.Option<DateTime.Zoned>,
  h: HtmlBuilder<M>,
): Html =>
  table.rows.length === 0
    ? quiet('Nothing recorded yet.', h)
    : h.div(
        [h.Class('min-w-0 overflow-auto')],
        [
          h.table(
            [h.AriaLabel(label), h.Class('w-full text-xs')],
            [
              h.thead(
                [],
                [
                  h.tr(
                    [],
                    table.columns.map(column =>
                      h.th(
                        [
                          h.Scope('col'),
                          h.Class(
                            `border-b border-line py-4 pr-12 font-bold text-muted ${numeric(column.unit) ? 'text-right' : 'text-left'}`,
                          ),
                        ],
                        [column.name],
                      ),
                    ),
                  ),
                ],
              ),
              h.tbody(
                [],
                table.rows.map(row =>
                  h.tr(
                    [],
                    Array.zipWith(
                      table.columns,
                      row,
                      (column: InsightsColumn, cell) =>
                        h.td(
                          [
                            h.Class(
                              `border-b border-line py-4 pr-12 ${numeric(column.unit) ? 'text-right font-mono' : 'text-left'}`,
                            ),
                          ],
                          [sayCell(cell, column.unit, today)],
                        ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      )

/** The tokens' grouping: one button per choice, the one shown pressed. */
const tokensBySwitch = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Role('group'), h.AriaLabel('Count by'), h.Class('flex gap-8')],
    TokensBy.literals.map(by =>
      h.keyed('button')(
        by,
        [
          h.Type('button'),
          h.AriaPressed(by === model.tokensBy ? 'true' : 'false'),
          h.OnClick(Message.SelectedTokensBy({ by })),
          h.Class(
            by === model.tokensBy
              ? 'rounded-button border border-c1 px-10 py-4 text-xs font-bold text-fg'
              : 'rounded-button border border-line px-10 py-4 text-xs text-muted',
          ),
        ],
        [tokensByTitle[by]],
      ),
    ),
  )

const panelView = (
  model: Model,
  panel: Panel,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('section')(
    panel,
    [
      h.AriaLabel(panelTitle[panel]),
      h.DataAttribute('panel', panel),
      h.Class(card),
      h.Style(cardStyle),
    ],
    [
      h.div(
        [h.Class('flex items-center gap-12')],
        [
          h.h2([h.Class('text-sm font-extrabold')], [panelTitle[panel]]),
          ...(panel === 'tokens' ? [tokensBySwitch(model, h)] : []),
        ],
      ),
      quiet(panelAbout[panel], h),
      Option.isNone(queryOf(panel, model))
        ? quiet(
            'Choose a project in the sidebar to see where its time goes.',
            h,
          )
        : AsyncData.matchData(model.tables[panel], {
            onEmpty: () => quiet('Asking the engine…', h),
            onFailure: reason =>
              problemLine(`It couldn't be read: ${reason}`, h),
            onData: table =>
              tableView(panelTitle[panel], table, inputs.today, h),
          }),
      staleLine(model.tables[panel], h),
    ],
  )

/** One of the summary's figures: its value in its role's colour, its label muted. */
const figure = (
  {
    name,
    value,
    label,
    role,
  }: {
    readonly name: string
    readonly value: string
    readonly label: string
    readonly role: string
  },
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Role('group'),
      h.AriaLabel(`${label} ${value}`),
      h.DataAttribute('figure', name),
      h.Class('flex items-baseline gap-8 border-r border-line'),
      h.Style({ padding: '10px 18px' }),
    ],
    [
      h.span(
        [h.Class(`font-extrabold ${role}`), h.Style({ fontSize: '20px' })],
        [value],
      ),
      h.span([h.Class('text-xs font-bold text-muted')], [label]),
    ],
  )

const figures = (
  summary: InsightsSummary,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  figure(
    {
      name: 'runs',
      value: String(summary.runs),
      label: 'Runs',
      role: 'text-c1',
    },
    h,
  ),
  figure(
    {
      name: 'merged',
      value: String(summary.merged),
      label: 'Merged',
      role: 'text-c4',
    },
    h,
  ),
  figure(
    {
      name: 'set-aside',
      value: String(summary.setAside),
      label: 'Set aside',
      role: 'text-c3',
    },
    h,
  ),
  figure(
    {
      name: 'hand-backs',
      value: String(summary.handBacks.resolve + summary.handBacks.fix),
      label: `Hand-backs (${summary.handBacks.resolve} to resolve, ${summary.handBacks.fix} to fix)`,
      role: 'text-c2',
    },
    h,
  ),
  figure(
    {
      name: 'tokens',
      value: sayTokens(
        Object.values(summary.tokens).reduce(
          (total, tokens) => total + tokenTotal(tokens),
          0,
        ),
      ),
      label: 'Tokens',
      role: 'text-c5',
    },
    h,
  ),
  figure(
    {
      name: 'cost',
      value: Option.match(summary.costUsd, {
        onNone: () => '—',
        onSome: sayUsd,
      }),
      label: 'Cost',
      role: 'text-c5',
    },
    h,
  ),
  figure(
    {
      name: 'ready-to-merged',
      value: Option.match(summary.readyToMerged, {
        onNone: () => '—',
        onSome: sayMillis,
      }),
      label: 'Ready to merged, median',
      role: 'text-c1',
    },
    h,
  ),
]

const summaryView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [
      h.AriaLabel('Summary'),
      h.Class('rounded-card border border-line bg-panel'),
    ],
    [
      AsyncData.matchData(model.summary, {
        onEmpty: () =>
          h.div([h.Style(cardStyle)], [quiet('Asking the engine…', h)]),
        onFailure: reason =>
          h.div(
            [h.Style(cardStyle)],
            [problemLine(`The summary couldn't be read: ${reason}`, h)],
          ),
        onData: summary =>
          h.div([h.Class('flex flex-wrap')], figures(summary, h)),
      }),
      AsyncData.isStale(model.summary)
        ? h.div([h.Style(cardStyle)], [staleLine(model.summary, h)])
        : h.empty,
    ],
  )

export const view = defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  h.div(
    [h.Class('flex min-h-0 flex-1 flex-col gap-16 overflow-auto')],
    [
      h.div(
        [h.Class('flex items-center gap-12')],
        [
          h.p(
            [h.Class('text-xs font-bold text-muted')],
            [
              `${Option.getOrElse(inputs.projectName, () => 'Every project')} · all time`,
            ],
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.PressedRefresh()),
              h.Class(
                'ml-auto rounded-button border border-line px-10 py-4 text-xs font-bold text-fg',
              ),
            ],
            ['Refresh'],
          ),
        ],
      ),
      summaryView(model, h),
      h.div(
        [
          h.Class('grid gap-16'),
          h.Style({ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }),
        ],
        Panel.literals.map(panel => panelView(model, panel, inputs, h)),
      ),
    ],
  ),
)
