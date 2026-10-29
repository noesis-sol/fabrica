import { Array, Option, Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type {
  HostLoad,
  MemoryPressure,
  Platform,
  UsageWindow,
} from '@fabrica/contracts'

// The console's title bar (spec §18.3, H46, H90; Appendix A.2): "Fabrica", the engine host's system
// stats, the selected project's usage windows and the search field that opens the command palette.
// The bar is the window's drag region (the frame marks it, titlebar.css applies it); its controls
// aren't, and the system's own window controls keep their room. A warning or an alarm is said in a
// word beside its colour, never by the colour alone (§18.2).

export const Model = Schema.Struct({})
export type Model = typeof Model.Type

export const init = (): Model => ({})

/** What the frame gives the bar. */
export interface Config<Message> {
  readonly platform: Platform
  /** The engine host's latest load sample: never the app's own machine's. */
  readonly load: Option.Option<HostLoad>
  /** The selected project's provider account's usage windows. */
  readonly usage: Option.Option<ReadonlyArray<UsageWindow>>
  /** The run holds on a usage limit: its banner takes the windows' place. */
  readonly usageHeld: boolean
  /** The search field's key hint, from the command list, and its Message. */
  readonly search: { readonly hint: string; readonly open: Message }
}

/** The value of `data-app-region`, which titlebar.css turns into Electron's drag region. */
export type AppRegion = 'drag' | 'no-drag'

/** How a stat stands: its bar in its colour, and a word beside it but when normal. */
export type Level = 'normal' | 'warning' | 'alarm'

/** Each level's word, the second signal beside its colour. */
export const levelWord: Record<Level, Option.Option<string>> = {
  normal: Option.none(),
  warning: Option.some('high'),
  alarm: Option.some('critical'),
}

const levelText: Record<Level, string> = {
  normal: 'text-fg',
  warning: 'text-c2',
  alarm: 'text-c3',
}

const levelFill: Record<Level, string> = {
  normal: '',
  warning: 'bg-c2',
  alarm: 'bg-c3',
}

/** MEM's level: the kernel's memory pressure, `c2` while it warns and `c3` when critical. */
export const memoryLevel: Record<MemoryPressure, Level> = {
  normal: 'normal',
  warn: 'warning',
  critical: 'alarm',
}

/**
 * CPU's level: `c2` past 1.5× the cores, `c3` past 3× (orchestra-recj). The figure is the 1-minute
 * load average, so past 3× it has been for about a minute.
 */
export const cpuLevel = (load: HostLoad): Level =>
  load.load1 > 3 * load.cores
    ? 'alarm'
    : load.load1 > 1.5 * load.cores
      ? 'warning'
      : 'normal'

const gigabyte = 1024 ** 3

/** Bytes in GB to one decimal, a whole number without it: `11.2`, `32`. */
export const gigabytes = (bytes: number): string => {
  const tenths = Math.round((bytes / gigabyte) * 10)
  return tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1)
}

/** The 1-minute load as a share of the cores, in percent: past 100% while work waits for a core. */
export const cpuPercent = (load: HostLoad): number =>
  Math.round((load.load1 / load.cores) * 100)

/** What hovering the stats shows: swapping, the merge check's memory and each worker's (orchestra-556h, -u6pv). */
export const loadDetail = (load: HostLoad): string =>
  [
    `Swapping: ${load.swapping ? 'yes' : 'no'}`,
    `Merge check: ${Option.match(load.mergeCheck, {
      onNone: () => 'not running',
      onSome: bytes => `${gigabytes(bytes)} GB`,
    })}`,
    ...(load.workers.length === 0
      ? ['Workers: none']
      : load.workers.map(
          worker => `${worker.ticket}: ${gigabytes(worker.bytes)} GB`,
        )),
  ].join('\n')

/** The usage windows' names as the provider's own apps say them (tutti-5170). */
const windowNames: Record<string, string> = {
  five_hour: 'Current usage',
  seven_day: 'This week',
  seven_day_opus: 'This week, Opus',
  seven_day_sonnet: 'This week, Sonnet',
}

/** A window's name in words: the provider apps' name, else its own with spaces (`one_day` is "One day"). */
export const windowName = (window: string): string =>
  windowNames[window] ??
  window.replaceAll('_', ' ').replace(/^./u, first => first.toUpperCase())

/** The usage meter's cells. */
const meterCells = 8

/** A share as a bar of box-drawing lines, which every font has (tutti-1l30): `━━━─────`. */
export const usageMeter = (utilization: number): string => {
  const filled = Math.min(meterCells, Math.round(utilization * meterCells))
  return '━'.repeat(filled) + '─'.repeat(meterCells - filled)
}

const percent = (utilization: number): string =>
  `${Math.round(utilization * 100)}%`

/** The tighter of the windows, the one used most: it has the meter, and a narrow bar keeps it alone. */
export const tighterWindow = (
  windows: ReadonlyArray<UsageWindow>,
): Option.Option<UsageWindow> =>
  Array.reduce(windows, Option.none<UsageWindow>(), (tightest, window) =>
    Option.match(tightest, {
      onNone: () => Option.some(window),
      onSome: current =>
        window.utilization > current.utilization
          ? Option.some(window)
          : tightest,
    }),
  )

const noDrag = <Message>(h: HtmlBuilder<Message>) =>
  h.DataAttribute('app-region', 'no-drag' satisfies AppRegion)

/** A 64 × 6 bar, `share` of it filled in `fill` (or the stat's own colour), its track `--line`. */
const bar = <Message>(
  share: number,
  fill: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [
      h.AriaHidden(true),
      h.Class('inline-block overflow-hidden bg-line'),
      h.Style({ width: '64px', height: '6px' }),
    ],
    [
      h.span([
        h.Class(`block h-full ${fill}`),
        h.Style({ width: `${Math.round(Math.min(1, share) * 100)}%` }),
      ]),
    ],
  )

/** A stat's warning word, in its colour and bold, or nothing while it is normal. */
const levelMark = <Message>(level: Level, h: HtmlBuilder<Message>): Html =>
  Option.match(levelWord[level], {
    onNone: () => h.empty,
    onSome: word =>
      h.span(
        [
          h.DataAttribute('level-mark', level),
          h.Class(`font-bold ${levelText[level]}`),
        ],
        [word],
      ),
  })

const stat = <Message>(
  {
    name,
    label,
    level,
    body,
  }: {
    readonly name: string
    readonly label: string
    readonly level: Level
    readonly body: ReadonlyArray<Html>
  },
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [
      h.Role('group'),
      h.AriaLabel(
        Option.match(levelWord[level], {
          onNone: () => label,
          onSome: word => `${label}, ${word}`,
        }),
      ),
      h.DataAttribute('stat', name),
      h.DataAttribute('level', level),
      h.Class('flex items-center gap-6'),
    ],
    [h.span([], [name]), ...body, levelMark(level, h)],
  )

const memoryStat = <Message>(load: HostLoad, h: HtmlBuilder<Message>): Html => {
  const level = memoryLevel[load.memory.pressure]
  const used = gigabytes(load.memory.used)
  const total = gigabytes(load.memory.total)
  return stat(
    {
      name: 'MEM',
      label: `Memory ${used} of ${total} GB`,
      level,
      body: [
        bar(
          load.memory.total === 0 ? 0 : load.memory.used / load.memory.total,
          level === 'normal' ? 'bg-c4' : levelFill[level],
          h,
        ),
        h.span([h.Class('text-fg')], [`${used}/${total} GB`]),
      ],
    },
    h,
  )
}

const cpuStat = <Message>(load: HostLoad, h: HtmlBuilder<Message>): Html => {
  const level = cpuLevel(load)
  const share = cpuPercent(load)
  return stat(
    {
      name: 'CPU',
      label: `CPU ${share}%`,
      level,
      body: [
        bar(share / 100, level === 'normal' ? 'bg-c5' : levelFill[level], h),
        h.span([h.Class('text-fg')], [`${share}%`]),
      ],
    },
    h,
  )
}

const coresStat = <Message>(load: HostLoad, h: HtmlBuilder<Message>): Html => {
  const busy = Math.min(load.busyCores, load.cores)
  return stat(
    {
      name: 'CORES',
      label: `${busy} of ${load.cores} cores busy`,
      level: 'normal',
      body: [
        h.span(
          [h.AriaHidden(true), h.Class('flex'), h.Style({ gap: '2px' })],
          Array.makeBy(load.cores, core =>
            h.span([
              h.DataAttribute('core', core < busy ? 'busy' : 'idle'),
              h.Class(core < busy ? 'bg-c1' : 'bg-line'),
              h.Style({ width: '5px', height: '12px' }),
            ]),
          ),
        ),
        h.span([h.Class('text-fg')], [`${busy}/${load.cores}`]),
      ],
    },
    h,
  )
}

/** MEM, CPU and CORES for the engine host; hovering them shows what the host's memory goes to. */
const systemStats = <Message>(
  load: Option.Option<HostLoad>,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(load, {
    onNone: () =>
      h.span([h.Class('font-mono text-xs text-muted')], ['No host load yet']),
    onSome: sample =>
      h.div(
        [
          h.Role('group'),
          h.AriaLabel('System stats'),
          h.Title(loadDetail(sample)),
          noDrag(h),
          h.Class('flex items-center gap-18 font-mono text-xs text-muted'),
        ],
        [memoryStat(sample, h), cpuStat(sample, h), coresStat(sample, h)],
      ),
  })

/** Whether a window is the tighter one, which a narrow bar keeps, or another, which it drops (titlebar.css). */
export type UsageRole = 'tighter' | 'other'

/**
 * The usage windows, `Current usage ━━━─────  41% · This week 12%`: the tighter one with its meter,
 * the others their share, each separator going with the other window beside it, so a narrow bar
 * that drops them leaves the tighter one alone. Near a limit the usage banner takes their place.
 */
const usageWindows = <Message>(
  windows: ReadonlyArray<UsageWindow>,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(tighterWindow(windows), {
    onNone: () => h.empty,
    onSome: tighter => {
      const tighterAt = windows.indexOf(tighter)
      return h.div(
        [
          h.Role('group'),
          h.AriaLabel('Usage windows'),
          h.Class(
            'flex items-center whitespace-pre font-mono text-xs text-muted',
          ),
        ],
        windows.map((window, index) =>
          window === tighter
            ? h.span(
                [
                  h.DataAttribute(
                    'usage-window',
                    'tighter' satisfies UsageRole,
                  ),
                ],
                [
                  `${windowName(window.window)} `,
                  h.span(
                    [h.AriaHidden(true), h.Class('text-fg')],
                    [usageMeter(window.utilization)],
                  ),
                  h.span(
                    [h.Class('text-fg')],
                    [`  ${percent(window.utilization)}`],
                  ),
                ],
              )
            : h.span(
                [h.DataAttribute('usage-window', 'other' satisfies UsageRole)],
                [
                  ...(index > tighterAt ? [' · '] : []),
                  `${windowName(window.window)} `,
                  h.span([h.Class('text-fg')], [percent(window.utilization)]),
                  ...(index < tighterAt ? [' · '] : []),
                ],
              ),
        ),
      )
    },
  })

/** The room the system's window controls take: macOS's traffic lights on the left, Windows' and Linux's on the right. */
const controlsRoom = <Message>(
  platform: Platform,
  side: 'left' | 'right',
  h: HtmlBuilder<Message>,
): Html =>
  platform === 'darwin'
    ? side === 'left'
      ? // Where the handoff drew its three 12px squares, 8px apart.
        h.span([
          h.DataAttribute('window-controls', 'left'),
          h.Style({ width: '52px' }),
        ])
      : h.empty
    : side === 'right'
      ? // The title bar overlay's own width, from Window Controls Overlay's environment variables.
        h.span([
          h.DataAttribute('window-controls', 'right'),
          h.Class('shrink-0'),
          h.Style({
            width:
              'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))',
          }),
        ])
      : h.empty

export const view = <Message>(
  _model: Model,
  config: Config<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex min-w-0 flex-1 items-center gap-8')],
    [
      controlsRoom(config.platform, 'left', h),
      h.span(
        [h.Class('text-sm font-bold'), h.Style({ marginLeft: '16px' })],
        ['Fabrica'],
      ),
      h.div(
        [h.Class('ml-auto flex items-center gap-18')],
        [
          systemStats(config.load, h),
          config.usageHeld
            ? h.empty
            : Option.match(config.usage, {
                onNone: () => h.empty,
                onSome: windows => usageWindows(windows, h),
              }),
        ],
      ),
      h.button(
        [
          h.Type('button'),
          h.OnClick(config.search.open),
          h.AriaKeyshortcuts(config.search.hint),
          noDrag(h),
          h.Class(
            'shrink-0 rounded-button border border-line px-8 text-left text-xs text-muted',
          ),
          h.Style({ width: '260px', height: '24px' }),
        ],
        [`Search tickets and sessions ${config.search.hint}`],
      ),
      controlsRoom(config.platform, 'right', h),
    ],
  )
