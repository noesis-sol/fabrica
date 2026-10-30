import { DateTime, Effect, Option, Stream } from 'effect'
import { expect as expectScene, given, role, scene } from 'foldkit/scene'

import { describe, expect, test } from '@effect/vitest'
import { EngineAddress } from '@fabrica/client'
import {
  AttentionClosed,
  AttentionRef,
  AttentionRequest,
  EngineId,
  ProjectId,
  ProjectRunState,
  ProjectStatus,
  StreamEpoch,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import * as RemoteEngines from '../src/app/remote-engines'
import type { AttentionItem } from '../src/app/streams'
import { makeSubscriptions } from '../src/app/subscriptions'
import { update } from '../src/app/update'
import { view } from '../src/app/view'

// The attention column under All projects (spec §18.3): every connected engine's requests, each
// engine's kept apart in the Model and joined in the column oldest first; a project's own scope shows
// its engine's requests alone.

const box = 'build-box'
const home = ProjectId.make('p-home')
const site = ProjectId.make('p-site')
const epoch = StreamEpoch.make('epoch-1')
const at = (hour: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 30, hour))

const status = (project: ProjectId, name: string) =>
  new ProjectStatus({
    project,
    name,
    base: 'main',
    setUp: true,
    trusted: false,
    run: ProjectRunState.cases.idle.make({}),
    ready: 0,
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
    {
      name: box,
      hello: Connection.Up({
        engine: EngineId.make('e-build-box'),
        release: '0.0.0',
        protocol: protocolVersion,
      }),
    },
  ).model,
}

const received = (model: Model, ...messages: ReadonlyArray<Message>): Model =>
  messages.reduce((shown, next) => update(shown, next).model, model)

/** Both engines' rows: this machine's `home`, and the build-box's `site`. */
const withRows = received(
  connected,
  Message.ReceivedProjects({
    engine: EngineId.make('e-local'),
    name: localEngineName,
    items: [{ _tag: 'snapshot', epoch, seq: 0, value: [status(home, 'home')] }],
  }),
  Message.ReceivedProjects({
    engine: EngineId.make('e-build-box'),
    name: box,
    items: [{ _tag: 'snapshot', epoch, seq: 0, value: [status(site, 'site')] }],
  }),
)

const task = (project: ProjectId, ticket: string, hour: number) =>
  AttentionRequest.cases.task.make({
    project,
    ticket: TicketId.make(ticket),
    title: `Task ${ticket}`,
    openedAt: at(hour),
  })

const homeEarly = task(home, 'fh-1', 7)
const homeLate = task(home, 'fh-2', 10)
const siteMiddle = task(site, 'fs-1', 8)

const snapshot = (
  engine: string,
  ...requests: ReadonlyArray<AttentionRequest>
): Message =>
  Message.ReceivedAttention({
    engine,
    items: [{ _tag: 'snapshot', epoch, seq: 0, value: requests }],
  })

const patch = (
  engine: string,
  value: (typeof AttentionItem.Type & { readonly _tag: 'patch' })['value'],
): Message =>
  Message.ReceivedAttention({
    engine,
    items: [{ _tag: 'patch', seq: 1, value }],
  })

const tickets = (model: Model) =>
  Option.map(model.attention, requests =>
    requests.map(request => request.ticket),
  )

describe('Needs your attention from every engine', () => {
  test("under All projects, every engine's requests joined oldest first", () => {
    const both = received(
      withRows,
      snapshot(localEngineName, homeEarly, homeLate),
      snapshot(box, siteMiddle),
    )
    expect(tickets(both)).toEqual(Option.some(['fh-1', 'fs-1', 'fh-2']))
    expect(both.engineAttention).toEqual([
      { engine: localEngineName, requests: [homeEarly, homeLate] },
      { engine: box, requests: [siteMiddle] },
    ])
    scene(
      { update, view },
      given(both),
      expectScene(role('listitem', { name: 'Your task fh-1' })).toExist(),
      expectScene(role('listitem', { name: 'Your task fs-1' })).toExist(),
      expectScene(role('listitem', { name: 'Your task fh-2' })).toExist(),
    )
  })

  test("an engine's patch changes its own requests, the other engine's kept", () => {
    const both = received(
      withRows,
      snapshot(localEngineName, homeEarly),
      snapshot(box, siteMiddle),
    )
    const patched = received(
      both,
      patch(localEngineName, {
        upsert: [homeLate],
        remove: [
          new AttentionClosed({
            ref: AttentionRef.cases.task.make({
              project: home,
              ticket: TicketId.make('fh-1'),
            }),
            by: Option.none(),
            at: at(11),
          }),
        ],
      }),
    )
    expect(tickets(patched)).toEqual(Option.some(['fs-1', 'fh-2']))
    expect(patched.engineAttention[1]).toBe(both.engineAttention[1])
  })

  test("a patch before an engine's first snapshot shows nothing of it", () => {
    const early = received(
      withRows,
      snapshot(localEngineName, homeLate),
      patch(box, { upsert: [siteMiddle], remove: [] }),
    )
    expect(tickets(early)).toEqual(Option.some(['fh-2']))
    expect(early.engineAttention.map(entry => entry.engine)).toEqual([
      localEngineName,
    ])
  })

  test("a project's own scope shows its engine's requests alone", () => {
    const scoped = received(
      withRows,
      Message.SelectedScope({ project: Option.some(site) }),
      snapshot(box, siteMiddle),
      // This machine's stream of All projects, sending after the scope changed.
      snapshot(localEngineName, homeEarly),
    )
    expect(tickets(scoped)).toEqual(Option.some(['fs-1']))
    expect(scoped.engineAttention.map(entry => entry.engine)).toEqual([box])
  })

  test("choosing a scope clears every engine's requests until its stream sends them", () => {
    const scoped = received(
      withRows,
      snapshot(localEngineName, homeEarly),
      snapshot(box, siteMiddle),
      Message.SelectedScope({ project: Option.some(home) }),
    )
    expect(scoped.attention).toEqual(Option.none())
    expect(scoped.engineAttention).toEqual([])
  })
})

const { attention: attentionWatch } = makeSubscriptions({
  nextFrame: Effect.void,
  keys: Stream.empty,
  ticks: Stream.empty,
  replacedEnginePorts: Stream.empty,
})

const watched = (model: Model) => attentionWatch.modelToDependencies(model)

describe("The attention column's watch", () => {
  test('under All projects, every connected engine, of every project', () => {
    expect(watched(withRows)).toEqual({
      engines: [localEngineName, box],
      project: Option.none(),
    })
  })

  test('an engine no longer connected is left out', () => {
    expect(
      watched({
        ...withRows,
        connection: Connection.Stopped({ reason: 'gone' }),
      }).engines,
    ).toEqual([box])
  })

  test("a project's scope, its own engine alone", () => {
    expect(watched({ ...withRows, scope: Option.some(site) })).toEqual({
      engines: [box],
      project: Option.some(site),
    })
    expect(watched({ ...withRows, scope: Option.some(home) })).toEqual({
      engines: [localEngineName],
      project: Option.some(home),
    })
  })
})
