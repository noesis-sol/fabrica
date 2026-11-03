import { Option, Schema } from 'effect'
import {
  expect as expectScene,
  given as givenScene,
  role,
  scene,
  within,
} from 'foldkit/scene'

import { describe, expect, test } from '@effect/vitest'
import {
  AttentionRequest,
  EngineId,
  ProjectId,
  StreamEpoch,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { paletteEntries } from '../src/app/features/palette/palette'
import { Message } from '../src/app/message'
import { type Model, Overlay, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Attention from '../src/console/attention'
import * as Palette from '../src/screens/palette'

// The palette's selection, as entries leave or join its list (spec §18.5): it is on an entry, not a
// place, so Enter runs what is highlighted, never what moved under the highlight. The console's answer
// and approval commands head the list, so a request gone or come is what moves the others.

const project = ProjectId.make('p-1')
const scoped: EngineProject = { engine: localEngineName, project }

const at = Date.UTC(2026, 9, 29, 12, 0, 0)

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
  consequential: false,
  maintainerOnly: false,
  blocks: ['fa-7'],
  askedFrom: 'fa-7',
  openedAt: at - 14 * 60_000,
})

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(scoped),
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

const fieldKey = (pressed: string) =>
  Message.PressedKey({
    key: pressed,
    mod: false,
    alt: false,
    inField: true,
    repeat: false,
  })

const openPalette = Message.PressedKey({
  key: 'k',
  mod: true,
  alt: false,
  inField: false,
  repeat: false,
})

const typed = (query: string) =>
  Message.GotPaletteMessage({
    message: Palette.Message.ChangedQuery({ query }),
  })

/** `messages` through update one after another, as the runtime sends them, with the last one's Commands. */
const sent = (start: Model, ...messages: ReadonlyArray<Message>) =>
  messages.reduce<{
    readonly model: Model
    readonly commands: ReadonlyArray<{ readonly name: string }>
  }>(
    (step, next) => {
      const result = update(step.model, next)
      return { model: result.model, commands: result.commands ?? [] }
    },
    { model: start, commands: [] },
  )

const selectedId = (shown: Model) =>
  Option.map(
    Palette.selected(shown.screens.palette, paletteEntries(shown)),
    ({ id }) => id,
  )

/** A question and a permission request, both guards passed, the question's options drawn; the palette over them. */
const both = sent(
  connected,
  received([question, permission]),
  answering,
  passed(1),
  passed(2),
  openPalette,
).model

const sending = (shown: Model) => shown.console.attention.sending

describe('a request leaves under the palette', () => {
  test('Enter on the question’s answer, the question gone, doesn’t approve the permission', () => {
    expect(selectedId(both)).toEqual(Option.some('answer.1'))
    const gone = sent(both, received([permission])).model
    expect(paletteEntries(gone)[0]?.id).toBe('approval.allow_once')
    expect(selectedId(gone)).toEqual(Option.none())

    const entered = sent(gone, fieldKey('Enter'))
    expect(sending(entered.model)).toEqual(Attention.Sending.None())
    expect(entered.commands).toEqual([])
    expect(entered.model.overlay).toEqual(Overlay.Palette())
  })

  test('the same, the selection moved to its answer with an arrow', () => {
    const moved = sent(both, fieldKey('ArrowDown')).model
    expect(selectedId(moved)).toEqual(Option.some('answer.2'))
    const gone = sent(moved, received([permission])).model
    expect(selectedId(gone)).toEqual(Option.none())
    expect(sending(sent(gone, fieldKey('Enter')).model)).toEqual(
      Attention.Sending.None(),
    )
  })

  test('nothing is highlighted, and an arrow selects again from either end', () => {
    const gone = sent(both, received([permission])).model
    const ids = paletteEntries(gone).map(({ id }) => id)
    expect(selectedId(sent(gone, fieldKey('ArrowDown')).model)).toEqual(
      Option.some(ids[0]),
    )
    expect(selectedId(sent(gone, fieldKey('ArrowUp')).model)).toEqual(
      Option.some(ids.at(-1)),
    )
    scene(
      { update, view },
      givenScene(gone),
      expectScene(
        within(
          role('dialog', { name: 'Command palette' }),
          role('button', { name: 'Approve: bash' }),
        ),
      ).toHaveAttr('aria-current', 'false'),
    )
  })

  test('an entry that stays keeps the selection as the entries above it leave', () => {
    const onApprove = sent(both, typed('approve')).model
    expect(selectedId(onApprove)).toEqual(Option.some('approval.allow_once'))
    const gone = sent(onApprove, received([permission])).model
    expect(selectedId(gone)).toEqual(Option.some('approval.allow_once'))
    expect(
      Attention.Sending.guards.Pending(
        sending(sent(gone, fieldKey('Enter')).model),
      ),
    ).toBe(true)
  })
})

describe('a request joins under the palette', () => {
  const opened = sent(connected, openPalette).model

  test('the entry selected by default stays selected, and Enter runs it', () => {
    const before = selectedId(opened)
    const firstBefore = paletteEntries(opened)[0]?.id
    expect(before).toEqual(Option.some(firstBefore))

    const joined = sent(opened, received([permission])).model
    expect(paletteEntries(joined)[0]?.id).toBe('approval.allow_once')
    expect(selectedId(joined)).toEqual(before)

    const first = paletteEntries(opened)[0]
    expect(sent(joined, fieldKey('Enter')).model).toEqual(
      sent(joined, Message.RanPaletteEntry({ id: first?.id ?? '' })).model,
    )
    scene(
      { update, view },
      givenScene(joined),
      expectScene(
        within(
          role('dialog', { name: 'Command palette' }),
          role('button', { name: first?.title ?? '' }),
        ),
      ).toHaveAttr('aria-current', 'true'),
      expectScene(
        within(
          role('dialog', { name: 'Command palette' }),
          role('button', { name: 'Approve: bash' }),
        ),
      ).toHaveAttr('aria-current', 'false'),
    )
  })

  test('the entry selected by an arrow stays selected', () => {
    const moved = sent(opened, fieldKey('ArrowDown')).model
    const before = selectedId(moved)
    expect(selectedId(sent(moved, received([permission])).model)).toEqual(
      before,
    )
  })

  test('the arrows go on from the entry selected, in the list as it is now', () => {
    const joined = sent(opened, received([permission])).model
    const ids = paletteEntries(joined).map(({ id }) => id)
    const place = ids.indexOf(Option.getOrThrow(selectedId(joined)))
    expect(selectedId(sent(joined, fieldKey('ArrowUp')).model)).toEqual(
      Option.some(ids[place - 1]),
    )
  })
})

describe('a query picks the first entry it matches at that moment', () => {
  test('a query with no match selects nothing, and an entry joining it stays unselected', () => {
    const none = sent(connected, openPalette, typed('approve')).model
    expect(none.screens.palette.selected).toEqual(Option.none())
    const joined = sent(none, received([permission]), passed(1)).model
    expect(selectedId(joined)).toEqual(Option.none())
  })

  test('the palette opened anew selects the first entry again', () => {
    const gone = sent(both, received([permission])).model
    const reopened = sent(gone, fieldKey('Escape'), openPalette).model
    expect(selectedId(reopened)).toEqual(
      Option.some(paletteEntries(reopened)[0]?.id),
    )
  })
})
