import { Option, Schema } from 'effect'
import {
  all,
  click,
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
  EngineId,
  HostLoad,
  ProjectId,
  RunView,
  UsageWindow,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import {
  cpuLevel,
  gigabytes,
  tighterWindow,
  usageMeter,
  windowName,
} from '../src/console/titlebar'
import titlebarCss from '../src/console/titlebar.css?raw'

// The console's title bar (spec §18.3, H46, H90; Appendix A.2), drawn from fixture load samples and
// usage windows: the engine host's stats with their warnings said in a word beside the colour, the
// usage windows in box-drawing lines, and the bar as the window's drag region but for its controls.

const project = ProjectId.make('p-1')
const gb = 1024 ** 3

/** `n` GB in whole bytes. */
const gbs = (n: number): number => Math.round(n * gb)
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

const decodeLoad = Schema.decodeUnknownSync(Schema.toCodecJson(HostLoad))

/** A sample of a 10-core host: 11.2 of 32 GB used, a load of 4.7, 6 cores busy, two workers. */
const loadJson = {
  sampledAt: at,
  memory: { used: gbs(11.2), total: gbs(32), pressure: 'normal' },
  swapping: false,
  load1: 4.7,
  cores: 10,
  busyCores: 6,
  workers: [
    { project, ticket: 'fa-7', bytes: gbs(1.5) },
    { project, ticket: 'fa-12', bytes: gbs(0.8) },
  ],
  mergeCheck: gbs(2),
}

const withLoad = (
  overrides: Partial<Record<keyof typeof loadJson, unknown>>,
  model: Model = connected,
): Model => ({
  ...model,
  load: Option.some(decodeLoad({ ...loadJson, ...overrides })),
})

const decodeWindow = Schema.decodeUnknownSync(Schema.toCodecJson(UsageWindow))

const usageWindow = (window: string, utilization: number): UsageWindow =>
  decodeWindow({ provider: 'anthropic', window, utilization, resetsAt: null })

const withUsage = (
  windows: ReadonlyArray<UsageWindow>,
  model: Model = connected,
): Model => ({ ...model, usage: Option.some(windows) })

const stats = role('group', { name: 'System stats' })
const usage = role('group', { name: 'Usage windows' })
const statOf = (name: string) => selector(`[data-stat="${name}"]`)

describe('the system stats', () => {
  test("MEM, CPU and CORES describe the engine host's sample", () => {
    scene(
      { update, view },
      given(withLoad({})),
      expectScene(statOf('MEM')).toContainText('MEM'),
      expectScene(statOf('MEM')).toContainText('11.2/32 GB'),
      expectScene(statOf('MEM')).toHaveAttr('data-level', 'normal'),
      expectScene(statOf('CPU')).toContainText('47%'),
      expectScene(statOf('CPU')).toHaveAttr('data-level', 'normal'),
      expectScene(statOf('CORES')).toContainText('6/10'),
      expectScene(selector('[data-level-mark]')).toBeAbsent(),
    )
  })

  test('CORES draws one block per core, the busy ones in c1', () => {
    scene(
      { update, view },
      given(withLoad({})),
      expectAll(all.selector('[data-core="busy"]')).toHaveCount(6),
      expectAll(all.selector('[data-core="idle"]')).toHaveCount(4),
      expectScene(selector('[data-core="busy"]')).toHaveClass('bg-c1'),
      expectScene(selector('[data-core="idle"]')).toHaveClass('bg-line'),
    )
  })

  test('MEM warns in c2 under memory pressure, and says so in a word', () => {
    scene(
      { update, view },
      given(
        withLoad({
          memory: { used: gbs(28), total: gbs(32), pressure: 'warn' },
        }),
      ),
      expectScene(statOf('MEM')).toHaveAttr('data-level', 'warning'),
      expectScene(
        within(statOf('MEM'), selector('[data-level-mark]')),
      ).toHaveText('high'),
      expectScene(
        within(statOf('MEM'), selector('[data-level-mark]')),
      ).toHaveClass('text-c2'),
      expectScene(
        within(statOf('MEM'), selector('[data-level-mark]')),
      ).toHaveClass('font-bold'),
      expectScene(within(statOf('MEM'), selector('.bg-c2'))).toExist(),
      expectScene(
        role('group', { name: 'Memory 28 of 32 GB, high' }),
      ).toExist(),
    )
  })

  test('MEM alarms in c3 when memory is critical, and says so in a word', () => {
    scene(
      { update, view },
      given(
        withLoad({
          memory: { used: gbs(31.5), total: gbs(32), pressure: 'critical' },
        }),
      ),
      expectScene(statOf('MEM')).toHaveAttr('data-level', 'alarm'),
      expectScene(
        within(statOf('MEM'), selector('[data-level-mark]')),
      ).toHaveText('critical'),
      expectScene(
        within(statOf('MEM'), selector('[data-level-mark]')),
      ).toHaveClass('text-c3'),
      expectScene(within(statOf('MEM'), selector('.bg-c3'))).toExist(),
    )
  })

  test('CPU warns in c2 past 1.5× the cores, with a word', () => {
    scene(
      { update, view },
      given(withLoad({ load1: 16 })),
      expectScene(statOf('CPU')).toHaveAttr('data-level', 'warning'),
      expectScene(statOf('CPU')).toContainText('160%'),
      expectScene(
        within(statOf('CPU'), selector('[data-level-mark]')),
      ).toHaveText('high'),
      expectScene(within(statOf('CPU'), selector('.bg-c2'))).toExist(),
      expectScene(role('group', { name: 'CPU 160%, high' })).toExist(),
    )
  })

  test('CPU alarms in c3 past 3× the cores over the minute, with a word', () => {
    scene(
      { update, view },
      given(withLoad({ load1: 31 })),
      expectScene(statOf('CPU')).toHaveAttr('data-level', 'alarm'),
      expectScene(
        within(statOf('CPU'), selector('[data-level-mark]')),
      ).toHaveText('critical'),
      expectScene(within(statOf('CPU'), selector('.bg-c3'))).toExist(),
    )
  })

  test("CPU's levels change past 1.5× and 3× the cores, not at them", () => {
    const sample = (load1: number) => decodeLoad({ ...loadJson, load1 })
    expect(cpuLevel(sample(15))).toBe('normal')
    expect(cpuLevel(sample(15.1))).toBe('warning')
    expect(cpuLevel(sample(30))).toBe('warning')
    expect(cpuLevel(sample(30.1))).toBe('alarm')
  })

  test("hovering the stats shows swapping, the merge check's memory and each worker's", () => {
    scene(
      { update, view },
      given(withLoad({ swapping: true })),
      expectScene(stats).toHaveAttr(
        'title',
        'Swapping: yes\nMerge check: 2 GB\nfa-7: 1.5 GB\nfa-12: 0.8 GB',
      ),
    )
    scene(
      { update, view },
      given(withLoad({ workers: [], mergeCheck: null })),
      expectScene(stats).toHaveAttr(
        'title',
        'Swapping: no\nMerge check: not running\nWorkers: none',
      ),
    )
  })

  test('a new sample replaces the one before', () => {
    scene(
      { update, view },
      given(withLoad({})),
      expectScene(statOf('CPU')).toContainText('47%'),
      given(withLoad({ load1: 2.5, busyCores: 3 })),
      expectScene(statOf('CPU')).toContainText('25%'),
      expectScene(statOf('CORES')).toContainText('3/10'),
    )
  })

  test('before the first sample, the bar says it has none', () => {
    scene(
      { update, view },
      given(connected),
      expectScene(stats).toBeAbsent(),
      expectScene(role('banner', { name: 'Title bar' })).toContainText(
        'No host load yet',
      ),
    )
  })

  test('gigabytes to one decimal, whole ones without', () => {
    expect(gigabytes(gbs(11.2))).toBe('11.2')
    expect(gigabytes(gbs(32))).toBe('32')
    expect(gigabytes(gbs(0.04))).toBe('0')
  })
})

describe('the usage windows', () => {
  test("named as the provider's apps name them, the tighter with its meter", () => {
    scene(
      { update, view },
      given(
        withUsage([
          usageWindow('five_hour', 0.41),
          usageWindow('seven_day', 0.12),
        ]),
      ),
      expectScene(usage).toHaveText(
        'Current usage ━━━─────  41% · This week 12%',
      ),
      expectScene(selector('[data-usage-window="tighter"]')).toContainText(
        'Current usage',
      ),
    )
  })

  test('the meter goes with the tighter window wherever it is', () => {
    scene(
      { update, view },
      given(
        withUsage([
          usageWindow('five_hour', 0.2),
          usageWindow('seven_day', 0.9),
        ]),
      ),
      expectScene(usage).toHaveText(
        'Current usage 20% · This week ━━━━━━━─  90%',
      ),
      expectScene(selector('[data-usage-window="tighter"]')).toContainText(
        'This week',
      ),
      expectScene(selector('[data-usage-window="other"]')).toHaveText(
        'Current usage 20% · ',
      ),
    )
  })

  test('a narrow bar keeps the tighter window alone: the others carry their separators', () => {
    scene(
      { update, view },
      given(
        withUsage([
          usageWindow('five_hour', 0.3),
          usageWindow('seven_day', 0.5),
          usageWindow('seven_day_opus', 0.1),
        ]),
      ),
      expectScene(usage).toHaveText(
        'Current usage 30% · This week ━━━━────  50% · This week, Opus 10%',
      ),
      expectScene(selector('[data-usage-window="tighter"]')).toHaveText(
        'This week ━━━━────  50%',
      ),
    )
    expect(titlebarCss).toMatch(
      /@media \(max-width: \d+px\) \{\s*\[data-usage-window='other'\] \{\s*display: none;/u,
    )
  })

  test('the meter is box-drawing lines, eight cells', () => {
    expect(usageMeter(0)).toBe('────────')
    expect(usageMeter(0.41)).toBe('━━━─────')
    expect(usageMeter(1)).toBe('━━━━━━━━')
    expect(windowName('one_day')).toBe('One day')
    expect(
      Option.map(
        tighterWindow([usageWindow('a', 0.5), usageWindow('b', 0.5)]),
        window => window.window,
      ),
    ).toEqual(Option.some('a'))
  })

  test("near a limit, the usage banner takes the windows' place", () => {
    const held = withUsage([usageWindow('five_hour', 0.98)], {
      ...connected,
      runView: Option.some(runViewHolding('USAGE_LIMIT')),
    })
    scene({ update, view }, given(held), expectScene(usage).toBeAbsent())
    scene(
      { update, view },
      given({ ...held, runView: Option.some(runViewHolding('DRAIN')) }),
      expectScene(usage).toExist(),
    )
  })

  test('choosing another project drops the windows until its own arrive', () => {
    const before = withUsage([usageWindow('five_hour', 0.41)])
    const { model: after } = update(
      before,
      Message.SelectedScope({ project: Option.some(ProjectId.make('p-2')) }),
    )
    expect(after.usage).toEqual(Option.none())
  })
})

describe('the drag region', () => {
  test('the bar is the drag region; its search field and stats are not', () => {
    scene(
      { update, view },
      given(withLoad({})),
      expectScene(role('banner', { name: 'Title bar' })).toHaveAttr(
        'data-app-region',
        'drag',
      ),
      expectScene(
        role('button', { name: 'Search tickets and sessions ⌘K' }),
      ).toHaveAttr('data-app-region', 'no-drag'),
      expectScene(stats).toHaveAttr('data-app-region', 'no-drag'),
    )
    expect(titlebarCss).toMatch(
      /\[data-app-region='drag'\] \{\s*-webkit-app-region: drag;/u,
    )
    expect(titlebarCss).toMatch(
      /\[data-app-region='no-drag'\] \{\s*-webkit-app-region: no-drag;/u,
    )
  })

  test('the search field opens the command palette', () => {
    scene(
      { update, view },
      given(connected),
      click(role('button', { name: 'Search tickets and sessions ⌘K' })),
      expectScene(role('dialog', { name: 'Command palette' })).toExist(),
    )
  })

  test("the system's window controls keep their room: macOS's on the left, others' on the right", () => {
    scene(
      { update, view },
      given(connected),
      expectScene(selector('[data-window-controls="left"]')).toHaveStyle(
        'width',
        '52px',
      ),
      expectScene(selector('[data-window-controls="right"]')).toBeAbsent(),
      expectScene(role('banner', { name: 'Title bar' })).toContainText(
        'Fabrica',
      ),
    )
    scene(
      { update, view },
      given({ ...connected, platform: 'win32' }),
      expectScene(selector('[data-window-controls="left"]')).toBeAbsent(),
      expectScene(selector('[data-window-controls="right"]')).toExist(),
    )
  })
})

const decodeRunView = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))

/** A running view of the project, held for `kind`. */
const runViewHolding = (kind: string): RunView =>
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
    holds: [
      { kind, reason: 'held', since: at, lifts: null, provider: 'anthropic' },
    ],
    banners: [],
    attention: [],
    load: null,
    steps: [],
  })
