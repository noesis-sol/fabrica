import { DateTime, Effect, Fiber, Option, Schema, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import {
  Mount,
  Command as SceneCommand,
  click,
  expect as expectScene,
  given as givenScene,
  role,
  scene,
  submit,
  text,
  type as typeInto,
  within,
} from 'foldkit/scene'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, it, test } from '@effect/vitest'
import {
  EngineId,
  ProjectId,
  ProjectRunState,
  ProjectStatus,
  RunView,
  StreamEpoch,
  TicketDetail,
  TicketId,
  TranscriptItem,
  UsageWindow,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { makeSubscriptions } from '../src/app/subscriptions'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Worker from '../src/screens/worker'

// The Worker view (spec §18.4, §18.5, H91): opened from a card on its project, it shows the ticket on
// top with the whole ticket a key away, the figures that move during a turn, the transcript drawn at
// most every 33 ms with a tool call's input withheld until it is whole, and a composer that messages,
// interrupts and releases the worker, and once the worker has finished keeps its text and files it as
// a ticket.

const engine = EngineId.make('e-1')
const auth = ProjectId.make('p-1')
const authHere: EngineProject = { engine: localEngineName, project: auth }
const fa7 = TicketId.make('fa-7')
const worker: Worker.Shown = { project: authHere, ticket: fa7 }

/** Thursday 29 October 2026, 12:00 UTC. */
const at = Date.UTC(2026, 9, 29, 12, 0, 0)

const received = (shown: Model, ...messages: ReadonlyArray<Message>): Model =>
  messages.reduce((before, next) => update(before, next).model, shown)

const workerMessage = (message: Worker.Message): Message =>
  Message.GotWorkerMessage({ message })

const projects = Message.ReceivedProjects({
  engine,
  name: localEngineName,
  items: [
    {
      _tag: 'snapshot',
      epoch: StreamEpoch.make('epoch-1'),
      seq: 0,
      value: [
        new ProjectStatus({
          project: auth,
          name: 'Auth refresh',
          base: 'main',
          setUp: true,
          trusted: true,
          run: ProjectRunState.cases.idle.make({}),
          ready: 0,
        }),
      ],
    },
  ],
})

const decodeRunView = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))

/** The auth project's run: fa-7's worker, 3m 05s in, 42k of a 200k window, the run's 100k tokens spent. */
const runView = decodeRunView({
  header: {
    run: 'r-1',
    project: auth,
    engine,
    mode: { _tag: 'tickets' },
    state: 'running',
    startedAt: at,
    offline: false,
    autoAnswer: false,
  },
  totals: {
    live: 1,
    slots: 4,
    counts: {
      in_queue: 0,
      working: 1,
      waiting_to_merge: 0,
      needs_you: 0,
      set_aside: 0,
      carried_over: 0,
      done: 0,
    },
    doneToday: 0,
    tokens: {
      input: 50_000,
      output: 10_000,
      cache_write: 0,
      cache_read: 40_000,
    },
    costUsd: null,
  },
  tickets: [],
  workers: [
    {
      ticket: fa7,
      session: 's-7',
      model: 'claude-opus-5-5',
      startedAt: at,
      action: null,
      context: { used: 42_000, window: 200_000 },
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

const now = DateTime.makeZonedUnsafe(at + 185_000, { timeZone: 'UTC' })

const usage = [
  new UsageWindow({
    provider: 'anthropic',
    window: 'five_hour',
    utilization: 0.4,
    resetsAt: Option.none(),
  }),
]

/** Connected, the auth project in scope with its run going, the clock ticking. */
const scoped: Model = {
  ...received(
    {
      ...initialModel({ platform: 'darwin', release: '0.0.0' }),
      connection: Connection.Up({
        engine,
        release: '0.1.0',
        protocol: protocolVersion,
      }),
    },
    projects,
    Message.SelectedScope({ project: Option.some(authHere) }),
    Message.ReceivedRunView({
      project: authHere,
      items: [
        {
          _tag: 'snapshot',
          epoch: StreamEpoch.make('epoch-r'),
          seq: 0,
          value: runView,
        },
      ],
    }),
    Message.Ticked({ now }),
  ),
  usage: Option.some(usage),
}

const decodeDetail = Schema.decodeUnknownSync(Schema.toCodecJson(TicketDetail))

const longDescription = `${'The refresh token must be rotated on every use. '.repeat(8)}See https://example.com/rfc6749.`

const detail = decodeDetail({
  ticket: {
    id: fa7,
    type: 'feature',
    title: 'Rotate refresh tokens',
    description: longDescription,
    design: 'Keep the rotation in src/auth/refresh.ts.',
    acceptance: 'A reused token is refused.',
    status: 'in_progress',
    resolution: null,
    priority: 1,
    deferUntil: null,
    assignee: null,
    model: null,
    metadata: {},
    result: null,
    question: null,
    mergedCommit: null,
    closeReason: null,
    createdAt: at,
    updatedAt: at,
  },
  labels: [],
  edges: [
    { from: fa7, to: 'fa-9', kind: 'blocks' },
    { from: 'fa-2', to: fa7, kind: 'parent' },
  ],
  notes: [
    {
      id: 'n-1',
      ticketId: fa7,
      author: { _tag: 'maintainer' },
      body: 'Mind the clock skew.',
      at,
    },
  ],
})

/** fa-7's worker view, opened from its card, its ticket read. */
const opened: Model = received(
  scoped,
  Message.RequestedWorker({ ticket: fa7 }),
  workerMessage(Worker.Message.SucceededLoadTicket({ worker, detail })),
)

const decodeItem = Schema.decodeUnknownSync(Schema.toCodecJson(TranscriptItem))

const snapshot = (...value: ReadonlyArray<unknown>) =>
  decodeItem({ _tag: 'snapshot', epoch: 'epoch-t', seq: 0, value })

const patch = (seq: number, ...value: ReadonlyArray<unknown>) =>
  decodeItem({ _tag: 'patch', seq, value })

const frame = (...items: ReadonlyArray<TranscriptItem>) =>
  Message.ReceivedWorkerTranscript({
    worker,
    items: [items[0] ?? snapshot(), ...items.slice(1)],
  })

const drawn = workerMessage(Worker.Message.CompletedWaitToDraw())

const said = (id: string, text: string) => ({
  _tag: 'message',
  id,
  role: 'assistant',
  text,
  at,
})

const blocksOf = (shown: Model) => shown.screens.worker.transcript.blocks

describe('opening a worker view', () => {
  test("a card's worker opens on the scoped project, its ticket read", () => {
    story(
      update,
      given(scoped),
      message(Message.RequestedWorker({ ticket: fa7 })),
      Command.resolve(
        Worker.LoadTicket({ worker }),
        Worker.Message.SucceededLoadTicket({ worker, detail }),
      ),
      model(shown => {
        expect(shown.screen).toEqual(Screen.Worker(worker))
        expect(shown.screens.worker.shown).toEqual(Option.some(worker))
      }),
    )
  })

  test('another worker starts afresh; the same one keeps its transcript', () => {
    const withText = received(opened, frame(snapshot(said('m-1', 'Hello'))))
    const fa8 = { project: authHere, ticket: TicketId.make('fa-8') }
    expect(
      blocksOf(
        received(
          withText,
          Message.RequestedScreen({ screen: Screen.Worker(worker) }),
        ),
      ),
    ).toHaveLength(1)
    const other = received(
      withText,
      Message.RequestedScreen({ screen: Screen.Console() }),
      Message.RequestedScreen({ screen: Screen.Worker(fa8) }),
    )
    expect(other.screens.worker.shown).toEqual(Option.some(fa8))
    expect(blocksOf(other)).toEqual([])
  })

  test("only the shown worker's transcript is watched, while its engine is connected", () => {
    const { workerTranscript } = makeSubscriptions({
      nextFrame: Effect.void,
      keys: Stream.empty,
      ticks: Stream.empty,
      replacedEnginePorts: Stream.empty,
    })
    expect(workerTranscript.modelToDependencies(scoped)).toEqual({
      worker: Option.none(),
      live: false,
    })
    expect(workerTranscript.modelToDependencies(opened)).toEqual({
      worker: Option.some(worker),
      live: true,
    })
    expect(
      workerTranscript.modelToDependencies({
        ...opened,
        connection: Connection.Connecting(),
      }).live,
    ).toBe(false)
  })
})

describe('the ticket on top', () => {
  test('its ID, type and priority, its title and the start of its description', () => {
    scene(
      { update, view },
      givenScene(opened),
      expectScene(
        within(role('region', { name: 'Ticket' }), text('fa-7')),
      ).toExist(),
      expectScene(
        within(role('region', { name: 'Ticket' }), text('feature')),
      ).toExist(),
      expectScene(
        within(role('region', { name: 'Ticket' }), text('P1')),
      ).toExist(),
      expectScene(role('heading', { name: 'Rotate refresh tokens' })).toExist(),
      expectScene(text(/^The refresh token must be rotated.*…$/u)).toExist(),
      expectScene(role('region', { name: 'Whole ticket' })).toBeAbsent(),
    )
  })

  test('the whole ticket a click or a key away: design, acceptance, notes, links and what it blocks', () => {
    scene(
      { update, view },
      givenScene(opened),
      click(role('button', { name: 'Whole ticket' })),
      expectScene(
        within(
          role('region', { name: 'Whole ticket' }),
          text('Keep the rotation in src/auth/refresh.ts.'),
        ),
      ).toExist(),
      expectScene(text('A reused token is refused.')).toExist(),
      expectScene(text('Mind the clock skew.')).toExist(),
      expectScene(text('fa-7 blocks fa-9')).toExist(),
      expectScene(
        within(role('region', { name: 'Blocks' }), text('fa-9')),
      ).toExist(),
      expectScene(
        role('link', { name: 'https://example.com/rfc6749' }),
      ).toHaveAttr('href', 'https://example.com/rfc6749'),
    )
    const pressed = received(
      opened,
      Message.PressedKey({ key: 't', mod: false, alt: false, inField: false }),
    )
    expect(pressed.screens.worker.wholeTicket).toBe(true)
  })
})

describe('the figures', () => {
  test('its time, its context against the window, and its share of the usage window, an estimate', () => {
    const spent = received(
      opened,
      frame(
        snapshot({
          _tag: 'turn_end',
          at,
          tokens: {
            input: 20_000,
            output: 5_000,
            cache_write: 0,
            cache_read: 0,
          },
        }),
      ),
    )
    scene(
      { update, view },
      givenScene(spent),
      expectScene(
        within(role('complementary', { name: 'Figures' }), text('3m 05s')),
      ).toExist(),
      expectScene(text('42k of 200k · 21%')).toExist(),
      expectScene(text('Usage (estimate)')).toExist(),
      expectScene(text('≈ 10% of Current usage')).toExist(),
    )
  })

  test('move during a turn: the time with the clock, the context with the run view', () => {
    const later = received(
      opened,
      Message.Ticked({
        now: DateTime.makeZonedUnsafe(at + 245_000, { timeZone: 'UTC' }),
      }),
    )
    scene(
      { update, view },
      givenScene(later),
      expectScene(text('4m 05s')).toExist(),
    )
  })
})

describe('the transcript', () => {
  test('streamed text is drawn at once, then at most every 33 ms', () => {
    const commandNames = (result: ReturnType<typeof update>) =>
      (result.commands ?? []).map(command => command.name)
    const first = update(opened, frame(snapshot(said('m-1', 'Running'))))
    expect(blocksOf(first.model)).toMatchObject([
      { _tag: 'said', role: 'assistant', text: 'Running', thinking: '' },
    ])
    expect(commandNames(first)).toEqual(['WaitToDraw'])
    const during = received(
      first.model,
      frame(patch(1, { _tag: 'text', message: 'm-1', delta: ' the' })),
      frame(patch(2, { _tag: 'text', message: 'm-1', delta: ' checks' })),
    )
    expect(blocksOf(during)[0]).toMatchObject({ text: 'Running' })
    expect(during.screens.worker.transcript.waiting).toHaveLength(2)
    const waited = update(during, drawn)
    expect(blocksOf(waited.model)[0]).toMatchObject({
      text: 'Running the checks',
    })
    expect(waited.model.screens.worker.transcript.waiting).toEqual([])
    expect(commandNames(waited)).toEqual(['WaitToDraw'])
    story(
      update,
      given(waited.model),
      message(drawn),
      Command.expectNone(),
      model(shown => {
        expect(shown.screens.worker.transcript.draw).toBe('Idle')
      }),
      message(frame(patch(3, { _tag: 'text', message: 'm-1', delta: '.' }))),
      model(shown => {
        expect(blocksOf(shown)[0]).toMatchObject({
          text: 'Running the checks.',
        })
      }),
      Command.resolve(
        Worker.WaitToDraw(),
        Worker.Message.CompletedWaitToDraw(),
      ),
    )
  })

  it.effect('a draw waits 33 ms, on the injected clock', () =>
    Effect.gen(function* () {
      const waiting = yield* Effect.forkChild(Worker.WaitToDraw().effect)
      yield* TestClock.adjust('32 millis')
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust('1 millis')
      expect(yield* Fiber.join(waiting)).toEqual(
        Worker.Message.CompletedWaitToDraw(),
      )
    }),
  )

  test("a tool call's streamed input is withheld until it is whole", () => {
    const streaming = received(
      opened,
      frame(
        snapshot(said('m-1', 'Running the checks.'), {
          _tag: 'tool_input',
          id: 'call-1',
          tool: 'bash',
          delta: '{"command":"make ch',
        }),
      ),
    )
    expect(blocksOf(streaming)[1]).toMatchObject({
      _tag: 'tool',
      tool: 'bash',
      input: Option.none(),
    })
    scene(
      { update, view },
      givenScene(streaming),
      expectScene(text('bash …')).toExist(),
      expectScene(text('Writing its input…')).toExist(),
      expectScene(role('log', { name: 'Transcript' })).not.toContainText(
        'make ch',
      ),
    )
    const more = received(
      streaming,
      frame(
        patch(1, {
          _tag: 'tool_input',
          id: 'call-1',
          tool: 'bash',
          delta: 'eck"}',
        }),
      ),
      drawn,
    )
    expect(blocksOf(more)[1]).toMatchObject({ input: Option.none() })
    const whole = received(
      more,
      frame(
        patch(2, {
          _tag: 'tool_call',
          id: 'call-1',
          tool: 'bash',
          input: { command: 'make check' },
          at,
        }),
      ),
      drawn,
    )
    expect(blocksOf(whole)).toHaveLength(2)
    scene(
      { update, view },
      givenScene(whole),
      expectScene(text('Writing its input…')).toBeAbsent(),
      expectScene(role('log', { name: 'Transcript' })).toContainText(
        '"command": "make check"',
      ),
    )
  })

  test('thinking collapsed, bare URLs as links, output in a terminal and an edit in the diff view', () => {
    const shown = received(
      opened,
      frame(
        snapshot(
          said('m-1', 'The spec is at https://example.com/spec.'),
          { _tag: 'thinking', message: 'm-1', delta: 'Read the spec first.' },
          {
            _tag: 'tool_call',
            id: 'call-1',
            tool: 'bash',
            input: { command: 'make check' },
            at,
          },
          { _tag: 'tool_output', id: 'call-1', chunk: 'ok 12 tests\n' },
          { _tag: 'tool_end', id: 'call-1', ok: true, at },
          {
            _tag: 'tool_call',
            id: 'call-2',
            tool: 'edit',
            input: {
              path: 'src/auth/refresh.ts',
              edits: [{ oldText: 'const a = 1', newText: 'const a = 2' }],
            },
            at,
          },
        ),
      ),
    )
    scene(
      { update, view },
      givenScene(shown),
      expectScene(
        role('link', { name: 'https://example.com/spec' }),
      ).toHaveAttr('href', 'https://example.com/spec'),
      expectScene(text('Thinking')).toExist(),
      expectScene(role('group')).not.toHaveAttr('open'),
      expectScene(text('bash ✓')).toExist(),
      expectScene(role('log', { name: 'Output of bash' })).toHaveAttr(
        'data-output',
        'ok 12 tests\n',
      ),
      Mount.expectExact(
        Worker.ShowOutput(),
        Worker.ShowChange({
          path: 'src/auth/refresh.ts',
          key: 'call-2',
          original: 'const a = 1',
          modified: 'const a = 2',
        }),
      ),
      Mount.resolveAll(
        [Worker.ShowOutput, Worker.Message.CompletedShowView()],
        [Worker.ShowChange, Worker.Message.CompletedShowView()],
      ),
    )
  })

  test('a watch the engine refuses says why, and the worker is not taken as finished', () => {
    const failed = received(
      opened,
      Message.FailedWorkerTranscript({ worker, reason: 'NotImplemented' }),
    )
    expect(failed.screens.worker.transcript.ended).toBe(false)
    scene(
      { update, view },
      givenScene(failed),
      expectScene(
        text("The transcript couldn't be read: NotImplemented"),
      ).toExist(),
    )
  })
})

describe('the composer', () => {
  test('a message steers the worker until it is released', () => {
    scene(
      { update, view },
      givenScene(opened),
      typeInto(role('textbox', { name: 'Message' }), 'Use the existing clock'),
      submit(role('form', { name: 'Composer' })),
      SceneCommand.resolve(
        Worker.SendToWorker({ worker, text: 'Use the existing clock' }),
        Worker.Message.SucceededSend(),
      ),
      expectScene(role('textbox', { name: 'Message' })).toHaveValue(''),
      expectScene(
        text('Steered: the engine sends it nothing until you release it.'),
      ).toExist(),
      click(role('button', { name: 'Release' })),
      SceneCommand.resolve(
        Worker.ReleaseWorker({ worker }),
        Worker.Message.SucceededRelease(),
      ),
      expectScene(role('button', { name: 'Release' })).toBeAbsent(),
    )
  })

  test('the interrupt key interrupts it, which steers it too', () => {
    story(
      update,
      given(opened),
      message(
        Message.PressedKey({
          key: 'i',
          mod: false,
          alt: false,
          inField: false,
        }),
      ),
      Command.resolve(
        Worker.InterruptWorker({ worker }),
        Worker.Message.SucceededInterrupt(),
      ),
      model(shown => {
        expect(shown.screens.worker.steered).toBe(true)
      }),
    )
  })

  test('once the worker has finished, keeps its text and files it as a ticket', () => {
    const typed = received(
      opened,
      workerMessage(
        Worker.Message.TypedDraft({
          text: 'Cover the clock skew\nThe refresh check ignores skew.',
        }),
      ),
      Message.EndedWorkerTranscript({ worker }),
    )
    scene(
      { update, view },
      givenScene(typed),
      expectScene(role('textbox', { name: 'Message' })).toHaveValue(
        'Cover the clock skew\nThe refresh check ignores skew.',
      ),
      expectScene(role('button', { name: 'Send' })).toBeAbsent(),
      expectScene(role('button', { name: 'Interrupt' })).toBeAbsent(),
      click(role('button', { name: 'File as a ticket' })),
      SceneCommand.resolve(
        Worker.FileTicket({
          project: authHere,
          ticket: {
            title: 'Cover the clock skew',
            description:
              "Cover the clock skew\nThe refresh check ignores skew.\n\nFiled from fa-7's worker view.",
          },
        }),
        Worker.Message.SucceededFileTicket({ ticket: TicketId.make('fa-12') }),
      ),
      expectScene(text('Filed as fa-12.')).toExist(),
      expectScene(role('textbox', { name: 'Message' })).toHaveValue(''),
    )
  })

  test('a finished worker is sent nothing', () => {
    story(
      update,
      given(
        received(
          opened,
          workerMessage(Worker.Message.TypedDraft({ text: 'Stop' })),
          Message.EndedWorkerTranscript({ worker }),
        ),
      ),
      message(workerMessage(Worker.Message.SubmittedDraft())),
      message(workerMessage(Worker.Message.ClickedInterrupt())),
      Command.expectNone(),
      model(shown => {
        expect(shown.screens.worker.composer.draft).toBe('Stop')
      }),
    )
  })
})
