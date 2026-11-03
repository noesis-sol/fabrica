import { Option, Schema } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import {
  EngineId,
  ProjectId,
  RunView,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { commandFor, paletteOverlayKeys } from '../src/app/keys'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import * as Stats from '../src/console/stats'

// A held key (spec §18.5): the system's auto-repeat of it runs no command, so holding `x` past the
// repeat delay can't give Stop its confirmation on the same key (§13.10); a fresh press still does.
// The palette's arrows alone run again on each repeat, moving on through its entries while held.

const project = ProjectId.make('p-1')
const scoped: EngineProject = { engine: localEngineName, project }

const at = Date.UTC(2026, 9, 29, 12, 0, 0)

const decodeRunView = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))

const running: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(scoped),
  runView: Option.some(
    decodeRunView({
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
    }),
  ),
}

const press = (key: string) =>
  Message.PressedKey({
    key,
    mod: false,
    alt: false,
    inField: false,
    repeat: false,
  })
const held = (key: string) =>
  Message.PressedKey({
    key,
    mod: false,
    alt: false,
    inField: false,
    repeat: true,
  })

describe('a held key', () => {
  test('holding X asks to stop and no more: only a second press stops the run', () => {
    story(
      update,
      given(running),
      message(press('x')),
      Command.expectNone(),
      message(held('x')),
      message(held('x')),
      Command.expectNone(),
      model(shown => {
        expect(shown.console.stats.controls).toEqual(
          Stats.Controls.ConfirmingStop(),
        )
      }),
      message(press('x')),
      Command.expectExact(Stats.AskRun({ project: scoped, action: 'stop' })),
      Command.resolve(Stats.AskRun, Stats.Message.SucceededRunRequest()),
    )
  })

  test('holding R opens the start modes and runs none of them', () => {
    story(
      update,
      given(running),
      message(held('r')),
      model(shown => {
        expect(shown.console.stats.controls).toEqual(Stats.Controls.Closed())
      }),
    )
  })

  test('the palette’s arrows run again on each repeat, Enter does not', () => {
    const inField = (key: string) => ({
      key,
      mod: false,
      alt: false,
      inField: true,
      repeat: true,
    })
    expect(
      ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].map(key =>
        Option.getOrUndefined(
          Option.map(
            commandFor(paletteOverlayKeys, inField(key)),
            command => command.id,
          ),
        ),
      ),
    ).toEqual(['palette.next', 'palette.previous', undefined, undefined])
  })
})
