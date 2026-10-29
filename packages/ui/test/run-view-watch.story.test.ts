import { Effect, Option, Schema, Stream } from 'effect'

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
  protocolVersion,
} from '@fabrica/contracts'

import { Connection } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { makeSubscriptions } from '../src/app/subscriptions'
import { update } from '../src/app/update'
import { goingRun } from '../src/console/sidebar'

// The scoped project's run view is watched afresh whenever its sidebar row shows a new run going,
// wherever the run was started (the app, the CLI, the run talk), not only when the scope changes or the
// app starts one; a run's end keeps its last view rather than watching afresh.

const engine = EngineId.make('e-1')
const project = ProjectId.make('p-1')
const other = ProjectId.make('p-2')
const first = RunId.make('r-1')
const second = RunId.make('r-2')

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine,
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(project),
}

const idle = ProjectRunState.cases.idle.make({})
const running = (run: RunId) =>
  ProjectRunState.cases.running.make({ run, overnight: false })
const waiting = (run: RunId) =>
  ProjectRunState.cases.waiting.make({ run, overnight: false, needsYou: 1 })

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
      {
        _tag: 'snapshot',
        epoch: StreamEpoch.make('epoch-1'),
        seq: 0,
        value,
      } satisfies ProjectStatusItem,
    ],
  })

const received = (model: Model, ...messages: ReadonlyArray<Message>): Model =>
  messages.reduce((shown, next) => update(shown, next).model, model)

const { runView } = makeSubscriptions({
  nextFrame: Effect.void,
  keys: Stream.empty,
  ticks: Stream.empty,
})

const dependencies = (model: Model) => runView.modelToDependencies(model)

const sameDependencies = Schema.toEquivalence(runView.dependenciesSchema)

const viewOf = (run: RunId): RunView =>
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

describe("the scoped project's run view watch", () => {
  test("a project's going run is its row's Running or Waiting run, none while idle or unknown", () => {
    const sidebar = received(
      connected,
      projects(status(project, running(first)), status(other, idle)),
    ).console.sidebar
    expect(goingRun(sidebar, project)).toEqual(Option.some(first))
    expect(goingRun(sidebar, other)).toEqual(Option.none())
    expect(goingRun(sidebar, ProjectId.make('p-3'))).toEqual(Option.none())
    const waited = received(
      connected,
      projects(status(project, waiting(second))),
    ).console.sidebar
    expect(goingRun(waited, project)).toEqual(Option.some(second))
  })

  test('a run started elsewhere watches the view afresh, with no new scope and no run the app started', () => {
    const before = received(connected, projects(status(project, idle)))
    const after = received(before, projects(status(project, running(first))))
    expect(after.scope).toEqual(before.scope)
    expect(after.runWatch).toBe(before.runWatch)
    expect(dependencies(before).run).toEqual(Option.none())
    expect(dependencies(after).run).toEqual(Option.some(first))
    expect(sameDependencies(dependencies(before), dependencies(after))).toBe(
      false,
    )
  })

  test('the next run watches afresh; the run going on to wait on the maintainer does not', () => {
    const going = received(connected, projects(status(project, running(first))))
    const waited = received(going, projects(status(project, waiting(first))))
    const next = received(waited, projects(status(project, running(second))))
    expect(sameDependencies(dependencies(going), dependencies(waited))).toBe(
      true,
    )
    expect(sameDependencies(dependencies(waited), dependencies(next))).toBe(
      false,
    )
  })

  test("a run's end keeps watching its view while the view shows it", () => {
    const going = {
      ...received(connected, projects(status(project, running(first)))),
      runView: Option.some(viewOf(first)),
    }
    const ended = received(going, projects(status(project, idle)))
    expect(Option.isSome(ended.runView)).toBe(true)
    expect(sameDependencies(dependencies(going), dependencies(ended))).toBe(
      true,
    )
  })

  test("another project's run going changes nothing in the scope's watch", () => {
    const before = received(
      connected,
      projects(status(project, idle), status(other, idle)),
    )
    const after = received(
      before,
      projects(status(project, idle), status(other, running(second))),
    )
    expect(sameDependencies(dependencies(before), dependencies(after))).toBe(
      true,
    )
  })

  test('nothing is watched while the engine is down', () => {
    const down = received(
      { ...connected, connection: Connection.Connecting() },
      projects(status(project, running(first))),
    )
    expect(dependencies(down).project).toEqual(Option.none())
    expect(dependencies(down).run).toEqual(Option.none())
  })
})
