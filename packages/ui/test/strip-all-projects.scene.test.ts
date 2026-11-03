import { DateTime, Option, Schema } from 'effect'
import {
  all,
  expectAll,
  expect as expectScene,
  given,
  nth,
  role,
  scene,
  selector,
  within,
} from 'foldkit/scene'

import { describe, test } from '@effect/vitest'
import {
  EngineId,
  ProjectId,
  ProjectRunState,
  ProjectStatus,
  type ProjectStatusItem,
  RunId,
  RunView,
  StreamEpoch,
  UsageWindow,
  protocolVersion,
} from '@fabrica/contracts'

import { sayMoment } from '../src/app/clock'
import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import { view } from '../src/app/view'

// The strip above the stats row and the title bar's usage hold under All projects (spec §18.3): each
// run's banners and run-wide steps, run after run in the sidebar's order, each marked with its project's
// chip, so a project's hold or stop shows in the app's starting scope; a project's own scope draws its
// one run's, unmarked. Any run's usage-limit hold takes the usage windows' place.

const engine = EngineId.make('e-1')
const alpha = ProjectId.make('p-1')
const beta = ProjectId.make('p-2')
const alphaRun = RunId.make('r-a')
const betaRun = RunId.make('r-b')
const epoch = StreamEpoch.make('epoch-1')

/** Thursday 29 October 2026, 12:00 UTC: 14:00 in Athens. */
const at = Date.UTC(2026, 9, 29, 12, 0, 0)
const now = DateTime.makeZonedUnsafe(at, { timeZone: 'Europe/Athens' })
const lifts = Date.UTC(2026, 9, 29, 13, 5)

const here = (project: ProjectId): EngineProject => ({
  engine: localEngineName,
  project,
})

const received = (shown: Model, ...messages: ReadonlyArray<Message>): Model =>
  messages.reduce((next, each) => update(next, each).model, shown)

const status = (of: ProjectId, run: RunId): ProjectStatus =>
  new ProjectStatus({
    project: of,
    name: of,
    base: 'main',
    setUp: true,
    trusted: false,
    run: ProjectRunState.cases.running.make({ run, overnight: false }),
    ready: 0,
  })

const decodeRunView = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))

/** A run's view, with what the strip and the title bar read of it. */
const viewOf = ({
  project,
  run,
  holds = [],
  banners = [],
  steps = [],
}: {
  readonly project: ProjectId
  readonly run: RunId
  readonly holds?: ReadonlyArray<object>
  readonly banners?: ReadonlyArray<object>
  readonly steps?: ReadonlyArray<object>
}): RunView =>
  decodeRunView({
    header: {
      run,
      project,
      engine,
      mode: { _tag: 'tickets' },
      state: 'running',
      startedAt: at - 3_600_000,
      offline: false,
      autoAnswer: false,
    },
    totals: {
      live: 0,
      slots: 1,
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
    holds,
    banners,
    attention: [],
    load: null,
    steps,
  })

const usageHold = {
  kind: 'USAGE_LIMIT',
  reason: 'Anthropic usage limit reached',
  since: at - 600_000,
  lifts,
  provider: 'anthropic',
}

const held = viewOf({
  project: alpha,
  run: alphaRun,
  holds: [usageHold],
  banners: [{ tone: 'hold', text: usageHold.reason, lifts }],
  steps: [{ step: 'merge_check', ticket: null, startedAt: at - 2_000 }],
})

const stopped = viewOf({
  project: beta,
  run: betaRun,
  banners: [{ tone: 'stop', text: 'Stopping: disk is full', lifts: null }],
  steps: [{ step: 'merge_check', ticket: null, startedAt: at - 75_000 }],
})

const viewed = (project: ProjectId, value: RunView): Message =>
  Message.ReceivedRunView({
    project: here(project),
    items: [{ _tag: 'snapshot', epoch, seq: 0, value }],
  })

/** Under All projects, alpha (chip 01) and beta (chip 02) running, their views not read yet. */
const known = received(
  {
    ...initialModel({ platform: 'darwin', release: '0.0.0' }),
    connection: Connection.Up({
      engine,
      release: '0.1.0',
      protocol: protocolVersion,
    }),
    now: Option.some(now),
  },
  Message.ReceivedProjects({
    engine,
    name: 'local',
    items: [
      {
        _tag: 'snapshot',
        epoch,
        seq: 0,
        value: [status(alpha, alphaRun), status(beta, betaRun)],
      } satisfies ProjectStatusItem,
    ],
  }),
)

/** Both runs' views shown, beta's first to come. */
const both = received(known, viewed(beta, stopped), viewed(alpha, held))

/** Alpha's own scope, its run's view shown. */
const scoped = received(
  known,
  Message.SelectedScope({ project: Option.some(here(alpha)) }),
  viewed(alpha, held),
)

const strip = role('list', { name: 'Holds and banners' })
const noticeChips = all.selector('[aria-label="Holds and banners"] [data-chip]')
const toned = (tone: string) => within(strip, selector(`[data-tone="${tone}"]`))
const usageWindows = selector('[aria-label="Usage windows"]')

const withUsage = (shown: Model): Model => ({
  ...shown,
  usage: Option.some([
    new UsageWindow({
      provider: 'anthropic',
      window: 'five_hour',
      utilization: 0.4,
      resetsAt: Option.none(),
    }),
  ]),
})

describe('the strip under All projects', () => {
  test("each run's banners, a hold with when it lifts and a stop, each with its project's chip", () => {
    scene(
      { update, view },
      given(both),
      expectScene(toned('hold')).toContainText(usageHold.reason),
      expectScene(toned('hold')).toContainText(
        `lifts ${sayMoment(DateTime.makeUnsafe(lifts), now)}`,
      ),
      expectScene(within(toned('hold'), selector('[data-chip]'))).toHaveText(
        '01',
      ),
      expectScene(toned('stop')).toContainText('Stopping: disk is full'),
      expectScene(within(toned('stop'), selector('[data-chip]'))).toHaveText(
        '02',
      ),
    )
  })

  test("each run's own steps, past their first second, even of one kind, each with its chip", () => {
    scene(
      { update, view },
      given(both),
      expectAll(
        all.selector('[aria-label="Holds and banners"] [data-step]'),
      ).toHaveCount(2),
      expectAll(
        all.selector(
          '[aria-label="Holds and banners"] [data-step="merge_check"] [data-chip]',
        ),
      ).toHaveCount(2),
    )
  })

  test("run after run in the sidebar's order, whichever view came first", () => {
    scene(
      { update, view },
      given(both),
      expectAll(noticeChips).toHaveCount(4),
      expectScene(nth(0)(noticeChips)).toHaveText('01'),
      expectScene(nth(1)(noticeChips)).toHaveText('01'),
      expectScene(nth(2)(noticeChips)).toHaveText('02'),
      expectScene(nth(3)(noticeChips)).toHaveText('02'),
    )
  })

  test('with no run going, or none with a notice, there is no strip', () => {
    scene({ update, view }, given(known), expectScene(strip).toBeAbsent())
    scene(
      { update, view },
      given(
        received(
          known,
          viewed(alpha, viewOf({ project: alpha, run: alphaRun })),
        ),
      ),
      expectScene(strip).toBeAbsent(),
    )
  })
})

describe("the strip in a project's own scope", () => {
  test('its run alone, unmarked', () => {
    scene(
      { update, view },
      given(scoped),
      expectScene(toned('hold')).toContainText(usageHold.reason),
      expectScene(within(strip, selector('[data-step]'))).toExist(),
      expectScene(toned('stop')).toBeAbsent(),
      expectScene(within(strip, selector('[data-chip]'))).toBeAbsent(),
    )
  })
})

describe('the title bar’s usage hold', () => {
  test('any run under All projects on a usage limit takes the usage windows’ place', () => {
    scene(
      { update, view },
      given(withUsage(both)),
      expectScene(usageWindows).toBeAbsent(),
    )
  })

  test('with no run under All projects on a usage limit the windows stay', () => {
    scene(
      { update, view },
      given(withUsage(received(known, viewed(beta, stopped)))),
      expectScene(usageWindows).toExist(),
    )
  })

  test("the scoped run's hold still takes their place", () => {
    scene(
      { update, view },
      given(withUsage(scoped)),
      expectScene(usageWindows).toBeAbsent(),
    )
  })
})
