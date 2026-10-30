import { Effect, Layer, Option, Stream } from 'effect'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { SocketServer } from 'effect/socket'
import {
  Command as SceneCommand,
  all,
  click,
  expectAll,
  expect as expectScene,
  given as givenScene,
  role,
  scene,
  selector,
  within,
} from 'foldkit/scene'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, it, test } from '@effect/vitest'
import { portServer, webPortEnd } from '@fabrica/client'
import {
  EngineHello,
  EngineId,
  EngineRpcs,
  ProjectId,
  ProjectRpcs,
  ProjectRunState,
  ProjectStatus,
  type ProjectStatusItem,
  RunId,
  StreamEpoch,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, connect, localEngineName } from '../src/app/connection'
import { projectMessages } from '../src/app/features/sidebar/sidebar'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { clientName } from '../src/app/program'
import { Screen } from '../src/app/screen'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import { chipOf, projectChip, rows } from '../src/console/sidebar'
import * as Engines from '../src/screens/engines'

// The console's sidebar (spec §18.3, H43; Appendix A.2), drawn from fixture project rows on two
// engines: the rows with their chips, Base and engine names and run states, the selected row's style,
// the scope Message a row sends, and "+ Add project" opening the engines screen.

const local = EngineId.make('e-local')
const server = EngineId.make('e-server')

const fabrica = ProjectId.make('p-fabrica')
const tutti = ProjectId.make('p-tutti')
const site = ProjectId.make('p-site')

/** The projects, each named with the engine holding it. */
const tuttiHere = { engine: localEngineName, project: tutti }
const siteOnServer = { engine: 'server-1', project: site }

const status = (
  project: ProjectId,
  name: string,
  base: string,
  run: ProjectRunState,
): ProjectStatus =>
  new ProjectStatus({
    project,
    name,
    base,
    setUp: true,
    trusted: false,
    run,
    ready: 0,
  })

const idle = ProjectRunState.cases.idle.make({})
const running = (overnight: boolean) =>
  ProjectRunState.cases.running.make({ run: RunId.make('r-1'), overnight })
const waiting = ProjectRunState.cases.waiting.make({
  run: RunId.make('r-2'),
  overnight: false,
  needsYou: 2,
})

const snapshot = (
  value: ReadonlyArray<ProjectStatus>,
): readonly [ProjectStatusItem] => [
  { _tag: 'snapshot', epoch: StreamEpoch.make('epoch-1'), seq: 0, value },
]

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: local,
    release: '0.1.0',
    protocol: protocolVersion,
  }),
}

const receivedLocal = Message.ReceivedProjects({
  engine: local,
  name: 'local',
  items: snapshot([
    status(fabrica, 'fabrica', 'main', running(false)),
    status(tutti, 'tutti', 'trunk', waiting),
  ]),
})

const receivedServer = Message.ReceivedProjects({
  engine: server,
  name: 'server-1',
  items: snapshot([status(site, 'site', 'main', running(true))]),
})

/** `messages` applied to `from`, as the runtime would. */
const after = (from: Model, ...messages: ReadonlyArray<Message>): Model =>
  messages.reduce((shown, received) => update(shown, received).model, from)

const oneEngine = after(connected, receivedLocal)
const twoEngines = after(oneEngine, receivedServer)

const rowOf = (project: string) => selector(`[data-project="${project}"]`)
const sidebar = role('navigation', { name: 'Projects' })

describe('the rows', () => {
  test('one row per project on every known engine, in order, after All projects', () => {
    scene(
      { update, view },
      givenScene(twoEngines),
      expectScene(
        within(sidebar, role('heading', { name: 'Projects' })),
      ).toExist(),
      expectScene(selector('[data-count="projects"]')).toHaveText('3'),
      expectAll(all.selector('button[data-project]')).toHaveCount(4),
      expectScene(rowOf('all')).toContainText('All projects'),
      expectScene(rowOf(fabrica)).toContainText('01'),
      expectScene(rowOf(tutti)).toContainText('02'),
      expectScene(rowOf(site)).toContainText('03'),
    )
    expect(rows(twoEngines.console.sidebar).map(row => row.index)).toEqual([
      1, 2, 3,
    ])
  })

  test('with two engines known, each Base carries its engine name', () => {
    scene(
      { update, view },
      givenScene(twoEngines),
      expectScene(rowOf(fabrica)).toContainText('main · local'),
      expectScene(rowOf(tutti)).toContainText('trunk · local'),
      expectScene(rowOf(site)).toContainText('main · server-1'),
      expectScene(
        role('button', { name: 'site, main · server-1, Running, overnight' }),
      ).toExist(),
    )
  })

  test('with one engine known, the Base stands alone', () => {
    scene(
      { update, view },
      givenScene(oneEngine),
      expectScene(selector('[data-count="projects"]')).toHaveText('2'),
      expectScene(role('button', { name: 'fabrica, main, Running' })).toExist(),
      expectScene(role('button', { name: 'tutti, trunk, Waiting' })).toExist(),
    )
  })

  test('chips take the five role colours in turn, by index, holding two digits', () => {
    scene(
      { update, view },
      givenScene(twoEngines),
      expectScene(within(rowOf(fabrica), selector('[data-chip]'))).toHaveClass(
        'bg-c1',
      ),
      expectScene(within(rowOf(tutti), selector('[data-chip]'))).toHaveClass(
        'bg-c2',
      ),
      expectScene(within(rowOf(site), selector('[data-chip]'))).toHaveClass(
        'bg-c3',
      ),
    )
    expect([1, 5, 6, 12].map(chipOf)).toEqual([
      { role: 'c1', label: '01' },
      { role: 'c5', label: '05' },
      { role: 'c1', label: '06' },
      { role: 'c2', label: '12' },
    ])
    expect(projectChip(twoEngines.console.sidebar, siteOnServer)).toEqual(
      Option.some({ role: 'c3', label: '03' }),
    )
  })

  test("each run's state is a word in its colour: Running c1, Waiting c2, Idle none", () => {
    const withIdle = after(
      twoEngines,
      Message.ReceivedProjects({
        engine: server,
        name: 'server-1',
        items: [
          {
            _tag: 'patch',
            seq: 1,
            value: {
              upsert: [status(site, 'site', 'main', idle)],
              remove: [],
            },
          },
        ],
      }),
    )
    scene(
      { update, view },
      givenScene(withIdle),
      expectScene(
        within(rowOf(fabrica), selector('[data-run-state]')),
      ).toHaveText('Running'),
      expectScene(
        within(rowOf(fabrica), selector('[data-run-state]')),
      ).toHaveClass('text-c1'),
      expectScene(
        within(rowOf(tutti), selector('[data-run-state]')),
      ).toHaveText('Waiting'),
      expectScene(
        within(rowOf(tutti), selector('[data-run-state]')),
      ).toHaveClass('text-c2'),
      expectScene(within(rowOf(site), selector('[data-run-state]'))).toHaveText(
        'Idle',
      ),
      expectScene(
        within(rowOf(site), selector('[data-run-state]')),
      ).not.toHaveClass('text-c1'),
      expectScene(
        within(rowOf(site), selector('[data-run-state]')),
      ).not.toHaveClass('text-c2'),
    )
  })

  test('an overnight run carries a c5 "overnight" tag on its row', () => {
    scene(
      { update, view },
      givenScene(twoEngines),
      expectScene(within(rowOf(site), selector('[data-tag]'))).toHaveText(
        'overnight',
      ),
      expectScene(within(rowOf(site), selector('[data-tag]'))).toHaveClass(
        'text-c5',
      ),
      expectScene(within(rowOf(fabrica), selector('[data-tag]'))).toBeAbsent(),
    )
  })

  test("a patch changes an engine's rows and leaves the other engine's as they were", () => {
    story(
      update,
      given(twoEngines),
      message(
        Message.ReceivedProjects({
          engine: local,
          name: 'local',
          items: [
            {
              _tag: 'patch',
              seq: 1,
              value: { upsert: [], remove: [tutti] },
            },
          ],
        }),
      ),
      model(shown => {
        const [before] = twoEngines.console.sidebar.engines
        const [localRows, serverRows] = shown.console.sidebar.engines
        expect(
          rows(shown.console.sidebar).map(row => row.status.project),
        ).toEqual([fabrica, site])
        expect(localRows?.projects).not.toBe(before?.projects)
        expect(serverRows).toBe(twoEngines.console.sidebar.engines[1])
      }),
    )
  })

  test('a released engine leaves no rows behind', () => {
    story(
      update,
      given(twoEngines),
      message(Message.ReleasedEngine()),
      model(shown => {
        expect(rows(shown.console.sidebar)).toEqual([])
      }),
    )
  })
})

describe('selection', () => {
  test('All projects is selected at first; a selected row has the panel background, the c1 bar and aria-current', () => {
    scene(
      { update, view },
      givenScene(twoEngines),
      expectScene(rowOf('all')).toHaveAttr('aria-current', 'true'),
      expectScene(rowOf('all')).toHaveClass('bg-panel'),
      expectScene(rowOf('all')).toHaveClass('border-c1'),
      expectScene(rowOf(site)).not.toHaveAttr('aria-current', 'true'),
      expectScene(rowOf(site)).toHaveClass('border-transparent'),
      click(
        role('button', { name: 'site, main · server-1, Running, overnight' }),
      ),
      expectScene(rowOf(site)).toHaveAttr('aria-current', 'true'),
      expectScene(rowOf(site)).toHaveClass('bg-panel'),
      expectScene(rowOf(site)).toHaveClass('border-c1'),
      expectScene(rowOf('all')).not.toHaveAttr('aria-current', 'true'),
      expectScene(rowOf('all')).toHaveClass('border-transparent'),
      click(role('button', { name: 'All projects' })),
      expectScene(rowOf('all')).toHaveAttr('aria-current', 'true'),
    )
  })

  test("a row's click sends the scope Message, which scopes the main area to its project", () => {
    scene(
      { update, view },
      givenScene(twoEngines),
      click(rowOf(tutti)),
      expectScene(rowOf(tutti)).toHaveAttr('aria-current', 'true'),
    )
    story(
      update,
      given(twoEngines),
      message(Message.SelectedScope({ project: Option.some(tuttiHere) })),
      model(shown => {
        expect(shown.scope).toEqual(Option.some(tuttiHere))
      }),
      message(Message.SelectedScope({ project: Option.none() })),
      model(shown => {
        expect(shown.scope).toEqual(Option.none())
      }),
    )
  })

  test("selecting the scope already chosen keeps the Model, so its streams' values stay", () => {
    const scoped = after(
      twoEngines,
      Message.SelectedScope({ project: Option.some(siteOnServer) }),
    )
    expect(
      update(
        scoped,
        Message.SelectedScope({ project: Option.some(siteOnServer) }),
      ).model,
    ).toBe(scoped)
  })
})

describe('+ Add project', () => {
  /** What the Engines screen asks as it opens, answered. */
  const engineScreenAnswers = [
    [
      Engines.LoadEngineStatus,
      Engines.Message.FailedLoadStatus({
        engine: localEngineName,
        reason: 'not this test’s',
      }),
    ],
    [
      Engines.LoadCredentials,
      Engines.Message.FailedLoadCredentials({
        engine: localEngineName,
        reason: 'not this test’s',
      }),
    ],
  ] as const

  test('is pinned at the bottom and opens the engines screen', () => {
    scene(
      { update, view },
      givenScene(twoEngines),
      expectScene(
        within(sidebar, role('button', { name: 'Add project' })),
      ).toHaveClass('bg-c1'),
      click(role('button', { name: 'Add project' })),
      expectScene(
        role('heading', { name: 'Engines and projects', level: 1 }),
      ).toExist(),
      expectScene(role('form', { name: 'Add project' })).toExist(),
      SceneCommand.resolveAll(...engineScreenAnswers),
    )
    story(
      update,
      given(twoEngines),
      message(Message.RequestedAddProject()),
      model(shown => {
        expect(shown.screen).toEqual(Screen.Engines())
      }),
      Command.resolveAll(...engineScreenAnswers),
    )
  })
})

// A test engine on the far end of a MessageChannel, as the connection process relays it: it says
// hello and sends its project rows, a snapshot then a patch.

const served = EngineRpcs.merge(ProjectRpcs)

const notServed = () => Effect.die('not served')

const projectItems: ReadonlyArray<ProjectStatusItem> = [
  ...snapshot([status(fabrica, 'fabrica', 'main', idle)]),
  {
    _tag: 'patch',
    seq: 1,
    value: {
      upsert: [status(fabrica, 'fabrica', 'main', running(false))],
      remove: [],
    },
  },
]

const handlers = served.toLayer({
  'engine.connect': () =>
    Effect.succeed(
      new EngineHello({
        protocol: protocolVersion,
        engine: local,
        release: '0.1.0',
      }),
    ),
  'engine.version': notServed,
  'engine.status': notServed,
  'engine.settings': notServed,
  'engine.stop': notServed,
  'engine.update': notServed,
  'engine.watchStatus': () => Stream.die('not served'),
  'engine.watchLoad': () => Stream.die('not served'),
  'projects.add': notServed,
  'projects.folders': notServed,
  'projects.list': notServed,
  'projects.remove': notServed,
  'projects.trust': notServed,
  'projects.settings.get': notServed,
  'projects.settings.set': notServed,
  'projects.init': notServed,
  'projects.watchStatus': () => Stream.fromIterable(projectItems),
  'projects.watchUsage': () => Stream.never,
})

describe("the engine's project rows", () => {
  it.live("become the sidebar's rows, under the connected engine", () =>
    Effect.gen(function* () {
      const channel = new MessageChannel()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          channel.port1.close()
          channel.port2.close()
        }),
      )
      const server = portServer(webPortEnd(channel.port2))
      yield* Layer.build(
        RpcServer.layer(served).pipe(
          Layer.provide(handlers),
          Layer.provide(RpcServer.layerProtocolSocketServer),
          Layer.provide(RpcSerialization.layerNdjson),
          Layer.provide(Layer.succeed(SocketServer.SocketServer, server)),
        ),
      )

      const session = yield* connect({
        enginePort: Effect.succeed(channel.port1),
        client: { name: clientName, kind: 'app', release: '0.0.0' },
      })
      const messages = yield* Stream.runCollect(
        projectMessages(session, localEngineName, Effect.void),
      )
      const shown = after(connected, ...messages)
      const [engine] = shown.console.sidebar.engines
      expect(engine?.engine).toBe(local)
      expect(engine?.name).toBe(localEngineName)
      expect(
        rows(shown.console.sidebar).map(row => [
          row.status.name,
          row.status.run._tag,
        ]),
      ).toEqual([['fabrica', 'running']])
    }),
  )
})
