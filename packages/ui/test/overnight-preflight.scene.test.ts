import { DateTime, Option, Schema } from 'effect'
import {
  Command,
  click,
  expect as expectScene,
  given,
  role,
  scene,
  selector,
  within,
} from 'foldkit/scene'
import {
  Command as StoryCommand,
  given as givenStory,
  message,
  model,
  story,
} from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import {
  AttentionRequest,
  EngineId,
  Preflight,
  PreflightChoices,
  ProjectId,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Stats from '../src/console/stats'
import * as TalkPanel from '../src/console/talk-panel'

// An overnight run's pre-flight checklist in the stats row (spec §15.6): Overnight asks the engine for
// the pre-flight before anything starts, shows its refusals to fix or override, its warnings with their
// fixes and the ready and question-only counts, then its questions in the answer talk, naming those
// left with what they hold; the start carries the fixes chosen, so a cancelled checklist changes nothing.

const project = ProjectId.make('p-1')

/** Thursday 29 October 2026, 22:00 UTC. */
const at = Date.UTC(2026, 9, 29, 22, 0, 0)
const now = DateTime.makeZonedUnsafe(at, { timeZone: 'Europe/Athens' })

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(project),
  now: Option.some(now),
}

const decodePreflight = Schema.decodeUnknownSync(Schema.toCodecJson(Preflight))

/** concurrent and the disk refused, three warnings, two questions. */
const preflight = decodePreflight({
  refusals: [
    {
      check: 'concurrent_low',
      text: 'concurrent is 1',
      fix: 'set concurrent to 2',
    },
    {
      check: 'free_disk',
      text: '12 GB free, under overnight.min_free_disk (20 GB)',
      fix: null,
    },
  ],
  warnings: [
    {
      check: 'usage_limit_wait',
      text: 'usage_limit_wait is 1h',
      fix: 'set usage_limit_wait to 5h',
    },
    { check: 'battery', text: 'the host is on battery', fix: null },
  ],
  questions: ['fa-q1', 'fa-q2'],
  ready: 7,
  waitingOnQuestions: 1,
})

const clear = decodePreflight({
  refusals: [],
  warnings: [],
  questions: [],
  ready: 3,
  waitingOnQuestions: 0,
})

const decodeRequest = Schema.decodeUnknownSync(
  Schema.toCodecJson(AttentionRequest),
)

const questionOf = (ticket: string, title: string, blocks: Array<string>) =>
  decodeRequest({
    _tag: 'question',
    project,
    ticket,
    title,
    description: null,
    choices: null,
    consequential: false,
    maintainerOnly: false,
    blocks,
    askedFrom: null,
    openedAt: at - 60_000,
  })

const q1 = questionOf('fa-q1', 'Which store keeps the sessions?', [
  'fa-7',
  'fa-8',
])
const q2 = questionOf('fa-q2', 'Keep the old login page?', ['fa-9'])

const checklistOf = (
  checklist: Stats.Checklist,
  base: Model = connected,
): Model => ({
  ...base,
  console: {
    ...base.console,
    stats: { ...Stats.init(), checklist },
  },
})

const answering = (attention: ReadonlyArray<AttentionRequest>): Model => ({
  ...checklistOf(
    Stats.Checklist.Answering({
      project,
      preflight,
      fix: ['concurrent_low'],
      override: ['free_disk'],
    }),
  ),
  attention: Option.some(attention),
})

const statsMessage = (child: Stats.Message) =>
  Message.GotStatsMessage({ message: child })

const checklist = role('region', { name: 'Overnight pre-flight' })

describe('the overnight pre-flight', () => {
  test('Overnight asks for the pre-flight, starting nothing, and shows its refusals, warnings and counts', () => {
    scene(
      { update, view },
      given(connected),
      click(role('button', { name: 'Start run' })),
      click(role('menuitem', { name: 'Overnight' })),
      expectScene(within(checklist, role('status'))).toHaveText(
        'Running the pre-flight…',
      ),
      Command.resolve(
        Stats.CheckPreflight({ project }),
        Stats.Message.SucceededPreflight({ project, preflight }),
      ),
      expectScene(selector('[data-check="concurrent_low"]')).toContainText(
        'concurrent is 1',
      ),
      expectScene(selector('[data-check="concurrent_low"]')).toHaveAttr(
        'data-tone',
        'stop',
      ),
      expectScene(selector('[data-check="battery"]')).toHaveAttr(
        'data-tone',
        'warning',
      ),
      // Every offered fix chosen to begin with; the disk has none and stands until overridden.
      expectScene(
        role('checkbox', { name: 'Fix: set concurrent to 2' }),
      ).toBeChecked(),
      expectScene(
        role('checkbox', { name: 'Fix: set usage_limit_wait to 5h' }),
      ).toBeChecked(),
      expectScene(selector('[data-preflight-counts]')).toHaveText(
        '7 tickets ready · 1 waits only on questions · 2 questions to answer',
      ),
      expectScene(within(checklist, role('status'))).toHaveText(
        'Fix or override 1 refusal to go on.',
      ),
      expectScene(
        role('button', { name: 'Answer 2 questions' }),
      ).toBeDisabled(),
      click(
        within(
          selector('[data-check="free_disk"]'),
          role('checkbox', { name: 'Override' }),
        ),
      ),
      expectScene(role('button', { name: 'Answer 2 questions' })).toBeEnabled(),
      // Unticking a refusal's fix leaves it standing again.
      click(role('checkbox', { name: 'Fix: set concurrent to 2' })),
      expectScene(
        role('button', { name: 'Answer 2 questions' }),
      ).toBeDisabled(),
    )
  })

  test('a refusal is fixed or overridden, never both', () => {
    story(
      update,
      givenStory(checklistOf(Stats.offered(project, preflight))),
      message(
        statsMessage(
          Stats.Message.ToggledOverride({ check: 'concurrent_low' }),
        ),
      ),
      model(shown => {
        const { checklist } = shown.console.stats
        expect(checklist._tag).toBe('Reviewing')
        if (Stats.Checklist.guards.Reviewing(checklist)) {
          expect(checklist.override).toEqual(['concurrent_low'])
          expect(checklist.fix).toEqual(['usage_limit_wait'])
        }
      }),
      message(
        statsMessage(Stats.Message.ToggledFix({ check: 'concurrent_low' })),
      ),
      model(shown => {
        const { checklist } = shown.console.stats
        if (Stats.Checklist.guards.Reviewing(checklist)) {
          expect(checklist.override).toEqual([])
          expect(checklist.fix).toEqual(['usage_limit_wait', 'concurrent_low'])
        }
      }),
    )
  })

  test('a pre-flight with nothing to answer starts at once, with the fixes and overrides chosen', () => {
    scene(
      { update, view },
      given(connected),
      click(role('button', { name: 'Start run' })),
      click(role('menuitem', { name: 'Overnight' })),
      Command.resolve(
        Stats.CheckPreflight({ project }),
        Stats.Message.SucceededPreflight({ project, preflight: clear }),
      ),
      expectScene(selector('[data-preflight-counts]')).toHaveText(
        '3 tickets ready · 0 wait only on questions · 0 questions to answer',
      ),
      click(role('button', { name: 'Start overnight' })),
      expectScene(checklist).toBeAbsent(),
      expectScene(role('button', { name: 'Starting…' })).toBeDisabled(),
      Command.resolve(
        Stats.StartOvernight({ project, fix: [], override: [] }),
        Stats.Message.SucceededStartRun({ project }),
      ),
    )
  })

  test('the questions go to the answer talk, and the start carries the choices once they are answered', () => {
    story(
      update,
      givenStory({ ...connected, attention: Option.some([q1, q2]) }),
      message(
        statsMessage(Stats.Message.ChoseMode({ project, mode: 'overnight' })),
      ),
      StoryCommand.resolve(
        Stats.CheckPreflight,
        Stats.Message.SucceededPreflight({ project, preflight }),
      ),
      message(
        statsMessage(Stats.Message.ToggledOverride({ check: 'free_disk' })),
      ),
      message(statsMessage(Stats.Message.ClickedContinue())),
      model(shown => {
        expect(shown.console.stats.checklist._tag).toBe('Answering')
        expect(shown.console.talkPanel.answer).toEqual(
          TalkPanel.Answer.Opening({ project }),
        )
      }),
      StoryCommand.expectExact(TalkPanel.OpenAnswerTalk({ project })),
      StoryCommand.resolve(
        TalkPanel.OpenAnswerTalk,
        TalkPanel.Message.FailedOpenAnswerTalk({ project, reason: 'not yet' }),
      ),
      message(statsMessage(Stats.Message.ClickedStartOvernight())),
      model(shown => {
        expect(shown.console.stats.checklist).toEqual(Stats.Checklist.None())
      }),
      StoryCommand.expectExact(
        Stats.StartOvernight({
          project,
          fix: ['concurrent_low', 'usage_limit_wait'],
          override: ['free_disk'],
        }),
      ),
      StoryCommand.resolve(
        Stats.StartOvernight,
        Stats.Message.SucceededStartRun({ project }),
      ),
    )
  })

  test('the start sends the pre-flight it went through with its flags', () => {
    expect(Stats.overnightFlags(['concurrent_low'], ['free_disk'])).toEqual({
      ...Stats.startFlags,
      preflight: Option.some(
        new PreflightChoices({
          fix: ['concurrent_low'],
          override: ['free_disk'],
        }),
      ),
    })
    expect(Stats.startFlags.preflight).toEqual(Option.none())
  })

  test('the questions still open are named with what they hold, and the start says it leaves them', () => {
    scene(
      { update, view },
      given(answering([q1, q2])),
      expectScene(within(checklist, role('status'))).toHaveText(
        '0 of 2 answered in the answer talk.',
      ),
      expectScene(selector('[data-question="fa-q1"]')).toHaveText(
        'fa-q1 Which store keeps the sessions? · holds fa-7, fa-8',
      ),
      expectScene(selector('[data-question="fa-q2"]')).toHaveText(
        'fa-q2 Keep the old login page? · holds fa-9',
      ),
      expectScene(
        role('button', { name: 'Start, leaving 2 questions open' }),
      ).toBeEnabled(),
    )
    scene(
      { update, view },
      given(answering([q2])),
      expectScene(within(checklist, role('status'))).toHaveText(
        '1 of 2 answered in the answer talk.',
      ),
      expectScene(selector('[data-question="fa-q1"]')).toBeAbsent(),
      expectScene(
        role('button', { name: 'Start, leaving 1 question open' }),
      ).toExist(),
    )
    scene(
      { update, view },
      given(answering([])),
      expectScene(within(checklist, role('status'))).toHaveText(
        'Every question is answered.',
      ),
      click(role('button', { name: 'Start overnight' })),
      Command.resolve(
        Stats.StartOvernight({
          project,
          fix: ['concurrent_low'],
          override: ['free_disk'],
        }),
        Stats.Message.SucceededStartRun({ project }),
      ),
    )
  })

  test('a cancelled checklist starts nothing and changes nothing', () => {
    story(
      update,
      givenStory(connected),
      message(
        statsMessage(Stats.Message.ChoseMode({ project, mode: 'overnight' })),
      ),
      StoryCommand.resolve(
        Stats.CheckPreflight,
        Stats.Message.SucceededPreflight({ project, preflight }),
      ),
      message(
        statsMessage(Stats.Message.ToggledOverride({ check: 'free_disk' })),
      ),
      message(statsMessage(Stats.Message.CancelledChecklist())),
      StoryCommand.expectNone(),
      model(shown => {
        expect(shown.console.stats).toEqual(Stats.init())
        expect(shown.runWatch).toBe(connected.runWatch)
      }),
      // A pre-flight arriving after the cancel is dropped.
      message(
        statsMessage(Stats.Message.SucceededPreflight({ project, preflight })),
      ),
      model(shown => {
        expect(shown.console.stats.checklist).toEqual(Stats.Checklist.None())
      }),
    )
    scene(
      { update, view },
      given(checklistOf(Stats.offered(project, preflight))),
      click(within(checklist, role('button', { name: 'Cancel' }))),
      expectScene(checklist).toBeAbsent(),
      expectScene(role('button', { name: 'Start run' })).toBeEnabled(),
    )
  })

  test("a pre-flight the engine couldn't give says why, and is asked again", () => {
    scene(
      { update, view },
      given(connected),
      click(role('button', { name: 'Start run' })),
      click(role('menuitem', { name: 'Overnight' })),
      Command.resolve(
        Stats.CheckPreflight({ project }),
        Stats.Message.FailedPreflight({
          project,
          reason: 'not connected to the engine',
        }),
      ),
      expectScene(within(checklist, role('status'))).toHaveText(
        'The pre-flight couldn’t run: not connected to the engine.',
      ),
      click(role('button', { name: 'Check again' })),
      Command.resolve(
        Stats.CheckPreflight({ project }),
        Stats.Message.SucceededPreflight({ project, preflight: clear }),
      ),
      expectScene(role('button', { name: 'Start overnight' })).toBeEnabled(),
      click(within(checklist, role('button', { name: 'Cancel' }))),
    )
  })

  test("another project's checklist isn't shown in this one's row", () => {
    scene(
      { update, view },
      given(checklistOf(Stats.offered(ProjectId.make('p-2'), preflight))),
      expectScene(checklist).toBeAbsent(),
    )
  })
})
