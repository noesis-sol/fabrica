import { DateTime, Option, Schema } from 'effect'
import {
  Command,
  all,
  click,
  expectAll,
  expect as expectScene,
  given,
  role,
  scene,
  selector,
  submit,
  text,
  type as typeInto,
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
  EngineId,
  NoRun,
  ProjectId,
  RunMode,
  RunRefused,
  RunView,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'

import { sayElapsed, sayMoment } from '../src/app/clock'
import { Connection } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Stats from '../src/console/stats'
import { waitForWords, waitingWords } from '../src/console/waiting'

// The console's stats row (spec §18.3, H80, H81; Appendix A.2), drawn from fixture run views: the
// counts in their role colours with the waiting tickets' reasons in words on hover, the run's
// controls in each state of the run, and the strip above it of holds and banners with when each
// lifts, the engine's steps with their elapsed time, and a request the engine refused.

const project = ProjectId.make('p-1')

/** Thursday 29 October 2026, 12:00 UTC: 14:00 in Athens. */
const at = Date.UTC(2026, 9, 29, 12, 0, 0)
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

const decodeRunView = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))

const row = (ticket: string, phase: unknown) => ({
  ticket,
  title: `Ticket ${ticket}`,
  type: 'task',
  priority: 2,
  phase,
  since: at - 60_000,
  startedAt: null,
  solo: false,
  handBacks: { resolve: 0, fix: 0 },
})

/** A run of 4 slots, all live: 23 done, 1 set aside, 2 needing the maintainer, 6 in the queue. */
const runJson = {
  header: {
    run: 'r-1',
    project,
    engine: 'e-1',
    mode: { _tag: 'tickets' },
    state: 'running',
    startedAt: at - 3_600_000,
    offline: false,
    autoAnswer: false,
  },
  totals: {
    live: 4,
    slots: 4,
    counts: {
      in_queue: 6,
      working: 4,
      waiting_to_merge: 1,
      needs_you: 2,
      set_aside: 1,
      carried_over: 0,
      done: 23,
    },
    tokens: {
      input: 200_000,
      output: 50_000,
      cache_write: 150_000,
      cache_read: 800_000,
    },
    costUsd: null,
  },
  tickets: [
    row('fa-7', { _tag: 'working' }),
    row('fa-8', { _tag: 'queued' }),
    row('fa-9', {
      _tag: 'held_back',
      reason: 'overlap',
      detail: 'touches src/auth/refresh.ts, like running fa-7',
    }),
    row('fa-10', {
      _tag: 'waiting',
      for: { _tag: 'merge', tickets: ['fa-12'] },
    }),
  ],
  workers: [],
  queue: { merging: null, train: null, waiting: [] },
  holds: [],
  banners: [],
  attention: [],
  load: null,
  steps: [],
}

const withRun = (
  overrides: Partial<Record<keyof typeof runJson, unknown>> = {},
  base: Model = connected,
): Model => ({
  ...base,
  runView: Option.some(decodeRunView({ ...runJson, ...overrides })),
})

const withHeader = (header: Partial<typeof runJson.header>): Model =>
  withRun({ header: { ...runJson.header, ...header } })

const statOf = (name: string) => selector(`[data-stat="${name}"]`)
const valueOf = (name: string) => within(statOf(name), selector('[data-value]'))
const strip = role('list', { name: 'Holds and banners' })
const controls = role('group', { name: 'Run controls' })

const statsMessage = (child: Stats.Message) =>
  Message.GotStatsMessage({ message: child })

describe('the counts', () => {
  test('each count in its role colour, workers live against the slots', () => {
    scene(
      { update, view },
      given(withRun()),
      expectScene(valueOf('live')).toHaveText('4 of 4'),
      expectScene(valueOf('live')).toHaveClass('text-c1'),
      expectScene(role('group', { name: 'Workers live 4 of 4' })).toExist(),
      expectScene(valueOf('done')).toHaveText('23'),
      expectScene(valueOf('done')).toHaveClass('text-c4'),
      expectScene(statOf('done')).toContainText('Done today'),
      expectScene(valueOf('set-aside')).toHaveText('1'),
      expectScene(valueOf('set-aside')).toHaveClass('text-c3'),
      expectScene(valueOf('needs-you')).toHaveText('2'),
      expectScene(valueOf('needs-you')).toHaveClass('text-c2'),
      expectScene(valueOf('in-queue')).toHaveText('6'),
      expectScene(valueOf('in-queue')).toHaveClass('text-c5'),
      expectScene(valueOf('tokens')).toHaveText('1.2M'),
      expectScene(valueOf('tokens')).toHaveClass('text-c5'),
    )
  })

  test('in queue says how many wait, and on hover each with why in words', () => {
    scene(
      { update, view },
      given(withRun()),
      expectScene(
        within(statOf('in-queue'), selector('[data-waiting]')),
      ).toHaveText('2 waiting'),
      expectScene(statOf('in-queue')).toHaveAttr(
        'title',
        'fa-9: touches src/auth/refresh.ts, like running fa-7\nfa-10: waits for fa-12 to merge',
      ),
    )
  })

  test('a queue with nothing waiting but for a slot has no hover', () => {
    scene(
      { update, view },
      given(withRun({ tickets: [row('fa-8', { _tag: 'queued' })] })),
      expectScene(
        within(statOf('in-queue'), selector('[data-waiting]')),
      ).toBeAbsent(),
      expectScene(statOf('in-queue')).not.toHaveAttr('title'),
    )
  })

  test('without a run the row says so, and has no counts', () => {
    scene(
      { update, view },
      given(connected),
      expectScene(text('No run')).toExist(),
      expectScene(statOf('live')).toBeAbsent(),
    )
  })

  test('tokens are written as the handoff does', () => {
    expect(Stats.sayTokens(512)).toBe('512')
    expect(Stats.sayTokens(34_400)).toBe('34k')
    expect(Stats.sayTokens(2_500)).toBe('2.5k')
    expect(Stats.sayTokens(1_200_000)).toBe('1.2M')
    expect(Stats.sayTokens(2_000_000)).toBe('2M')
  })
})

describe('the waiting words', () => {
  test("a held-back ticket's words are the engine's, a waiting one's are said from what it waits for", () => {
    expect(
      waitingWords({
        _tag: 'held_back',
        reason: 'solo',
        detail: 'waits for the solo ticket fa-9',
      }),
    ).toEqual(Option.some('waits for the solo ticket fa-9'))
    expect(
      waitForWords({
        _tag: 'merge',
        tickets: [TicketId.make('fa-12'), TicketId.make('fa-13')],
      }),
    ).toBe('waits for fa-12 and fa-13 to merge')
    expect(
      waitForWords({
        _tag: 'merge',
        tickets: [
          TicketId.make('fa-12'),
          TicketId.make('fa-13'),
          TicketId.make('fa-14'),
        ],
      }),
    ).toBe('waits for fa-12, fa-13 and fa-14 to merge')
    expect(waitForWords({ _tag: 'setup' })).toBe(
      'waits to retry: its setup failed',
    )
    expect(waitForWords({ _tag: 'probe' })).toBe(
      'waits for the environment probe',
    )
    expect(waitingWords({ _tag: 'queued' })).toEqual(Option.none())
    expect(waitingWords({ _tag: 'working' })).toEqual(Option.none())
  })
})

describe('the run controls', () => {
  test('while the project is idle: Start run, its modes in a menu', () => {
    scene(
      { update, view },
      given(connected),
      expectScene(
        within(controls, role('button', { name: 'Start run' })),
      ).toExist(),
      expectScene(role('button', { name: 'Drain' })).toBeAbsent(),
      expectScene(role('button', { name: 'Stop' })).toBeAbsent(),
      expectScene(role('menu', { name: 'Start run' })).toBeAbsent(),
      click(role('button', { name: 'Start run' })),
      expectAll(all.role('menuitem')).toHaveCount(5),
      expectScene(role('menuitem', { name: 'The current tickets' })).toExist(),
      expectScene(role('menuitem', { name: 'One ticket' })).toExist(),
      expectScene(role('menuitem', { name: 'A spec' })).toExist(),
      expectScene(role('menuitem', { name: 'A feature' })).toExist(),
      expectScene(role('menuitem', { name: 'Overnight' })).toExist(),
      click(role('menuitem', { name: 'The current tickets' })),
      expectScene(role('menu', { name: 'Start run' })).toBeAbsent(),
      expectScene(role('button', { name: 'Starting…' })).toBeDisabled(),
      Command.resolve(
        Stats.StartRun({ project, mode: RunMode.cases.tickets.make({}) }),
        Stats.Message.SucceededStartRun({ project }),
      ),
      expectScene(role('button', { name: 'Start run' })).toBeEnabled(),
    )
  })

  test('Start run opens its modes whatever the controls showed while the run went, and closes them again', () => {
    scene(
      { update, view },
      given({
        ...connected,
        console: {
          ...connected.console,
          stats: { ...Stats.init(), controls: Stats.Controls.ConfirmingStop() },
        },
      }),
      click(role('button', { name: 'Start run' })),
      expectScene(role('menu', { name: 'Start run' })).toExist(),
      click(role('button', { name: 'Start run' })),
      expectScene(role('menu', { name: 'Start run' })).toBeAbsent(),
    )
  })

  test('a started run is watched afresh', () => {
    story(
      update,
      givenStory(connected),
      message(
        statsMessage(Stats.Message.ChoseMode({ project, mode: 'overnight' })),
      ),
      StoryCommand.expectHas(Stats.StartRun),
      StoryCommand.resolve(
        Stats.StartRun,
        Stats.Message.SucceededStartRun({ project }),
      ),
      model(shown => {
        expect(shown.runWatch).toBe(connected.runWatch + 1)
      }),
    )
  })

  test('one ticket asks for its ID before it starts', () => {
    scene(
      { update, view },
      given(connected),
      click(role('button', { name: 'Start run' })),
      click(role('menuitem', { name: 'One ticket' })),
      expectScene(role('form', { name: 'Start run: One ticket' })).toExist(),
      expectScene(role('button', { name: 'Start' })).toBeDisabled(),
      typeInto(role('textbox', { name: 'Ticket' }), 'not an id'),
      expectScene(role('button', { name: 'Start' })).toBeDisabled(),
      typeInto(role('textbox', { name: 'Ticket' }), 'fa-12'),
      expectScene(role('button', { name: 'Start' })).toBeEnabled(),
      submit(role('form', { name: 'Start run: One ticket' })),
      Command.resolve(
        Stats.StartRun({
          project,
          mode: RunMode.cases.ticket.make({ ticket: TicketId.make('fa-12') }),
        }),
        Stats.Message.SucceededStartRun({ project }),
      ),
      expectScene(role('form', { name: 'Start run: One ticket' })).toBeAbsent(),
    )
  })

  test('a spec can be refined first, and Cancel leaves the controls as they were', () => {
    expect(Stats.typedMode('spec', ' docs/spec.md ', true)).toEqual(
      Option.some(
        RunMode.cases.spec.make({ source: 'docs/spec.md', refine: true }),
      ),
    )
    expect(Stats.typedMode('feature', '   ', false)).toEqual(Option.none())
    scene(
      { update, view },
      given(connected),
      click(role('button', { name: 'Start run' })),
      click(role('menuitem', { name: 'A spec' })),
      expectScene(role('checkbox', { name: 'Refine first' })).not.toBeChecked(),
      click(role('checkbox', { name: 'Refine first' })),
      expectScene(role('checkbox', { name: 'Refine first' })).toBeChecked(),
      typeInto(role('textbox', { name: 'Spec' }), 'docs/spec.md'),
      submit(role('form', { name: 'Start run: A spec' })),
      Command.resolve(
        Stats.StartRun({
          project,
          mode: RunMode.cases.spec.make({
            source: 'docs/spec.md',
            refine: true,
          }),
        }),
        Stats.Message.SucceededStartRun({ project }),
      ),
    )
    scene(
      { update, view },
      given(connected),
      click(role('button', { name: 'Start run' })),
      click(role('menuitem', { name: 'A feature' })),
      expectScene(role('checkbox', { name: 'Refine first' })).toBeAbsent(),
      click(role('button', { name: 'Cancel' })),
      expectScene(role('form', { name: 'Start run: A feature' })).toBeAbsent(),
      expectScene(role('button', { name: 'Start run' })).toExist(),
      expectScene(role('menu', { name: 'Start run' })).toBeAbsent(),
    )
  })

  test('while the run goes: Drain and Stop, Stop confirmed first', () => {
    scene(
      { update, view },
      given(withRun()),
      expectScene(role('button', { name: 'Start run' })).toBeAbsent(),
      expectScene(
        within(controls, role('button', { name: 'Drain' })),
      ).toExist(),
      click(role('button', { name: 'Stop' })),
      expectScene(role('button', { name: 'Stop the run' })).toExist(),
      click(role('button', { name: 'Keep running' })),
      expectScene(role('button', { name: 'Stop the run' })).toBeAbsent(),
      click(role('button', { name: 'Stop' })),
      click(role('button', { name: 'Stop the run' })),
      expectScene(role('button', { name: 'Stop' })).toBeDisabled(),
      Command.resolve(
        Stats.AskRun({ project, action: 'stop' }),
        Stats.Message.SucceededRunRequest(),
      ),
      expectScene(role('button', { name: 'Stop' })).toBeEnabled(),
    )
  })

  test('Drain asks the engine to drain the run', () => {
    scene(
      { update, view },
      given(withRun()),
      click(role('button', { name: 'Drain' })),
      Command.resolve(
        Stats.AskRun({ project, action: 'drain' }),
        Stats.Message.SucceededRunRequest(),
      ),
    )
  })

  test('while the run drains: Undrain and Stop, and the row says it drains', () => {
    scene(
      { update, view },
      given(withHeader({ state: 'draining' })),
      expectScene(selector('[data-run-state="draining"]')).toHaveText(
        'Draining',
      ),
      expectScene(role('button', { name: 'Drain' })).toBeAbsent(),
      expectScene(role('button', { name: 'Undrain' })).toExist(),
      expectScene(role('button', { name: 'Stop' })).toExist(),
    )
  })

  test('while the run stops, its controls wait', () => {
    scene(
      { update, view },
      given(withHeader({ state: 'stopping' })),
      expectScene(selector('[data-run-state="stopping"]')).toHaveText(
        'Stopping…',
      ),
      expectScene(role('button', { name: 'Drain' })).toBeDisabled(),
      expectScene(role('button', { name: 'Stop' })).toBeDisabled(),
    )
  })

  test('an overnight run carries its c5 tag', () => {
    scene(
      { update, view },
      given(withHeader({ mode: { _tag: 'overnight' } })),
      expectScene(selector('[data-tag="overnight"]')).toHaveText('overnight'),
      expectScene(selector('[data-tag="overnight"]')).toHaveClass('text-c5'),
    )
    scene(
      { update, view },
      given(withRun()),
      expectScene(selector('[data-tag="overnight"]')).toBeAbsent(),
    )
  })

  test('no controls without a chosen project or a connection', () => {
    scene(
      { update, view },
      given({ ...connected, scope: Option.none() }),
      expectScene(controls).toBeAbsent(),
    )
    scene(
      { update, view },
      given({ ...connected, connection: Connection.Connecting() }),
      expectScene(controls).toBeAbsent(),
    )
  })

  test('a refused start is said in the strip, as a stop, until dismissed', () => {
    scene(
      { update, view },
      given(connected),
      click(role('button', { name: 'Start run' })),
      click(role('menuitem', { name: 'The current tickets' })),
      Command.resolve(
        Stats.StartRun({ project, mode: RunMode.cases.tickets.make({}) }),

        Stats.Message.FailedRunRequest({
          action: 'start',
          reason: 'check_fast fails on Base; the remote is unreachable',
        }),
      ),
      expectScene(within(strip, selector('[data-tone="stop"]'))).toContainText(
        'Start run refused: check_fast fails on Base; the remote is unreachable',
      ),
      click(role('button', { name: 'Dismiss' })),
      expectScene(strip).toBeAbsent(),
    )
  })

  test("the engine's refusals in words", () => {
    expect(Stats.refusalWords(new NoRun({ project }))).toBe(
      'the project has no run going',
    )
    expect(
      Stats.refusalWords(
        new RunRefused({
          end: 'SETUP',
          problems: ['check_fast fails on Base', 'the remote is unreachable'],
        }),
      ),
    ).toBe('check_fast fails on Base; the remote is unreachable')
  })
})

const hold = (overrides: Record<string, unknown>) => ({
  kind: 'USAGE_LIMIT',
  reason: 'Anthropic usage limit reached',
  since: at - 600_000,
  lifts: null,
  provider: 'anthropic',
  ...overrides,
})

describe('the strip of holds and banners', () => {
  test('a hold in c2 with when it lifts, today as a time', () => {
    scene(
      { update, view },
      given(
        withRun({ holds: [hold({ lifts: Date.UTC(2026, 9, 29, 13, 5) })] }),
      ),
      expectScene(within(strip, selector('[data-tone="hold"]'))).toContainText(
        'Anthropic usage limit reached',
      ),
      expectScene(selector('[data-tone="hold"]')).toHaveClass('border-c2'),
      expectScene(selector('[data-tone-mark="hold"]')).toHaveText('Hold'),
      expectScene(selector('[data-tone-mark="hold"]')).toHaveClass('text-c2'),
      expectScene(selector('[data-lifts]')).toHaveText('lifts 15:05'),
    )
  })

  test('a lift on another day says its day', () => {
    scene(
      { update, view },
      given(withRun({ holds: [hold({ lifts: Date.UTC(2026, 9, 30, 0, 0) })] })),
      expectScene(selector('[data-lifts]')).toHaveText(
        'lifts Fri 30 Oct 02:00',
      ),
    )
  })

  test('a hold with no known lift says none', () => {
    scene(
      { update, view },
      given(
        withRun({
          holds: [hold({ kind: 'MACHINE', reason: 'The machine is busy' })],
        }),
      ),
      expectScene(selector('[data-tone="hold"]')).toContainText(
        'The machine is busy',
      ),
      expectScene(selector('[data-lifts]')).toBeAbsent(),
    )
  })

  test('a stop in c3', () => {
    scene(
      { update, view },
      given(
        withRun({
          holds: [
            hold({ kind: 'STOP', reason: 'Stopping: asked by the maintainer' }),
          ],
        }),
      ),
      expectScene(selector('[data-tone="stop"]')).toHaveClass('border-c3'),
      expectScene(selector('[data-tone-mark="stop"]')).toHaveText('Stop'),
      expectScene(selector('[data-tone-mark="stop"]')).toHaveClass('text-c3'),
    )
  })

  test("banners take the strip in their tone, a warning's said in a word", () => {
    scene(
      { update, view },
      given(
        withRun({
          banners: [
            { tone: 'warning', text: 'On battery at 40%', lifts: null },
            {
              tone: 'hold',
              text: 'Held until fa-12 merges',
              lifts: Date.UTC(2026, 9, 29, 12, 30),
            },
          ],
        }),
      ),
      expectAll(all.selector('[data-tone]')).toHaveCount(2),
      expectScene(selector('[data-tone="warning"]')).toContainText('Warning'),
      expectScene(selector('[data-tone="warning"]')).toContainText(
        'On battery at 40%',
      ),
      expectScene(
        within(selector('[data-tone="hold"]'), selector('[data-lifts]')),
      ).toHaveText('lifts 14:30'),
    )
  })

  test('nothing to say, no strip', () => {
    scene({ update, view }, given(withRun()), expectScene(strip).toBeAbsent())
  })

  test("the run's steps past a second, with their elapsed time; a ticket's step is its card's", () => {
    scene(
      { update, view },
      given(
        withRun({
          steps: [
            { step: 'full_check', ticket: null, startedAt: at - 75_000 },
            { step: 'report', ticket: null, startedAt: at - 500 },
            { step: 'merge_check', ticket: 'fa-7', startedAt: at - 30_000 },
          ],
        }),
      ),
      expectAll(all.selector('[data-step]')).toHaveCount(1),
      expectScene(selector('[data-step="full_check"]')).toContainText(
        'Running the full check…',
      ),
      expectScene(
        within(
          selector('[data-step="full_check"]'),
          selector('[data-elapsed]'),
        ),
      ).toHaveText('1m 15s'),
    )
  })

  test('the clock moves the elapsed time on', () => {
    scene(
      { update, view },
      given(
        withRun({
          steps: [
            { step: 'start_checks', ticket: null, startedAt: at - 2_000 },
          ],
        }),
      ),
      expectScene(selector('[data-elapsed]')).toHaveText('2s'),
    )
    story(
      update,
      givenStory(connected),
      message(
        Message.Ticked({
          now: DateTime.makeZonedUnsafe(at + 1_000, {
            timeZone: 'Europe/Athens',
          }),
        }),
      ),
      model(shown => {
        expect(Option.map(shown.now, DateTime.toEpochMillis)).toEqual(
          Option.some(at + 1_000),
        )
      }),
    )
  })
})

describe('the clock', () => {
  test('a moment today is a time, on another day its day too', () => {
    expect(
      sayMoment(DateTime.makeUnsafe(Date.UTC(2026, 9, 29, 7, 9)), now),
    ).toBe('09:09')
    expect(
      sayMoment(DateTime.makeUnsafe(Date.UTC(2026, 9, 28, 21, 59)), now),
    ).toBe('Wed 28 Oct 23:59')
    expect(
      sayMoment(DateTime.makeUnsafe(Date.UTC(2026, 9, 28, 22, 0)), now),
    ).toBe('00:00')
  })

  test('elapsed times in seconds, minutes and hours', () => {
    const start = DateTime.makeUnsafe(at)
    const after = (millis: number) => DateTime.makeUnsafe(at + millis)
    expect(sayElapsed(start, after(12_400))).toBe('12s')
    expect(sayElapsed(start, after(185_000))).toBe('3m 05s')
    expect(sayElapsed(start, after(3_720_000))).toBe('1h 02m')
    expect(sayElapsed(after(5_000), start)).toBe('0s')
  })
})
