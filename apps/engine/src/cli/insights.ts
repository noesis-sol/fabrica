import { Data, DateTime, Effect, Option } from 'effect'
import { Argument, Command, Flag } from 'effect/cli'
import * as NodePath from 'node:path'

import type { EngineClientShape } from '@fabrica/client'
import {
  CheckSuite,
  type ColumnUnit,
  type InsightsCell,
  InsightsQuery,
  type InsightsQueryName,
  InsightsSummary,
  InsightsTable,
  ProjectId,
  RunId,
  TicketId,
  formatDurationMillis,
} from '@fabrica/contracts'

import { withEngine } from './connect'
import { printAnswer } from './output'
import { sanitiseLine } from './sanitise'
import { projectHolding } from './tickets-project'

// `fabrica insights [<query>]` (spec §19, §21): the engine's telemetry summed up, or one of its named
// queries as a table. A query is about `--project <id>`, or every project where none is given; where
// a ticket's time goes is about one project, the one whose checkout holds this folder where none is
// given. `--since <time>` leaves out what came before it. No SQL is sent: the engine runs the query
// named. Values the engine sends are sanitised for the terminal.

/** The engine refused what the command asked, or the command can't tell what it was asked. */
export class InsightsRefused extends Data.TaggedError('InsightsRefused')<{
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

const refused = (reason: string) => new InsightsRefused({ reason })

/** The named queries, each with what it answers, as the help lists them. */
const queries: { readonly [K in InsightsQueryName]: string } = {
  ticket_time:
    "where a ticket's time goes: phases, checks by suite, questions, hand-backs, holds",
  waits: 'how long questions and permission requests waited',
  check_durations: 'check durations and failures, by suite',
  flaky_tests: 'tests that failed and passed on the same tree',
  cost_per_merged_ticket: 'cost per merged ticket, by run',
  tokens_by_model: 'tokens and cost per model, by run, ticket or project',
  hand_back_rates: 'hand-back and set-aside rates',
  models_compared: 'models compared on tickets of a type',
}

const queryNames = Object.keys(queries).filter(
  (name): name is InsightsQueryName => Object.hasOwn(queries, name),
)

/** An ID read from a flag, or the refusal that it isn't one. */
const idOf = <A>(
  what: string,
  make: (text: string) => Option.Option<A>,
  given: Option.Option<string>,
) =>
  Option.match(given, {
    onNone: () => Effect.succeed(Option.none<A>()),
    onSome: text =>
      Option.match(make(text), {
        onNone: () =>
          Effect.fail(refused(`${sanitiseLine(text)} isn't a ${what}'s ID`)),
        onSome: id => Effect.succeed(Option.some(id)),
      }),
  })

/** The project `--project` names, or the one whose checkout holds the folder the command runs in. */
const projectHere = (
  client: EngineClientShape,
  given: Option.Option<ProjectId>,
) =>
  Option.match(given, {
    onSome: Effect.succeed,
    onNone: () =>
      Effect.gen(function* () {
        const folder = NodePath.resolve('.')
        const projects = yield* client.rpc['projects.list']()
        return yield* Option.match(projectHolding(projects, folder), {
          onNone: () =>
            Effect.fail(
              refused(
                `no project's checkout holds ${sanitiseLine(folder)}: name one with --project <id>, as \`fabrica project list\` gives it`,
              ),
            ),
          onSome: ({ id }) => Effect.succeed(id),
        })
      }),
  })

/** A cell as the terminal shows it, by its column's unit. */
const cellText = (cell: InsightsCell, unit: ColumnUnit): string =>
  Option.match(cell, {
    onNone: () => '-',
    onSome: value => {
      if (typeof value === 'string') return sanitiseLine(value)
      switch (unit) {
        case 'millis':
          return formatDurationMillis(Math.round(value))
        case 'usd':
          return `$${value.toFixed(2)}`
        case 'share':
          return `${Math.round(value * 100)}%`
        case 'time':
          return DateTime.formatIso(DateTime.makeUnsafe(value))
        case 'text':
        case 'count':
        case 'tokens':
          return String(value)
      }
    },
  })

/** The table as aligned columns under their names; a word where it has no rows. */
export const tableText = (table: InsightsTable): string => {
  if (table.rows.length === 0) return 'nothing recorded yet'
  const lines = [
    table.columns.map(({ name }) => sanitiseLine(name)),
    ...table.rows.map(row =>
      table.columns.map((column, index) =>
        cellText(row[index] ?? Option.none(), column.unit),
      ),
    ),
  ]
  const widths = table.columns.map((_, column) =>
    Math.max(...lines.map(line => line[column]?.length ?? 0)),
  )
  return lines
    .map(line =>
      line
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

/** The summary as labelled lines. */
export const summaryText = (summary: InsightsSummary): string => {
  const models = Object.entries(summary.tokens).map(
    ([model, tokens]) =>
      `  ${sanitiseLine(model)}: ${tokens.input} in, ${tokens.output} out, ${tokens.cache_write} cache write, ${tokens.cache_read} cache read`,
  )
  return [
    `runs             ${summary.runs}`,
    `merged           ${summary.merged}`,
    `set aside        ${summary.setAside}`,
    `hand-backs       ${summary.handBacks.resolve} resolve, ${summary.handBacks.fix} fix`,
    `ready to merged  ${Option.match(summary.readyToMerged, {
      onNone: () => '-',
      onSome: millis => `${formatDurationMillis(millis)} (median)`,
    })}`,
    `cost             ${Option.match(summary.costUsd, {
      onNone: () => 'not priced',
      onSome: cost => `$${cost.toFixed(2)}`,
    })}`,
    models.length === 0 ? 'tokens           none' : 'tokens',
    ...models,
  ].join('\n')
}

/** The named query `name` with the flags' parameters. */
const queryOf = (
  client: EngineClientShape,
  name: InsightsQueryName,
  flags: {
    readonly project: Option.Option<ProjectId>
    readonly since: Option.Option<DateTime.Utc>
    readonly ticket: Option.Option<TicketId>
    readonly run: Option.Option<RunId>
    readonly suite: Option.Option<CheckSuite>
    readonly by: 'run' | 'ticket' | 'project'
  },
): Effect.Effect<InsightsQuery, InsightsRefused | Error> => {
  const { project, since } = flags
  switch (name) {
    case 'ticket_time':
      return Effect.map(projectHere(client, project), here =>
        InsightsQuery.cases.ticket_time.make({
          project: here,
          ticket: flags.ticket,
          run: flags.run,
        }),
      )
    case 'waits':
      return Effect.succeed(InsightsQuery.cases.waits.make({ project, since }))
    case 'check_durations':
      return Effect.succeed(
        InsightsQuery.cases.check_durations.make({
          project,
          since,
          suite: flags.suite,
        }),
      )
    case 'flaky_tests':
      return Effect.succeed(
        InsightsQuery.cases.flaky_tests.make({ project, since }),
      )
    case 'cost_per_merged_ticket':
      return Effect.succeed(
        InsightsQuery.cases.cost_per_merged_ticket.make({ project, since }),
      )
    case 'tokens_by_model':
      return Effect.succeed(
        InsightsQuery.cases.tokens_by_model.make({
          project,
          since,
          by: flags.by,
        }),
      )
    case 'hand_back_rates':
      return Effect.succeed(
        InsightsQuery.cases.hand_back_rates.make({ project, since }),
      )
    case 'models_compared':
      return Effect.succeed(
        InsightsQuery.cases.models_compared.make({ project, since }),
      )
  }
}

export const insights = Command.make(
  'insights',
  {
    query: Argument.Literals('query', queryNames).pipe(
      Argument.withDescription(
        `A named query: ${queryNames.map(name => `${name} (${queries[name]})`).join('; ')}; the summary where none is given`,
      ),
      Argument.optional,
    ),
    project: Flag.String('project').pipe(
      Flag.withDescription(
        "The project's ID; every project where it isn't given (for ticket_time, the one whose checkout holds this folder)",
      ),
      Flag.optional,
    ),
    since: Flag.Date('since').pipe(
      Flag.withDescription(
        'Leaves out what came before this time: 2026-10-25, or 2026-10-25T10:00:00Z',
      ),
      Flag.optional,
    ),
    ticket: Flag.String('ticket').pipe(
      Flag.withDescription("ticket_time: this ticket's alone"),
      Flag.optional,
    ),
    run: Flag.String('run').pipe(
      Flag.withDescription("ticket_time: this run's alone"),
      Flag.optional,
    ),
    suite: Flag.Literals('suite', CheckSuite.literals).pipe(
      Flag.withDescription("check_durations: this suite's alone"),
      Flag.optional,
    ),
    by: Flag.Literals('by', ['run', 'ticket', 'project'] as const).pipe(
      Flag.withDescription('tokens_by_model: what the tokens are summed by'),
      Flag.withDefault('ticket' as const),
    ),
  },
  flags =>
    Effect.gen(function* () {
      const project = yield* idOf(
        'project',
        ProjectId.makeOption,
        flags.project,
      )
      const ticket = yield* idOf('ticket', TicketId.makeOption, flags.ticket)
      const run = yield* idOf('run', RunId.makeOption, flags.run)
      const since = Option.flatMap(flags.since, date => DateTime.make(date))
      yield* withEngine(client =>
        Option.match(flags.query, {
          onNone: () =>
            client.rpc['insights.summary']({ project, since }).pipe(
              Effect.flatMap(value =>
                printAnswer({
                  schema: InsightsSummary,
                  value,
                  text: summaryText,
                }),
              ),
            ),
          onSome: name =>
            queryOf(client, name, {
              project,
              since,
              ticket,
              run,
              suite: flags.suite,
              by: flags.by,
            }).pipe(
              Effect.flatMap(query => client.rpc['insights.query']({ query })),
              Effect.flatMap(value =>
                printAnswer({ schema: InsightsTable, value, text: tableText }),
              ),
            ),
        }),
      ).pipe(
        Effect.catchTag('ProjectNotFound', ({ project: missing }) =>
          Effect.fail(
            refused(`the engine has no project ${sanitiseLine(missing)}`),
          ),
        ),
      )
    }),
).pipe(Command.withDescription('Telemetry summaries and the named queries'))
