import { DateTime, Option, Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { Lazy } from 'foldkit/test'

import { describe, test } from '@effect/vitest'
import {
  EngineId,
  ProjectId,
  RunView,
  TicketId,
  TranscriptItem,
  protocolVersion,
} from '@fabrica/contracts'

import { dayOf } from '../src/app/clock'
import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import * as BacklogFeature from '../src/app/features/backlog/backlog'
import * as ConsoleFeature from '../src/app/features/console/console'
import * as EnginesFeature from '../src/app/features/engines/engines'
import * as InsightsFeature from '../src/app/features/insights/insights'
import * as ReviewFeature from '../src/app/features/review/review'
import * as WorkerFeature from '../src/app/features/worker/worker'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import * as Worker from '../src/screens/worker'

// The screens memoised on their own slices of the Model (spec §18.5): a change to a part a screen
// doesn't draw (the clock's tick within the day, a worker's frame in the run view, the load) reuses
// its view, every lazy part of it drawn on the first render hit on the second.

const project = ProjectId.make('p-1')
const scoped: EngineProject = { engine: localEngineName, project }

/** Thursday 29 October 2026, 12:00 UTC. */
const at = Date.UTC(2026, 9, 29, 12, 0, 0)
const zoned = (millis: number) =>
  DateTime.makeZonedUnsafe(millis, { timeZone: 'UTC' })

const runView = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))({
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
    live: 1,
    slots: 4,
    counts: {
      in_queue: 0,
      working: 1,
      waiting_to_merge: 0,
      needs_you: 0,
      set_aside: 0,
      carried_over: 0,
      done: 1,
    },
    doneToday: 1,
    tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
    costUsd: null,
  },
  tickets: [
    {
      ticket: 'fa-6',
      title: 'User schema',
      type: 'task',
      priority: 2,
      phase: {
        _tag: 'merged',
        commit: 'ffd6ce4a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f',
      },
      since: at,
      startedAt: null,
      solo: false,
      handBacks: { resolve: 0, fix: 0 },
    },
  ],
  workers: [],
  queue: { merging: null, train: null, waiting: [] },
  holds: [],
  banners: [],
  attention: [],
  load: null,
  steps: [],
})

/** The scoped project's run going, at noon. */
const going: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(scoped),
  now: Option.some(zoned(at)),
  today: Option.some(dayOf(zoned(at))),
  runView: Option.some(runView),
  backlog: Option.some([]),
}

/** `model` a second later: the clock ticked within the day. */
const ticked = (model: Model): Model =>
  update(model, Message.Ticked({ now: zoned(at + 1_000) })).model

/** `model` with its run view's workers changed, as a worker's frame changes them, its tickets as they were. */
const workerFrame = (model: Model): Model => ({
  ...model,
  runView: Option.some({ ...runView, workers: [...runView.workers] }),
})

/** `model` with its run view's load sampled again, every part the console draws as it was. */
const loadSampled = (model: Model): Model => ({
  ...model,
  runView: Option.some({ ...runView, load: Option.none() }),
})

/** Draws `before`, then `after`: every lazy part of the second render must be the first's. */
const expectReused = <M, Msg>(
  view: (model: M, h: HtmlBuilder<Msg>) => Html,
  before: M,
  after: M,
) => {
  const models = [before, after].values()
  Lazy.expectAllReused({
    view: (_: M, h: HtmlBuilder<Msg>) => view(models.next().value ?? after, h),
    model: before,
  })
}

describe('the screens are memoised on their own slices', () => {
  test("the Backlog is reused across a tick and a worker's frame: of the run it reads only its tickets", () => {
    expectReused(BacklogFeature.view, going, ticked(going))
    expectReused(BacklogFeature.view, going, workerFrame(going))
  })

  test('Review, Insights and Engines are reused across a tick and a run-view frame', () => {
    for (const view of [
      ReviewFeature.view,
      InsightsFeature.view,
      EnginesFeature.view,
    ]) {
      expectReused(view, going, ticked(going))
      expectReused(view, going, workerFrame(going))
    }
  })

  test("the console's stats row is reused when only the run's load changes", () => {
    expectReused(ConsoleFeature.view, going, loadSampled(going))
  })
})

describe("the worker's transcript is memoised on its blocks", () => {
  const worker: Worker.Shown = {
    project: scoped,
    ticket: TicketId.make('fa-7'),
  }
  const decodeItem = Schema.decodeUnknownSync(
    Schema.toCodecJson(TranscriptItem),
  )
  const shown: Worker.Model = Worker.receivedTranscript(
    Worker.opened(Worker.init(), worker).model,
    worker,
    [
      decodeItem({
        _tag: 'snapshot',
        epoch: 'epoch-t',
        seq: 0,
        value: [
          {
            _tag: 'tool_call',
            id: 'call-1',
            tool: 'bash',
            input: { command: 'echo https://example.com/1' },
            at,
          },
          { _tag: 'tool_output', id: 'call-1', chunk: '1\n' },
          { _tag: 'tool_end', id: 'call-1', ok: true, at },
        ],
      }),
    ],
  ).model
  const onWorker: Model = {
    ...going,
    screens: { ...going.screens, worker: shown },
  }
  const inputs = (now: number): Worker.ViewInputs => ({
    live: true,
    now: Option.some(zoned(now)),
    row: Option.none(),
    usage: Option.none(),
    runTokens: Option.none(),
  })

  test('a tick redraws the figures, not the transcript', () => {
    expectReused(
      (now: number, h: HtmlBuilder<Worker.Message>) =>
        Worker.view(shown, inputs(now), h),
      at,
      at + 1_000,
    )
  })

  test('the Worker view is reused across a change it draws nothing of', () => {
    expectReused(
      (model: Model, h: HtmlBuilder<Message>) =>
        WorkerFeature.view(model, worker, h),
      onWorker,
      { ...onWorker, backlog: Option.some([]) },
    )
  })
})
