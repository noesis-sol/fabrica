import { DateTime, Option, Schema } from 'effect'
import {
  Command,
  click,
  expect as expectScene,
  given,
  role,
  scene,
  selector,
  within,
} from 'foldkit/scene'

import { describe, test } from '@effect/vitest'
import {
  AttentionRequest,
  EngineId,
  ProjectId,
  RunView,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { type Model, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Attention from '../src/console/attention'

// What the answer talk's work shows in the console (spec §15.3): options a talk drafted are marked so on
// the question's card, and a run with nothing ready but questions says it waits on the answers.

const project = ProjectId.make('p-1')
const scoped: EngineProject = { engine: localEngineName, project }
const at = Date.UTC(2026, 9, 29, 12, 0, 0)

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(scoped),
  now: Option.some(DateTime.makeZonedUnsafe(at, { timeZone: 'Europe/Athens' })),
}

const decodeRequest = Schema.decodeUnknownSync(
  Schema.toCodecJson(AttentionRequest),
)

const question = (ticket: string, drafted: boolean) =>
  decodeRequest({
    _tag: 'question',
    project,
    ticket,
    title: 'Which store keeps the sessions?',
    description: null,
    choices: {
      options: [
        { label: 'Redis', tradeOff: 'Fast; another service to run' },
        { label: 'Postgres', tradeOff: 'Already running; slower' },
      ],
      recommended: 1,
    },
    drafted,
    consequential: false,
    maintainerOnly: false,
    blocks: ['fa-7'],
    askedFrom: null,
    openedAt: at,
  })

const withRequests = (requests: ReadonlyArray<AttentionRequest>): Model => ({
  ...connected,
  attention: Option.some(requests),
  engineAttention: [{ engine: localEngineName, requests }],
})

const decodeRunView = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))

const asking = decodeRunView({
  header: {
    run: 'r-1',
    project,
    engine: 'e-1',
    mode: { _tag: 'tickets' },
    state: 'asking',
    startedAt: at,
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
      needs_you: 1,
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

/** The question's card, its options open. */
const opened = (ticket: string, drafted: boolean, expected: boolean) =>
  scene(
    { update, view },
    given(withRequests([question(ticket, drafted)])),
    click(
      within(
        role('listitem', { name: `Question ${ticket}` }),
        role('button', { name: 'Answer' }),
      ),
    ),
    Command.resolve(
      Attention.WaitGuard({ drawing: 1 }),
      Attention.Message.PassedGuard({ drawing: 1 }),
    ),
    expected
      ? expectScene(selector('[data-drafted]')).toExist()
      : expectScene(selector('[data-drafted]')).toBeAbsent(),
  )

describe('the answer talk in the console', () => {
  test('marks options a talk drafted', () => {
    opened('fa-q1', true, true)
  })

  test('leaves options their asker filed unmarked', () => {
    opened('fa-q2', false, false)
  })

  test('says a run with nothing ready but questions waits on the answers', () => {
    scene(
      { update, view },
      given({ ...connected, runView: Option.some(asking) }),
      expectScene(selector('[data-run-state="asking"]')).toHaveText(
        'Waiting on your answers',
      ),
    )
  })
})
