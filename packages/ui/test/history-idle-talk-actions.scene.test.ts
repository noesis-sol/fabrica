import { Effect, Option, Stream } from 'effect'
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
  StreamEpoch,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'
import * as VirtualList from '@foldkit/ui/virtualList'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import type { EventsItem } from '../src/app/streams'
import { makeSubscriptions } from '../src/app/subscriptions'
import { update } from '../src/app/update'
import { view } from '../src/app/view'

// The run talk's actions with no run going in History (spec §15.4, §18.3): in a project's scope they
// appear as the engine sends them, above what the last run's stream kept, and a run starting takes
// History back to its own events. Another project's actions, and All projects, are left out.

const project: EngineProject = {
  engine: localEngineName,
  project: ProjectId.make('p-1'),
}
const other: EngineProject = { ...project, project: ProjectId.make('p-2') }
const run = RunId.make('2026-10-29T10:00:00.000+02:00')
const ticket = TicketId.make('fa-7')
const epoch = StreamEpoch.make('epoch-1')

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(project),
}

const action = (minute: string, text: string): RunEvent =>
  RunEvent.cases.talk_action.make({
    time: LocalTime.make(`2026-10-29T10:${minute}:00.000+02:00`),
    run,
    actor: 'run_talk',
    tool: 'label_ticket',
    ticket,
    text,
  })

const dispatch = (minute: string, title: string): RunEvent =>
  RunEvent.cases.dispatch.make({
    time: LocalTime.make(`2026-10-29T10:${minute}:00.000+02:00`),
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
  seq: events.length,
  value: events,
})

const patchOf = (
  seq: number,
  events: ReadonlyArray<RunEvent>,
): typeof EventsItem.Type => ({ _tag: 'patch', seq, value: events })

/** The project list, with `state` as the scoped project's run. */
const rows = (state: ProjectRunState): Message =>
  Message.ReceivedProjects({
    engine: EngineId.make('e-1'),
    name: 'local',
    items: [
      {
        _tag: 'snapshot',
        epoch,
        seq: 0,
        value: [
          new ProjectStatus({
            project: project.project,
            name: project.project,
            base: 'main',
            setUp: true,
            trusted: false,
            run: state,
            ready: 0,
          }),
        ],
      } satisfies ProjectStatusItem,
    ],
  })

const received = (model: Model, ...messages: ReadonlyArray<Message>): Model =>
  messages.reduce((shown, next) => update(shown, next).model, model)

const measured = () =>
  Mount.resolve(
    { name: 'ObserveVirtualList', args: { id: 'history' } },
    VirtualList.Message.ResizedContainer({
      containerWidth: 320,
      containerHeight: 1000,
    }),
  )

const rowText = (index: number) =>
  within(
    selector(`[data-virtual-list-item-index="${index}"]`),
    selector('[data-history-line]'),
  )

const shownEvents = (model: Model) =>
  model.events.flatMap(({ events }) => events.map(event => event.time))

const talkActions = (
  items: readonly [typeof EventsItem.Type, ...Array<typeof EventsItem.Type>],
  of: EngineProject = project,
): Message => Message.ReceivedTalkActions({ project: of, items })

const going = ProjectRunState.cases.running.make({ run, overnight: false })

describe('History with no run going', () => {
  test('shows the run talk’s actions as they come, newest first', () => {
    scene(
      { update, view },
      given(connected),
      Subscription.emit(
        talkActions([snapshotOf([action('01', 'Run talk labelled fa-7 one')])]),
      ),
      measured(),
      expectScene(rowText(0)).toContainText('Run talk labelled fa-7 one'),
      Subscription.emit(
        talkActions([patchOf(2, [action('02', 'Run talk labelled fa-7 two')])]),
      ),
      expectScene(rowText(0)).toContainText('Run talk labelled fa-7 two'),
      expectScene(rowText(1)).toContainText('Run talk labelled fa-7 one'),
    )
  })

  test('puts them above what the last run’s stream kept, and takes none twice', () => {
    const first = dispatch('01', 'Refresh tokens')
    const last = action('02', 'Run talk drained the run')
    const after = action('05', 'Run talk labelled fa-7 one')
    const kept = received(
      connected,
      Message.ReceivedEvents({
        project,
        items: [snapshotOf([first, last])],
      }),
    )
    const followed = received(kept, talkActions([snapshotOf([])]))
    expect(shownEvents(followed)).toEqual([last.time, first.time])

    const live = received(followed, talkActions([patchOf(1, [after])]))
    expect(shownEvents(live)).toEqual([after.time, last.time, first.time])

    // Sent again, as a new snapshot after a lost connection, each keeps one row.
    const again = received(live, talkActions([snapshotOf([after])]))
    expect(shownEvents(again)).toEqual(shownEvents(live))
  })

  test('a run starting takes History back to its own events', () => {
    scene(
      { update, view },
      given(connected),
      Subscription.emit(
        talkActions([snapshotOf([action('01', 'Run talk labelled fa-7 one')])]),
      ),
      measured(),
      Subscription.emit(rows(going)),
      Subscription.emit(
        Message.ReceivedEvents({
          project,
          items: [snapshotOf([dispatch('02', 'Refresh tokens')])],
        }),
      ),
      expectScene(rowText(0)).toContainText('Refresh tokens'),
      expectScene(rowText(1)).toBeAbsent(),
    )
  })

  test('leaves out an action that comes once a run goes', () => {
    const started = received(connected, rows(going))
    expect(
      received(
        started,
        talkActions([snapshotOf([action('01', 'Run talk labelled fa-7 one')])]),
      ).events,
    ).toEqual([])
  })

  test('leaves out another project’s, and any under All projects', () => {
    const late = talkActions(
      [snapshotOf([action('01', 'Run talk labelled fa-7 one')])],
      other,
    )
    scene(
      { update, view },
      given(connected),
      Subscription.emit(late),
      expectScene(role('region', { name: 'History' })).toContainText(
        'No events yet',
      ),
    )
    expect(
      received(
        { ...connected, scope: Option.none() },
        talkActions([snapshotOf([action('01', 'Run talk labelled fa-7 one')])]),
      ).events,
    ).toEqual([])
  })
})

const { talkActions: talkActionsWatch } = makeSubscriptions({
  nextFrame: Effect.void,
  keys: Stream.empty,
  ticks: Stream.empty,
  replacedEnginePorts: Stream.empty,
})

const watched = (model: Model) =>
  talkActionsWatch.modelToDependencies(model).project

describe('History’s talk actions watch', () => {
  test('follows the scoped project while its row shows no run going', () => {
    expect(watched(connected)).toEqual(Option.some(project))
    expect(
      watched(received(connected, rows(ProjectRunState.cases.idle.make({})))),
    ).toEqual(Option.some(project))
  })

  test('stops as a run starts, and comes back as it ends, its last view kept', () => {
    const started = received(connected, rows(going))
    expect(watched(started)).toEqual(Option.none())
    expect(
      watched(received(started, rows(ProjectRunState.cases.idle.make({})))),
    ).toEqual(Option.some(project))
  })

  test('follows nothing under All projects or while the engine is down', () => {
    expect(watched({ ...connected, scope: Option.none() })).toEqual(
      Option.none(),
    )
    expect(
      watched({ ...connected, connection: Connection.Connecting() }),
    ).toEqual(Option.none())
  })
})
