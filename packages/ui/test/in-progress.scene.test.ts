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
  text,
  within,
} from 'foldkit/scene'

import { describe, expect, test } from '@effect/vitest'
import {
  EngineId,
  type Phase,
  ProjectId,
  ProjectRunState,
  ProjectStatus,
  RunId,
  RunView,
  StreamEpoch,
  TicketId,
  WorkerAction,
  phaseFacts,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as InProgress from '../src/console/in-progress'
import * as Worker from '../src/screens/worker'

// The console's In progress column (spec §18.3, H45, H80; Appendix A.2), drawn from a fixture run
// view with a ticket in each phase in progress: the cards and their phase bars, passed segments
// filled and the current one in the project's colour, a hand-back striped on merging, the step (the
// engine's, the worker's latest action, the place in the queue) with its elapsed time, every card one
// height, and a click opening the worker view.

const engine = EngineId.make('e-1')
const other = ProjectId.make('p-other')
const project = ProjectId.make('p-1')
const scoped: EngineProject = { engine: localEngineName, project }

/** Thursday 29 October 2026, 12:00 UTC. */
const at = Date.UTC(2026, 9, 29, 12, 0, 0)
const now = DateTime.makeZonedUnsafe(at, { timeZone: 'Europe/Athens' })

/** Connected, scoped to the project, which the sidebar lists second: its colour is `c2`. */
const connected: Model = update(
  {
    ...initialModel({ platform: 'darwin', release: '0.0.0' }),
    connection: Connection.Up({
      engine,
      release: '0.1.0',
      protocol: protocolVersion,
    }),
    scope: Option.some(scoped),
    now: Option.some(now),
  },
  Message.ReceivedProjects({
    engine,
    name: 'local',
    items: [
      {
        _tag: 'snapshot',
        epoch: StreamEpoch.make('epoch-1'),
        seq: 0,
        value: [other, project].map(
          id =>
            new ProjectStatus({
              project: id,
              name: id,
              base: 'main',
              setUp: true,
              trusted: false,
              run: ProjectRunState.cases.running.make({
                run: RunId.make('r-1'),
                overnight: false,
              }),
              ready: 0,
            }),
        ),
      },
    ],
  }),
).model

const decodeRunView = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))

/** A ticket row, in `phase` for the last `minutes`. */
const row = (ticket: string, phase: unknown, minutes = 3) => ({
  ticket,
  title: `Ticket ${ticket}`,
  type: 'task',
  priority: 2,
  phase,
  since: at - minutes * 60_000,
  startedAt: at - 3_600_000,
  solo: false,
  handBacks: { resolve: 0, fix: 0 },
})

const worker = (ticket: string, action: unknown) => ({
  ticket,
  session: `s-${ticket}`,
  model: 'claude-opus-5-5',
  startedAt: at - 600_000,
  action,
  context: null,
  tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
  steered: false,
})

const runJson = {
  header: {
    run: 'r-1',
    project,
    engine,
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
      in_queue: 1,
      working: 5,
      waiting_to_merge: 3,
      needs_you: 0,
      set_aside: 1,
      carried_over: 0,
      done: 2,
    },
    doneToday: 2,
    tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
    costUsd: null,
  },
  tickets: [
    row('fa-1', { _tag: 'working' }),
    row('fa-2', { _tag: 'working' }, 0),
    row('fa-3', { _tag: 'verifying', round: 1 }),
    row('fa-4', { _tag: 'waiting_to_merge', place: 2 }),
    row('fa-5', { _tag: 'waiting_to_merge', place: 1 }),
    row('fa-6', { _tag: 'merging', step: 'check' }),
    row('fa-7', { _tag: 'resolving', attempt: 1 }),
    row('fa-8', { _tag: 'fixing', attempt: 2 }),
    row('fa-9', { _tag: 'queued' }),
    row('fa-10', { _tag: 'set_aside', reason: 'DEFERRED' }),
    row('fa-11', { _tag: 'merged', commit: 'a'.repeat(40) }),
  ],
  workers: [
    worker('fa-1', {
      tool: 'bash',
      argument: 'scripts/check-own.sh',
      at: at - 5_000,
    }),
    worker('fa-2', null),
    worker('fa-4', { tool: 'edit', argument: 'src/a.ts', at: at - 9_000 }),
    worker('fa-7', {
      tool: 'edit',
      argument: 'src/auth/refresh.ts',
      at: at - 2_000,
    }),
  ],
  queue: { merging: 'fa-6', train: 'fa-5', waiting: ['fa-4'] },
  holds: [],
  banners: [],
  attention: [],
  load: null,
  steps: [{ step: 'merge_check', ticket: 'fa-6', startedAt: at - 75_000 }],
}

const withRun: Model = {
  ...connected,
  runView: Option.some(decodeRunView(runJson)),
}

const column = role('region', { name: 'In progress' })
const card = (ticket: string) => selector(`[data-ticket="${ticket}"]`)
const segment = (ticket: string, name: string) =>
  within(card(ticket), selector(`[data-segment="${name}"]`))
const stepOf = (ticket: string) =>
  within(card(ticket), selector('[data-card-step]'))
const elapsedOf = (ticket: string) =>
  within(card(ticket), selector('[data-elapsed]'))

describe('the cards', () => {
  test('one card for each ticket in progress, with its ID and title; none for the rest', () => {
    scene(
      { update, view },
      given(withRun),
      expectAll(all.selector('[data-ticket]')).toHaveCount(8),
      expectScene(
        within(column, selector('[data-count="in-progress"]')),
      ).toHaveText('8'),
      expectScene(card('fa-1')).toContainText('fa-1'),
      expectScene(card('fa-1')).toContainText('Ticket fa-1'),
      expectScene(card('fa-9')).toBeAbsent(),
      expectScene(card('fa-10')).toBeAbsent(),
      expectScene(card('fa-11')).toBeAbsent(),
    )
  })

  test('without a run the column says nothing is in progress', () => {
    scene(
      { update, view },
      given(connected),
      expectScene(within(column, text('Nothing in progress'))).toExist(),
      expectScene(selector('[data-ticket]')).toBeAbsent(),
    )
  })

  test('clicking a card opens its worker view', () => {
    scene(
      { update, view },
      given(withRun),
      click(card('fa-3')),
      Command.resolve(
        Worker.LoadTicket({
          worker: { project: scoped, ticket: TicketId.make('fa-3') },
        }),
        Worker.Message.FailedLoadTicket({
          worker: { project: scoped, ticket: TicketId.make('fa-3') },
          reason: 'not served',
        }),
      ),
      expectScene(role('heading', { name: 'Worker fa-3' })).toExist(),
    )
  })

  test('every card keeps one height, whether or not its worker has an action', () => {
    scene(
      { update, view },
      given(withRun),
      ...['fa-1', 'fa-2', 'fa-3', 'fa-6'].flatMap(ticket => [
        expectScene(card(ticket)).toHaveStyle('height', InProgress.cardHeight),
        expectScene(stepOf(ticket)).toExist(),
        expectScene(elapsedOf(ticket)).toExist(),
      ]),
      expectScene(stepOf('fa-2')).toHaveText('Starting'),
    )
  })

  test('no percentage anywhere on a card', () => {
    scene(
      { update, view },
      given(withRun),
      expectScene(within(column, text(/%/))).toBeAbsent(),
    )
  })
})

describe('the phase bar', () => {
  test('working: the first segment current, in the project colour, the rest ahead', () => {
    scene(
      { update, view },
      given(withRun),
      expectScene(segment('fa-1', 'working')).toHaveAttr(
        'data-state',
        'current',
      ),
      expectScene(segment('fa-1', 'working')).toHaveClass('bg-c2'),
      expectScene(segment('fa-1', 'verifying')).toHaveAttr(
        'data-state',
        'ahead',
      ),
      expectScene(segment('fa-1', 'verifying')).toHaveClass('bg-line'),
      expectScene(segment('fa-1', 'merging')).toHaveAttr('data-state', 'ahead'),
      expectScene(
        within(card('fa-1'), role('img', { name: 'Phase: Working' })),
      ).toExist(),
    )
  })

  test('verifying: working passed and filled, verifying current', () => {
    scene(
      { update, view },
      given(withRun),
      expectScene(segment('fa-3', 'working')).toHaveAttr(
        'data-state',
        'passed',
      ),
      expectScene(segment('fa-3', 'working')).toHaveClass('bg-muted'),
      expectScene(segment('fa-3', 'verifying')).toHaveAttr(
        'data-state',
        'current',
      ),
      expectScene(segment('fa-3', 'waiting_to_merge')).toHaveAttr(
        'data-state',
        'ahead',
      ),
    )
  })

  test('waiting to merge: two passed, its own current, merging ahead', () => {
    scene(
      { update, view },
      given(withRun),
      expectScene(segment('fa-4', 'verifying')).toHaveAttr(
        'data-state',
        'passed',
      ),
      expectScene(segment('fa-4', 'waiting_to_merge')).toHaveAttr(
        'data-state',
        'current',
      ),
      expectScene(segment('fa-4', 'waiting_to_merge')).toHaveClass('bg-c2'),
      expectScene(segment('fa-4', 'merging')).toHaveAttr('data-state', 'ahead'),
    )
  })

  test('merging: the last segment current, with no hand-back mark', () => {
    scene(
      { update, view },
      given(withRun),
      expectScene(segment('fa-6', 'waiting_to_merge')).toHaveAttr(
        'data-state',
        'passed',
      ),
      expectScene(segment('fa-6', 'merging')).toHaveAttr(
        'data-state',
        'current',
      ),
      expectScene(segment('fa-6', 'merging')).not.toHaveAttr('data-hand-back'),
    )
  })

  test('a hand-back is marked on the merging segment', () => {
    scene(
      { update, view },
      given(withRun),
      ...['fa-7', 'fa-8'].flatMap(ticket => [
        expectScene(segment(ticket, 'merging')).toHaveAttr(
          'data-state',
          'current',
        ),
        expectScene(segment(ticket, 'merging')).toHaveAttr('data-hand-back'),
        expectScene(
          within(
            card(ticket),
            role('img', { name: 'Phase: Merging, handed back' }),
          ),
        ).toExist(),
      ]),
      expectScene(
        within(card('fa-7'), selector('[data-hand-back]')),
      ).toHaveAttr('data-segment', 'merging'),
    )
  })

  test('each phase in progress has its segment, and the rest none', () => {
    const inProgress = Object.entries(phaseFacts)
      .filter(([, facts]) => Option.isSome(facts.bar))
      .map(([tag]) => tag)
    expect(inProgress.toSorted()).toEqual(
      [
        'fixing',
        'merging',
        'resolving',
        'verifying',
        'waiting_to_merge',
        'working',
      ].toSorted(),
    )
    const phase = (value: unknown): Phase =>
      Schema.decodeUnknownSync(Schema.toCodecJson(RunView))({
        ...runJson,
        tickets: [row('fa-1', value)],
      }).tickets[0]?.phase ?? { _tag: 'queued' }
    expect(InProgress.onBar(phase({ _tag: 'fixing', attempt: 1 }))).toEqual(
      Option.some({ segment: 'merging', handBack: true }),
    )
    expect(InProgress.onBar(phase({ _tag: 'working' }))).toEqual(
      Option.some({ segment: 'working', handBack: false }),
    )
    expect(InProgress.onBar(phase({ _tag: 'queued' }))).toEqual(Option.none())
  })
})

describe('the step', () => {
  test("the worker's latest action, its tool and main argument", () => {
    scene(
      { update, view },
      given(withRun),
      expectScene(stepOf('fa-1')).toHaveText('Running scripts/check-own.sh'),
      expectScene(stepOf('fa-7')).toHaveText('Editing src/auth/refresh.ts'),
      expectScene(elapsedOf('fa-1')).toHaveText('3m 00s'),
    )
  })

  test('its place in the queue, or the train, whatever its worker last did', () => {
    scene(
      { update, view },
      given(withRun),
      expectScene(stepOf('fa-4')).toHaveText('2nd to merge'),
      expectScene(stepOf('fa-5')).toHaveText('in the train'),
    )
  })

  test("the engine's step for the ticket, timed from its start", () => {
    scene(
      { update, view },
      given(withRun),
      expectScene(stepOf('fa-6')).toHaveText('Running the merge check…'),
      expectScene(elapsedOf('fa-6')).toHaveText('1m 15s'),
    )
  })

  test('the phase in words where nothing more is known', () => {
    scene(
      { update, view },
      given(withRun),
      expectScene(stepOf('fa-3')).toHaveText('Verifying'),
      expectScene(stepOf('fa-8')).toHaveText(
        'Handed back: fixing the merge check, attempt 2',
      ),
    )
  })

  test('actions and places in words', () => {
    const action = (tool: string, argument: string | null) =>
      new WorkerAction({
        tool,
        argument: Option.fromNullOr(argument),
        at: DateTime.makeUnsafe(at),
      })
    expect(InProgress.actionWords(action('write', 'notes.md'))).toBe(
      'Writing notes.md',
    )
    expect(InProgress.actionWords(action('web_fetch', null))).toBe('web_fetch')
    expect(
      [1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(InProgress.ordinal),
    ).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '101st',
    ])
  })
})
