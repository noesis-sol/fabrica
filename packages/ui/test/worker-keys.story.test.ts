import { Option, Schema } from 'effect'
import {
  Command as SceneCommand,
  click,
  expect as expectScene,
  given as givenScene,
  role,
  scene,
} from 'foldkit/scene'
import { Command, given, message, story } from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import {
  EngineId,
  ProjectId,
  ProjectRunState,
  ProjectStatus,
  RunView,
  StreamEpoch,
  TicketDetail,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { modelCommands } from '../src/app/features/keys/keys'
import { paletteEntries } from '../src/app/features/palette/palette'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Worker from '../src/screens/worker'

// The Worker view's keys (spec §18.4, §18.5): the whole ticket, interrupting the worker and releasing
// it are each in the screen's one command list only while the view offers its button enabled, so the
// header's hints, the key help and the palette show them then, and a key acts only where its button
// would: Release only while the worker is steered, Interrupt and Release only until it has finished
// and while its engine is connected.

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

const key = (pressed: string) =>
  Message.PressedKey({
    key: pressed,
    mod: false,
    alt: false,
    inField: false,
    repeat: false,
  })

const decodeRunView = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))

/** The auth project's run, fa-7's worker in it, steered or not as its row says. */
const runView = (steered: boolean) =>
  decodeRunView({
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
      tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
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
        tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
        steered,
      },
    ],
    queue: { merging: null, train: null, waiting: [] },
    holds: [],
    banners: [],
    attention: [],
    load: null,
    steps: [],
  })

const receivedRunView = (steered: boolean) =>
  Message.ReceivedRunView({
    project: authHere,
    items: [
      {
        _tag: 'snapshot',
        epoch: StreamEpoch.make('epoch-r'),
        seq: 0,
        value: runView(steered),
      },
    ],
  })

const detail = Schema.decodeUnknownSync(Schema.toCodecJson(TicketDetail))({
  ticket: {
    id: fa7,
    type: 'feature',
    title: 'Rotate refresh tokens',
    description: 'The refresh token must be rotated on every use.',
    design: null,
    acceptance: null,
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
  edges: [],
  notes: [],
})

/** Connected, the auth project in scope with its run going, fa-7's worker view open on its card. */
const requested: Model = received(
  {
    ...initialModel({ platform: 'darwin', release: '0.0.0' }),
    connection: Connection.Up({
      engine,
      release: '0.1.0',
      protocol: protocolVersion,
    }),
  },
  Message.ReceivedProjects({
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
  }),
  Message.SelectedScope({ project: Option.some(authHere) }),
  receivedRunView(false),
  Message.RequestedWorker({ project: authHere, ticket: fa7 }),
)

/** The same, its ticket read. */
const opened: Model = received(
  requested,
  workerMessage(Worker.Message.SucceededLoadTicket({ worker, detail })),
)

/** Steered from here: interrupted. */
const steered: Model = received(
  opened,
  workerMessage(Worker.Message.SucceededInterrupt()),
)

const offline = (shown: Model): Model => ({
  ...shown,
  connection: Connection.Failed({ reason: 'ECONNREFUSED' }),
})

const finished = (shown: Model): Model =>
  received(shown, Message.EndedWorkerTranscript({ worker }))

const workerIds = ['worker.ticket', 'worker.interrupt', 'worker.release']

/** The worker commands of the model's list. */
const workerCommands = (shown: Model) =>
  modelCommands(shown)
    .map(command => command.id)
    .filter(id => workerIds.includes(id))

/** The worker commands the palette runs. */
const paletteWorkerCommands = (shown: Model) =>
  paletteEntries(shown)
    .map(entry => entry.id)
    .filter(id => workerIds.includes(id))

describe('the worker keys apply only while their buttons do', () => {
  test('not steered: the whole ticket and Interrupt, no Release', () => {
    expect(workerCommands(opened)).toEqual([
      'worker.ticket',
      'worker.interrupt',
    ])
    expect(paletteWorkerCommands(opened)).toEqual([
      'worker.ticket',
      'worker.interrupt',
    ])
  })

  test('the ticket not read yet: no key for the whole ticket', () => {
    expect(workerCommands(requested)).toEqual(['worker.interrupt'])
  })

  test('R sends no release to a worker that is not steered', () => {
    story(update, given(opened), message(key('r')), Command.expectNone())
  })

  test('steered from here: R releases it, as its button does', () => {
    expect(workerCommands(steered)).toEqual([
      'worker.ticket',
      'worker.interrupt',
      'worker.release',
    ])
    story(
      update,
      given(steered),
      message(key('r')),
      Command.expectExact(Worker.ReleaseWorker({ worker })),
      Command.resolve(
        Worker.ReleaseWorker({ worker }),
        Worker.Message.SucceededRelease(),
      ),
    )
  })

  test('steered as its run view says: Release is offered', () => {
    expect(workerCommands(received(opened, receivedRunView(true)))).toEqual([
      'worker.ticket',
      'worker.interrupt',
      'worker.release',
    ])
  })

  test('the engine offline: I and R send nothing, their buttons disabled', () => {
    expect(workerCommands(offline(steered))).toEqual(['worker.ticket'])
    expect(paletteWorkerCommands(offline(steered))).toEqual(['worker.ticket'])
    story(
      update,
      given(offline(steered)),
      message(key('i')),
      message(key('r')),
      Command.expectNone(),
    )
    scene(
      { update, view },
      givenScene(offline(steered)),
      expectScene(role('button', { name: 'Interrupt' })).toBeDisabled(),
      expectScene(role('button', { name: 'Release' })).toBeDisabled(),
    )
  })

  test('a request going: neither is offered until it is answered', () => {
    const going = received(steered, key('i'))
    expect(workerCommands(going)).toEqual(['worker.ticket'])
  })

  test('finished: neither is offered', () => {
    expect(workerCommands(finished(steered))).toEqual(['worker.ticket'])
  })

  test("the header's hints are the offered keys, each its command's click", () => {
    scene(
      { update, view },
      givenScene(opened),
      expectScene(role('button', { name: /Release the worker/u })).toBeAbsent(),
      click(role('button', { name: /Interrupt the worker/u })),
      expectScene(role('button', { name: 'Interrupt' })).toBeDisabled(),
      SceneCommand.resolve(
        Worker.InterruptWorker({ worker }),
        Worker.Message.SucceededInterrupt(),
      ),
      expectScene(role('button', { name: /Release the worker/u })).toExist(),
    )
  })
})
