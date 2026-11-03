import { DateTime, Effect, Fiber, Option, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { describe, expect, it, test } from '@effect/vitest'
import { SshPrompt } from '@fabrica/client'
import {
  AttentionAnswer,
  AttentionRequest,
  EngineId,
  PermissionDecision,
  PermissionId,
  ProjectId,
  StreamEpoch,
  attentionKey,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { isConsoleShown } from '../src/app/features/screen/screen'
import { Message } from '../src/app/message'
import { type Model, Overlay, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { update } from '../src/app/update'
import * as Attention from '../src/console/attention'

// The attention column's key guards, as the console is shown again (spec §15.1, H62): a request that
// arrives, or a guard that runs out, while another screen or an overlay is up has been drawn in front of
// no one, so both guards start afresh on the way back, and a key pressed right after it answers nothing.

const project = ProjectId.make('p-1')
const scoped: EngineProject = { engine: localEngineName, project }

/** Thursday 29 October 2026, 12:00 UTC: 14:00 in Athens. */
const at = Date.UTC(2026, 9, 29, 12, 0, 0)
const now = DateTime.makeZonedUnsafe(at, { timeZone: 'Europe/Athens' })

const decodeRequest = Schema.decodeUnknownSync(
  Schema.toCodecJson(AttentionRequest),
)

const permission = decodeRequest({
  _tag: 'permission',
  project,
  id: 'perm-1',
  ticket: 'fa-7',
  session: 's-1',
  tool: 'bash',
  input: { command: 'rm -rf build/' },
  shown: { _tag: 'command', lines: ['rm -rf build/'] },
  why: 'rm is not on the allow list',
  openedAt: at - 3 * 60_000,
})

const other = decodeRequest({
  _tag: 'permission',
  project,
  id: 'perm-2',
  ticket: 'fa-8',
  session: 's-2',
  tool: 'bash',
  input: { command: 'git push --force' },
  shown: { _tag: 'command', lines: ['git push --force'] },
  why: 'git push is not on the allow list',
  openedAt: at - 60_000,
})

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

const permissionKey = 'permission:p-1:perm-1'

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

const received = (requests: ReadonlyArray<AttentionRequest>) =>
  Message.ReceivedAttention({
    engine: localEngineName,
    items: [
      {
        _tag: 'snapshot',
        epoch: StreamEpoch.make('epoch-1'),
        seq: 0,
        value: requests,
      },
    ],
  })

const attentionMessage = (child: Attention.Message) =>
  Message.GotAttentionMessage({ message: child })

const passed = (drawing: number) =>
  attentionMessage(Attention.Message.PassedGuard({ drawing }))

const answering = attentionMessage(
  Attention.Message.ClickedAnswer({
    engine: localEngineName,
    request: question,
  }),
)

const key = (pressed: string, mod = false) =>
  Message.PressedKey({
    key: pressed,
    mod,
    alt: false,
    inField: false,
    repeat: false,
  })

const showConsole = key('1', true)
const showBacklog = key('3', true)
const escape = key('Escape')
const palette = key('k', true)
const help = key('?')

const notice = SshPrompt.cases.Notice.make({
  destination: 'build-box',
  text: 'Host key changed',
})

/** `messages` through update one after another, as the runtime sends them, with the last one's Commands. */
const sent = (start: Model, ...messages: ReadonlyArray<Message>) =>
  messages.reduce<{
    readonly model: Model
    readonly commands: ReadonlyArray<{
      readonly name: string
      readonly args?: unknown
    }>
  }>(
    (step, next) => {
      const result = update(step.model, next)
      return { model: result.model, commands: result.commands ?? [] }
    },
    { model: start, commands: [] },
  )

const commandsOf = (step: ReturnType<typeof sent>) =>
  step.commands.map(command => [command.name, command.args])

const waitFor = (...drawings: ReadonlyArray<number>) =>
  drawings.map(drawing => ['WaitGuard', { drawing }])

const allowOnce = [
  [
    'Answer',
    {
      key: permissionKey,
      engine: localEngineName,
      answer: AttentionAnswer.cases.permission.make({
        project,
        id: PermissionId.make('perm-1'),
        decision: PermissionDecision.cases.allow_once.make({}),
      }),
    },
  ],
]

describe('the approval keys, as the console is shown again', () => {
  it.effect(
    'a request that arrived on another screen waits 500 ms from ⌘1 on the injected clock, not from its arrival',
    () =>
      Effect.gen(function* () {
        const away = sent(connected, showBacklog, received([permission]))
        expect(commandsOf(away)).toEqual(waitFor(1))
        const ranOut = sent(away.model, passed(1))
        expect(
          Attention.Guard.guards.Waiting(
            ranOut.model.console.attention.approvalGuard,
          ),
        ).toBe(true)

        const back = sent(ranOut.model, showConsole)
        expect(back.model.screen).toEqual(Screen.Console())
        expect(commandsOf(back)).toEqual(waitFor(2))

        const early = sent(back.model, key('y'))
        expect(commandsOf(early)).toEqual([])
        expect(early.model.console.attention.sending).toEqual(
          Attention.Sending.None(),
        )

        const waiting = yield* Effect.forkChild(
          Attention.WaitGuard({ drawing: 2 }).effect,
        )
        yield* TestClock.adjust('499 millis')
        expect(waiting.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust('1 millis')
        const message = yield* Fiber.join(waiting)
        expect(message).toEqual(Attention.Message.PassedGuard({ drawing: 2 }))

        expect(
          commandsOf(sent(back.model, attentionMessage(message), key('y'))),
        ).toEqual(allowOnce)
      }),
  )

  test('a guard that started before the console was left can’t pass the one started on the way back', () => {
    const back = sent(
      connected,
      showBacklog,
      received([permission]),
      showConsole,
    )
    expect(commandsOf(back)).toEqual(waitFor(2))
    expect(commandsOf(sent(back.model, passed(1), key('y')))).toEqual([])
  })

  test.each([
    ['the key help closed', [help, escape]],
    ['the palette closed', [palette, escape]],
    [
      'the palette’s entry run',
      [palette, Message.RanPaletteEntry({ id: 'theme.neon-grid' })],
    ],
  ])('%s starts it again', (_, closing) => {
    const covered = sent(
      connected,
      received([permission]),
      passed(1),
      ...closing.slice(0, -1),
    )
    expect(commandsOf(sent(covered.model, key('y')))).toEqual([])
    const shown = sent(covered.model, ...closing.slice(-1))
    expect(shown.model.overlay).toEqual(Overlay.Closed())
    expect(commandsOf(shown).filter(([name]) => name === 'WaitGuard')).toEqual(
      waitFor(2),
    )
    expect(commandsOf(sent(shown.model, key('y')))).toEqual([])
    expect(commandsOf(sent(shown.model, passed(2), key('y')))).toEqual(
      allowOnce,
    )
  })

  test('the palette’s entry back to the console starts it once', () => {
    const shown = sent(
      connected,
      showBacklog,
      received([permission]),
      passed(1),
      palette,
      Message.RanPaletteEntry({ id: 'go.Console' }),
    )
    expect(shown.model.screen).toEqual(Screen.Console())
    expect(commandsOf(shown)).toEqual(waitFor(2))
  })

  test('a palette entry can’t answer a request that arrived under the palette', () => {
    const under = sent(connected, palette, received([permission]), passed(1))
    expect(under.model.console.attention.approvalGuard._tag).toBe('Waiting')
    expect(
      sent(under.model, Message.RanPaletteSelection()).model.console.attention
        .sending,
    ).toEqual(Attention.Sending.None())
    const entry = sent(
      under.model,
      Message.RanPaletteEntry({ id: 'approval.allow_once' }),
    )
    expect(entry.model.overlay).toEqual(Overlay.Closed())
    expect(entry.model.console.attention.sending).toEqual(
      Attention.Sending.None(),
    )
    expect(commandsOf(entry)).toEqual(waitFor(2))
  })

  test('a palette entry can’t answer a request that changed under the palette', () => {
    const entry = sent(
      connected,
      received([permission]),
      passed(1),
      palette,
      received([other]),
      passed(2),
      Message.RanPaletteEntry({ id: 'approval.allow_once' }),
    )
    expect(entry.model.console.attention.sending).toEqual(
      Attention.Sending.None(),
    )
  })

  test('a palette entry answers a request whose guard passed before the palette opened', () => {
    const entry = sent(
      connected,
      received([permission]),
      passed(1),
      palette,
      Message.RanPaletteEntry({ id: 'approval.allow_once' }),
    )
    expect(commandsOf(entry).slice(0, 1)).toEqual(allowOnce)
  })

  test('an SSH prompt gone starts it again', () => {
    const asked = sent(
      connected,
      received([permission]),
      passed(1),
      Message.AskedSsh({ id: 1, prompt: notice }),
    )
    expect(commandsOf(asked)).toEqual([])
    const shown = sent(asked.model, Message.WithdrewSsh({ id: 1 }))
    expect(commandsOf(shown)).toEqual(waitFor(2))
    expect(commandsOf(sent(shown.model, key('y')))).toEqual([])
  })

  test.each([
    ['opening the palette', [palette], false],
    ['going from screen to screen', [showBacklog, key('5', true)], false],
    ['the console asked for again', [showConsole], true],
    [
      'the palette closing onto another screen',
      [showBacklog, palette, escape],
      false,
    ],
    [
      'the palette’s entry opening the key help',
      [palette, Message.RanPaletteEntry({ id: 'help' })],
      false,
    ],
  ])('%s leaves it as it is', (_, messages, shownAfter) => {
    const after = sent(
      connected,
      received([permission]),
      passed(1),
      ...messages,
    )
    expect(isConsoleShown(after.model)).toBe(shownAfter)
    expect(after.model.console.attention.drawings).toBe(1)
    expect(after.model.console.attention.approvalGuard._tag).toBe('Passed')
  })
})

describe('keys 1–9, as the console is shown again', () => {
  const drawn = sent(connected, received([question]), answering)

  test('the drawn options wait again after the key help closes', () => {
    const shown = sent(drawn.model, passed(1), help, escape)
    expect(commandsOf(shown)).toEqual(waitFor(2))
    const early = sent(shown.model, key('1'))
    expect(commandsOf(early)).toEqual([])
    expect(early.model.console.attention.sending).toEqual(
      Attention.Sending.None(),
    )
    expect(
      Attention.Sending.guards.Pending(
        sent(shown.model, passed(2), key('1')).model.console.attention.sending,
      ),
    ).toBe(true)
  })

  test('the drawn options wait again after another screen', () => {
    const shown = sent(drawn.model, passed(1), showBacklog, showConsole)
    expect(commandsOf(shown)).toEqual(waitFor(2))
    expect(commandsOf(sent(shown.model, key('1')))).toEqual([])
  })

  test('a palette entry answers options whose guard passed before the palette opened, and no others', () => {
    const answers = (start: Model) =>
      sent(start, Message.RanPaletteEntry({ id: 'answer.1' })).model.console
        .attention.sending
    expect(answers(sent(drawn.model, passed(1), palette).model)).toEqual(
      Attention.Sending.Pending({ key: attentionKey(question) }),
    )
    expect(answers(sent(drawn.model, palette, passed(1)).model)).toEqual(
      Attention.Sending.None(),
    )
  })

  test('both guards start, each with a drawing of its own', () => {
    const both = sent(
      connected,
      received([question, permission]),
      answering,
      passed(1),
      passed(2),
      showBacklog,
    )
    const shown = sent(both.model, showConsole)
    expect(commandsOf(shown)).toEqual(waitFor(3, 4))
    expect(shown.model.console.attention.guard._tag).toBe('Waiting')
    expect(shown.model.console.attention.approvalGuard._tag).toBe('Waiting')
  })

  test('a guard that is off stays off', () => {
    const shown = sent(connected, showBacklog, showConsole)
    expect(commandsOf(shown)).toEqual([])
    expect(shown.model.console.attention).toEqual(connected.console.attention)
  })
})
