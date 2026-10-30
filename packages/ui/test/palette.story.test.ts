import { Option, Schema } from 'effect'
import {
  Command as SceneCommand,
  Subscription,
  all,
  click,
  expectAll,
  expect as expectScene,
  given as givenScene,
  role,
  scene,
  text,
  type,
  within,
} from 'foldkit/scene'
import {
  Command as StoryCommand,
  given,
  message,
  model,
  story,
} from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import {
  EngineId,
  InsightsQuery,
  ProjectId,
  ProjectRunState,
  ProjectStatus,
  RunView,
  StreamEpoch,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import { runOffers } from '../src/app/features/keys/keys'
import { paletteEntries } from '../src/app/features/palette/palette'
import {
  chordLabel,
  commandsFor,
  openPalette,
  paletteOverlayKeys,
} from '../src/app/keys'
import { Message } from '../src/app/message'
import { type Model, Overlay, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { ShowTheme } from '../src/app/theme-host'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Insights from '../src/screens/insights'
import * as Palette from '../src/screens/palette'
import * as Worker from '../src/screens/worker'

// The command palette (spec §18.5, §18.3's title bar): ⌘K opens it over any screen, listing exactly
// the screen's bound commands, from its one command list, with their keys, then the projects, the
// run's tickets and workers, and the themes. Typing filters it; the arrows and Enter, the palette's
// own commands in the same list, move through it and run the selection; a click runs an entry.

const engine = EngineId.make('e-1')
const fabrica = ProjectId.make('p-fabrica')
const tutti = ProjectId.make('p-tutti')

const at = Date.UTC(2026, 9, 29, 12, 0, 0)

const decodeRunView = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))

const ticketRow = (ticket: string, title: string) => ({
  ticket,
  title,
  type: 'task',
  priority: 2,
  phase: { _tag: 'working' },
  since: at - 60_000,
  startedAt: at - 600_000,
  solo: false,
  handBacks: { resolve: 0, fix: 0 },
})

const runView = decodeRunView({
  header: {
    run: 'r-1',
    project: fabrica,
    engine,
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
      in_queue: 1,
      working: 1,
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
  tickets: [
    ticketRow('fa-1', 'Refresh the auth token'),
    ticketRow('fa-2', 'Draw the phase bar'),
  ],
  workers: [
    {
      ticket: 'fa-1',
      session: 's-fa-1',
      model: 'claude-opus-5-5',
      startedAt: at - 600_000,
      action: null,
      context: null,
      tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
      steered: false,
    },
  ],
  queue: { merging: null, train: null, waiting: [] },
  holds: [],
  banners: [],
  attention: [],
  load: null,
  steps: [],
})

const projectStatus = (project: ProjectId, name: string) =>
  new ProjectStatus({
    project,
    name,
    base: 'main',
    setUp: true,
    trusted: true,
    run: ProjectRunState.cases.idle.make({}),
    ready: 0,
  })

/** Connected, scoped to fabrica and its run, with the sidebar's two projects. */
const connected: Model = {
  ...update(
    {
      ...initialModel({ platform: 'darwin', release: '0.0.0' }),
      connection: Connection.Up({
        engine,
        release: '0.1.0',
        protocol: protocolVersion,
      }),
      scope: Option.some({ engine: localEngineName, project: fabrica }),
    },
    Message.ReceivedProjects({
      engine,
      name: 'local',
      items: [
        {
          _tag: 'snapshot',
          epoch: StreamEpoch.make('epoch-1'),
          seq: 0,
          value: [
            projectStatus(fabrica, 'fabrica'),
            projectStatus(tutti, 'tutti'),
          ],
        },
      ],
    }),
  ).model,
  runView: Option.some(runView),
}

const key = (pressed: string, { mod = false, inField = false } = {}) =>
  Message.PressedKey({ key: pressed, mod, alt: false, inField })

/** A key pressed in the palette's search field, where focus starts. */
const fieldKey = (pressed: string) => key(pressed, { inField: true })

/** The list scrolled to the selection, where the arrows moved it. */
const scrolledScene = () =>
  SceneCommand.resolve(
    Palette.ScrollToEntry,
    Palette.Message.CompletedScrollToEntry(),
  )
const scrolledStory = () =>
  StoryCommand.resolve(
    Palette.ScrollToEntry,
    Palette.Message.CompletedScrollToEntry(),
  )

const palette = role('dialog', { name: 'Command palette' })
const search = role('textbox', { name: 'Search commands' })
/** The palette's entries, each a button in its list. */
const entries = all.selector('#palette-entries button')

const allScreens: ReadonlyArray<Screen> = [
  Screen.Console(),
  Screen.Worker({
    project: { engine: localEngineName, project: fabrica },
    ticket: TicketId.make('fa-1'),
  }),
  Screen.Talks(),
  Screen.Backlog(),
  Screen.Review(),
  Screen.Insights(),
  Screen.Engines(),
  Screen.Settings(),
]

const commandEntries = (shown: Model) =>
  paletteEntries(shown).filter(entry => entry.group === 'command')

/** The Insights screen's requests as it opens, each answered that the engine doesn't serve it. */
const insightsUnserved = [
  [
    Insights.LoadSummary,
    Insights.Message.FailedLoadSummary({
      project: Option.none(),
      reason: 'not served',
    }),
  ] as const,
  ...Insights.Panel.literals.map(
    panel =>
      [
        Insights.RunQuery,
        Insights.Message.FailedQuery({
          scope: Option.none(),
          panel,
          query: InsightsQuery.cases.cost_per_merged_ticket.make({
            project: Option.none(),
            since: Option.none(),
          }),
          reason: 'not served',
        }),
      ] as const,
  ),
]

describe('the palette lists exactly the bound commands', () => {
  test("each screen's commands, from its one list, with their keys, but the palette's own", () => {
    for (const screen of allScreens) {
      const shown: Model = { ...connected, screen, overlay: Overlay.Palette() }
      const listed = commandsFor({
        screen,
        overlayOpen: false,
        offers: runOffers(shown),
      }).filter(command => command.id !== openPalette.id)
      expect(
        commandEntries(shown).map(entry => [
          entry.id,
          entry.title,
          Option.getOrUndefined(entry.key),
        ]),
      ).toEqual(
        listed.map(command => [
          command.id,
          command.title,
          Option.getOrUndefined(
            Option.map(command.chord, chord => chordLabel(chord, 'darwin')),
          ),
        ]),
      )
    }
  })

  test('neither the palette itself nor its own keys are among its entries', () => {
    const ids = paletteEntries({
      ...connected,
      overlay: Overlay.Palette(),
    }).map(entry => entry.id)
    expect(ids).not.toContain(openPalette.id)
    for (const own of paletteOverlayKeys) {
      expect(ids).not.toContain(own.id)
    }
  })

  test('⌘K opens it with every entry drawn, its keys on the commands, its own keys at its foot', () => {
    scene(
      { update, view },
      givenScene(connected),
      Subscription.emit(key('k', { mod: true })),
      expectScene(palette).toExist(),
      expectAll(entries).toHaveCount(
        paletteEntries({ ...connected, overlay: Overlay.Palette() }).length,
      ),
      expectScene(
        within(palette, role('button', { name: 'Go to Backlog' })),
      ).toHaveAttr('aria-keyshortcuts', '⌘3'),
      expectScene(
        within(palette, role('button', { name: 'Show the keys' })),
      ).toHaveAttr('aria-keyshortcuts', '?'),
      expectScene(within(palette, text('Next'))).toExist(),
      expectScene(within(palette, text('↓'))).toExist(),
      expectScene(within(palette, text('↑'))).toExist(),
      expectScene(within(palette, text('⏎'))).toExist(),
      expectScene(within(palette, text('Esc'))).toExist(),
    )
  })

  test('navigation follows: every project, the run’s tickets and its workers, then the themes', () => {
    expect(
      paletteEntries(connected)
        .filter(entry => entry.group !== 'command')
        .map(entry => [entry.group, entry.title]),
    ).toEqual([
      ['project', 'All projects'],
      ['project', 'fabrica'],
      ['project', 'tutti'],
      ['ticket', 'fa-1 Refresh the auth token'],
      ['ticket', 'fa-2 Draw the phase bar'],
      ['worker', 'fa-1 Refresh the auth token · claude-opus-5-5'],
      ['theme', 'Lichen Bright'],
      ['theme', 'Classic'],
      ['theme', 'Neon Grid'],
    ])
  })
})

describe('filtering', () => {
  test('typing keeps the entries holding each word, in any order, case aside', () => {
    scene(
      { update, view },
      givenScene(connected),
      Subscription.emit(key('k', { mod: true })),
      type(search, 'BACKLOG'),
      expectAll(entries).toHaveCount(1),
      expectScene(
        within(palette, role('button', { name: 'Go to Backlog' })),
      ).toExist(),
      type(search, 'theme'),
      expectAll(entries).toHaveCount(3),
      type(search, 'grid neon'),
      expectAll(entries).toHaveCount(1),
      expectScene(
        within(palette, role('button', { name: 'Neon Grid' })),
      ).toExist(),
      type(search, 'fa-1 worker'),
      expectAll(entries).toHaveCount(1),
      type(search, 'nothing like this'),
      expectAll(entries).toHaveCount(0),
      expectScene(within(palette, role('status'))).toHaveText(
        'Nothing matches.',
      ),
    )
  })

  test('a changed query selects the first entry it matches', () => {
    const typed = Palette.update(
      { query: 'the', selected: 2 },
      Palette.Message.ChangedQuery({ query: 'theme' }),
    )
    expect(typed).toEqual({ query: 'theme', selected: 0 })
  })
})

describe('running a command', () => {
  test('the arrows move the selection, round from either end, and Enter runs it', () => {
    scene(
      { update, view },
      givenScene(connected),
      Subscription.emit(key('k', { mod: true })),
      type(search, 'theme'),
      expectScene(
        within(palette, role('button', { name: 'Lichen Bright' })),
      ).toHaveAttr('aria-current', 'true'),
      Subscription.emit(fieldKey('ArrowUp')),
      expectScene(
        within(palette, role('button', { name: 'Neon Grid' })),
      ).toHaveAttr('aria-current', 'true'),
      SceneCommand.expectExact(
        Palette.ScrollToEntry({ id: 'theme.neon-grid' }),
      ),
      scrolledScene(),
      Subscription.emit(fieldKey('ArrowDown')),
      scrolledScene(),
      Subscription.emit(fieldKey('ArrowDown')),
      SceneCommand.expectExact(Palette.ScrollToEntry({ id: 'theme.classic' })),
      scrolledScene(),
      expectScene(
        within(palette, role('button', { name: 'Classic' })),
      ).toHaveAttr('aria-current', 'true'),
      expectScene(
        within(palette, role('button', { name: 'Lichen Bright' })),
      ).toHaveAttr('aria-current', 'false'),
      Subscription.emit(fieldKey('Enter')),
      SceneCommand.expectExact(ShowTheme({ theme: 'classic' })),
      expectScene(palette).toBeAbsent(),
      SceneCommand.resolve(ShowTheme, Message.CompletedShowTheme()),
    )
  })

  test('Enter on a project scopes the console to it, and closes the palette', () => {
    story(
      update,
      given(connected),
      message(key('k', { mod: true })),
      message(
        Message.GotPaletteMessage({
          message: Palette.Message.ChangedQuery({ query: 'tutti project' }),
        }),
      ),
      message(fieldKey('Enter')),
      model(shown => {
        expect(shown.scope).toEqual(
          Option.some({ engine: localEngineName, project: tutti }),
        )
        expect(shown.overlay).toEqual(Overlay.Closed())
      }),
    )
  })

  test('a click runs its entry: a ticket opens its worker view', () => {
    scene(
      { update, view },
      givenScene(connected),
      Subscription.emit(key('k', { mod: true })),
      type(search, 'phase bar'),
      click(
        within(palette, role('button', { name: 'fa-2 Draw the phase bar' })),
      ),
      expectScene(palette).toBeAbsent(),
      SceneCommand.resolve(
        Worker.LoadTicket({
          worker: {
            project: { engine: localEngineName, project: fabrica },
            ticket: TicketId.make('fa-2'),
          },
        }),
        Worker.Message.FailedLoadTicket({
          worker: {
            project: { engine: localEngineName, project: fabrica },
            ticket: TicketId.make('fa-2'),
          },
          reason: 'not served',
        }),
      ),
      expectScene(role('heading', { name: 'Worker fa-2', level: 1 })).toExist(),
    )
  })

  test('a bound command runs as its key would: Go to Insights', () => {
    story(
      update,
      given(connected),
      message(key('k', { mod: true })),
      message(Message.RanPaletteEntry({ id: 'go.Insights' })),
      StoryCommand.resolveAll(...insightsUnserved),
      model(shown => {
        expect(shown.screen).toEqual(Screen.Insights())
        expect(shown.overlay).toEqual(Overlay.Closed())
      }),
    )
  })

  test('Escape closes it, and it opens afresh, its query gone', () => {
    story(
      update,
      given(connected),
      message(key('k', { mod: true })),
      message(
        Message.GotPaletteMessage({
          message: Palette.Message.ChangedQuery({ query: 'theme' }),
        }),
      ),
      message(fieldKey('ArrowDown')),
      scrolledStory(),
      message(fieldKey('Escape')),
      model(shown => {
        expect(shown.overlay).toEqual(Overlay.Closed())
      }),
      message(key('k', { mod: true })),
      model(shown => {
        expect(shown.overlay).toEqual(Overlay.Palette())
        expect(shown.screens.palette).toEqual(Palette.init())
      }),
    )
  })

  test('Enter and the arrows on a focused entry, outside the search field, are the entry’s own', () => {
    story(
      update,
      given(connected),
      message(key('k', { mod: true })),
      message(key('ArrowDown')),
      StoryCommand.expectNone(),
      message(key('Enter')),
      model(shown => {
        expect(shown.overlay).toEqual(Overlay.Palette())
        expect(shown.screens.palette).toEqual(Palette.init())
      }),
      // The focused button's own click runs it, though another is selected.
      message(Message.RanPaletteEntry({ id: 'theme.classic' })),
      StoryCommand.expectExact(ShowTheme({ theme: 'classic' })),
      model(shown => {
        expect(shown.theme).toEqual(Option.some('classic'))
        expect(shown.overlay).toEqual(Overlay.Closed())
      }),
      StoryCommand.resolve(ShowTheme, Message.CompletedShowTheme()),
    )
  })

  test('with the palette closed its keys are typing, and an entry runs nothing', () => {
    story(
      update,
      given(connected),
      message(fieldKey('Enter')),
      message(fieldKey('ArrowDown')),
      message(Message.RanPaletteEntry({ id: 'go.Insights' })),
      model(shown => {
        expect(shown.screen).toEqual(Screen.Console())
        expect(shown.overlay).toEqual(Overlay.Closed())
        expect(shown.screens.palette).toEqual(Palette.init())
      }),
    )
  })
})
