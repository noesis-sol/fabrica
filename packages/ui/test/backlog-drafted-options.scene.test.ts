import { DateTime, Option, Schema } from 'effect'
import {
  Command,
  Mount,
  Subscription,
  expect as expectScene,
  given,
  role,
  scene,
  selector,
} from 'foldkit/scene'

import { describe, test } from '@effect/vitest'
import {
  EngineId,
  ProjectId,
  StreamEpoch,
  Ticket,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'
import * as VirtualList from '@foldkit/ui/virtualList'

import { dayOf } from '../src/app/clock'
import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Backlog from '../src/screens/backlog'

// The Backlog screen's question (spec §15.3): options a talk drafted are marked so there too, and those
// its asker filed are not.

const project = ProjectId.make('p-1')
const scoped: EngineProject = { engine: localEngineName, project }
const at = Date.UTC(2026, 9, 29, 12, 0, 0)
const today = dayOf(DateTime.makeZonedUnsafe(at, { timeZone: 'Europe/Athens' }))
const question = TicketId.make('fa-q1')

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(scoped),
  today: Option.some(today),
}

const asked = Schema.decodeUnknownSync(Schema.toCodecJson(Ticket))({
  id: question,
  type: 'question',
  title: 'Which store?',
  description: null,
  design: null,
  acceptance: null,
  status: 'open',
  resolution: null,
  priority: 2,
  deferUntil: null,
  assignee: null,
  model: null,
  metadata: {},
  result: null,
  question: {
    choices: {
      options: [
        { label: 'SQLite', tradeOff: 'One file' },
        { label: 'Postgres', tradeOff: 'A server to run' },
      ],
      recommended: 0,
    },
    consequential: false,
    maintainerOnly: false,
    answer: null,
  },
  mergedCommit: null,
  closeReason: null,
  createdAt: at,
  updatedAt: at,
})

const shownWith = (
  drafted: ReadonlyArray<TicketId>,
  mark: 'toExist' | 'toBeAbsent',
) =>
  scene(
    { update, view },
    given(
      update(connected, Message.RequestedScreen({ screen: Screen.Backlog() }))
        .model,
    ),
    Subscription.emit(
      Message.ReceivedBacklog({
        project: scoped,
        items: [
          {
            _tag: 'snapshot',
            epoch: StreamEpoch.make('epoch-1'),
            seq: 0,
            value: [asked],
          },
        ],
      }),
    ),
    Command.resolve(
      Backlog.LoadFacts,
      Backlog.Message.SucceededLoadFacts({
        facts: {
          project: scoped,
          ready: [],
          waiting: [],
          edges: [],
          drafted,
          conflicts: [],
        },
      }),
    ),
    Mount.resolve(
      { name: 'ObserveVirtualList', args: { id: 'backlog' } },
      VirtualList.Message.ResizedContainer({
        containerWidth: 600,
        containerHeight: 800,
      }),
    ),
    Mount.resolve(
      Backlog.DrawGraph,
      Backlog.Message.SelectedTicket({ ticket: question }),
    ),
    Command.resolve(Backlog.FocusGraph, Backlog.Message.CompletedFocusGraph()),
    expectScene(role('region', { name: 'Options' })).toContainText('SQLite'),
    mark === 'toExist'
      ? expectScene(selector('[data-drafted]')).toExist()
      : expectScene(selector('[data-drafted]')).toBeAbsent(),
  )

describe('a question on the Backlog screen', () => {
  test('marks options a talk drafted', () => {
    shownWith([question], 'toExist')
  })

  test('leaves options its asker filed unmarked', () => {
    shownWith([], 'toBeAbsent')
  })
})
