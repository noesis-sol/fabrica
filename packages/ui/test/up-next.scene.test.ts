import { Option, Schema } from 'effect'
import {
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
  AttentionRequest,
  EngineId,
  ProjectId,
  RunView,
  StreamEpoch,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import { queue, shownAtMost } from '../src/console/up-next'

// The console's Up next column (spec §18.3, H81), drawn from a fixture run view: it takes the
// attention column's place while nothing needs the maintainer, lists the ready tickets first, then
// each waiting one with why in words, a ticket waiting on a question with the question, and the
// tickets past the column's count as `+N more`.

const project = ProjectId.make('p-1')
const at = 1_793_268_900_000

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(project),
}

/** A ticket row's JSON in `phase`. */
const row = (ticket: string, title: string, phase: object) => ({
  ticket,
  title,
  type: 'task',
  priority: 2,
  phase,
  since: at,
  startedAt: null,
  solo: false,
  handBacks: { resolve: 0, fix: 0 },
})

const questionJson = {
  _tag: 'question',
  project,
  ticket: 'fa-3',
  title: 'Keep the old refresh endpoint?',
  description: null,
  choices: null,
  consequential: false,
  maintainerOnly: false,
  blocks: ['fa-20'],
  askedFrom: null,
  openedAt: at,
}

const decodeRunView = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))
const decodeRequest = Schema.decodeUnknownSync(
  Schema.toCodecJson(AttentionRequest),
)

/** A running view of the project with `tickets` and the run's open `attention` requests. */
const runView = (
  tickets: ReadonlyArray<object>,
  attention: ReadonlyArray<object> = [],
): RunView =>
  decodeRunView({
    header: {
      run: 'r-1',
      project,
      engine: 'e-1',
      mode: { _tag: 'tickets' },
      state: 'running',
      startedAt: at,
      offline: false,
      autoAnswer: false,
    },
    totals: {
      live: 1,
      slots: 4,
      counts: {
        in_queue: tickets.length,
        working: 1,
        waiting_to_merge: 0,
        needs_you: 0,
        set_aside: 0,
        carried_over: 0,
        done: 0,
      },
      doneToday: 0,
      tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
      costUsd: null,
    },
    tickets,
    workers: [],
    queue: { merging: null, train: null, waiting: [] },
    holds: [],
    banners: [],
    attention,
    load: null,
    steps: [],
  })

/** The queue in every kind of place, as many as the column lists, the waiting ones first so the ready one must move up. */
const tickets = [
  row('fa-7', 'Refresh tokens', { _tag: 'working' }),
  row('fa-14', 'Rotate refresh keys', {
    _tag: 'held_back',
    reason: 'overlap',
    detail: 'touches src/auth/refresh.ts, like running fa-7',
  }),
  row('fa-15', 'Billing webhooks', {
    _tag: 'held_back',
    reason: 'solo',
    detail: 'waits for the solo ticket fa-9',
  }),
  row('fa-16', 'Session expiry', {
    _tag: 'waiting',
    for: { _tag: 'merge', tickets: ['fa-12'] },
  }),
  row('fa-17', 'Logout everywhere', {
    _tag: 'waiting',
    for: { _tag: 'merge', tickets: ['fa-12', 'fa-13', 'fa-7'] },
  }),
  row('fa-18', 'Seed the fixtures', {
    _tag: 'waiting',
    for: { _tag: 'setup' },
  }),
  row('fa-19', 'Cache warmup', { _tag: 'waiting', for: { _tag: 'probe' } }),
  row('fa-20', 'Drop the old endpoint', { _tag: 'asked', question: 'fa-3' }),
  row('fa-21', 'Search indexer', { _tag: 'queued' }),
  row('fa-23', 'Old work', { _tag: 'merged', commit: 'a'.repeat(40) }),
]

const withQueue = (
  rows: ReadonlyArray<object>,
  attention: ReadonlyArray<object> = [],
): Model => ({
  ...connected,
  runView: Option.some(runView(rows, attention)),
  attention: Option.some([]),
})

/** The scope's attention requests as a snapshot of their stream. */
const receivedAttention = (requests: ReadonlyArray<object>) =>
  Message.ReceivedAttention({
    engine: localEngineName,
    items: [
      {
        _tag: 'snapshot',
        epoch: StreamEpoch.make('epoch-1'),
        seq: 0,
        value: requests.map(request => decodeRequest(request)),
      },
    ],
  })

/** `messages` applied to `from`, as the runtime would. */
const after = (from: Model, ...messages: ReadonlyArray<Message>): Model =>
  messages.reduce((shown, received) => update(shown, received).model, from)

const upNext = role('region', { name: 'Up next' })
const attentionColumn = role('region', { name: 'Needs your attention' })
const entryOf = (ticket: string) => selector(`[data-entry="${ticket}"]`)
const reasonOf = (ticket: string) =>
  within(entryOf(ticket), selector('[data-reason]'))

describe('the switch with Needs your attention', () => {
  test('Up next takes the column while nothing needs the maintainer', () => {
    scene(
      { update, view },
      given(withQueue(tickets)),
      expectScene(upNext).toExist(),
      expectScene(
        within(upNext, role('heading', { name: 'Up next' })),
      ).toExist(),
      expectScene(attentionColumn).toBeAbsent(),
    )
  })

  test('a request for the maintainer takes the column back, and Up next returns once it is answered', () => {
    const asked = after(withQueue(tickets), receivedAttention([questionJson]))
    scene(
      { update, view },
      given(asked),
      expectScene(attentionColumn).toExist(),
      expectScene(upNext).toBeAbsent(),
    )
    scene(
      { update, view },
      given(after(asked, receivedAttention([]))),
      expectScene(upNext).toExist(),
      expectScene(attentionColumn).toBeAbsent(),
    )
  })

  test('with no run in the scope, Up next says the queue is empty', () => {
    scene(
      { update, view },
      given({ ...connected, attention: Option.some([]) }),
      expectScene(within(upNext, selector('[data-count="queue"]'))).toHaveText(
        '0',
      ),
      expectScene(upNext).toContainText('Nothing in the queue.'),
    )
  })
})

describe('the queue', () => {
  test('the ready tickets come first, then the waiting ones, in the run view’s order', () => {
    const shown = withQueue(tickets, [questionJson])
    expect(
      queue(
        Option.getOrThrow(shown.runView).tickets,
        Option.getOrThrow(shown.runView).attention,
      ).map(entry => entry.row.ticket),
    ).toEqual([
      'fa-21',
      'fa-14',
      'fa-15',
      'fa-16',
      'fa-17',
      'fa-18',
      'fa-19',
      'fa-20',
    ])
    scene(
      { update, view },
      given(shown),
      expectScene(selector('[data-count="queue"]')).toHaveText('8'),
      expectAll(all.selector('[data-place="Ready"]')).toHaveCount(1),
      expectScene(selector('[data-more]')).toBeAbsent(),
      expectScene(
        within(entryOf('fa-21'), selector('[data-place]')),
      ).toHaveText('Ready'),
      expectScene(reasonOf('fa-21')).toBeAbsent(),
      expectScene(
        within(entryOf('fa-14'), selector('[data-place]')),
      ).toHaveText('Waiting'),
      expectScene(entryOf('fa-14')).toContainText('Rotate refresh keys'),
      expectScene(entryOf('fa-7')).toBeAbsent(),
      expectScene(entryOf('fa-23')).toBeAbsent(),
    )
  })

  test('each waiting ticket says why in words, as the log says them', () => {
    scene(
      { update, view },
      given(withQueue(tickets, [questionJson])),
      expectScene(reasonOf('fa-14')).toHaveText(
        'touches src/auth/refresh.ts, like running fa-7',
      ),
      expectScene(reasonOf('fa-15')).toHaveText(
        'waits for the solo ticket fa-9',
      ),
      expectScene(reasonOf('fa-16')).toHaveText('waits for fa-12 to merge'),
      expectScene(reasonOf('fa-17')).toHaveText(
        'waits for fa-12, fa-13 and fa-7 to merge',
      ),
      expectScene(reasonOf('fa-18')).toHaveText(
        'waits to retry: its setup failed',
      ),
      expectScene(reasonOf('fa-19')).toHaveText(
        'waits for the environment probe',
      ),
    )
  })

  test('a ticket waiting on a question shows the question', () => {
    scene(
      { update, view },
      given(withQueue(tickets, [questionJson])),
      expectScene(reasonOf('fa-20')).toHaveText(
        'waits on the question fa-3: Keep the old refresh endpoint?',
      ),
    )
  })

  test('a question not among the open requests is named by its ID', () => {
    scene(
      { update, view },
      given(withQueue(tickets)),
      expectScene(reasonOf('fa-20')).toHaveText('waits on the question fa-3'),
    )
  })
})

describe('+N more', () => {
  const many = Array.from({ length: shownAtMost + 3 }, (_, at) =>
    row(`fa-${100 + at}`, `Ticket ${at}`, { _tag: 'queued' }),
  )

  test('the column lists its count of tickets, and says how many more there are', () => {
    scene(
      { update, view },
      given(withQueue(many)),
      expectScene(selector('[data-count="queue"]')).toHaveText(
        String(shownAtMost + 3),
      ),
      expectAll(all.selector('li[data-entry]')).toHaveCount(shownAtMost),
      expectScene(selector('[data-more]')).toHaveText('+3 more'),
    )
  })

  test('no +N more while every ticket fits', () => {
    scene(
      { update, view },
      given(withQueue(many.slice(0, shownAtMost))),
      expectAll(all.selector('li[data-entry]')).toHaveCount(shownAtMost),
      expectScene(selector('[data-more]')).toBeAbsent(),
    )
  })
})
