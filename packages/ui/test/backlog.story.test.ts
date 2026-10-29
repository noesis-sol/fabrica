import { DateTime, Option, Schema } from 'effect'
import * as AsyncData from 'foldkit/asyncData'
import {
  Mount,
  Command as SceneCommand,
  Subscription,
  click,
  expect as expectScene,
  given as givenScene,
  role,
  scene,
  selector,
  within,
} from 'foldkit/scene'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import {
  EngineId,
  ProjectId,
  RunView,
  StreamEpoch,
  Ticket,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'
import * as VirtualList from '@foldkit/ui/virtualList'

import { dayOf } from '../src/app/clock'
import { Connection } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Backlog from '../src/screens/backlog'
import { graphKey, graphOf } from '../src/screens/backlog-graph'

// The Backlog screen (spec §18.4, H24, H40), from fixture tickets, edges and reasons: its sections
// (open, epics, ready, waiting, questions, deferred, finished by the run, closed), what is ready and
// why the rest isn't in the engine's words, asked one request at a time as the backlog changes, the
// graph built from the edges, and the chosen ticket shown whole; read-only.

const project = ProjectId.make('p-1')
const other = ProjectId.make('p-2')
const at = 1_793_268_900_000
const id = (ticket: string) => TicketId.make(ticket)

const decodeTicket = Schema.decodeUnknownSync(Schema.toCodecJson(Ticket))
const decodeFacts = Schema.decodeUnknownSync(Schema.toCodecJson(Backlog.Facts))
const decodeRunView = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))

/** A ticket's JSON, as the engine sends it, with `fields` over a plain open task. */
const ticket = (
  ticketId: string,
  title: string,
  fields: Record<string, unknown> = {},
): Ticket =>
  decodeTicket({
    id: ticketId,
    type: 'task',
    title,
    description: null,
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
    createdAt: at,
    updatedAt: at,
    ...fields,
  })

const epic = ticket('fa-1', 'Sign-in', { type: 'epic', priority: 1 })
const login = ticket('fa-2', 'Login form', {
  priority: 1,
  description: 'The form, its fields and its errors.',
})
const session = ticket('fa-3', 'Session store')
const refresh = ticket('fa-4', 'Refresh tokens', {
  status: 'in_progress',
  assignee: { engine: 'e-1', session: 's-1' },
})
const docs = ticket('fa-5', 'Document sign-in', {
  status: 'deferred',
  deferUntil: Date.parse('2026-10-30T09:00:00.000Z'),
})
const schema = ticket('fa-6', 'User schema', {
  status: 'closed',
  resolution: 'done',
  updatedAt: at + 10,
})
const old = ticket('fa-7', 'Old prototype', {
  status: 'closed',
  resolution: 'cancelled',
  updatedAt: at + 20,
})
const keep = ticket('fa-q1', 'Keep the old refresh endpoint?', {
  type: 'question',
  question: {
    choices: {
      options: [
        { label: 'Keep it', tradeOff: 'Old clients go on working' },
        { label: 'Drop it', tradeOff: 'Less to maintain' },
      ],
      recommended: 0,
    },
    consequential: false,
    maintainerOnly: false,
    answer: null,
  },
})

const tickets: ReadonlyArray<Ticket> = [
  epic,
  login,
  session,
  refresh,
  docs,
  schema,
  old,
  keep,
]

const edges = [
  { from: 'fa-1', to: 'fa-2', kind: 'parent' },
  { from: 'fa-1', to: 'fa-3', kind: 'parent' },
  { from: 'fa-1', to: 'fa-6', kind: 'parent' },
  { from: 'fa-2', to: 'fa-3', kind: 'blocks' },
  { from: 'fa-6', to: 'fa-2', kind: 'blocks' },
  { from: 'fa-q1', to: 'fa-4', kind: 'blocks' },
  { from: 'fa-7', to: 'fa-6', kind: 'related' },
]

const facts = (forProject: ProjectId = project): Backlog.Facts =>
  decodeFacts({
    project: forProject,
    ready: ['fa-2'],
    waiting: [
      {
        ticket: 'fa-1',
        reasons: [
          {
            reason: { _tag: 'not_dispatched', type: 'epic' },
            words: 'it is an epic',
          },
        ],
      },
      {
        ticket: 'fa-3',
        reasons: [
          {
            reason: { _tag: 'blocked', by: 'fa-2', status: 'open' },
            words: 'waits for fa-2 to merge: it is open',
          },
          {
            reason: { _tag: 'filed_from_unmerged', ticket: 'fa-6' },
            words: 'waits for fa-6, the ticket it was filed from, to merge',
          },
        ],
      },
      {
        ticket: 'fa-q1',
        reasons: [
          {
            reason: { _tag: 'not_dispatched', type: 'question' },
            words: 'it is a question',
          },
        ],
      },
    ],
    edges,
  })

const openIds = [id('fa-1'), id('fa-2'), id('fa-3'), id('fa-q1')]

/** A run view with `rows` as its ticket rows. */
const runView = (rows: ReadonlyArray<object>): RunView =>
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
        in_queue: 1,
        working: 1,
        waiting_to_merge: 0,
        needs_you: 0,
        set_aside: 0,
        carried_over: 0,
        done: 2,
      },
      tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
      costUsd: null,
    },
    tickets: rows,
    workers: [],
    queue: { merging: null, train: null, waiting: [] },
    holds: [],
    banners: [],
    attention: [],
    load: null,
    steps: [],
  })

const runRow = (ticketId: string, title: string, phase: object) => ({
  ticket: ticketId,
  title,
  type: 'task',
  priority: 2,
  phase,
  since: at,
  startedAt: null,
  solo: false,
  handBacks: { resolve: 0, fix: 0 },
})

const today = dayOf(
  DateTime.makeZonedUnsafe('2026-10-29T12:00:00.000Z', {
    timeZone: 'Europe/Athens',
  }),
)

const inputs = (
  loaded: Option.Option<Backlog.Facts> = Option.some(facts()),
): Backlog.RowInputs => ({
  tickets,
  facts: loaded,
  runView: Option.none(),
  today: Option.some(today),
})

/** The requests `commands` make: each Command's name and arguments. */
const requests = (
  commands: ReadonlyArray<{
    readonly name: string
    readonly args?: unknown
  }> = [],
) => commands.map(({ name, args }) => ({ name, args }))

const loadFacts = (open: ReadonlyArray<TicketId>) =>
  requests([Backlog.LoadFacts({ ask: { project, open } })])

const said = (rows: ReadonlyArray<Backlog.BacklogRow>) =>
  rows.map(row => [row.ticket, row.mark.word, row.note])

describe('the list', () => {
  test('open: every ticket not closed, most urgent first, each with its mark and what it waits for', () => {
    expect(said(Backlog.rowsOf('open', inputs()))).toEqual([
      ['fa-1', 'waiting', '1 of 3 closed'],
      ['fa-2', 'ready', ''],
      [
        'fa-3',
        'waiting',
        'waits for fa-2 to merge: it is open; waits for fa-6, the ticket it was filed from, to merge',
      ],
      ['fa-4', 'in progress', ''],
      ['fa-5', 'deferred', 'until Fri 30 Oct 11:00'],
      ['fa-q1', 'for you', 'fa-4 waits on it'],
    ])
  })

  test('epics: how many of their tickets are closed', () => {
    expect(said(Backlog.rowsOf('epics', inputs()))).toEqual([
      ['fa-1', 'waiting', '1 of 3 closed'],
    ])
  })

  test('ready, in the engine’s order; nothing before the engine has said', () => {
    expect(said(Backlog.rowsOf('ready', inputs()))).toEqual([
      ['fa-2', 'ready', 'ready'],
    ])
    expect(Backlog.rowsOf('ready', inputs(Option.none()))).toEqual([])
  })

  test('waiting: each open ticket that isn’t ready, with every reason in the engine’s words', () => {
    expect(said(Backlog.rowsOf('waiting', inputs()))).toEqual([
      ['fa-1', 'waiting', 'it is an epic'],
      [
        'fa-3',
        'waiting',
        'waits for fa-2 to merge: it is open; waits for fa-6, the ticket it was filed from, to merge',
      ],
      ['fa-q1', 'for you', 'it is a question'],
    ])
  })

  test('questions and deferred tickets: the tickets a question holds up, and when a deferral ends', () => {
    expect(said(Backlog.rowsOf('questions', inputs()))).toEqual([
      ['fa-q1', 'for you', 'fa-4 waits on it'],
    ])
    expect(said(Backlog.rowsOf('deferred', inputs()))).toEqual([
      ['fa-5', 'deferred', 'until Fri 30 Oct 11:00'],
    ])
  })

  test('finished by the run: its merged tickets and those closed without a change', () => {
    const run = runView([
      runRow('fa-6', 'User schema', {
        _tag: 'merged',
        commit: 'ffd6ce4a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f',
      }),
      runRow('fa-8', 'Tidy imports', { _tag: 'no_change' }),
      runRow('fa-4', 'Refresh tokens', { _tag: 'working' }),
    ])
    expect(
      said(
        Backlog.rowsOf('finished', { ...inputs(), runView: Option.some(run) }),
      ),
    ).toEqual([
      ['fa-6', 'finished', 'merged'],
      ['fa-8', 'finished', 'no change'],
    ])
    expect(Backlog.rowsOf('finished', inputs())).toEqual([])
  })

  test('closed: newest first, with how each ended', () => {
    expect(said(Backlog.rowsOf('closed', inputs()))).toEqual([
      ['fa-7', 'closed', 'cancelled'],
      ['fa-6', 'closed', 'done'],
    ])
  })

  test('each mark has its role colour, a glyph and a word, so colour is never alone', () => {
    const readiness = Option.none()
    expect(
      tickets.map(shown => {
        const mark = Backlog.markOf(shown, readiness)
        return [shown.id, mark.role, mark.glyph, mark.word]
      }),
    ).toEqual([
      ['fa-1', 'c5', '·', 'open'],
      ['fa-2', 'c5', '·', 'open'],
      ['fa-3', 'c5', '·', 'open'],
      ['fa-4', 'c1', '●', 'in progress'],
      ['fa-5', 'c3', '‖', 'deferred'],
      ['fa-6', 'c4', '✓', 'closed'],
      ['fa-7', 'c4', '✓', 'closed'],
      ['fa-q1', 'c2', '?', 'for you'],
    ])
  })
})

describe('why the rest isn’t ready', () => {
  test('the backlog’s first frame asks the engine of its open tickets; the answer fills the list', () => {
    story(
      Backlog.update,
      given(Backlog.init()),
      model(shown => {
        const told = Backlog.receivedBacklog(shown, { project, tickets })
        expect(requests(told.commands)).toEqual(loadFacts(openIds))
        expect(AsyncData.isLoading(told.model.facts)).toBe(true)
        expect(told.model.asking).toEqual(Option.some(project))
      }),
    )
    const asked = Backlog.receivedBacklog(Backlog.init(), {
      project,
      tickets,
    }).model
    story(
      Backlog.update,
      given(asked),
      message(Backlog.Message.SucceededLoadFacts({ facts: facts() })),
      Command.expectNone(),
      model(shown => {
        expect(AsyncData.getData(shown.facts)).toEqual(Option.some(facts()))
        expect(shown.asking).toEqual(Option.none())
      }),
    )
  })

  test('a change while the engine is asked waits for its answer, then asks once more', () => {
    const asked = Backlog.receivedBacklog(Backlog.init(), {
      project,
      tickets,
    }).model
    const changed = Backlog.receivedBacklog(asked, {
      project,
      tickets: tickets.filter(shown => shown.id !== 'fa-3'),
    })
    expect(changed.commands).toBeUndefined()
    const again = { project, open: [id('fa-1'), id('fa-2'), id('fa-q1')] }
    expect(changed.model.again).toEqual(Option.some(again))
    story(
      Backlog.update,
      given(changed.model),
      message(Backlog.Message.SucceededLoadFacts({ facts: facts() })),
      Command.expectExact(Backlog.LoadFacts({ ask: again })),
      model(shown => {
        expect(AsyncData.isRefreshing(shown.facts)).toBe(true)
        expect(shown.again).toEqual(Option.none())
        expect(shown.asking).toEqual(Option.some(project))
      }),
      Command.resolve(
        Backlog.LoadFacts,
        Backlog.Message.SucceededLoadFacts({ facts: facts() }),
      ),
      model(shown => {
        expect(shown.asking).toEqual(Option.none())
      }),
    )
  })

  test('an answer for another project than the one asked is dropped', () => {
    const asked = Backlog.receivedBacklog(Backlog.init(), {
      project,
      tickets,
    }).model
    story(
      Backlog.update,
      given(asked),
      message(Backlog.Message.SucceededLoadFacts({ facts: facts(other) })),
      model(shown => {
        expect(shown).toBe(asked)
      }),
    )
  })

  test('the engine’s failure is kept in words, and the next change asks again', () => {
    const asked = Backlog.receivedBacklog(Backlog.init(), {
      project,
      tickets,
    }).model
    story(
      Backlog.update,
      given(asked),
      message(
        Backlog.Message.FailedLoadFacts({ project, reason: 'not connected' }),
      ),
      model(shown => {
        expect(AsyncData.getError(shown.facts)).toEqual(
          Option.some('not connected'),
        )
        expect(
          requests(
            Backlog.receivedBacklog(shown, { project, tickets }).commands,
          ),
        ).toEqual(loadFacts(openIds))
      }),
    )
  })

  test('choosing a section or a ticket changes only what is shown; the same choice keeps the model', () => {
    story(
      Backlog.update,
      given(Backlog.init()),
      message(Backlog.Message.ChoseSection({ section: 'waiting' })),
      message(Backlog.Message.SelectedTicket({ ticket: id('fa-3') })),
      Command.expectNone(),
      model(shown => {
        expect(shown.section).toBe('waiting')
        expect(shown.selected).toEqual(Option.some(id('fa-3')))
        expect(
          Backlog.update(
            shown,
            Backlog.Message.ChoseSection({ section: 'waiting' }),
          ).model,
        ).toBe(shown)
      }),
    )
  })
})

describe('the graph', () => {
  test('built from the edges: the tickets not closed, the closed ones linked to them, and their links', () => {
    const readiness = Backlog.readinessOf(Option.some(facts()))
    const graph = graphOf({
      tickets,
      edges: facts().edges,
      roleOf: shown => Backlog.markOf(shown, readiness).role,
    })
    expect(graph.nodes.map(node => [node.id, node.role])).toEqual([
      ['fa-1', 'c5'],
      ['fa-2', 'c5'],
      ['fa-3', 'c5'],
      ['fa-4', 'c1'],
      ['fa-5', 'c3'],
      ['fa-6', 'c4'],
      ['fa-q1', 'c2'],
    ])
    // fa-7 is closed and linked only to fa-6, closed too: it and its link are left out.
    expect(graph.edges.map(edge => [edge.from, edge.to, edge.kind])).toEqual([
      ['fa-1', 'fa-2', 'parent'],
      ['fa-1', 'fa-3', 'parent'],
      ['fa-1', 'fa-6', 'parent'],
      ['fa-2', 'fa-3', 'blocks'],
      ['fa-6', 'fa-2', 'blocks'],
      ['fa-q1', 'fa-4', 'blocks'],
    ])
  })

  test('its key changes with what it draws, and only then', () => {
    const graph = graphOf({
      tickets,
      edges: facts().edges,
      roleOf: () => 'c5',
    })
    const same = graphOf({
      tickets,
      edges: facts().edges,
      roleOf: () => 'c5',
    })
    const fewer = graphOf({
      tickets,
      edges: facts().edges.slice(1),
      roleOf: () => 'c5',
    })
    expect(graphKey(same)).toBe(graphKey(graph))
    expect(graphKey(fewer)).not.toBe(graphKey(graph))
  })
})

// The screen in the app: the Backlog screen opened on a project, the stream's snapshot received.

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(project),
  today: Option.some(today),
}

const snapshot = Message.ReceivedBacklog({
  project,
  items: [
    {
      _tag: 'snapshot',
      epoch: StreamEpoch.make('epoch-1'),
      seq: 0,
      value: tickets,
    },
  ],
})

const measured = () =>
  Mount.resolve(
    { name: 'ObserveVirtualList', args: { id: 'backlog' } },
    VirtualList.Message.ResizedContainer({
      containerWidth: 600,
      containerHeight: 800,
    }),
  )

const rowAt = (index: number) =>
  selector(`[data-virtual-list-item-index="${index}"]`)

describe('the screen', () => {
  test('opened on a project: its tickets listed, what is ready asked, a ticket shown whole with why it waits', () => {
    const opened = update(
      connected,
      Message.RequestedScreen({ screen: Screen.Backlog() }),
    ).model
    expect(requests(update(opened, snapshot).commands)).toEqual(
      loadFacts(openIds),
    )
    scene(
      { update, view },
      givenScene(opened),
      expectScene(selector('p')).toHaveText('Reading the backlog…'),
      Subscription.emit(snapshot),
      SceneCommand.resolve(
        Backlog.LoadFacts,
        Backlog.Message.SucceededLoadFacts({ facts: facts() }),
      ),
      measured(),
      // A tap on a node of the graph chooses its ticket.
      Mount.resolve(
        Backlog.DrawGraph,
        Backlog.Message.SelectedTicket({ ticket: id('fa-2') }),
      ),
      expectScene(role('button', { name: 'Open 6' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
      expectScene(role('button', { name: 'Waiting 3' })).toExist(),
      expectScene(selector('[data-graph-nodes]')).toHaveAttr(
        'data-graph-nodes',
        '7',
      ),
      expectScene(role('region', { name: 'Ticket' })).toContainText(
        'The form, its fields and its errors.',
      ),
      expectScene(rowAt(2)).toContainText('Session store'),
      expectScene(within(rowAt(2), selector('[data-note]'))).toHaveText(
        'waits for fa-2 to merge: it is open; waits for fa-6, the ticket it was filed from, to merge',
      ),
      click(role('button', { name: 'fa-3 Session store: waiting' })),
      expectScene(
        role('button', { name: 'fa-3 Session store: waiting' }),
      ).toHaveAttr('aria-pressed', 'true'),
      expectScene(role('region', { name: 'Why it isn’t ready' })).toContainText(
        'waits for fa-6, the ticket it was filed from, to merge',
      ),
      expectScene(role('region', { name: 'Links' })).toContainText(
        'fa-2 blocks fa-3',
      ),
      click(role('button', { name: 'Questions 1' })),
      click(
        role('button', {
          name: 'fa-q1 Keep the old refresh endpoint?: for you',
        }),
      ),
      expectScene(role('region', { name: 'Options' })).toContainText(
        'Keep it (recommended): Old clients go on working',
      ),
    )
  })

  test('a ticket sent again unchanged, as a link of its changed, asks the engine afresh', () => {
    const opened = update(
      connected,
      Message.RequestedScreen({ screen: Screen.Backlog() }),
    ).model
    const received = update(opened, snapshot).model
    const answered = update(
      received,
      Message.GotBacklogMessage({
        message: Backlog.Message.SucceededLoadFacts({ facts: facts() }),
      }),
    ).model
    expect(answered.screens.backlog.asking).toEqual(Option.none())
    const resent = update(
      answered,
      Message.ReceivedBacklog({
        project,
        items: [
          {
            _tag: 'patch',
            seq: 1,
            value: { upsert: [session], remove: [] },
          },
        ],
      }),
    )
    expect(requests(resent.commands)).toEqual(loadFacts(openIds))
  })

  test('with every project in scope, it asks for one', () => {
    scene(
      { update, view },
      givenScene({
        ...connected,
        scope: Option.none(),
        screen: Screen.Backlog(),
      }),
      expectScene(selector('p')).toContainText(
        'Choose a project in the sidebar to see its backlog.',
      ),
    )
  })
})
