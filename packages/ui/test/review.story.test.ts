import { DateTime, Option, Schema } from 'effect'
import * as AsyncData from 'foldkit/asyncData'
import {
  Mount,
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
  FileDiff,
  ProjectId,
  Report,
  RunId,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection } from '../src/app/connection'
import { type Model, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import { diffColoursOf, sidesOf } from '../src/mounts/diff'
import * as Review from '../src/screens/review'
import themesCss from '../src/theme/themes.css?raw'

// The Review screen (spec §18.4, §18.3): a set-aside ticket's Review opens its branch diff, each file
// in Monaco's diff view, its sides rebuilt from the patch; the screen reached from navigation shows the
// scoped project's last report and its log, and a report opens its run's merged diff. Answers for a
// diff or a project no longer shown are dropped; a file Monaco can't draw is shown as its patch.

const project = ProjectId.make('p-1')
const ticket = TicketId.make('fa-11')
const run = RunId.make('r-7')

/** Thursday 29 October 2026, 12:00 UTC. */
const at = Date.UTC(2026, 9, 29, 12, 0, 0)

const base = CommitHash.make('a'.repeat(40))
const head = CommitHash.make('b'.repeat(40))

const refreshPatch = [
  'diff --git a/src/auth/refresh.ts b/src/auth/refresh.ts',
  'index 1111111..2222222 100644',
  '--- a/src/auth/refresh.ts',
  '+++ b/src/auth/refresh.ts',
  '@@ -1,3 +1,3 @@',
  " import { rotate } from './rotate'",
  '-export const ttl = 60',
  '+export const ttl = 600',
  ' export const refresh = rotate',
  '@@ -20,2 +20,3 @@ export const revoke',
  ' revoke()',
  '+log()',
  ' done()',
  '',
].join('\n')

const refresh = FileDiff.make({
  path: 'src/auth/refresh.ts',
  change: 'modified',
  from: Option.none(),
  patch: refreshPatch,
})

const logo = FileDiff.make({
  path: 'assets/logo.png',
  change: 'added',
  from: Option.none(),
  patch: [
    'diff --git a/assets/logo.png b/assets/logo.png',
    'new file mode 100644',
    'Binary files /dev/null and b/assets/logo.png differ',
    '',
  ].join('\n'),
})

const ticketDiff = Diff.make({ base, head, files: [refresh, logo] })

const report = Report.make({
  run,
  markdown: '# Run r-7\n\n3 tickets merged, 1 set aside.',
  writtenAt: DateTime.makeUnsafe(at),
})

const ticketSubject = Review.Subject.Ticket({ project, ticket })
const runSubject = Review.Subject.Run({ project, run })

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(project),
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

const refreshSides = {
  original: [
    '@@ -1,3 +1,3 @@',
    "import { rotate } from './rotate'",
    'export const ttl = 60',
    'export const refresh = rotate',
    '@@ -20,2 +20,3 @@ export const revoke',
    'revoke()',
    'done()',
  ].join('\n'),
  modified: [
    '@@ -1,3 +1,3 @@',
    "import { rotate } from './rotate'",
    'export const ttl = 600',
    'export const refresh = rotate',
    '@@ -20,2 +20,3 @@ export const revoke',
    'revoke()',
    'log()',
    'done()',
  ].join('\n'),
}

const refreshMount = Review.ShowDiff({
  path: refresh.path,
  key: 'ticket/fa-11',
  ...refreshSides,
})

describe("a set-aside ticket's diff", () => {
  test("its card's Review opens its branch diff, each file in Monaco's diff view", () => {
    scene(
      { update, view },
      givenScene({ ...connected, attention: Option.some([reviewCard]) }),
      click(role('button', { name: 'Review' })),
      expectScene(role('heading', { name: 'Review', level: 1 })).toExist(),
      SceneCommand.expectExact(
        Review.LoadDiff({ subject: ticketSubject }),
        Review.LoadReport({ project }),
        Review.LoadLog({ project }),
      ),
      expectScene(text('Reading the diff…')).toExist(),
      SceneCommand.resolveAll(
        [
          Review.LoadDiff,
          Review.Message.SucceededLoadDiff({
            subject: ticketSubject,
            diff: ticketDiff,
          }),
        ],
        [
          Review.LoadReport,
          Review.Message.SucceededLoadReport({ project, report }),
        ],
        [
          Review.LoadLog,
          Review.Message.SucceededLoadLog({
            project,
            lines: ['12:00 dispatched fa-11', '12:20 set aside fa-11'],
          }),
        ],
      ),
      expectScene(role('heading', { name: "fa-11's branch" })).toExist(),
      expectScene(text('2 files · aaaaaaa → bbbbbbb')).toExist(),
      expectScene(
        within(
          role('navigation', { name: 'Changed files' }),
          role('button', { name: /src\/auth\/refresh\.ts/u }),
        ),
      ).toHaveAttr('aria-pressed', 'true'),
      expectScene(
        role('region', { name: 'Diff of src/auth/refresh.ts' }),
      ).toExist(),
      Mount.expectExact(refreshMount),
      Mount.resolve(refreshMount, Review.Message.CompletedShowDiff()),
      // A binary file has no hunks for Monaco: its patch is shown as text.
      click(role('button', { name: /assets\/logo\.png/u })),
      Mount.expectEnded(refreshMount),
      expectScene(role('region', { name: /Diff of/u })).toBeAbsent(),
      expectScene(
        text(/Binary files \/dev\/null and b\/assets\/logo\.png differ/u),
      ).toExist(),
      Mount.expectNone(),
    )
  })

  test('a ticket with no branch says why; an answer for a diff no longer shown is dropped', () => {
    story(
      Review.update,
      given(Review.openTicket(Review.init(), { project, ticket }).model),
      message(
        Review.Message.FailedLoadDiff({
          subject: ticketSubject,
          reason:
            'fa-11 has no branch: it was never dispatched, or its worktree is gone.',
        }),
      ),
      model(shown => {
        expect(AsyncData.getError(shown.diff)).toEqual(
          Option.some(
            'fa-11 has no branch: it was never dispatched, or its worktree is gone.',
          ),
        )
      }),
      message(Review.Message.RequestedRunDiff({ project, run })),
      Command.expectExact(Review.LoadDiff({ subject: runSubject })),
      // The ticket's diff, answering late, is not the run's.
      Command.resolve(
        Review.LoadDiff,
        Review.Message.SucceededLoadDiff({
          subject: ticketSubject,
          diff: ticketDiff,
        }),
      ),
      model(shown => {
        expect(shown.subject).toEqual(Option.some(runSubject))
        expect(AsyncData.isPending(shown.diff)).toBe(true)
      }),
    )
  })

  test("a file Monaco can't draw is shown as its patch, with why", () => {
    const opened = Review.openTicket(Review.init(), { project, ticket }).model
    story(
      Review.update,
      given(opened),
      message(
        Review.Message.SucceededLoadDiff({
          subject: ticketSubject,
          diff: ticketDiff,
        }),
      ),
      message(
        Review.Message.FailedShowDiff({
          path: refresh.path,
          reason: 'workers are refused',
        }),
      ),
      model(shown => {
        expect(shown.viewProblem).toEqual(Option.some('workers are refused'))
      }),
      // Choosing another file tries Monaco again.
      message(Review.Message.SelectedFile({ path: logo.path })),
      model(shown => {
        expect(shown.viewProblem).toEqual(Option.none())
        expect(Option.map(shown.file, path => path)).toEqual(
          Option.some(logo.path),
        )
      }),
    )
  })
})

describe('reports and the log', () => {
  test("from navigation: the scope's last report, which opens its run's merged diff, and the log", () => {
    scene(
      { update, view },
      givenScene(connected),
      click(role('button', { name: /^Search tickets and sessions/u })),
      click(role('button', { name: /^Go to Review/u })),
      SceneCommand.expectExact(
        Review.LoadReport({ project }),
        Review.LoadLog({ project }),
      ),
      expectScene(
        text(/a set-aside ticket's Review opens its branch/u),
      ).toExist(),
      SceneCommand.resolveAll(
        [
          Review.LoadReport,
          Review.Message.SucceededLoadReport({ project, report }),
        ],
        [
          Review.LoadLog,
          Review.Message.SucceededLoadLog({
            project,
            lines: ['12:00 run r-7 started', '12:40 run r-7 ended'],
          }),
        ],
      ),
      click(role('button', { name: 'Report' })),
      expectScene(
        within(
          role('article', { name: 'Report of run r-7' }),
          text(/3 tickets merged, 1 set aside\./u),
        ),
      ).toExist(),
      click(role('button', { name: "The run's merged diff" })),
      SceneCommand.expectExact(Review.LoadDiff({ subject: runSubject })),
      expectScene(role('heading', { name: 'What run r-7 merged' })).toExist(),
      SceneCommand.resolve(
        Review.LoadDiff,
        Review.Message.SucceededLoadDiff({
          subject: runSubject,
          diff: Diff.make({ base, head, files: [refresh] }),
        }),
      ),
      Mount.expectExact(
        Review.ShowDiff({
          path: refresh.path,
          key: 'run/r-7',
          ...refreshSides,
        }),
      ),
      Mount.resolve(Review.ShowDiff, Review.Message.CompletedShowDiff()),
      // The log's key shows it; Read again asks for it afresh.
      click(role('button', { name: 'Log' })),
      Mount.expectEnded(Review.ShowDiff),
      expectScene(text(/12:40 run r-7 ended/u)).toExist(),
      click(role('button', { name: 'Read again' })),
      SceneCommand.expectExact(Review.LoadLog({ project })),
      SceneCommand.resolve(
        Review.LoadLog,
        Review.Message.FailedLoadLog({
          project,
          reason: 'the engine is not connected',
        }),
      ),
      expectScene(role('alert')).toHaveText(
        "The log couldn't be read: the engine is not connected",
      ),
    )
  })

  test('a project with no run yet says so', () => {
    story(
      Review.update,
      given(
        Review.opened(Review.init(), {
          project: Option.some(project),
          run: Option.none(),
        }).model,
      ),
      message(
        Review.Message.FailedLoadReport({
          project,
          reason: 'The project has had no run yet.',
        }),
      ),
      // Another project's answer, arriving late, changes nothing.
      message(
        Review.Message.SucceededLoadReport({
          project: ProjectId.make('p-2'),
          report,
        }),
      ),
      model(shown => {
        expect(AsyncData.getError(shown.report)).toEqual(
          Option.some('The project has had no run yet.'),
        )
      }),
    )
  })

  test('with every project and none shown before, the screen asks for a project', () => {
    const opened = Review.opened(Review.init(), {
      project: Option.none(),
      run: Option.none(),
    })
    expect(opened.model).toEqual(Review.init())
    expect(opened.commands).toBeUndefined()
  })
})

describe("the diff view's sides and colours", () => {
  test("a patch's hunks make both sides, each hunk under its header", () => {
    expect(sidesOf(refresh)).toEqual(Option.some(refreshSides))
  })

  test('a patch with no hunk has no sides', () => {
    expect(sidesOf(logo)).toEqual(Option.none())
  })

  test("every theme's tokens give Monaco its colours, as hex", () => {
    for (const theme of ['lichen-bright', 'classic', 'neon-grid'] as const) {
      const colours = Option.getOrThrow(diffColoursOf(themesCss, theme))
      for (const value of Object.values(colours)) {
        expect(value).toMatch(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/u)
      }
    }
  })
})
