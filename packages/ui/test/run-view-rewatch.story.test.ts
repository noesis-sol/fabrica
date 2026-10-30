import { Effect, Fiber, Option, Schema, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, it, test } from '@effect/vitest'
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

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { WaitToRewatchRunView } from '../src/app/features/run-view/run-view'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { makeSubscriptions } from '../src/app/subscriptions'
import { update } from '../src/app/update'

// A run view watch that ends NoRun while the scoped project's row shows a run going is tried again
// after a pause: the row can show a run before the engine has its view, and with the watch's key
// unchanged nothing else would watch again.

const engine = EngineId.make('e-1')
const project = ProjectId.make('p-1')
const other = ProjectId.make('p-2')

/** The projects, named with this machine's engine, which holds them. */
const scoped: EngineProject = { engine: localEngineName, project }
const otherScoped: EngineProject = { engine: localEngineName, project: other }
const first = RunId.make('r-1')
const second = RunId.make('r-2')

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine,
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(scoped),
}

const idle = ProjectRunState.cases.idle.make({})
const running = (run: RunId) =>
  ProjectRunState.cases.running.make({ run, overnight: false })

const projects = (run: ProjectRunState): Message =>
  Message.ReceivedProjects({
    engine,
    name: 'local',
    items: [
      {
        _tag: 'snapshot',
        epoch: StreamEpoch.make('epoch-1'),
        seq: 0,
        value: [
          new ProjectStatus({
            project,
            name: project,
            base: 'main',
            setUp: true,
            trusted: false,
            run,
            ready: 0,
          }),
        ],
      } satisfies ProjectStatusItem,
    ],
  })

const received = (shown: Model, ...messages: ReadonlyArray<Message>): Model =>
  messages.reduce((next, each) => update(next, each).model, shown)

const going = received(connected, projects(running(first)))

const noRun = Message.EndedRunView({ project: scoped, reason: 'NoRun' })

const waited = Message.WaitedToRewatchRunView({ project: scoped, run: first })

const { runView } = makeSubscriptions({
  nextFrame: Effect.void,
  keys: Stream.empty,
  ticks: Stream.empty,
  replacedEnginePorts: Stream.empty,
})

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
      doneToday: 0,
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

describe('a run view watch that ended with no run', () => {
  test('watches again after a pause while the row shows the run going', () => {
    story(
      update,
      given(going),
      message(noRun),
      Command.expectExact(
        WaitToRewatchRunView({ project: scoped, run: first }),
      ),
      Command.resolve(WaitToRewatchRunView, waited),
      model(shown => {
        expect(shown.runWatch).toBe(going.runWatch + 1)
        expect(
          sameDependencies(
            runView.modelToDependencies(going),
            runView.modelToDependencies(shown),
          ),
        ).toBe(false)
      }),
    )
  })

  test('is not tried again while the row shows no run going', () => {
    story(
      update,
      given(received(connected, projects(idle))),
      message(noRun),
      Command.expectNone(),
    )
  })

  test('is not tried again when it ended for another reason', () => {
    story(
      update,
      given(going),
      message(
        Message.EndedRunView({
          project: scoped,
          reason: 'ProjectNotFound',
        }),
      ),
      Command.expectNone(),
    )
  })

  test("is not tried again for a project out of the console's scope", () => {
    story(
      update,
      given(going),
      message(Message.EndedRunView({ project: otherScoped, reason: 'NoRun' })),
      Command.expectNone(),
    )
  })

  test('the pause watches nothing again once the run ended, the next run started or the scope moved', () => {
    const ended = received(going, noRun, projects(idle), waited)
    const next = received(going, noRun, projects(running(second)), waited)
    const elsewhere = received(
      { ...going, scope: Option.some(otherScoped) },
      waited,
    )
    expect(ended.runWatch).toBe(going.runWatch)
    expect(next.runWatch).toBe(going.runWatch)
    expect(elsewhere.runWatch).toBe(going.runWatch)
  })

  test('the pause watches nothing again once the view shows', () => {
    const shown = received(
      { ...going, runView: Option.some(viewOf(first)) },
      waited,
    )
    expect(shown.runWatch).toBe(going.runWatch)
  })

  it.effect('the pause is a second, on the injected clock', () =>
    Effect.gen(function* () {
      const waiting = yield* Effect.forkChild(
        WaitToRewatchRunView({ project: scoped, run: first }).effect,
      )
      yield* TestClock.adjust('999 millis')
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust('1 millis')
      expect(yield* Fiber.join(waiting)).toEqual(waited)
    }),
  )
})
