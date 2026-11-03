import { DateTime, Option, Schema } from 'effect'
import {
  expect as expectScene,
  given,
  role,
  scene,
  selector,
  within,
} from 'foldkit/scene'

import { describe, expect, test } from '@effect/vitest'
import {
  AttentionRequest,
  EngineId,
  ProjectId,
  RunView,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { runOffers } from '../src/app/features/keys/keys'
import { answerKeyLabels } from '../src/app/keys'
import { Message } from '../src/app/message'
import { type Model, Overlay, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Attention from '../src/console/attention'
import * as Stats from '../src/console/stats'

// One list of commands (spec §18.5, H79): the run buttons are the stats row's offers, with their titles
// and Messages, so a button works exactly where its key does; the options' key caps and shortcuts are
// the command list's keys 1–9.

const project = ProjectId.make('p-1')
const scoped: EngineProject = { engine: localEngineName, project }

/** Thursday 29 October 2026, 12:00 UTC: 14:00 in Athens. */
const at = Date.UTC(2026, 9, 29, 12, 0, 0)
const now = DateTime.makeZonedUnsafe(at, { timeZone: 'Europe/Athens' })

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(scoped),
  now: Option.some(now),
}

const decodeRunView = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))

const runOf = (state: 'running' | 'draining' | 'stopping') =>
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

const withRun = (
  state: 'running' | 'draining' | 'stopping',
  controlsState: Stats.Controls = Stats.Controls.Closed(),
): Model => ({
  ...connected,
  runView: Option.some(runOf(state)),
  console: {
    ...connected.console,
    stats: { ...connected.console.stats, controls: controlsState },
  },
})

const controls = role('group', { name: 'Run controls' })

const button = (name: string) => within(controls, role('button', { name }))

const key = (pressed: string) =>
  Message.PressedKey({
    key: pressed,
    mod: false,
    alt: false,
    inField: false,
    repeat: false,
  })

describe('the run buttons are the row’s offers', () => {
  test.each([
    ['running', Stats.Controls.Closed(), ['Drain', 'Stop']],
    ['draining', Stats.Controls.Closed(), ['Undrain', 'Stop']],
    [
      'running',
      Stats.Controls.ConfirmingStop(),
      ['Drain', 'Stop the run', 'Keep running'],
    ],
  ] as const)(
    'a run %s: each offer is an enabled button with its title',
    (state, controlsState, titles) => {
      const shown = withRun(state, controlsState)
      expect(runOffers(shown).map(Stats.offerTitle)).toEqual(titles)
      scene(
        { update, view },
        given(shown),
        ...titles.map(title => expectScene(button(title)).toBeEnabled()),
      )
    },
  )

  test('while the run stops nothing is offered, and Keep running is disabled with the rest', () => {
    const shown = withRun('stopping', Stats.Controls.ConfirmingStop())
    expect(runOffers(shown)).toEqual([])
    scene(
      { update, view },
      given(shown),
      expectScene(button('Drain')).toBeDisabled(),
      expectScene(button('Stop the run')).toBeDisabled(),
      expectScene(button('Keep running')).toBeDisabled(),
    )
  })

  test('Escape does nothing where Keep running is disabled, and keeps the run where it is enabled', () => {
    const stopping = withRun('stopping', Stats.Controls.ConfirmingStop())
    expect(
      update(stopping, key('Escape')).model.console.stats.controls,
    ).toEqual(Stats.Controls.ConfirmingStop())
    const running = withRun('running', Stats.Controls.ConfirmingStop())
    expect(update(running, key('Escape')).model.console.stats.controls).toEqual(
      Stats.Controls.Closed(),
    )
  })
})

const decodeRequest = Schema.decodeUnknownSync(
  Schema.toCodecJson(AttentionRequest),
)

/** A question of four options, the second recommended, so it is drawn first and takes key 1. */
const question = decodeRequest({
  _tag: 'question',
  project,
  ticket: 'fa-q1',
  title: 'Which store keeps the sessions?',
  description: 'The worker needs a store for the refresh tokens.',
  choices: {
    options: [
      { label: 'Redis', tradeOff: 'Fast; another service to run' },
      { label: 'Postgres', tradeOff: 'Already running; slower' },
      { label: 'Memory', tradeOff: 'Nothing to run; lost on restart' },
      { label: 'Files', tradeOff: 'Nothing to run; one machine only' },
    ],
    recommended: 1,
  },
  drafted: false,
  consequential: false,
  maintainerOnly: false,
  blocks: ['fa-7'],
  askedFrom: 'fa-7',
  openedAt: at - 14 * 60_000,
})

const answering = (): Model => {
  const withRequests: Model = {
    ...connected,
    attention: Option.some([question]),
    engineAttention: [{ engine: localEngineName, requests: [question] }],
  }
  return update(
    withRequests,
    Message.GotAttentionMessage({
      message: Attention.Message.ClickedAnswer({
        engine: localEngineName,
        request: question,
      }),
    }),
  ).model
}

const option = (index: number) => selector(`[data-option="${index}"]`)

describe('the options’ key caps are the command list’s keys', () => {
  test('a key is labelled for each option drawn, none while none are drawn', () => {
    expect(
      answerKeyLabels(
        Attention.keyedOptions(answering().console.attention),
        'darwin',
      ),
    ).toEqual(['1', '2', '3', '4'])
    expect(answerKeyLabels(Option.none(), 'darwin')).toEqual([])
  })

  test('each option carries the cap and shortcut of the key that answers it, in the order drawn', () => {
    scene(
      { update, view },
      given(answering()),
      ...[
        { index: 1, cap: '1' },
        { index: 0, cap: '2' },
        { index: 2, cap: '3' },
        { index: 3, cap: '4' },
      ].flatMap(({ index, cap }) => [
        expectScene(option(index)).toHaveAttr('aria-keyshortcuts', cap),
        expectScene(within(option(index), selector('kbd'))).toHaveText(cap),
      ]),
    )
  })

  test('the caps stay beneath an open overlay, whose keys cover theirs', () => {
    scene(
      { update, view },
      given({ ...answering(), overlay: Overlay.KeyHelp() }),
      expectScene(within(option(1), selector('kbd'))).toHaveText('1'),
    )
  })
})
