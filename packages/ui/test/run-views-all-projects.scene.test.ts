import { Effect, Option, Schema, Stream } from 'effect'
import {
  Command,
  all,
  click,
  expect as expectScene,
  first,
  given,
  role,
  scene,
  selector,
  text,
  within,
} from 'foldkit/scene'
import {
  Command as StoryCommand,
  message,
  model,
  story,
  given as storyGiven,
} from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import {
  EngineId,
  ProjectId,
  ProjectRunState,
  ProjectStatus,
  type ProjectStatusItem,
  RunId,
  RunView,
  StreamEpoch,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import { type EngineProject, projectKey } from '../src/app/engine-project'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { makeSubscriptions } from '../src/app/subscriptions'
import { WaitToRewatchRunView, update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Worker from '../src/screens/worker'

// The console under the sidebar's All projects scope (spec §18.3): every project's run going has its
// view watched, In progress draws each one's cards in its own project's colour with its chip, Up next
// merges their queues, and the stats row sums its figures over them; a card opens its worker on its
// own project. A project's own scope keeps its one run.

const engine = EngineId.make('e-1')
const alpha = ProjectId.make('p-1')
const beta = ProjectId.make('p-2')
const gamma = ProjectId.make('p-3')
const alphaRun = RunId.make('r-a')
const betaRun = RunId.make('r-b')
const nextRun = RunId.make('r-c')
const epoch = StreamEpoch.make('epoch-1')

/** A project on this machine's engine, which holds them all. */
const here = (project: ProjectId): EngineProject => ({
  engine: localEngineName,
  project,
})

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine,
    release: '0.1.0',
    protocol: protocolVersion,
  }),
}

const idle = ProjectRunState.cases.idle.make({})
const running = (run: RunId) =>
  ProjectRunState.cases.running.make({ run, overnight: false })

const status = (of: ProjectId, run: ProjectRunState): ProjectStatus =>
  new ProjectStatus({
    project: of,
    name: of,
    base: 'main',
    setUp: true,
    trusted: false,
    run,
    ready: 0,
  })

const projects = (...value: ReadonlyArray<ProjectStatus>): Message =>
  Message.ReceivedProjects({
    engine,
    name: 'local',
    items: [
      { _tag: 'snapshot', epoch, seq: 0, value } satisfies ProjectStatusItem,
    ],
  })

const received = (shown: Model, ...messages: ReadonlyArray<Message>): Model =>
  messages.reduce((next, each) => update(next, each).model, shown)

/** A ticket row's JSON in `phase`. */
const row = (ticket: string, phase: object) => ({
  ticket,
  title: `Ticket ${ticket}`,
  type: 'task',
  priority: 2,
  phase,
  since: 1_793_268_900_000,
  startedAt: null,
  solo: false,
  handBacks: { resolve: 0, fix: 0 },
})

const decodeRunView = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))

/** A run's view: its ticket rows, its workers live against its slots, its queue and its tokens. */
const viewOf = ({
  project,
  run,
  tickets,
  live,
  slots,
  inQueue,
  tokens,
}: {
  readonly project: ProjectId
  readonly run: RunId
  readonly tickets: ReadonlyArray<object>
  readonly live: number
  readonly slots: number
  readonly inQueue: number
  readonly tokens: number
}): RunView =>
  decodeRunView({
    header: {
      run,
      project,
      engine,
      mode: { _tag: 'tickets' },
      state: 'running',
      startedAt: 1_793_268_900_000,
      offline: false,
      autoAnswer: false,
    },
    totals: {
      live,
      slots,
      counts: {
        in_queue: inQueue,
        working: live,
        waiting_to_merge: 0,
        needs_you: 1,
        set_aside: 0,
        carried_over: 0,
        done: 0,
      },
      doneToday: 2,
      tokens: { input: tokens, output: 0, cache_write: 0, cache_read: 0 },
      costUsd: null,
    },
    tickets,
    workers: [],
    queue: { merging: null, train: null, waiting: [] },
    holds: [],
    banners: [],
    attention: [],
    load: null,
    steps: [],
  })

const alphaView = viewOf({
  project: alpha,
  run: alphaRun,
  tickets: [
    row('fa-1', { _tag: 'working' }),
    row('fa-2', {
      _tag: 'held_back',
      reason: 'merge',
      detail: 'waits for fa-1 to merge',
    }),
  ],
  live: 1,
  slots: 4,
  inQueue: 1,
  tokens: 1_000,
})

const betaView = viewOf({
  project: beta,
  run: betaRun,
  tickets: [
    row('fb-1', { _tag: 'verifying', round: 1 }),
    row('fb-2', { _tag: 'queued' }),
  ],
  live: 2,
  slots: 2,
  inQueue: 1,
  tokens: 2_000,
})

/** The shape of a run view with nothing in it, for a view that matters only for whose it is. */
const shape = {
  tickets: [],
  live: 0,
  slots: 1,
  inQueue: 0,
  tokens: 0,
}

const viewed = (project: ProjectId, value: RunView): Message =>
  Message.ReceivedRunView({
    project: here(project),
    items: [{ _tag: 'snapshot', epoch, seq: 0, value }],
  })

/** Under All projects, alpha (chip 01, c1) and beta (chip 02, c2) running, gamma idle. */
const known = received(
  connected,
  projects(
    status(alpha, running(alphaRun)),
    status(beta, running(betaRun)),
    status(gamma, idle),
  ),
)

/** Both runs' views shown, beta's first to come. */
const both = received(known, viewed(beta, betaView), viewed(alpha, alphaView))

const inProgress = role('region', { name: 'In progress' })
const upNext = role('region', { name: 'Up next' })
const card = (project: ProjectId, ticket: string) =>
  selector(
    `[data-project="${projectKey(here(project))}"][data-ticket="${ticket}"]`,
  )
const entry = (project: ProjectId, ticket: string) =>
  selector(
    `[data-project="${projectKey(here(project))}"][data-entry="${ticket}"]`,
  )
const valueOf = (name: string) =>
  within(selector(`[data-stat="${name}"]`), selector('[data-value]'))

describe('the run views watch', () => {
  const { runViews } = makeSubscriptions({
    nextFrame: Effect.void,
    keys: Stream.empty,
    ticks: Stream.empty,
    replacedEnginePorts: Stream.empty,
  })

  test("under All projects, each project's run going; none of an idle one", () => {
    expect(runViews.modelToDependencies(known).runs).toEqual([
      { engine: localEngineName, project: alpha, run: alphaRun },
      { engine: localEngineName, project: beta, run: betaRun },
    ])
  })

  test("a project's own scope watches none: its run is the scoped watch's", () => {
    expect(
      runViews.modelToDependencies({
        ...known,
        scope: Option.some(here(alpha)),
      }).runs,
    ).toEqual([])
  })

  test('nothing is watched while the engine is down', () => {
    expect(
      runViews.modelToDependencies({
        ...known,
        connection: Connection.Connecting(),
      }).runs,
    ).toEqual([])
  })
})

describe('the run views kept', () => {
  test("each project's view is kept apart, a patch of one keeping the other's identity", () => {
    expect(both.runViews.map(({ project }) => project)).toEqual([
      here(beta),
      here(alpha),
    ])
    expect(Option.isNone(both.runView)).toBe(true)
    const patched = received(
      both,
      Message.ReceivedRunView({
        project: here(alpha),
        items: [{ _tag: 'patch', seq: 1, value: {} }],
      }),
    )
    expect(patched.runViews[0]).toBe(both.runViews[0])
  })

  test("an idle project's view is not kept", () => {
    const shown = received(
      known,
      viewed(gamma, viewOf({ ...shape, project: gamma, run: alphaRun })),
    )
    expect(shown.runViews).toEqual([])
  })

  test('a run ended, or followed by another, drops its view; the rest keep the list', () => {
    const ended = received(
      both,
      projects(status(alpha, idle), status(beta, running(betaRun))),
    )
    expect(ended.runViews.map(({ project }) => project)).toEqual([here(beta)])
    const followed = received(
      both,
      projects(status(alpha, running(nextRun)), status(beta, running(betaRun))),
    )
    expect(followed.runViews.map(({ project }) => project)).toEqual([
      here(beta),
    ])
    const same = received(
      both,
      projects(
        status(alpha, running(alphaRun)),
        status(beta, running(betaRun)),
      ),
    )
    expect(same.runViews).toBe(both.runViews)
  })

  test('choosing a project clears them; its own run is watched instead', () => {
    const scoped = received(
      both,
      Message.SelectedScope({ project: Option.some(here(alpha)) }),
    )
    expect(scoped.runViews).toEqual([])
    expect(received(scoped, viewed(beta, betaView)).runViews).toEqual([])
  })

  test('a watch that ended NoRun drops its view and watches again after a pause while its row shows the run', () => {
    story(
      update,
      storyGiven(both),
      message(Message.EndedRunView({ project: here(alpha), reason: 'NoRun' })),
      StoryCommand.expectExact(
        WaitToRewatchRunView({ project: here(alpha), run: alphaRun }),
      ),
      StoryCommand.resolve(
        WaitToRewatchRunView,
        Message.WaitedToRewatchRunView({ project: here(alpha), run: alphaRun }),
      ),
      model(shown => {
        expect(shown.runViews.map(({ project }) => project)).toEqual([
          here(beta),
        ])
        expect(shown.runWatch).toBe(both.runWatch + 1)
      }),
    )
  })

  test('the pause watches nothing again once the view shows', () => {
    const waited = received(
      both,
      Message.WaitedToRewatchRunView({ project: here(alpha), run: alphaRun }),
    )
    expect(waited.runWatch).toBe(both.runWatch)
  })
})

describe('In progress under All projects', () => {
  test("every project's cards, in the sidebar's order, each with its chip and its colour", () => {
    scene(
      { update, view },
      given(both),
      expectScene(
        within(inProgress, selector('[data-count="in-progress"]')),
      ).toHaveText('2'),
      expectScene(within(inProgress, text('Nothing in progress'))).toBeAbsent(),
      expectScene(
        within(card(alpha, 'fa-1'), selector('[data-chip]')),
      ).toHaveText('01'),
      expectScene(
        within(card(alpha, 'fa-1'), selector('[data-state="current"]')),
      ).toHaveClass('bg-c1'),
      expectScene(
        within(card(beta, 'fb-1'), selector('[data-chip]')),
      ).toHaveText('02'),
      expectScene(
        within(card(beta, 'fb-1'), selector('[data-state="current"]')),
      ).toHaveClass('bg-c2'),
      expectScene(first(all.selector('[data-ticket]'))).toHaveAttr(
        'data-ticket',
        'fa-1',
      ),
    )
  })

  test('a card opens its worker on its own project', () => {
    const worker = { project: here(beta), ticket: TicketId.make('fb-1') }
    scene(
      { update, view },
      given(both),
      click(card(beta, 'fb-1')),
      Command.resolve(
        Worker.LoadTicket({ worker }),
        Worker.Message.FailedLoadTicket({ worker, reason: 'not served' }),
      ),
      expectScene(role('heading', { name: 'Worker fb-1' })).toExist(),
    )
    expect(update(both, Message.RequestedWorker(worker)).model.screen).toEqual(
      Screen.Worker(worker),
    )
  })

  test("a project's own scope draws its cards unmarked", () => {
    scene(
      { update, view },
      given({
        ...known,
        scope: Option.some(here(beta)),
        runView: Option.some(betaView),
      }),
      expectScene(card(beta, 'fb-1')).toExist(),
      expectScene(card(alpha, 'fa-1')).toBeAbsent(),
      expectScene(
        within(card(beta, 'fb-1'), selector('[data-chip]')),
      ).toBeAbsent(),
    )
  })
})

describe('Up next under All projects', () => {
  test("every project's queue merged, the ready tickets first, each entry with its chip", () => {
    scene(
      { update, view },
      given({ ...both, attention: Option.some([]) }),
      expectScene(within(upNext, selector('[data-count="queue"]'))).toHaveText(
        '2',
      ),
      expectScene(
        within(entry(beta, 'fb-2'), selector('[data-place]')),
      ).toHaveText('Ready'),
      expectScene(
        within(entry(beta, 'fb-2'), selector('[data-chip]')),
      ).toHaveText('02'),
      expectScene(
        within(entry(alpha, 'fa-2'), selector('[data-place]')),
      ).toHaveText('Waiting'),
      expectScene(
        within(entry(alpha, 'fa-2'), selector('[data-chip]')),
      ).toHaveText('01'),
      expectScene(first(all.selector('[data-entry]'))).toHaveAttr(
        'data-entry',
        'fb-2',
      ),
    )
  })
})

describe('the stats row under All projects', () => {
  test('its figures summed over every run going, with no run controls', () => {
    scene(
      { update, view },
      given(both),
      expectScene(valueOf('live')).toHaveText('3 of 6'),
      expectScene(valueOf('done')).toHaveText('4'),
      expectScene(valueOf('needs-you')).toHaveText('2'),
      expectScene(valueOf('in-queue')).toHaveText('2'),
      expectScene(valueOf('tokens')).toHaveText('3k'),
      expectScene(
        within(selector('[data-stat="in-queue"]'), selector('[data-waiting]')),
      ).toHaveText('1 waiting'),
      expectScene(role('group', { name: 'Run controls' })).toBeAbsent(),
    )
  })

  test('with no run going it says so', () => {
    scene(
      { update, view },
      given(known),
      expectScene(text('No run going')).toExist(),
      expectScene(selector('[data-stat="live"]')).toBeAbsent(),
    )
  })
})
