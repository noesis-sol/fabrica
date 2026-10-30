import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Stream,
} from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { mkdtemp } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeSocket } from '@effect/platform-node'
import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  EngineHost,
  FabricaRpcs,
  type NewTicket,
  NoRun,
  type ProjectId,
  ProjectSource,
  type RunFlags,
  RunMode,
  type RunView,
  TicketId,
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

// The run view and the Workers group over RPC (spec §8.1, §8.3, §18.4): a test engine runs a ticket on
// the scripted agent; the run's view streams as a snapshot then patches, showing the run, its ticket
// working and its worker; a message steers the worker, which its row and its transcript show, and a
// release hands it back; a worker the run hasn't is not found; and the view's stream ends with the run.

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

/** The project's run view as a client keeps it: each view, its snapshot's and each patch applied. */
const follow = Effect.fn(function* (client: Client, project: ProjectId) {
  const views = yield* Queue.unbounded<RunView>()
  const tags = yield* Queue.unbounded<'snapshot' | 'patch'>()
  const fiber = yield* client['run.watchView']({
    project,
    resume: Option.none(),
  }).pipe(
    Stream.mapAccum(Option.none<RunView>, (kept, item) => {
      const view =
        item._tag === 'snapshot'
          ? item.value
          : Option.match(kept, {
              onNone: () => expect.fail('a patch before the snapshot'),
              onSome: before => applyRunViewPatch(before, item.value),
            })
      return [Option.some(view), [[item._tag, view] as const]]
    }),
    Stream.runForEach(([tag, view]) =>
      Effect.andThen(Queue.offer(tags, tag), Queue.offer(views, view)),
    ),
    Effect.forkScoped,
  )
  /** The first view that `found` matches. */
  const until = (found: (view: RunView) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const view = yield* Queue.take(views)
        if (found(view)) return view
      }
    })
  return { until, tags, ended: Fiber.join(fiber) }
})

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : expect.fail('it succeeded')

describe('the run view over RPC', () => {
  it.live(
    "streams the run's view with its worker, steered by a message and released, and ends with the run",
    () =>
      Effect.gen(function* () {
        const { client, project } = yield* newEngine
        const ticket = yield* file(client, project, 'hang')
        const { run } = yield* client['run.start']({
          project,
          mode: RunMode.cases.tickets.make({}),
          flags: noFlags,
        })
        const view = yield* follow(client, project)

        const working = yield* view.until(
          now => now.workers.length === 1 && now.tickets.length === 1,
        )
        expect(working.header).toMatchObject({ run, project, state: 'running' })
        expect(working.tickets[0]).toMatchObject({
          ticket,
          title: 'Never done',
          phase: { _tag: 'working' },
        })
        expect(working.totals).toMatchObject({ live: 1 })
        expect(working.workers[0]).toMatchObject({ ticket, steered: false })
        expect(yield* Queue.take(view.tags)).toBe('snapshot')

        yield* client['worker.message']({ project, ticket, text: 'Look here' })
        yield* view.until(now => now.workers[0]?.steered === true)
        const [shown] = yield* client['worker.watchTranscript']({
          project,
          ticket,
          resume: Option.none(),
        }).pipe(Stream.take(1), Stream.runCollect)
        expect(
          shown?._tag === 'snapshot' &&
            shown.value.flatMap(entry =>
              entry._tag === 'message' ? [[entry.role, entry.text]] : [],
            ),
        ).toContainEqual(['user', 'Look here'])

        yield* client['worker.release']({ project, ticket })
        yield* view.until(now => now.workers[0]?.steered === false)

        const nobody = TicketId.make(`${project}-zzzz`)
        expect(
          failureOf(
            yield* Effect.exit(
              client['worker.interrupt']({ project, ticket: nobody }),
            ),
          ),
        ).toEqual(new WorkerNotFound({ project, ticket: nobody }))

        yield* client['run.stop']({ project })
        yield* view.ended
        expect(
          failureOf(
            yield* Effect.exit(
              client['run.watchView']({
                project,
                resume: Option.none(),
              }).pipe(Stream.runDrain),
            ),
          ),
        ).toEqual(new NoRun({ project }))
      }),
  )
})
