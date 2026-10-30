import { DateTime, Option } from 'effect'

import { describe, expect, test } from '@effect/vitest'
import { EngineAddress } from '@fabrica/client'
import {
  AttentionRequest,
  EngineId,
  ProjectId,
  StreamEpoch,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import * as RemoteEngines from '../src/app/remote-engines'
import { update } from '../src/app/update'

// The attention column keeps the requests of the engines its watch follows alone (spec §18.3): an
// engine that fails, stops or is refused has its requests dropped from the column, since none can be
// answered there, and its stream sends them afresh once it is connected again. One reconnecting (Down)
// keeps them.

const box = 'build-box'
const home = ProjectId.make('p-home')
const site = ProjectId.make('p-site')
const siteOnBox: EngineProject = { engine: box, project: site }
const epoch = StreamEpoch.make('epoch-1')
const at = (hour: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 30, hour))

const boxUp = Connection.Up({
  engine: EngineId.make('e-build-box'),
  release: '0.0.0',
  protocol: protocolVersion,
})

/** This machine's engine and the build-box, both connected. */
const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-local'),
    release: '0.0.0',
    protocol: protocolVersion,
  }),
  remotes: RemoteEngines.connected(
    RemoteEngines.added(RemoteEngines.init(), {
      name: box,
      address: EngineAddress.cases.Ssh.make({ destination: 'me@build-box' }),
    }),
    { name: box, hello: boxUp },
  ).model,
}

const received = (model: Model, ...messages: ReadonlyArray<Message>): Model =>
  messages.reduce((shown, next) => update(shown, next).model, model)

const task = (project: ProjectId, ticket: string, hour: number) =>
  AttentionRequest.cases.task.make({
    project,
    ticket: TicketId.make(ticket),
    title: `Task ${ticket}`,
    openedAt: at(hour),
  })

const homeTask = task(home, 'fh-1', 7)
const siteTask = task(site, 'fs-1', 8)
const siteQuestion = AttentionRequest.cases.question.make({
  project: site,
  ticket: TicketId.make('fs-q1'),
  title: 'Which store keeps the sessions?',
  description: Option.none(),
  choices: Option.none(),
  consequential: false,
  maintainerOnly: false,
  blocks: [],
  askedFrom: Option.none(),
  openedAt: at(9),
})

const snapshot = (
  engine: string,
  ...requests: ReadonlyArray<AttentionRequest>
): Message =>
  Message.ReceivedAttention({
    engine,
    items: [{ _tag: 'snapshot', epoch, seq: 0, value: requests }],
  })

/** Both engines' requests, under All projects. */
const both = received(
  connected,
  snapshot(localEngineName, homeTask),
  snapshot(box, siteTask, siteQuestion),
)

const tickets = (model: Model) =>
  Option.map(model.attention, requests =>
    requests.map(request => request.ticket),
  )

const engines = (model: Model) =>
  model.engineAttention.map(entry => entry.engine)

describe("Needs your attention, as an engine's connection is lost", () => {
  test.each([
    [
      'stops connecting',
      Message.StoppedConnectingRemote({
        name: box,
        reason: 'host key changed',
      }),
    ],
    [
      'fails to connect',
      Message.FailedToConnectRemote({ name: box, reason: 'unreachable' }),
    ],
    [
      'is refused',
      Message.RefusedByRemote({
        name: box,
        client: protocolVersion,
        engine: protocolVersion,
        update: 'client',
      }),
    ],
  ])(
    "a known engine that %s has its requests dropped, the others' kept",
    (_, lost) => {
      expect(tickets(both)).toEqual(Option.some(['fh-1', 'fs-1', 'fs-q1']))
      const dropped = received(both, lost)
      expect(tickets(dropped)).toEqual(Option.some(['fh-1']))
      expect(engines(dropped)).toEqual([localEngineName])
      expect(dropped.engineAttention[0]).toBe(both.engineAttention[0])
    },
  )

  test("a lost engine's open questions leave the answer talk's", () => {
    expect(both.console.talkPanel.questions).toEqual([
      { project: siteOnBox, ticket: TicketId.make('fs-q1') },
    ])
    const dropped = received(
      both,
      Message.StoppedConnectingRemote({
        name: box,
        reason: 'host key changed',
      }),
    )
    expect(dropped.console.talkPanel.questions).toEqual([])
  })

  test('a known engine reconnecting keeps its requests', () => {
    const down = received(both, Message.LostRemote({ name: box }))
    expect(down).toMatchObject({ engineAttention: both.engineAttention })
    expect(tickets(down)).toEqual(tickets(both))
  })

  test("this machine's engine failing has its requests dropped, the build-box's kept", () => {
    const failed = received(
      both,
      Message.LostEngine(),
      Message.FailedToConnect({ reason: 'the client stopped reconnecting' }),
    )
    expect(tickets(failed)).toEqual(Option.some(['fs-1', 'fs-q1']))
    expect(engines(failed)).toEqual([box])
  })

  test('every engine lost, the column has nothing to show until a snapshot comes', () => {
    const gone = received(
      both,
      Message.StoppedConnecting({ reason: 'ssh refused' }),
      Message.StoppedConnectingRemote({
        name: box,
        reason: 'host key changed',
      }),
    )
    expect(gone.attention).toEqual(Option.none())
    expect(gone.engineAttention).toEqual([])
  })

  test("an engine connected again shows its stream's fresh requests", () => {
    const back = received(
      both,
      Message.StoppedConnectingRemote({
        name: box,
        reason: 'host key changed',
      }),
      Message.ConnectedToRemote({
        name: box,
        engine: boxUp.engine,
        release: boxUp.release,
        protocol: boxUp.protocol,
      }),
      snapshot(box, siteTask),
    )
    expect(tickets(back)).toEqual(Option.some(['fh-1', 'fs-1']))
    expect(engines(back)).toEqual([localEngineName, box])
  })

  test("a project's scope on a stopped engine shows none of its requests", () => {
    const scoped = received(
      connected,
      Message.SelectedScope({ project: Option.some(siteOnBox) }),
      snapshot(box, siteTask),
      Message.StoppedConnectingRemote({
        name: box,
        reason: 'host key changed',
      }),
    )
    expect(scoped.attention).toEqual(Option.none())
    expect(scoped.engineAttention).toEqual([])
  })
})
