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
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import {
  AttentionRequest,
  CommitHash,
  Diff,
  EngineId,
  ProjectId,
  Report,
  RunEntry,
  RunId,
  TicketDetail,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'

import { dayOf } from '../src/app/clock'
import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { type Model, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Review from '../src/screens/review'

// A set-aside ticket's notes and the project's past reports on the Review screen (spec §18.3, §18.4):
// the ticket's Review shows its notes, where the worker, the verifier or triage said why it was set
// aside, beside its diff; the Report view lists the project's runs, newest first, and reads the report
// of the one chosen. Answers for a ticket, a report or a project no longer shown are dropped.

const project = ProjectId.make('p-1')
const scoped: EngineProject = { engine: localEngineName, project }
const other: EngineProject = { ...scoped, project: ProjectId.make('p-2') }
const ticket = TicketId.make('fa-11')
const last = RunId.make('r-7')
const earlier = RunId.make('r-6')

/** Thursday 29 October 2026, 12:00 UTC. */
const at = Date.UTC(2026, 9, 29, 12, 0, 0)

const today = dayOf(DateTime.makeZonedUnsafe(at, { timeZone: 'Europe/Athens' }))

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(scoped),
  today: Option.some(today),
}

const reviewCard = Schema.decodeUnknownSync(
  Schema.toCodecJson(AttentionRequest),
)({
  _tag: 'review',
  project,
  ticket,
  title: 'Refresh tokens rotate',
  reason: 'CHECKS_FAILED',
  openedAt: at - 3_600_000,
})

const detail = Schema.decodeUnknownSync(Schema.toCodecJson(TicketDetail))({
  ticket: {
    id: ticket,
    type: 'feature',
    title: 'Refresh tokens rotate',
    description: 'Rotate the refresh token on every use.',
    design: null,
    acceptance: null,
    status: 'open',
    resolution: null,
    priority: 2,
    deferUntil: null,
    assignee: null,
    model: null,
    metadata: {},
    result: null,
    question: null,
    mergedCommit: null,
    closeReason: null,
    createdAt: at - 7_200_000,
    updatedAt: at - 3_600_000,
  },
  labels: [],
  edges: [],
  notes: [
    {
      id: 'n-1',
      ticketId: ticket,
      author: { _tag: 'worker', session: 's-1' },
      body: 'The merge check fails on src/auth/refresh.test.ts.',
      at: at - 3_900_000,
    },
    {
      id: 'n-2',
      ticketId: ticket,
      author: { _tag: 'organ', organ: 'triage' },
      body: 'Set aside: the test expects a 60s ttl.',
      at: at - 3_600_000,
    },
  ],
})

const diff = Diff.make({
  base: CommitHash.make('a'.repeat(40)),
  head: CommitHash.make('b'.repeat(40)),
  files: [],
})

const runs = [
  RunEntry.make({ run: last, startedAt: DateTime.makeUnsafe(at - 600_000) }),
  // Wednesday 28 October, 09:00 UTC.
  RunEntry.make({
    run: earlier,
    startedAt: DateTime.makeUnsafe(at - 27 * 3_600_000),
  }),
]

const reportOf = (run: RunId, markdown: string) =>
  Report.make({ run, markdown, writtenAt: DateTime.makeUnsafe(at) })

const ticketSubject = Review.Subject.Ticket({ project: scoped, ticket })

/** Commands by their names and arguments, which tell them apart. */
const named = (
  commands: ReadonlyArray<{
    readonly name: string
    readonly args: unknown
  }> = [],
) => commands.map(({ name, args }) => ({ name, args }))

describe("a set-aside ticket's notes", () => {
  test('its Review shows its notes beside its diff, each with who wrote it and when', () => {
    scene(
      { update, view },
      givenScene({
        ...connected,
        attention: Option.some([reviewCard]),
        engineAttention: [{ engine: localEngineName, requests: [reviewCard] }],
      }),
      click(role('button', { name: 'Review' })),
      SceneCommand.expectExact(
        Review.LoadDiff({ subject: ticketSubject }),
        Review.LoadTicket({ project: scoped, ticket }),
        Review.LoadRuns({ project: scoped }),
        Review.LoadReport({ project: scoped, run: Option.none() }),
        Review.LoadLog({ project: scoped }),
      ),
      expectScene(
        within(
          role('complementary', { name: 'Notes on fa-11' }),
          text('Reading the ticket…'),
        ),
      ).toExist(),
      SceneCommand.resolveAll(
        [
          Review.LoadDiff,
          Review.Message.SucceededLoadDiff({ subject: ticketSubject, diff }),
        ],
        [
          Review.LoadTicket,
          Review.Message.SucceededLoadTicket({
            project: scoped,
            ticket,
            detail,
          }),
        ],
        [
          Review.LoadRuns,
          Review.Message.SucceededLoadRuns({ project: scoped, runs }),
        ],
        [
          Review.LoadReport,
          Review.Message.SucceededLoadReport({
            project: scoped,
            run: Option.none(),
            report: reportOf(last, '# Run r-7'),
          }),
        ],
        [
          Review.LoadLog,
          Review.Message.SucceededLoadLog({ project: scoped, lines: [] }),
        ],
      ),
      expectScene(role('heading', { name: "fa-11's branch" })).toExist(),
      expectScene(
        within(
          role('complementary', { name: 'Notes on fa-11' }),
          text('Refresh tokens rotate'),
        ),
      ).toExist(),
      expectScene(
        within(
          role('complementary', { name: 'Notes on fa-11' }),
          text('Worker · 12:55'),
        ),
      ).toExist(),
      expectScene(
        within(
          role('complementary', { name: 'Notes on fa-11' }),
          text('The merge check fails on src/auth/refresh.test.ts.'),
        ),
      ).toExist(),
      expectScene(
        within(
          role('complementary', { name: 'Notes on fa-11' }),
          text('Triage · 13:00'),
        ),
      ).toExist(),
      expectScene(
        within(
          role('complementary', { name: 'Notes on fa-11' }),
          text('Set aside: the test expects a 60s ttl.'),
        ),
      ).toExist(),
    )
  })

  test("a ticket that can't be read says why; a run's diff shows no notes, and a late answer for the ticket is dropped", () => {
    story(
      Review.update,
      given(
        Review.openTicket(Review.init(), { project: scoped, ticket }).model,
      ),
      model(shown => {
        expect(AsyncData.isPending(shown.ticket)).toBe(true)
      }),
      message(
        Review.Message.FailedLoadTicket({
          project: scoped,
          ticket,
          reason: 'the engine is not connected',
        }),
      ),
      model(shown => {
        expect(AsyncData.getError(shown.ticket)).toEqual(
          Option.some('the engine is not connected'),
        )
      }),
      message(Review.Message.RequestedRunDiff({ project: scoped, run: last })),
      Command.expectExact(
        Review.LoadDiff({
          subject: Review.Subject.Run({ project: scoped, run: last }),
        }),
      ),
      Command.resolve(
        Review.LoadDiff,
        Review.Message.FailedLoadDiff({
          subject: Review.Subject.Run({ project: scoped, run: last }),
          reason: 'the engine is not connected',
        }),
      ),
      message(
        Review.Message.SucceededLoadTicket({ project: scoped, ticket, detail }),
      ),
      model(shown => {
        expect(shown.ticket).toEqual(AsyncData.Idle())
      }),
    )
  })

  test('opening the same ticket again keeps its notes while they are read afresh', () => {
    const opened = Review.openTicket(Review.init(), {
      project: scoped,
      ticket,
    })
    const read = Review.update(
      opened.model,
      Review.Message.SucceededLoadTicket({ project: scoped, ticket, detail }),
    ).model
    const again = Review.openTicket(read, { project: scoped, ticket })
    expect(AsyncData.getData(again.model.ticket)).toEqual(Option.some(detail))
    expect(AsyncData.isPending(again.model.ticket)).toBe(true)
    expect(named(again.commands)).toContainEqual(
      named([Review.LoadTicket({ project: scoped, ticket })])[0],
    )
  })
})

describe("the project's runs and their reports", () => {
  test("the Report view lists the runs, newest first, the last one's report shown; choosing another reads its report", () => {
    scene(
      { update, view },
      givenScene(connected),
      click(role('button', { name: /^Search tickets and sessions/u })),
      click(role('button', { name: /^Go to Review/u })),
      SceneCommand.expectExact(
        Review.LoadRuns({ project: scoped }),
        Review.LoadReport({ project: scoped, run: Option.none() }),
        Review.LoadLog({ project: scoped }),
      ),
      SceneCommand.resolveAll(
        [
          Review.LoadRuns,
          Review.Message.SucceededLoadRuns({ project: scoped, runs }),
        ],
        [
          Review.LoadReport,
          Review.Message.SucceededLoadReport({
            project: scoped,
            run: Option.none(),
            report: reportOf(last, '# Run r-7\n\nAll merged.'),
          }),
        ],
        [
          Review.LoadLog,
          Review.Message.SucceededLoadLog({ project: scoped, lines: [] }),
        ],
      ),
      click(role('button', { name: 'Report' })),
      expectScene(
        within(
          role('navigation', { name: 'Runs' }),
          role('button', { name: /^r-7/u }),
        ),
      ).toHaveAttr('aria-pressed', 'true'),
      expectScene(
        within(
          role('navigation', { name: 'Runs' }),
          role('button', { name: /^r-6/u }),
        ),
      ).toHaveText('r-6Wed 28 Oct 11:00'),
      click(
        within(
          role('navigation', { name: 'Runs' }),
          role('button', { name: /^r-6/u }),
        ),
      ),
      SceneCommand.expectExact(
        Review.LoadReport({ project: scoped, run: Option.some(earlier) }),
      ),
      expectScene(text("Reading run r-6's report…")).toExist(),
      expectScene(
        within(
          role('navigation', { name: 'Runs' }),
          role('button', { name: /^r-6/u }),
        ),
      ).toHaveAttr('aria-pressed', 'true'),
      SceneCommand.resolve(
        Review.LoadReport,
        Review.Message.SucceededLoadReport({
          project: scoped,
          run: Option.some(earlier),
          report: reportOf(earlier, '# Run r-6\n\n1 set aside.'),
        }),
      ),
      expectScene(
        within(
          role('article', { name: 'Report of run r-6' }),
          text(/1 set aside\./u),
        ),
      ).toExist(),
    )
  })

  test("a run with no report says so; an answer for a report no longer chosen is dropped; the choice holds for the project's next visit", () => {
    const opened = Review.opened(Review.init(), {
      project: Option.some(scoped),
      run: Option.none(),
    }).model
    story(
      Review.update,
      given(opened),
      message(Review.Message.SelectedRun({ run: earlier })),
      Command.expectExact(
        Review.LoadReport({ project: scoped, run: Option.some(earlier) }),
      ),
      Command.resolve(
        Review.LoadReport,
        Review.Message.FailedLoadReport({
          project: scoped,
          run: Option.some(earlier),
          reason: "Run r-6 hasn't written its report yet.",
        }),
      ),
      // The last run's report, asked for as the screen opened, answers late.
      message(
        Review.Message.SucceededLoadReport({
          project: scoped,
          run: Option.none(),
          report: reportOf(last, '# Run r-7'),
        }),
      ),
      model(shown => {
        expect(shown.reportRun).toEqual(Option.some(earlier))
        expect(AsyncData.getError(shown.report)).toEqual(
          Option.some("Run r-6 hasn't written its report yet."),
        )
      }),
      // Choosing the run shown asks for nothing.
      message(Review.Message.SelectedRun({ run: earlier })),
      Command.expectNone(),
      // Another project's runs, answering late, change nothing.
      message(Review.Message.SucceededLoadRuns({ project: other, runs })),
      model(shown => {
        expect(AsyncData.isPending(shown.runs)).toBe(true)
      }),
    )
    const chosen = Review.update(
      opened,
      Review.Message.SelectedRun({ run: earlier }),
    ).model
    const back = Review.opened(chosen, {
      project: Option.some(scoped),
      run: Option.none(),
    })
    expect(back.model.reportRun).toEqual(Option.some(earlier))
    expect(named(back.commands)).toContainEqual(
      named([
        Review.LoadReport({ project: scoped, run: Option.some(earlier) }),
      ])[0],
    )
    const elsewhere = Review.opened(chosen, {
      project: Option.some(other),
      run: Option.none(),
    })
    expect(elsewhere.model.reportRun).toEqual(Option.none())
    expect(named(elsewhere.commands)).toContainEqual(
      named([Review.LoadReport({ project: other, run: Option.none() })])[0],
    )
  })

  test('a project with no run lists none', () => {
    scene(
      { update, view },
      givenScene(connected),
      click(role('button', { name: /^Search tickets and sessions/u })),
      click(role('button', { name: /^Go to Review/u })),
      SceneCommand.resolveAll(
        [
          Review.LoadRuns,
          Review.Message.SucceededLoadRuns({ project: scoped, runs: [] }),
        ],
        [
          Review.LoadReport,
          Review.Message.FailedLoadReport({
            project: scoped,
            run: Option.none(),
            reason: 'The project has had no run yet.',
          }),
        ],
        [
          Review.LoadLog,
          Review.Message.SucceededLoadLog({ project: scoped, lines: [] }),
        ],
      ),
      click(role('button', { name: 'Report' })),
      expectScene(
        within(role('navigation', { name: 'Runs' }), text('No run yet.')),
      ).toExist(),
      expectScene(role('alert')).toHaveText('The project has had no run yet.'),
    )
  })
})
