import { Effect, Option, Schema, Stream } from 'effect'
import {
  Mount,
  Subscription,
  expect as expectScene,
  given,
  role,
  scene,
  selector,
  within,
} from 'foldkit/scene'

import { describe, expect, test } from '@effect/vitest'
import {
  EngineId,
  LocalTime,
  ProjectId,
  ProjectRunState,
  ProjectStatus,
  type ProjectStatusItem,
  RunEvent,
  RunId,
  RunView,
  StreamEpoch,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'
import * as VirtualList from '@foldkit/ui/virtualList'

import { Connection } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import type { EventsItem } from '../src/app/streams'
import { makeSubscriptions } from '../src/app/subscriptions'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import { historyRows } from '../src/console/history'

// History under the sidebar's All projects scope (spec §18.3): every project's run going is watched,
// its events merged newest first by the moment each was recorded, times in different zones compared
// as instants, each row marked with its project's chip; a project's own scope shows its events alone,
// unmarked.

const engine = EngineId.make('e-1')
const alpha = ProjectId.make('p-1')
const beta = ProjectId.make('p-2')
const gamma = ProjectId.make('p-3')
const alphaRun = RunId.make('2026-10-29T10:00:00.000+02:00')
const betaRun = RunId.make('2026-10-29T08:00:00.000+00:00')
const ticket = TicketId.make('fa-7')
const epoch = StreamEpoch.make('epoch-1')

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine,
    release: '0.1.0',
    protocol: protocolVersion,
  }),
}

const running = (run: RunId) =>
  ProjectRunState.cases.running.make({ run, overnight: false })

const status = (of: ProjectId, run: ProjectRunState): ProjectStatus =>
  new ProjectStatus({
    project: of,
    name: of,
    base: 'main',
    setUp: true,
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

const received = (model: Model, ...messages: ReadonlyArray<Message>): Model =>
  messages.reduce((shown, next) => update(shown, next).model, model)

/** A dispatch in `run`, recorded at `time`, its line naming `title`. */
const dispatch = (run: RunId, time: string, title: string): RunEvent =>
  RunEvent.cases.dispatch.make({
    time: LocalTime.make(time),
    run,
    ticket,
    title,
    n: 1,
    queued: 0,
    text: `fa-7 dispatching: ${title}`,
  })

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

const eventsOf = (
  project: ProjectId,
  items: readonly [typeof EventsItem.Type, ...Array<typeof EventsItem.Type>],
): Message => Message.ReceivedEvents({ project, items })

const measured = () =>
  Mount.resolve(
    { name: 'ObserveVirtualList', args: { id: 'history' } },
    VirtualList.Message.ResizedContainer({
      containerWidth: 320,
      containerHeight: 1000,
    }),
  )

const rowAt = (index: number) =>
  selector(`[data-virtual-list-item-index="${index}"]`)

const rowText = (index: number) =>
  within(rowAt(index), selector('[data-history-line]'))

const rowChip = (index: number) =>
  within(rowAt(index), selector('[data-history-chip]'))

/** Two projects known to the sidebar, alpha first (chip 01, c1), beta second (chip 02, c2). */
const known = received(
  connected,
  projects(status(alpha, running(alphaRun)), status(beta, running(betaRun))),
)

describe('History under All projects', () => {
  test("every project's events, newest first by their moment, each row with its project's chip", () => {
    scene(
      { update, view },
      given(
        received(
          known,
          eventsOf(alpha, [
            snapshotOf([
              dispatch(alphaRun, '2026-10-29T10:05:00.000+02:00', 'alpha one'),
              dispatch(alphaRun, '2026-10-29T10:20:00.000+02:00', 'alpha two'),
            ]),
          ]),
        ),
      ),
      measured(),
      Subscription.emit(
        eventsOf(beta, [
          snapshotOf([
            dispatch(betaRun, '2026-10-29T08:10:00.000+00:00', 'beta one'),
          ]),
        ]),
      ),
      // beta's 08:10 UTC is later than alpha's 10:05 at +02:00 (08:05 UTC), though its string sorts first.
      expectScene(rowText(0)).toContainText('alpha two'),
      expectScene(rowChip(0)).toHaveText('01'),
      expectScene(rowChip(0)).toHaveAttr('data-history-chip', 'c1'),
      expectScene(rowText(1)).toContainText('beta one'),
      expectScene(rowChip(1)).toHaveText('02'),
      expectScene(rowChip(1)).toHaveAttr('data-history-chip', 'c2'),
      expectScene(rowText(2)).toContainText('alpha one'),
      expectScene(rowChip(2)).toHaveText('01'),
    )
  })

  test("a project's patch goes on among its own rows, the others kept", () => {
    const both = received(
      known,
      eventsOf(alpha, [
        snapshotOf([
          dispatch(alphaRun, '2026-10-29T10:05:00.000+02:00', 'alpha one'),
        ]),
      ]),
      eventsOf(beta, [
        snapshotOf([
          dispatch(betaRun, '2026-10-29T08:10:00.000+00:00', 'beta one'),
        ]),
      ]),
    )
    const patched = received(
      both,
      eventsOf(alpha, [
        patchOf(1, [
          dispatch(alphaRun, '2026-10-29T10:30:00.000+02:00', 'alpha two'),
        ]),
      ]),
    )
    expect(patched.events.map(entry => entry.project)).toEqual([alpha, beta])
    expect(patched.events[1]).toBe(both.events[1])
    expect(
      historyRows(
        patched.events.map(entry => ({ ...entry, chip: Option.none() })),
      ).map(row => row.text),
    ).toEqual([
      'fa-7 dispatching: alpha two',
      'fa-7 dispatching: beta one',
      'fa-7 dispatching: alpha one',
    ])
  })

  test('a patch before its project’s first snapshot shows nothing', () => {
    const early = received(
      known,
      eventsOf(alpha, [
        patchOf(1, [
          dispatch(alphaRun, '2026-10-29T10:05:00.000+02:00', 'alpha one'),
        ]),
      ]),
    )
    expect(early.events).toEqual([])
  })

  test('rows of runs with the same ID in two projects keep keys of their own', () => {
    const shared = RunId.make('r-1')
    const rows = historyRows(
      [alpha, beta].map(project => ({
        project,
        events: [dispatch(shared, '2026-10-29T10:05:00.000+02:00', project)],
        chip: Option.none(),
      })),
    )
    expect(new Set(rows.map(row => row.key)).size).toBe(2)
  })

  test("a project's own scope shows its events alone, with no chip", () => {
    scene(
      { update, view },
      given({ ...known, scope: Option.some(alpha) }),
      Subscription.emit(
        eventsOf(beta, [
          snapshotOf([
            dispatch(betaRun, '2026-10-29T08:10:00.000+00:00', 'beta one'),
          ]),
        ]),
      ),
      Subscription.emit(
        eventsOf(alpha, [
          snapshotOf([
            dispatch(alphaRun, '2026-10-29T10:05:00.000+02:00', 'alpha one'),
          ]),
        ]),
      ),
      measured(),
      expectScene(rowText(0)).toContainText('alpha one'),
      expectScene(rowChip(0)).toBeAbsent(),
      expectScene(rowAt(1)).toBeAbsent(),
    )
  })

  test('choosing All projects clears the scoped project’s events until the streams send theirs', () => {
    const scoped = received(
      { ...known, scope: Option.some(alpha) },
      eventsOf(alpha, [
        snapshotOf([
          dispatch(alphaRun, '2026-10-29T10:05:00.000+02:00', 'alpha one'),
        ]),
      ]),
    )
    const all = received(
      scoped,
      Message.SelectedScope({ project: Option.none() }),
    )
    expect(all.events).toEqual([])
    scene(
      { update, view },
      given(all),
      expectScene(role('region', { name: 'History' })).toContainText(
        'No events yet',
      ),
    )
  })
})

const { events: eventsWatch } = makeSubscriptions({
  nextFrame: Effect.void,
  keys: Stream.empty,
  ticks: Stream.empty,
})

const watched = (model: Model) => eventsWatch.modelToDependencies(model).runs

const sameWatch = Schema.toEquivalence(eventsWatch.dependenciesSchema)

const viewOf = (project: ProjectId, run: RunId): RunView =>
  Schema.decodeUnknownSync(Schema.toCodecJson(RunView))({
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
      live: 0,
      slots: 4,
      counts: {
        in_queue: 0,
        working: 0,
        waiting_to_merge: 0,
        needs_you: 0,
        set_aside: 0,
        carried_over: 0,
        done: 0,
      },
      tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
      costUsd: null,
    },
    tickets: [],
    workers: [],
    queue: { merging: null, train: null, waiting: [] },
    holds: [],
    banners: [],
    attention: [],
    load: null,
    steps: [],
  })

describe("History's events watch", () => {
  test("under All projects, each project's run going; none of an idle one", () => {
    const model = received(
      connected,
      projects(
        status(alpha, running(alphaRun)),
        status(beta, ProjectRunState.cases.idle.make({})),
        status(
          gamma,
          ProjectRunState.cases.waiting.make({
            run: betaRun,
            overnight: false,
            needsYou: 1,
          }),
        ),
      ),
    )
    expect(watched(model)).toEqual([
      { project: alpha, run: alphaRun },
      { project: gamma, run: betaRun },
    ])
  })

  test("a project's run starting under All projects watches afresh", () => {
    const before = received(
      connected,
      projects(
        status(alpha, running(alphaRun)),
        status(beta, ProjectRunState.cases.idle.make({})),
      ),
    )
    const after = received(
      before,
      projects(
        status(alpha, running(alphaRun)),
        status(beta, running(betaRun)),
      ),
    )
    expect(sameWatch({ runs: watched(before) }, { runs: watched(after) })).toBe(
      false,
    )
  })

  test("a project's scope watches its viewed run alone", () => {
    const scoped = {
      ...known,
      scope: Option.some(alpha),
      runView: Option.some(viewOf(alpha, alphaRun)),
    }
    expect(watched(scoped)).toEqual([{ project: alpha, run: alphaRun }])
    expect(watched({ ...scoped, runView: Option.none() })).toEqual([])
  })

  test('nothing is watched while the engine is down', () => {
    expect(watched({ ...known, connection: Connection.Connecting() })).toEqual(
      [],
    )
  })
})
