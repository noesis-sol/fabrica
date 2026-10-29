import { DateTime, Option } from 'effect'
import {
  Mount,
  Subscription,
  all,
  expectAll,
  expect as expectScene,
  given,
  role,
  scene,
  selector,
  within,
} from 'foldkit/scene'

import { describe, expect, test } from '@effect/vitest'
import {
  CommitHash,
  EngineId,
  LocalTime,
  ProjectId,
  RunEvent,
  RunId,
  SessionId,
  StreamEpoch,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'
import * as VirtualList from '@foldkit/ui/virtualList'

import { dayOf } from '../src/app/clock'
import { Connection } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import type { EventsItem } from '../src/app/streams'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import { historyLine, historyRows, historyTime } from '../src/console/history'

// The console's History panel (spec §18.3, §7.7; Appendix A.2, A.3), drawn from fixture events: each
// kind's dot in its role's colour and its line as the log says it, newest first with new events on
// top, times in the viewer's zone with the day when it isn't today, and only the rows in view drawn.

const project = ProjectId.make('p-1')
const run = RunId.make('2026-10-29T10:00:00.000+02:00')
const ticket = TicketId.make('fa-7')
const question = TicketId.make('fa-q1')
const time = LocalTime.make('2026-10-29T10:15:00.000+02:00')
const at = { time, run }

/** Noon UTC on the 29th, in `zone`. */
const nowIn = (zone: string): DateTime.Zoned =>
  DateTime.makeZonedUnsafe('2026-10-29T12:00:00.000Z', { timeZone: zone })

/** The start of the 29th in `zone`, as the Model keeps the viewer's day. */
const dayIn = (zone: string): DateTime.Zoned => dayOf(nowIn(zone))

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(project),
  today: Option.some(dayIn('Europe/Athens')),
}

/** The model with `events` (oldest first, as the stream sends them) shown in History. */
const withEvents = (
  events: ReadonlyArray<RunEvent>,
  model: Model = connected,
): Model => ({ ...model, events: [{ project, events: [...events].reverse() }] })

/**
 * The list measured by its Mount (the virtual list's `ObserveVirtualList`, matched by its name), as
 * the browser reports it: rows are drawn only once it is.
 */
const measured = (height = 1000) =>
  Mount.resolve(
    { name: 'ObserveVirtualList', args: { id: 'history' } },
    VirtualList.Message.ResizedContainer({
      containerWidth: 320,
      containerHeight: height,
    }),
  )

const rowAt = (index: number) =>
  selector(`[data-virtual-list-item-index="${index}"]`)

const rowText = (index: number) =>
  within(rowAt(index), selector('[data-history-line]'))

const rowTime = (index: number) => within(rowAt(index), selector('time'))

const rowDot = (index: number) =>
  within(rowAt(index), selector('[data-history-dot]'))

const dispatch = (n: number, title = 'Refresh tokens'): RunEvent =>
  RunEvent.cases.dispatch.make({
    ...at,
    ticket,
    title,
    n,
    queued: 0,
    text: `[${n}/12] fa-7 dispatching: ${title}`,
  })

/** One event of each kind History has a line for, with its role and the line it shows. */
const lined: ReadonlyArray<readonly [RunEvent, string, string]> = [
  [
    RunEvent.cases.start.make({
      ...at,
      version: '0.1.0',
      engine: EngineId.make('e-1'),
      repo: '/work/proj',
      branch: 'main',
      commit: CommitHash.make('eda8c7a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6'),
      concurrency: 4,
    }),
    'c1',
    'Run started on main',
  ],
  [dispatch(1), 'c1', '[1/12] fa-7 dispatching: Refresh tokens'],
  [
    RunEvent.cases.resumed.make({
      ...at,
      ticket,
      session: SessionId.make('s-1'),
      why: 'hand_back',
    }),
    'c1',
    'fa-7 resumed: hand back',
  ],
  [
    RunEvent.cases.closed.make({
      ...at,
      ticket,
      title: 'Refresh tokens',
      detail: 'ffd6ce4 merged into main',
      text: '  fa-7 closed: ffd6ce4 merged into main',
    }),
    'c4',
    'fa-7 closed: ffd6ce4 merged into main',
  ],
  [
    RunEvent.cases.done.make({
      ...at,
      detail: 'READY_EMPTY',
      text: 'READY_EMPTY after 12 tickets',
    }),
    'c4',
    'READY_EMPTY after 12 tickets',
  ],
  [
    RunEvent.cases.full_check.make({
      ...at,
      detail: 'passed',
      text: 'FULL_CHECK passed',
    }),
    'c4',
    'FULL_CHECK passed',
  ],
  [
    RunEvent.cases.asked.make({
      ...at,
      ticket,
      title: 'Refresh tokens',
      question,
      detail: 'fa-q1 Which store keeps the tokens?',
      text: '  fa-7 asked fa-q1 Which store keeps the tokens?',
    }),
    'c2',
    'fa-7 asked fa-q1 Which store keeps the tokens?',
  ],
  [
    RunEvent.cases.battery.make({
      ...at,
      level: 19,
      threshold: 20,
      text: 'BATTERY: 19%',
    }),
    'c2',
    'BATTERY: 19%',
  ],
  [
    RunEvent.cases.warn.make({
      ...at,
      ticket,
      text: 'CHECKS_FAILED: fa-7 pnpm test',
    }),
    'c3',
    'CHECKS_FAILED: fa-7 pnpm test',
  ],
  [
    RunEvent.cases.deferred.make({
      ...at,
      ticket,
      title: 'Refresh tokens',
      detail: 'past its limit',
      text: '  fa-7 deferred: past its limit',
    }),
    'c3',
    'fa-7 deferred: past its limit',
  ],
  [
    RunEvent.cases.hold.make({
      ...at,
      hold: 'MACHINE',
      text: 'HOLD: MACHINE memory critical',
    }),
    'c3',
    'HOLD: MACHINE memory critical',
  ],
  [
    RunEvent.cases.usage_limit.make({
      ...at,
      provider: 'anthropic',
      detail: '429',
      text: 'HOLD: USAGE_LIMIT until 15:00',
    }),
    'c3',
    'HOLD: USAGE_LIMIT until 15:00',
  ],
  [
    RunEvent.cases.credentials_hold.make({
      ...at,
      provider: 'anthropic',
      detail: '401',
      text: 'HOLD: CREDENTIALS: anthropic refused its key',
    }),
    'c3',
    'HOLD: CREDENTIALS: anthropic refused its key',
  ],
  [
    RunEvent.cases.merge_conflict.make({
      ...at,
      ticket,
      files: ['src/a.ts'],
      text: 'MERGE_CONFLICT in src/a.ts',
    }),
    'c3',
    'MERGE_CONFLICT in src/a.ts',
  ],
  [
    RunEvent.cases.stop.make({
      ...at,
      detail: 'MERGE_FAILED',
      text: 'MERGE_FAILED: fa-7 does not fast-forward',
    }),
    'c3',
    'MERGE_FAILED: fa-7 does not fast-forward',
  ],
  [
    RunEvent.cases.full_check.make({
      ...at,
      detail: 'failed',
      text: 'FULL_CHECK_FAILED: pnpm test',
    }),
    'c3',
    'FULL_CHECK_FAILED: pnpm test',
  ],
  [
    RunEvent.cases.info.make({ ...at, ticket, text: 'worktree ready' }),
    'c5',
    'worktree ready',
  ],
  [
    RunEvent.cases.hold.make({
      ...at,
      hold: 'MACHINE',
      lifted: true,
      text: 'HOLD lifted: MACHINE',
    }),
    'c5',
    'HOLD lifted: MACHINE',
  ],
  [RunEvent.cases.drain.make({ ...at }), 'c5', 'Draining'],
  [RunEvent.cases.resume.make({ ...at }), 'c5', 'Drain taken back'],
  [RunEvent.cases.probed.make({ ...at, text: 'PROBE_OK' }), 'c5', 'PROBE_OK'],
  [
    RunEvent.cases.usage_limit_lifted.make({
      ...at,
      provider: 'anthropic',
      text: 'HOLD: USAGE_LIMIT lifted',
    }),
    'c5',
    'HOLD: USAGE_LIMIT lifted',
  ],
  [
    RunEvent.cases.credentials_lifted.make({
      ...at,
      provider: 'anthropic',
      text: 'HOLD: CREDENTIALS lifted',
    }),
    'c5',
    'HOLD: CREDENTIALS lifted',
  ],
  [
    RunEvent.cases.slept.make({
      ...at,
      from: LocalTime.make('2026-10-29T09:00:00.000+02:00'),
      to: LocalTime.make('2026-10-29T09:34:00.000+02:00'),
      seconds: 2040,
      text: "SLEPT: the host slept 34m (09:00–09:34); limits don't count it",
    }),
    'c5',
    "SLEPT: the host slept 34m (09:00–09:34); limits don't count it",
  ],
  [
    RunEvent.cases.answered.make({
      ...at,
      ticket,
      title: 'Refresh tokens',
      detail: 'fa-q1 answered',
      text: '  fa-7 answered',
    }),
    'c5',
    'fa-7 answered',
  ],
  [
    RunEvent.cases.auto_answered.make({
      ...at,
      ticket,
      question,
      title: 'Which store keeps the tokens?',
      option: 'The keychain',
      text: 'fa-7 answered by --auto-answer',
    }),
    'c5',
    'fa-7 answered by --auto-answer',
  ],
  [
    RunEvent.cases.waits.make({
      ...at,
      ticket,
      title: 'Refresh tokens',
      waits_for: [TicketId.make('fa-3')],
      detail: 'fa-3',
      text: 'WAITS_FOR_MERGE: fa-7 waits for fa-3 to merge',
    }),
    'c5',
    'WAITS_FOR_MERGE: fa-7 waits for fa-3 to merge',
  ],
  [
    RunEvent.cases.reopened.make({
      ...at,
      ticket,
      detail: 'environment hold',
      text: '  fa-7 reopened',
    }),
    'c5',
    'fa-7 reopened',
  ],
  [
    RunEvent.cases.requeued.make({
      ...at,
      ticket,
      detail: 'its question answered',
    }),
    'c5',
    'fa-7 requeued: its question answered',
  ],
  [
    RunEvent.cases.triage.make({
      ...at,
      ticket,
      title: 'The test runner ran out of memory',
      detail: 'environment · high',
      text: 'TRIAGE: fa-7 environment · high',
    }),
    'c5',
    'TRIAGE: fa-7 environment · high',
  ],
  [
    RunEvent.cases.organ.make({
      ...at,
      organ: 'triage',
      ticket,
      outcome: 'answered',
      duration_ms: 1200,
    }),
    'c5',
    'triage on fa-7: answered',
  ],
]

/** Kinds that only count or measure: History has no line for them. */
const unlined: ReadonlyArray<RunEvent> = [
  RunEvent.cases.usage_window.make({
    ...at,
    provider: 'anthropic',
    window: 'five_hour',
    utilization: 0.4,
  }),
  RunEvent.cases.check.make({
    ...at,
    suite: 'merge',
    command: 'pnpm test',
    seconds: 40,
    result: 'passed',
  }),
  RunEvent.cases.end.make({ ...at, code: 0 }),
  RunEvent.cases.phase.make({
    ...at,
    ticket,
    to: 'working',
    cause: 'dispatched',
  }),
  RunEvent.cases.queue.make({ ...at, queued: 3 }),
  RunEvent.cases.settled.make({
    ...at,
    ticket,
    outcome: 'finish',
    text: 'fa-7 finished',
  }),
  RunEvent.cases.ticket_end.make({
    ...at,
    ticket,
    outcome: 'merged',
    phase: 'merging',
    seconds: 600,
  }),
  RunEvent.cases.suspended.make({
    ...at,
    ticket,
    session: SessionId.make('s-1'),
    why: 'the run stopped',
  }),
  RunEvent.cases.turn.make({
    ...at,
    session: SessionId.make('s-1'),
    model: 'anthropic/claude-opus-5-5',
    turns: 3,
    duration_ms: 9000,
  }),
]

describe("each event's colour and line", () => {
  test.each(lined.map(([event, colour, line]) => ({ event, colour, line })))(
    '$colour: $line',
    ({ event, colour, line }) => {
      scene(
        { update, view },
        given(withEvents([event])),
        measured(),
        expectScene(rowDot(0)).toHaveClass(`bg-${colour}`),
        expectScene(rowAt(0)).toContainText(line),
        expectScene(rowText(0)).toHaveText(line),
      )
    },
  )

  test('every kind of row is drawn in one list, each with its own role', () => {
    scene(
      { update, view },
      given(withEvents(lined.map(([event]) => event))),
      measured(),
      expectAll(all.selector('[data-history-role]')).toHaveCount(lined.length),
      ...lined.flatMap(([, colour, line], index) => {
        const shown = lined.length - 1 - index
        return [
          expectScene(rowDot(shown)).toHaveAttr('data-history-dot', colour),
          expectScene(rowText(shown)).toHaveText(line),
        ]
      }),
    )
  })

  test('the kinds that only count or measure have no line', () => {
    expect(unlined.map(historyLine)).toEqual(unlined.map(() => Option.none()))
    scene(
      { update, view },
      given(withEvents(unlined)),
      expectScene(role('region', { name: 'History' })).toContainText(
        'No events yet',
      ),
    )
  })

  test('a long line is cut on one line, whole on hover', () => {
    const title = 'A title long enough to be cut at the History panel’s width'
    scene(
      { update, view },
      given(withEvents([dispatch(1, title)])),
      measured(),
      expectScene(rowText(0)).toHaveClass('whitespace-nowrap'),
      expectScene(rowText(0)).toHaveClass('text-ellipsis'),
      expectScene(rowAt(0)).toContainText(title),
      expectScene(selector('[data-history-role="c1"]')).toHaveAttr(
        'title',
        `[1/12] fa-7 dispatching: ${title}`,
      ),
    )
  })
})

describe('times in the viewer’s zone', () => {
  test('a time from another zone is shown in the viewer’s', () => {
    scene(
      { update, view },
      given(
        withEvents([dispatch(1)], {
          ...connected,
          today: Option.some(dayIn('Asia/Tokyo')),
        }),
      ),
      measured(),
      expectScene(rowTime(0)).toHaveText('17:15'),
    )
    scene(
      { update, view },
      given(
        withEvents([dispatch(1)], {
          ...connected,
          today: Option.some(dayIn('America/New_York')),
        }),
      ),
      measured(),
      expectScene(rowTime(0)).toHaveText('04:15'),
      expectScene(role('region', { name: 'History' })).toContainText('Today'),
    )
  })

  test('a time on another day in the viewer’s zone carries its day, and the column makes room', () => {
    const late = RunEvent.cases.info.make({
      time: LocalTime.make('2026-10-29T01:30:00.000+02:00'),
      run,
      text: 'worktree ready',
    })
    scene(
      { update, view },
      given(
        withEvents([late, dispatch(1)], {
          ...connected,
          today: Option.some(dayIn('Europe/London')),
        }),
      ),
      measured(),
      expectScene(rowTime(0)).toHaveText('08:15'),
      expectScene(rowTime(1)).toHaveText('Wed 28 Oct 23:30'),
      expectScene(selector('[data-history-role="c5"]')).toHaveStyle(
        'grid-template-columns',
        '116px 6px minmax(0,1fr)',
      ),
      expectScene(role('region', { name: 'History' })).not.toContainText(
        'Today',
      ),
    )
  })

  test('today a time, another day with its day, as sayMoment says them', () => {
    const today = Option.some(dayIn('Europe/Athens'))
    expect(historyTime(time, today)).toBe('10:15')
    expect(
      historyTime(LocalTime.make('2026-03-02T08:05:00.000+00:00'), today),
    ).toBe('Mon 2 Mar 10:05')
  })

  test('before the first tick, the time as it was recorded', () => {
    expect(historyTime(time, Option.none())).toBe('10:15')
  })

  test("the viewer's day is kept through the day's ticks, and moves as the next begins", () => {
    const athens = 'Europe/Athens'
    const { model: first } = update(
      connected,
      Message.Ticked({ now: nowIn(athens) }),
    )
    const { model: later } = update(
      first,
      Message.Ticked({
        now: DateTime.makeZonedUnsafe('2026-10-29T21:59:00.000Z', {
          timeZone: athens,
        }),
      }),
    )
    expect(later.today).toBe(first.today)
    const { model: next } = update(
      later,
      Message.Ticked({
        now: DateTime.makeZonedUnsafe('2026-10-29T22:00:00.000Z', {
          timeZone: athens,
        }),
      }),
    )
    expect(Option.map(next.today, day => DateTime.formatIsoDate(day))).toEqual(
      Option.some('2026-10-30'),
    )
  })
})

const epoch = StreamEpoch.make('epoch-1')

const snapshotOf = (
  events: ReadonlyArray<RunEvent>,
): typeof EventsItem.Type => ({
  _tag: 'snapshot',
  epoch,
  seq: 0,
  value: events,
})

const patchOf = (
  seq: number,
  events: ReadonlyArray<RunEvent>,
): typeof EventsItem.Type => ({ _tag: 'patch', seq, value: events })

describe('the list', () => {
  test('newest first, new events added at the top', () => {
    scene(
      { update, view },
      given(connected),
      Subscription.emit(
        Message.ReceivedEvents({
          project,
          items: [snapshotOf([dispatch(1), dispatch(2)])],
        }),
      ),
      measured(),
      expectScene(rowText(0)).toContainText('[2/12]'),
      expectScene(rowText(1)).toContainText('[1/12]'),
      Subscription.emit(
        Message.ReceivedEvents({
          project,
          items: [patchOf(1, [dispatch(3)]), patchOf(2, [dispatch(4)])],
        }),
      ),
      expectScene(rowText(0)).toContainText('[4/12]'),
      expectScene(rowText(1)).toContainText('[3/12]'),
      expectScene(rowText(3)).toContainText('[1/12]'),
    )
  })

  test('rows keep their keys as new events go on above them', () => {
    const events = [dispatch(1), dispatch(2)]
    const of = (shown: ReadonlyArray<RunEvent>) =>
      historyRows([{ project, events: shown, chip: Option.none() }]).map(
        row => row.key,
      )
    const before = of([...events].reverse())
    const after = of([dispatch(3), ...[...events].reverse()])
    expect(after.slice(1)).toEqual(before)
  })

  test('only the rows in view are drawn', () => {
    const many = Array.from({ length: 500 }, (_, index) => dispatch(index + 1))
    scene(
      { update, view },
      given(withEvents(many)),
      measured(117),
      expectScene(rowText(0)).toContainText('[500/12]'),
      expectScene(rowAt(0)).toHaveAttr('aria-setsize', '500'),
      expectScene(rowAt(30)).toBeAbsent(),
    )
  })

  test('another project’s events are left out, and choosing another scope clears them', () => {
    scene(
      { update, view },
      given(connected),
      Subscription.emit(
        Message.ReceivedEvents({
          project: ProjectId.make('p-2'),
          items: [snapshotOf([dispatch(1)])],
        }),
      ),
      expectScene(role('region', { name: 'History' })).toContainText(
        'No events yet',
      ),
    )
    const { model: shown } = update(
      withEvents([dispatch(1)]),
      Message.SelectedScope({ project: Option.some(ProjectId.make('p-2')) }),
    )
    expect(shown.events).toEqual([])
  })
})
