import { DateTime, Option, Schema } from 'effect'
import * as AsyncData from 'foldkit/asyncData'
import {
  Command as SceneCommand,
  click,
  expect as expectScene,
  given as givenScene,
  role,
  scene,
  text,
  within,
} from 'foldkit/scene'
import { given, message, model, story } from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import {
  EngineId,
  InsightsQuery,
  InsightsSummary,
  InsightsTable,
  ProjectId,
  ProjectStatus,
  StreamEpoch,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Insights from '../src/screens/insights'

// The Insights screen (spec §18.4, §21): the scope's telemetry, a summary and a panel per named query
// of the Insights group, each drawn from the table the engine answers, its cells in their columns'
// units. What it asks follows the scope and the tokens' grouping; an answer for a query no longer
// shown is dropped.

const project = ProjectId.make('p-1')
const other = ProjectId.make('p-2')
const engine = EngineId.make('e-1')
const flags = { platform: 'darwin' as const, release: '0.0.0' }

/** Thursday 29 October 2026, 12:00 UTC. */
const at = Date.UTC(2026, 9, 29, 12, 0, 0)
const today = DateTime.makeZonedUnsafe(at, { timeZone: 'UTC' })

const row = Schema.decodeUnknownSync(ProjectStatus)({
  project: 'p-1',
  name: 'fabrica',
  base: 'main',
  setUp: true,
  trusted: true,
  run: { _tag: 'idle' },
  ready: 0,
})

/** The app connected to its local engine, the one project `fabrica` in the sidebar, scoped to it. */
const connected = (): Model => {
  const up: Model = {
    ...initialModel(flags),
    today: Option.some(today),
    connection: Connection.Up({
      engine,
      release: '0.1.0',
      protocol: protocolVersion,
    }),
  }
  const withProject = update(
    up,
    Message.ReceivedProjects({
      engine,
      name: 'local',
      items: [
        {
          _tag: 'snapshot',
          epoch: StreamEpoch.make('epoch-1'),
          seq: 0,
          value: [row],
        },
      ],
    }),
  ).model
  return update(
    withProject,
    Message.SelectedScope({ project: Option.some(project) }),
  ).model
}

const table = Schema.decodeUnknownSync(InsightsTable)

const summary = Schema.decodeUnknownSync(InsightsSummary)({
  runs: 3,
  merged: 21,
  setAside: 2,
  handBacks: { resolve: 1, fix: 4 },
  tokens: {
    'anthropic/claude-opus-5-5': {
      input: 1_000_000,
      output: 150_000,
      cache_write: 30_000,
      cache_read: 20_000,
    },
  },
  costUsd: 31.5,
  readyToMerged: 1_260_000,
})

/** Each panel's answer, one column of every unit among them. */
const tables: Record<Insights.Panel, InsightsTable> = {
  tokens: table({
    columns: [
      { name: 'Run', unit: 'text' },
      { name: 'Model', unit: 'text' },
      { name: 'Tokens in', unit: 'tokens' },
      { name: 'Tokens out', unit: 'tokens' },
      { name: 'Cost', unit: 'usd' },
    ],
    rows: [
      ['r-7', 'anthropic/claude-opus-5-5', 1_200_000, 34_000, 4.2],
      ['r-7', 'openai/gpt-6', 512, 80, 0.001],
    ],
  }),
  cost: table({
    columns: [
      { name: 'Run', unit: 'text' },
      { name: 'Merged', unit: 'count' },
      { name: 'Per ticket', unit: 'usd' },
    ],
    rows: [['r-7', 3, 4.2]],
  }),
  phases: table({
    columns: [
      { name: 'Phase', unit: 'text' },
      { name: 'Time', unit: 'millis' },
      { name: 'Share', unit: 'share' },
    ],
    rows: [
      ['working', 2_520_000, 0.6],
      ['the merge queue', 340, 0.15],
      ['holds', null, null],
    ],
  }),
  checks: table({
    columns: [
      { name: 'Suite', unit: 'text' },
      { name: 'Runs', unit: 'count' },
      { name: 'Failed', unit: 'count' },
      { name: 'Median', unit: 'millis' },
    ],
    rows: [['merge', 21, 2, 185_000]],
  }),
  flaky: table({
    columns: [
      { name: 'Test', unit: 'text' },
      { name: 'Flakes', unit: 'count' },
      { name: 'Last', unit: 'time' },
    ],
    rows: [['look.test.ts > draws the console', 3, at - 7_200_000]],
  }),
  waits: table({
    columns: [
      { name: 'Kind', unit: 'text' },
      { name: 'Asked', unit: 'count' },
      { name: 'Median wait', unit: 'millis' },
    ],
    rows: [['question', 4, 3_725_000]],
  }),
  handBacks: table({
    columns: [
      { name: 'Outcome', unit: 'text' },
      { name: 'Tickets', unit: 'count' },
      { name: 'Rate', unit: 'share' },
    ],
    rows: [
      ['handed back', 5, 0.24],
      ['set aside', 2, 0.095],
    ],
  }),
  models: table({
    columns: [
      { name: 'Model', unit: 'text' },
      { name: 'Tickets', unit: 'count' },
      { name: 'Median', unit: 'millis' },
      { name: 'Per ticket', unit: 'usd' },
    ],
    rows: [['anthropic/claude-opus-5-5', 12, 1_260_000, 1.5]],
  }),
}

const scope = (
  scoped: Option.Option<ProjectId>,
  tokensBy: Insights.TokensBy = 'run',
) => ({ project: scoped, tokensBy })

const queryOf = (
  panel: Insights.Panel,
  scoped: Option.Option<ProjectId> = Option.some(project),
  tokensBy: Insights.TokensBy = 'run',
): InsightsQuery =>
  Option.getOrThrow(Insights.queryOf(panel, scope(scoped, tokensBy)))

const insightsMessage = (message: Insights.Message): Message =>
  Message.GotInsightsMessage({ message })

/** The app on the Insights screen, every panel answered with its fixture table. */
const onScreen = (start: Model = connected()): Model =>
  Insights.Panel.literals.reduce(
    (shown, panel) =>
      update(
        shown,
        insightsMessage(
          Insights.Message.SucceededQuery({
            panel,
            query: queryOf(panel),
            table: tables[panel],
          }),
        ),
      ).model,
    update(
      update(start, Message.RequestedScreen({ screen: Screen.Insights() }))
        .model,
      insightsMessage(
        Insights.Message.SucceededLoadSummary({
          project: Option.some(project),
          summary,
        }),
      ),
    ).model,
  )

/** Commands by their names and arguments, which compare where the Commands' effects don't. */
const namesAndArgs = (
  commands: ReadonlyArray<{
    readonly name: string
    readonly args?: unknown
  }> = [],
) => commands.map(command => [command.name, command.args])

const panel = (name: Insights.Panel) =>
  role('region', { name: Insights.panelTitle[name] })

describe('the queries asked of the engine', () => {
  test("as the screen opens: the scope's summary and every panel's named query", () => {
    const opened = Insights.opened(Insights.init(), Option.some(project))
    expect(namesAndArgs(opened.commands)).toStrictEqual([
      ['LoadSummary', { project: Option.some(project) }],
      ...Insights.Panel.literals.map(name => [
        'RunQuery',
        { panel: name, query: queryOf(name) },
      ]),
    ])
    expect(queryOf('tokens')).toStrictEqual(
      InsightsQuery.cases.tokens_by_model.make({
        project: Option.some(project),
        since: Option.none(),
        by: 'run',
      }),
    )
    expect(queryOf('phases')).toStrictEqual(
      InsightsQuery.cases.ticket_time.make({
        project,
        ticket: Option.none(),
        run: Option.none(),
      }),
    )
    // The screen entered from the root asks the same, lifted.
    const entered = update(
      connected(),
      Message.RequestedScreen({ screen: Screen.Insights() }),
    )
    expect(entered.commands?.map(command => command.name)).toStrictEqual([
      'LoadSummary',
      ...Insights.Panel.literals.map(() => 'RunQuery'),
    ])
  })

  test('with every project in scope, time per phase, which needs a project, is not asked', () => {
    const opened = Insights.opened(Insights.init(), Option.none())
    expect(
      opened.commands?.flatMap(command =>
        command.name === 'RunQuery' ? [command.args?.panel] : [],
      ),
    ).toStrictEqual(Insights.Panel.literals.filter(name => name !== 'phases'))
    expect(opened.model.tables.phases._tag).toBe('Idle')
    scene(
      { update, view },
      givenScene(
        update(onScreen(), Message.SelectedScope({ project: Option.none() }))
          .model,
      ),
      expectScene(text('Every project · all time')).toExist(),
      expectScene(
        within(
          panel('phases'),
          text('Choose a project in the sidebar to see where its time goes.'),
        ),
      ).toExist(),
    )
  })

  test("an answer for another scope's query is dropped; the scope's own is shown", () => {
    story(
      Insights.update,
      given(Insights.opened(Insights.init(), Option.some(project)).model),
      message(
        Insights.Message.SucceededQuery({
          panel: 'checks',
          query: queryOf('checks', Option.some(other)),
          table: tables.checks,
        }),
      ),
      message(
        Insights.Message.SucceededLoadSummary({
          project: Option.some(other),
          summary,
        }),
      ),
      model(shown => {
        expect(shown.tables.checks._tag).toBe('Loading')
        expect(shown.summary._tag).toBe('Loading')
      }),
      message(
        Insights.Message.SucceededQuery({
          panel: 'checks',
          query: queryOf('checks'),
          table: tables.checks,
        }),
      ),
      model(shown => {
        expect(shown.tables.checks).toStrictEqual(
          AsyncData.succeed(tables.checks),
        )
      }),
    )
  })

  test('another project chosen while the screen is shown: its telemetry asked afresh, nothing of the last kept', () => {
    const rescoped = update(
      onScreen(),
      Message.SelectedScope({ project: Option.some(other) }),
    )
    const insights = rescoped.model.screens.insights
    expect(insights.project).toStrictEqual(Option.some(other))
    expect(insights.summary._tag).toBe('Loading')
    expect(insights.tables.tokens._tag).toBe('Loading')
    expect(
      rescoped.commands?.flatMap(command =>
        command.name === 'RunQuery' && command.args?.panel === 'tokens'
          ? [command.args.query]
          : [],
      ),
    ).toStrictEqual([queryOf('tokens', Option.some(other))])
  })

  test('Refresh asks again, what is shown kept meanwhile', () => {
    const refreshed = Insights.update(
      onScreen().screens.insights,
      Insights.Message.PressedRefresh(),
    )
    expect(refreshed.model.summary._tag).toBe('Refreshing')
    expect(refreshed.model.tables.models._tag).toBe('Refreshing')
    expect(refreshed.commands).toHaveLength(1 + Insights.Panel.literals.length)
    // A request still in flight isn't asked twice.
    const again = Insights.update(
      refreshed.model,
      Insights.Message.PressedRefresh(),
    )
    expect(again.commands).toStrictEqual([])
  })
})

describe('tokens and cost, by run, ticket or project', () => {
  test('choosing Ticket asks the tokens again by ticket; an answer by run, come late, is dropped', () => {
    const byTicket = queryOf('tokens', Option.some(project), 'ticket')
    const ticketTable = table({
      columns: [
        { name: 'Ticket', unit: 'text' },
        { name: 'Model', unit: 'text' },
        { name: 'Cost', unit: 'usd' },
      ],
      rows: [['fa-11', 'anthropic/claude-opus-5-5', 0.75]],
    })
    const tokens = panel('tokens')
    scene(
      { update, view },
      givenScene(onScreen()),
      expectScene(within(tokens, role('button', { name: 'Run' }))).toHaveAttr(
        'aria-pressed',
        'true',
      ),
      click(within(tokens, role('button', { name: 'Ticket' }))),
      SceneCommand.expectExact(
        Insights.RunQuery({ panel: 'tokens', query: byTicket }),
      ),
      expectScene(
        within(tokens, role('button', { name: 'Ticket' })),
      ).toHaveAttr('aria-pressed', 'true'),
      expectScene(within(tokens, text('Asking the engine…'))).toExist(),
      SceneCommand.resolve(
        Insights.RunQuery({ panel: 'tokens', query: byTicket }),
        Insights.Message.SucceededQuery({
          panel: 'tokens',
          query: byTicket,
          table: ticketTable,
        }),
      ),
      expectScene(
        within(tokens, role('table', { name: 'Tokens and cost' })),
      ).toContainText('fa-11anthropic/claude-opus-5-5$0.75'),
    )
    const late = update(
      update(
        onScreen(),
        insightsMessage(Insights.Message.SelectedTokensBy({ by: 'ticket' })),
      ).model,
      insightsMessage(
        Insights.Message.SucceededQuery({
          panel: 'tokens',
          query: queryOf('tokens'),
          table: tables.tokens,
        }),
      ),
    )
    expect(late.model.screens.insights.tables.tokens._tag).toBe('Loading')
  })
})

describe('each panel drawn from its query’s answer', () => {
  test('the summary: runs, merged, set aside, hand-backs, tokens, cost and the median ready to merged', () => {
    const figures = role('region', { name: 'Summary' })
    scene(
      { update, view },
      givenScene(onScreen()),
      expectScene(text('fabrica · all time')).toExist(),
      ...[
        'Runs 3',
        'Merged 21',
        'Set aside 2',
        'Hand-backs (1 to resolve, 4 to fix) 5',
        'Tokens 1.2M',
        'Cost $31.50',
        'Ready to merged, median 21m 00s',
      ].map(name =>
        expectScene(within(figures, role('group', { name }))).toExist(),
      ),
    )
  })

  test('every table, each cell in its column’s unit', () => {
    const tableOf = (name: Insights.Panel) =>
      within(panel(name), role('table', { name: Insights.panelTitle[name] }))
    scene(
      { update, view },
      givenScene(onScreen()),
      expectScene(tableOf('tokens')).toContainText(
        'RunModelTokens inTokens outCost',
      ),
      expectScene(tableOf('tokens')).toContainText(
        'r-7anthropic/claude-opus-5-51.2M34k$4.20',
      ),
      expectScene(tableOf('tokens')).toContainText(
        'r-7openai/gpt-651280<$0.01',
      ),
      expectScene(tableOf('cost')).toContainText('r-73$4.20'),
      expectScene(tableOf('phases')).toContainText('working42m 00s60%'),
      expectScene(tableOf('phases')).toContainText('the merge queue340ms15%'),
      expectScene(tableOf('phases')).toContainText('holds——'),
      expectScene(tableOf('checks')).toContainText('merge2123m 05s'),
      expectScene(tableOf('flaky')).toContainText(
        'look.test.ts > draws the console310:00',
      ),
      expectScene(tableOf('waits')).toContainText('question41h 02m'),
      expectScene(tableOf('handBacks')).toContainText('handed back524%'),
      expectScene(tableOf('handBacks')).toContainText('set aside210%'),
      expectScene(tableOf('models')).toContainText(
        'anthropic/claude-opus-5-51221m 00s$1.50',
      ),
    )
  })

  test('a panel the engine answers with no rows says so; one it fails says why, its last answer kept', () => {
    const empty = update(
      onScreen(),
      insightsMessage(
        Insights.Message.SucceededQuery({
          panel: 'flaky',
          query: queryOf('flaky'),
          table: table({ columns: [{ name: 'Test', unit: 'text' }], rows: [] }),
        }),
      ),
    ).model
    const failedAgain = update(
      empty,
      insightsMessage(
        Insights.Message.FailedQuery({
          panel: 'models',
          query: queryOf('models'),
          reason: 'the engine is not connected',
        }),
      ),
    ).model
    scene(
      { update, view },
      givenScene(failedAgain),
      expectScene(
        within(panel('flaky'), text('Nothing recorded yet.')),
      ).toExist(),
      expectScene(
        within(panel('models'), role('table', { name: 'Models compared' })),
      ).toContainText('anthropic/claude-opus-5-5'),
      expectScene(within(panel('models'), role('alert'))).toHaveText(
        "It couldn't be read again: the engine is not connected",
      ),
    )
    const failedFirst = Insights.Panel.literals.reduce(
      (shown, name) =>
        update(
          shown,
          insightsMessage(
            Insights.Message.FailedQuery({
              panel: name,
              query: queryOf(name),
              reason: 'insights.query is not served yet',
            }),
          ),
        ).model,
      update(
        update(
          connected(),
          Message.RequestedScreen({ screen: Screen.Insights() }),
        ).model,
        insightsMessage(
          Insights.Message.FailedLoadSummary({
            project: Option.some(project),
            reason: 'insights.summary is not served yet',
          }),
        ),
      ).model,
    )
    scene(
      { update, view },
      givenScene(failedFirst),
      expectScene(
        within(role('region', { name: 'Summary' }), role('alert')),
      ).toHaveText(
        "The summary couldn't be read: insights.summary is not served yet",
      ),
      ...Insights.Panel.literals.map(name =>
        expectScene(within(panel(name), role('alert'))).toHaveText(
          "It couldn't be read: insights.query is not served yet",
        ),
      ),
    )
  })
})

describe('a cell in its unit', () => {
  test('numbers as the console says them, a missing value a dash, text as it is', () => {
    const say = (
      cell: number | string | null,
      unit: Parameters<typeof Insights.sayCell>[1],
    ) => Insights.sayCell(Option.fromNullishOr(cell), unit, Option.some(today))
    expect(say(null, 'usd')).toBe('—')
    expect(say('n/a', 'millis')).toBe('n/a')
    expect(say(12, 'count')).toBe('12')
    expect(say(999, 'millis')).toBe('999ms')
    expect(say(12_000, 'millis')).toBe('12s')
    expect(say(0, 'usd')).toBe('$0')
    expect(say(0.004, 'usd')).toBe('<$0.01')
    expect(say(1.256, 'usd')).toBe('$1.26')
    expect(say(34_000, 'tokens')).toBe('34k')
    expect(say(0.333, 'share')).toBe('33%')
    expect(say(at - 86_400_000, 'time')).toBe('Wed 28 Oct 12:00')
    expect(Insights.sayCell(Option.some(at), 'time', Option.none())).toBe(
      '2026-10-29T12:00:00.000Z',
    )
  })
})
