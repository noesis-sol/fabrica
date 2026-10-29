import { Option, Schema } from 'effect'
import {
  Subscription,
  expect as expectScene,
  given as givenScene,
  role,
  scene,
  text,
  within,
} from 'foldkit/scene'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import {
  EngineId,
  ProjectId,
  RunMode,
  RunView,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection } from '../src/app/connection'
import { chordLabel } from '../src/app/keys'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { modelCommands, paletteEntries, update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Stats from '../src/console/stats'

// The console's keys for the stats row's run controls (spec §13.10, §18.5): Start run opening its
// modes, Drain or Undrain on `s`, Stop asking its confirmation and the same key giving it, Escape
// closing what they opened. Each is in the console's one command list only while its button is
// offered, enabled, so the key help and the palette show them then and a key acts only where its
// button would.

const project = ProjectId.make('p-1')

const at = Date.UTC(2026, 9, 29, 12, 0, 0)

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(project),
}

const decodeRunView = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))

const withRun = (state: string, base: Model = connected): Model => ({
  ...base,
  runView: Option.some(
    decodeRunView({
      header: {
        run: 'r-1',
        project,
        engine: 'e-1',
        mode: { _tag: 'tickets' },
        state,
        startedAt: at - 3_600_000,
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
    }),
  ),
})

const withStats = (base: Model, stats: Partial<Stats.Model>): Model => ({
  ...base,
  console: { ...base.console, stats: { ...base.console.stats, ...stats } },
})

const key = (pressed: string, { inField = false } = {}) =>
  Message.PressedKey({ key: pressed, mod: false, alt: false, inField })

/** The run commands of the model's list, each with its key as macOS writes it. */
const runCommands = (shown: Model) =>
  modelCommands(shown)
    .filter(command => command.id.startsWith('run.'))
    .map(command => [
      command.id,
      command.title,
      Option.getOrUndefined(
        Option.map(command.chord, chord => chordLabel(chord, 'darwin')),
      ),
    ])

const startModes = [
  ['run.start.tickets', 'Start run: The current tickets', undefined],
  ['run.start.ticket', 'Start run: One ticket', undefined],
  ['run.start.spec', 'Start run: A spec', undefined],
  ['run.start.feature', 'Start run: A feature', undefined],
  ['run.start.overnight', 'Start run: Overnight', undefined],
]

describe('the run keys apply only while their controls do', () => {
  test('idle: Start run on R, each mode a command without a key', () => {
    expect(runCommands(connected)).toEqual([
      ['run.start', 'Start run', 'R'],
      ...startModes,
    ])
  })

  test('its modes open: Escape closes them', () => {
    expect(
      runCommands(
        withStats(connected, { controls: Stats.Controls.ChoosingMode() }),
      ),
    ).toEqual([
      ['run.start', 'Start run', 'R'],
      ...startModes,
      ['run.start.close', 'Cancel Start run', 'Esc'],
    ])
  })

  test("a mode's field open: only Escape, which cancels it", () => {
    expect(
      runCommands(
        withStats(connected, {
          controls: Stats.Controls.Typing({
            mode: 'feature',
            text: '',
            refine: false,
          }),
        }),
      ),
    ).toEqual([['run.start.close', 'Cancel Start run', 'Esc']])
  })

  test('the run going: Drain on S and Stop on X', () => {
    expect(runCommands(withRun('running'))).toEqual([
      ['run.drain', 'Drain', 'S'],
      ['run.stop', 'Stop', 'X'],
    ])
  })

  test('the run draining: Undrain on S', () => {
    expect(runCommands(withRun('draining'))).toEqual([
      ['run.undrain', 'Undrain', 'S'],
      ['run.stop', 'Stop', 'X'],
    ])
  })

  test('Stop asked for: X again stops the run, Escape keeps it running', () => {
    expect(
      runCommands(
        withStats(withRun('running'), {
          controls: Stats.Controls.ConfirmingStop(),
        }),
      ),
    ).toEqual([
      ['run.drain', 'Drain', 'S'],
      ['run.stop.confirm', 'Stop the run', 'X'],
      ['run.stop.keep', 'Keep running', 'Esc'],
    ])
  })

  test('none while the run stops or a request waits on the engine', () => {
    expect(runCommands(withRun('stopping'))).toEqual([])
    expect(
      runCommands(
        withStats(withRun('running'), {
          request: Stats.Request.Pending({ action: 'drain' }),
        }),
      ),
    ).toEqual([])
    expect(
      runCommands(
        withStats(connected, {
          request: Stats.Request.Pending({ action: 'start' }),
        }),
      ),
    ).toEqual([])
  })

  test('none without a project, a connection, or off the console', () => {
    expect(
      runCommands({ ...withRun('running'), scope: Option.none() }),
    ).toEqual([])
    expect(
      runCommands({
        ...withRun('running'),
        connection: Connection.Connecting(),
      }),
    ).toEqual([])
    expect(
      runCommands({ ...withRun('running'), screen: Screen.Backlog() }),
    ).toEqual([])
  })

  test('the palette lists them, with their keys', () => {
    expect(
      paletteEntries(withRun('running'))
        .filter(entry => entry.id.startsWith('run.'))
        .map(entry => [entry.id, Option.getOrUndefined(entry.key)]),
    ).toEqual([
      ['run.drain', 'S'],
      ['run.stop', 'X'],
    ])
  })
})

describe('the keys run the controls', () => {
  test('R opens Start run’s modes and closes them again; Escape closes them too', () => {
    story(
      update,
      given(connected),
      message(key('r')),
      model(shown => {
        expect(shown.console.stats.controls).toEqual(
          Stats.Controls.ChoosingMode(),
        )
      }),
      message(key('r')),
      model(shown => {
        expect(shown.console.stats.controls).toEqual(Stats.Controls.Closed())
      }),
      message(key('r')),
      message(key('Escape')),
      model(shown => {
        expect(shown.console.stats.controls).toEqual(Stats.Controls.Closed())
      }),
    )
  })

  test("a mode's field takes its letters as typing; Escape in it cancels", () => {
    story(
      update,
      given(connected),
      message(key('r')),
      message(
        Message.GotStatsMessage({
          message: Stats.Message.ChoseMode({ project, mode: 'feature' }),
        }),
      ),
      message(key('r', { inField: true })),
      model(shown => {
        expect(shown.console.stats.controls._tag).toBe('Typing')
      }),
      message(key('Escape', { inField: true })),
      model(shown => {
        expect(shown.console.stats.controls).toEqual(Stats.Controls.Closed())
      }),
    )
  })

  test('a mode run from the palette starts the run', () => {
    story(
      update,
      given(connected),
      message(Message.RequestedPalette()),
      message(Message.RanPaletteEntry({ id: 'run.start.tickets' })),
      Command.expectExact(
        Stats.StartRun({ project, mode: RunMode.cases.tickets.make({}) }),
      ),
      Command.resolve(
        Stats.StartRun,
        Stats.Message.SucceededStartRun({ project }),
      ),
    )
  })

  test('S drains the run', () => {
    story(
      update,
      given(withRun('running')),
      message(key('s')),
      Command.expectExact(Stats.AskRun({ project, action: 'drain' })),
      Command.resolve(Stats.AskRun, Stats.Message.SucceededRunRequest()),
    )
  })

  test('S undrains a draining run', () => {
    story(
      update,
      given(withRun('draining')),
      message(key('s')),
      Command.expectExact(Stats.AskRun({ project, action: 'undrain' })),
      Command.resolve(Stats.AskRun, Stats.Message.SucceededRunRequest()),
    )
  })

  test('X asks to stop, and only X again stops the run', () => {
    story(
      update,
      given(withRun('running')),
      message(key('x')),
      Command.expectNone(),
      model(shown => {
        expect(shown.console.stats.controls).toEqual(
          Stats.Controls.ConfirmingStop(),
        )
      }),
      message(key('Escape')),
      model(shown => {
        expect(shown.console.stats.controls).toEqual(Stats.Controls.Closed())
      }),
      message(key('x')),
      message(key('x')),
      Command.expectExact(Stats.AskRun({ project, action: 'stop' })),
      Command.resolve(Stats.AskRun, Stats.Message.SucceededRunRequest()),
    )
  })

  test('S does nothing while a drain waits on the engine', () => {
    story(
      update,
      given(
        withStats(withRun('running'), {
          request: Stats.Request.Pending({ action: 'drain' }),
        }),
      ),
      message(key('s')),
      Command.expectNone(),
    )
  })

  test('the key help lists them', () => {
    scene(
      { update, view },
      givenScene(withRun('running')),
      Subscription.emit(key('?')),
      expectScene(
        within(role('dialog', { name: 'Keys' }), text('Drain')),
      ).toExist(),
      expectScene(
        within(role('dialog', { name: 'Keys' }), text('Stop')),
      ).toExist(),
    )
  })
})
