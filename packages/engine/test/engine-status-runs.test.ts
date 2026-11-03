import { Effect, Fiber, Layer, Option, Queue, Stream } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeSocket } from '@effect/platform-node'
import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  EngineHost,
  FabricaRpcs,
  type NewTicket,
  type ProjectId,
  ProjectSource,
  type RunEvent,
  type RunFlags,
  RunMode,
} from '@fabrica/contracts'

import { pathsIn, startEngine } from '../src/engine'
import {
  type ScriptedPlaces,
  engineGit,
  makeCheckout,
  makeScriptedPlaces,
  scriptedHosting,
  scriptedSettings,
} from './scripted-run'

// The engine's status counts what it hosts (spec §7.3, §8.1): a test engine, on a scripted agent, says
// how many runs go and how many workers are live across them, on the one Runs service its Runs and
// Workers groups serve; a run that has ended is no longer counted, and a ticket past its work takes no
// slot, so it isn't a live worker.

let places: ScriptedPlaces

beforeAll(() => {
  places = makeScriptedPlaces()
})

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test-host',
  cores: 4,
})

/** A test engine on the scripted agent, and a protocol client on its local socket. */
const newEngine = Effect.gen(function* () {
  const data = yield* Effect.promise(() =>
    mkdtemp(NodePath.join(places.root, 'e')),
  )
  const paths = pathsIn({ data, socketFolder: data })
  yield* startEngine({
    paths,
    host,
    release: '1.2.3',
    git: engineGit(places),
    runs: scriptedHosting(places, paths.data),
  })
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide([
        NodeSocket.layerNet({ path: paths.socket }),
        RpcSerialization.layerNdjson,
      ]),
    ),
  )
  return yield* RpcClient.make(FabricaRpcs).pipe(Effect.provide(protocol))
})

type Client = Effect.Success<typeof newEngine>

/** A project of the engine on a new checkout, with `settings`. */
const addProject = (client: Client, name: string, settings: object) =>
  Effect.map(
    client['projects.add']({
      source: ProjectSource.cases.path.make({
        path: makeCheckout(places, settings),
      }),
      name: Option.some(name),
    }),
    added => added.id,
  )

/** A task whose stub does `script`, filed through the engine. */
const file = (
  client: Client,
  project: ProjectId,
  title: string,
  script: string,
) =>
  client['tickets.create']({
    project,
    ticket: {
      type: 'task',
      title,
      description: Option.some(`stub: ${script}`),
      design: Option.none(),
      acceptance: Option.none(),
      priority: Option.none(),
      labels: Option.none(),
      parent: Option.none(),
      metadata: Option.none(),
      model: Option.none(),
    } satisfies NewTicket,
  })

const noFlags: RunFlags = {
  limit: Option.none(),
  offline: false,
  settings: {},
  environment: {},
  preflight: Option.none(),
}

/** Starts the project's run: `until` takes its records up to one `found` matches, `ended` waits for its end. */
const startRun = Effect.fn(function* (client: Client, project: ProjectId) {
  const { run } = yield* client['run.start']({
    project,
    mode: RunMode.cases.tickets.make({}),
    flags: noFlags,
  })
  const queue = yield* Queue.unbounded<RunEvent>()
  const fiber = yield* client['run.watchEvents']({
    project,
    run: Option.some(run),
    resume: Option.none(),
  }).pipe(
    Stream.flatMap(item => Stream.fromIterable(item.value)),
    Stream.runForEach(event => Queue.offer(queue, event)),
    Effect.forkScoped,
  )
  const until = Effect.fn(function* (
    count: number,
    found: (event: RunEvent) => boolean,
  ) {
    for (let left = count; left > 0;) {
      if (found(yield* Queue.take(queue))) left -= 1
    }
  })
  return { until, ended: Fiber.join(fiber) }
})

const isDispatch = (event: RunEvent) => event.kind === 'dispatch'

/** What the engine's status says it hosts. */
const hosted = (client: Client) =>
  Effect.map(client['engine.status'](), ({ runs, liveWorkers }) => ({
    runs,
    liveWorkers,
  }))

describe("the engine's status", () => {
  it.live('counts the runs going and the workers live across them', () =>
    Effect.gen(function* () {
      const client = yield* newEngine
      expect(yield* hosted(client)).toEqual({ runs: 0, liveWorkers: 0 })

      const two = yield* addProject(client, 'two', {
        ...scriptedSettings,
        concurrent: 2,
      })
      yield* file(client, two, 'First', 'hang')
      yield* file(client, two, 'Second', 'hang')
      const one = yield* addProject(client, 'one', scriptedSettings)
      yield* file(client, one, 'Third', 'hang')

      const twoRun = yield* startRun(client, two)
      const oneRun = yield* startRun(client, one)
      yield* twoRun.until(2, isDispatch)
      yield* oneRun.until(1, isDispatch)
      expect(yield* hosted(client)).toEqual({ runs: 2, liveWorkers: 3 })

      yield* client['run.stop']({ project: two })
      yield* twoRun.ended
      expect(yield* hosted(client)).toEqual({ runs: 1, liveWorkers: 1 })

      yield* client['run.stop']({ project: one })
      yield* oneRun.ended
      expect(yield* hosted(client)).toEqual({ runs: 0, liveWorkers: 0 })
    }),
  )

  it.live("doesn't count a ticket past its work as a live worker", () =>
    Effect.gen(function* () {
      const client = yield* newEngine
      const folder = yield* Effect.promise(() =>
        mkdtemp(NodePath.join(places.root, 'g')),
      )
      const go = NodePath.join(folder, 'go')
      const project = yield* addProject(client, 'work', {
        ...scriptedSettings,
        check_fast: `until [ -e ${go} ]; do sleep 0.05; done`,
      })
      yield* file(client, project, 'Merges', 'finish')

      const run = yield* startRun(client, project)
      yield* run.until(1, isDispatch)
      yield* run.until(
        1,
        event => event.kind === 'phase' && event.to === 'merging',
      )
      expect(yield* hosted(client)).toEqual({ runs: 1, liveWorkers: 0 })

      writeFileSync(go, '')
      yield* run.ended
      expect(yield* hosted(client)).toEqual({ runs: 0, liveWorkers: 0 })
    }),
  )
})
