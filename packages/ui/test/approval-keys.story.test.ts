import { DateTime, Effect, Fiber, Option, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import {
  expect as expectScene,
  given,
  role,
  scene,
  within,
} from 'foldkit/scene'

import { describe, expect, it, test } from '@effect/vitest'
import {
  AttentionAnswer,
  AttentionRequest,
  EngineId,
  PermissionDecision,
  PermissionId,
  ProjectId,
  StreamEpoch,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { chordLabel } from '../src/app/keys'
import { Message } from '../src/app/message'
import { type Model, Overlay, initialModel } from '../src/app/model'
import type { AttentionItem } from '../src/app/streams'
import { modelCommands, paletteEntries, update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Attention from '../src/console/attention'

// The console's approval keys (spec §15.1, §18.5, H62): Approve, Allow for this run and Refuse answer
// the column's first permission request as its card's buttons do, only while those buttons are drawn,
// only 500 ms after that request was first drawn, on the injected clock, the guard starting again
// whenever the request they would answer changes. They are commands of the console's one list, so the
// key help and the palette show them, and the keyed card's buttons carry their caps.

const project = ProjectId.make('p-1')
const scoped: EngineProject = { engine: localEngineName, project }

/** Thursday 29 October 2026, 12:00 UTC: 14:00 in Athens. */
const at = Date.UTC(2026, 9, 29, 12, 0, 0)
const now = DateTime.makeZonedUnsafe(at, { timeZone: 'Europe/Athens' })

const decodeRequest = Schema.decodeUnknownSync(
  Schema.toCodecJson(AttentionRequest),
)

const permissionJson = {
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
}

const permission = decodeRequest(permissionJson)

const edit = decodeRequest({
  _tag: 'permission',
  project,
  id: 'perm-2',
  ticket: 'fa-8',
  session: 's-2',
  tool: 'edit',
  input: { path: 'src/auth/refresh.ts' },
  shown: {
    _tag: 'edit',
    path: 'src/auth/refresh.ts',
    diff: '-const ttl = 60\n+const ttl = 3600',
  },
  why: 'the file is outside the ticket',
  openedAt: at - 60_000,
})

const review = decodeRequest({
  _tag: 'review',
  project,
  ticket: 'fa-11',
  title: 'Refresh tokens rotate',
  reason: 'CHECKS_FAILED',
  openedAt: at - 3_600_000,
})

/** Asked before the others: the column, oldest first, draws it above them. */
const older = decodeRequest({
  ...permissionJson,
  id: 'perm-0',
  ticket: 'fa-6',
  tool: 'write',
  openedAt: at - 10 * 60_000,
})

const permissionKey = 'permission:p-1:perm-1'
const editKey = 'permission:p-1:perm-2'

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

const epoch = StreamEpoch.make('epoch-1')

const snapshotOf = (
  requests: ReadonlyArray<AttentionRequest>,
): typeof AttentionItem.Type => ({
  _tag: 'snapshot',
  epoch,
  seq: 0,
  value: requests,
})

const received = (requests: ReadonlyArray<AttentionRequest>) =>
  Message.ReceivedAttention({
    engine: localEngineName,
    items: [snapshotOf(requests)],
  })

const attentionMessage = (child: Attention.Message) =>
  Message.GotAttentionMessage({ message: child })

const passed = (drawing: number) =>
  attentionMessage(Attention.Message.PassedGuard({ drawing }))

const key = (pressed: string) =>
  Message.PressedKey({ key: pressed, mod: false, alt: false, inField: false })

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

/** The approval commands of the model's list, each with its key as macOS writes it. */
const approvalCommands = (shown: Model) =>
  modelCommands(shown)
    .filter(command => command.id.startsWith('approval.'))
    .map(command => [
      command.title,
      Option.getOrUndefined(
        Option.map(command.chord, chord => chordLabel(chord, 'darwin')),
      ),
    ])

const answerOf = (
  id: string,
  decision: PermissionDecision,
  key = permissionKey,
) => [
  'Answer',
  {
    key,
    engine: localEngineName,
    answer: AttentionAnswer.cases.permission.make({
      project,
      id: PermissionId.make(id),
      decision,
    }),
  },
]

const allowOnce = PermissionDecision.cases.allow_once.make({})

describe('the approval keys', () => {
  it.effect(
    'the column’s first permission request starts their guard, which passes 500 ms later on the injected clock',
    () =>
      Effect.gen(function* () {
        const drawn = sent(connected, received([review, permission]))
        expect(commandsOf(drawn)).toEqual([['WaitGuard', { drawing: 1 }]])
        const waiting = yield* Effect.forkChild(
          Attention.WaitGuard({ drawing: 1 }).effect,
        )
        yield* TestClock.adjust('499 millis')
        expect(waiting.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust('1 millis')
        const message = yield* Fiber.join(waiting)
        expect(message).toEqual(Attention.Message.PassedGuard({ drawing: 1 }))
        expect(
          Attention.Guard.guards.Passed(
            sent(drawn.model, attentionMessage(message)).model.console.attention
              .approvalGuard,
          ),
        ).toBe(true)
      }),
  )

  test('are the console’s commands only while a permission request is in the column, uncovered', () => {
    expect(approvalCommands(sent(connected, received([review])).model)).toEqual(
      [],
    )
    const drawn = sent(connected, received([permission, edit])).model
    expect(approvalCommands(drawn)).toEqual([
      ['Approve: bash', 'Y'],
      ['Allow for this run: bash', 'W'],
      ['Refuse: bash', 'N'],
    ])
    // The palette runs them too, with their keys.
    expect(
      paletteEntries(drawn)
        .filter(entry => entry.id.startsWith('approval.'))
        .map(entry => [entry.title, Option.getOrUndefined(entry.key)]),
    ).toEqual([
      ['Approve: bash', 'Y'],
      ['Allow for this run: bash', 'W'],
      ['Refuse: bash', 'N'],
    ])
    // An overlay over the column takes them away.
    expect(approvalCommands({ ...drawn, overlay: Overlay.KeyHelp() })).toEqual(
      [],
    )
  })

  test('a key before 500 ms answers nothing; after it, as the card’s buttons do', () => {
    const drawn = sent(connected, received([permission]))
    expect(commandsOf(sent(drawn.model, key('y')))).toEqual([])
    expect(commandsOf(sent(drawn.model, key('w')))).toEqual([])
    expect(sent(drawn.model, key('n')).model.console.attention.open).toEqual(
      Attention.Open.None(),
    )
    expect(commandsOf(sent(drawn.model, passed(1), key('y')))).toEqual([
      answerOf('perm-1', allowOnce),
    ])
    expect(commandsOf(sent(drawn.model, passed(1), key('w')))).toEqual([
      answerOf('perm-1', PermissionDecision.cases.allow_run.make({})),
    ])
  })

  test('Refuse opens the refusal’s note in the buttons’ place, where the keys answer nothing', () => {
    const refusing = sent(
      connected,
      received([permission]),
      passed(1),
      key('n'),
    ).model
    expect(refusing.console.attention.open).toEqual(
      Attention.Open.Refusing({ key: permissionKey, note: '' }),
    )
    expect(approvalCommands(refusing)).toEqual([])
    expect(commandsOf(sent(refusing, key('y')))).toEqual([])
    expect(
      commandsOf(
        sent(
          refusing,
          Message.PressedApprovalKey({
            key: permissionKey,
            decision: 'allow_once',
          }),
        ),
      ),
    ).toEqual([])
    // Cancel draws the buttons again, and the keys with them.
    expect(
      approvalCommands(
        sent(refusing, attentionMessage(Attention.Message.CancelledOpen()))
          .model,
      ),
    ).toEqual([
      ['Approve: bash', 'Y'],
      ['Allow for this run: bash', 'W'],
      ['Refuse: bash', 'N'],
    ])
  })

  test('answer only the column’s first permission request, then the next once its guard has passed again', () => {
    const first = sent(
      connected,
      received([review, permission, edit]),
      passed(1),
    )
    expect(commandsOf(sent(first.model, key('y')))).toEqual([
      answerOf('perm-1', allowOnce),
    ])
    // A key naming another request than the keyed one answers nothing.
    expect(
      commandsOf(
        sent(
          first.model,
          Message.PressedApprovalKey({ key: editKey, decision: 'allow_once' }),
        ),
      ),
    ).toEqual([])
    // Answered, its keys are off at once, before the stream says so.
    const answered = sent(
      first.model,
      key('y'),
      attentionMessage(
        Attention.Message.SucceededAnswer({ key: permissionKey }),
      ),
    )
    expect(approvalCommands(answered.model)).toEqual([])
    expect(commandsOf(sent(answered.model, key('y')))).toEqual([])
    // The next request drawn first starts the guard again.
    const next = sent(answered.model, received([review, edit]))
    expect(commandsOf(next)).toEqual([['WaitGuard', { drawing: 2 }]])
    expect(approvalCommands(next.model)).toEqual([
      ['Approve: edit', 'Y'],
      ['Allow for this run: edit', 'W'],
      ['Refuse: edit', 'N'],
    ])
    expect(commandsOf(sent(next.model, key('y')))).toEqual([])
    expect(commandsOf(sent(next.model, passed(2), key('y')))).toEqual([
      answerOf('perm-2', allowOnce, editKey),
    ])
  })

  test('a change to the request they answer starts the guard again, and the old guard passes nothing', () => {
    const changed = decodeRequest({
      ...permissionJson,
      shown: { _tag: 'command', lines: ['rm -rf /'] },
    })
    const drawn = sent(connected, received([permission]), passed(1))
    const redrawn = sent(drawn.model, received([changed]))
    expect(commandsOf(redrawn)).toEqual([['WaitGuard', { drawing: 2 }]])
    expect(commandsOf(sent(redrawn.model, key('y')))).toEqual([])
    expect(commandsOf(sent(redrawn.model, passed(1), key('y')))).toEqual([])
    expect(commandsOf(sent(redrawn.model, passed(2), key('y')))).toEqual([
      answerOf('perm-1', allowOnce),
    ])
    // A request drawn above it is the one keyed now.
    const above = sent(drawn.model, received([permission, older]))
    expect(commandsOf(above)).toEqual([['WaitGuard', { drawing: 2 }]])
    expect(commandsOf(sent(above.model, passed(2), key('y')))).toEqual([
      answerOf('perm-0', allowOnce, 'permission:p-1:perm-0'),
    ])
    // The same request again, unchanged, keeps the guard passed.
    const same = sent(drawn.model, received([permission, edit]))
    expect(commandsOf(same)).toEqual([])
    expect(commandsOf(sent(same.model, key('y')))).toEqual([
      answerOf('perm-1', allowOnce),
    ])
    // None left: the keys are gone and their guard off.
    const none = sent(drawn.model, received([review]))
    expect(none.model.console.attention.approvalGuard).toEqual(
      Attention.Guard.Off(),
    )
    expect(commandsOf(sent(none.model, key('y')))).toEqual([])
  })

  test('the keyed card’s buttons carry the keys’ caps; another card’s carry none', () => {
    const drawn = sent(connected, received([permission, edit])).model
    scene(
      { update, view },
      given(drawn),
      expectScene(
        within(
          role('listitem', { name: 'Approval fa-7' }),
          role('button', { name: /^Approve/ }),
        ),
      ).toHaveAttr('aria-keyshortcuts', 'Y'),
      expectScene(
        within(
          role('listitem', { name: 'Approval fa-8' }),
          role('button', { name: /^Approve/ }),
        ),
      ).not.toHaveAttr('aria-keyshortcuts', 'Y'),
      expectScene(
        within(
          role('listitem', { name: 'Approval fa-8' }),
          role('button', { name: 'Approve' }),
        ),
      ).toExist(),
    )
  })
})
