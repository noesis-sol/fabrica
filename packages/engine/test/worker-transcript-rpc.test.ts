import { Cause, Effect, Exit, Fiber, Layer, Option, Stream } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
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
  type RunFlags,
  RunMode,
  type RunView,
  WorkerNotFound,
  applyRunViewPatch,
} from '@fabrica/contracts'

import { pathsIn, startEngine } from '../src/engine'
import {
  type ScriptedPlaces,
  engineGit,
  makeCheckout,
  makeScriptedPlaces,
  scriptedHosting,
} from './scripted-run'

// A worker's transcript over RPC (spec §8.1, §8.3): a test engine runs a ticket on the scripted agent;
// its transcript streams the maintainer's message, and ends as the worker's part in the run ends with
// the run, the worker then not found.

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

/** A protocol client on the engine's local socket, for the current scope. */
const clientAt = Effect.fn(function* (path: string) {
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide([
        NodeSocket.layerNet({ path }),
        RpcSerialization.layerNdjson,
      ]),
    ),
  )
  return yield* RpcClient.make(FabricaRpcs).pipe(Effect.provide(protocol))
})

type Client = Effect.Success<ReturnType<typeof clientAt>>

/** A test engine whose runs are on the scripted agent, with one project on a new checkout. */
const newEngine = Effect.gen(function* () {
  const data = yield* Effect.promise(() =>
    mkdtemp(NodePath.join(places.root, 'v')),
  )
  const paths = pathsIn({ data, socketFolder: data })
  yield* startEngine({
    paths,
    host,
    release: '1.2.3',
    git: engineGit(places),
    runs: scriptedHosting(places, paths.data),
  })
  const client = yield* clientAt(paths.socket)
  const added = yield* client['projects.add']({
    source: ProjectSource.cases.path.make({ path: makeCheckout(places) }),
    name: Option.some('work'),
  })
  return { client, project: added.id }
})

/** A task whose stub does `script`. */
const file = (client: Client, project: ProjectId, script: string) =>
  Effect.map(
    client['tickets.create']({
      project,
      ticket: {
        type: 'task',
        title: 'Never done',
        description: Option.some(`stub: ${script}`),
        design: Option.none(),
        acceptance: Option.none(),
        priority: Option.none(),
        labels: Option.none(),
        parent: Option.none(),
        metadata: Option.none(),
        model: Option.none(),
      } satisfies NewTicket,
    }),
    ({ id }) => id,
  )

const noFlags: RunFlags = {
  limit: Option.none(),
  offline: false,
  settings: {},
  preflight: Option.none(),
}

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : expect.fail('it succeeded')

describe("a worker's transcript over RPC", () => {
  it.live('streams while the worker works, and ends with the run', () =>
    Effect.gen(function* () {
      const { client, project } = yield* newEngine
      const ticket = yield* file(client, project, 'hang')
      yield* client['run.start']({
        project,
        mode: RunMode.cases.tickets.make({}),
        flags: noFlags,
      })
      // The worker is there once the run's view shows it.
      yield* client['run.watchView']({ project, resume: Option.none() }).pipe(
        Stream.mapAccum(Option.none<RunView>, (kept, item) => {
          const view =
            item._tag === 'snapshot'
              ? item.value
              : Option.match(kept, {
                  onNone: () => expect.fail('a patch before the snapshot'),
                  onSome: before => applyRunViewPatch(before, item.value),
                })
          return [Option.some(view), [view]]
        }),
        Stream.takeUntil(view => view.workers.length === 1),
        Stream.runDrain,
      )
      yield* client['worker.message']({ project, ticket, text: 'Look here' })
      const watch = yield* client['worker.watchTranscript']({
        project,
        ticket,
        resume: Option.none(),
      }).pipe(Stream.runCollect, Effect.forkScoped)

      yield* client['run.stop']({ project })
      const items = yield* Fiber.join(watch)
      expect(
        items.flatMap(item =>
          item.value.flatMap(entry =>
            entry._tag === 'message' ? [[entry.role, entry.text]] : [],
          ),
        ),
      ).toContainEqual(['user', 'Look here'])
      expect(
        failureOf(
          yield* Effect.exit(
            client['worker.watchTranscript']({
              project,
              ticket,
              resume: Option.none(),
            }).pipe(Stream.runDrain),
          ),
        ),
      ).toEqual(new WorkerNotFound({ project, ticket }))
    }),
  )
})
