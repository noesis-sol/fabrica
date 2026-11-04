import { Effect, Fiber, Layer, Option, Queue, Stream } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeSocket } from '@effect/platform-node'
import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type AttentionRequest,
  EngineHost,
  FabricaRpcs,
  type NewTicket,
  type ProjectId,
  ProjectSource,
  type RunFlags,
  RunMode,
  type TicketId,
  applyAttentionPatch,
} from '@fabrica/contracts'

import { pathsIn, startEngine } from '../src/engine'
import {
  type ScriptedPlaces,
  engineGit,
  makeCheckout,
  makeScriptedPlaces,
  scriptedHosting,
} from './scripted-run'

// A going run's set-aside tickets as attention requests (spec §15.1, §18.3), over RPC on a scripted
// agent: a ticket its worker defers is listed for review, with its reason; it leaves the list as it goes
// back in the queue, and stays past the run's end.

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

/** A test engine with one project, on a new checkout, its runs on the scripted agent. */
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
  const client = yield* clientAt(paths.socket)
  const added = yield* client['projects.add']({
    source: ProjectSource.cases.path.make({ path: makeCheckout(places) }),
    name: Option.some('work'),
  })
  return { client, project: added.id, data }
})

const file = (
  client: Client,
  project: ProjectId,
  title: string,
  script: string,
) =>
  Effect.map(
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
    }),
    ({ id }) => id,
  )

const noFlags: RunFlags = {
  limit: Option.none(),
  offline: false,
  settings: {},
  environment: {},
  preflight: Option.none(),
}

/** The project's open requests as they come: `until` waits for a list that `found` likes. */
const followRequests = Effect.fn(function* (
  client: Client,
  project: ProjectId,
) {
  const lists = yield* Queue.unbounded<ReadonlyArray<AttentionRequest>>()
  yield* client['attention.watch']({
    project: Option.some(project),
    resume: Option.none(),
  }).pipe(
    Stream.mapAccum(
      (): ReadonlyArray<AttentionRequest> => [],
      (now, item) => {
        const next =
          item._tag === 'snapshot'
            ? item.value
            : applyAttentionPatch(now, item.value)
        return [next, [next]] as const
      },
    ),
    Stream.runForEach(list => Queue.offer(lists, list)),
    Effect.forkScoped,
  )
  const until = (found: (list: ReadonlyArray<AttentionRequest>) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const list = yield* Queue.take(lists)
        if (found(list)) return list
      }
    })
  return { until }
})

const isReviewOf = (ticket: TicketId) => (request: AttentionRequest) =>
  request._tag === 'review' && request.ticket === ticket

describe("a going run's set-aside tickets", () => {
  it.live(
    'are listed for review as they are set aside, and leave the list as they go back in the queue',
    () =>
      Effect.gen(function* () {
        const { client, project, data } = yield* newEngine
        const go = NodePath.join(data, 'go')
        const hold = NodePath.join(data, 'hold')
        const requests = yield* followRequests(client, project)
        const aside = yield* file(client, project, 'Aside', `defer ${go}`)
        yield* file(client, project, 'Holder', `wait ${hold}`)
        yield* client['run.start']({
          project,
          mode: RunMode.cases.tickets.make({}),
          flags: noFlags,
        })

        const listed = yield* requests.until(list =>
          list.some(isReviewOf(aside)),
        )
        expect(listed.find(isReviewOf(aside))).toMatchObject({
          _tag: 'review',
          project,
          ticket: aside,
          title: 'Aside',
          reason: 'DEFERRED',
        })
        // Read again from the work graph, it stays: nothing there lists it.
        expect(
          (yield* client['attention.list']({
            project: Option.some(project),
          })).some(isReviewOf(aside)),
        ).toBe(true)

        // Undeferred, it goes back in the queue, and its request closes.
        writeFileSync(go, '')
        yield* client['tickets.update']({
          project,
          ticket: aside,
          changes: { status: 'open' },
        })
        yield* requests.until(list => !list.some(isReviewOf(aside)))

        yield* client['run.stop']({ project })
      }),
  )

  it.live(
    'stay on the list as the run ends, with their reason, until undeferred',
    () =>
      Effect.gen(function* () {
        const { client, project, data } = yield* newEngine
        const requests = yield* followRequests(client, project)
        const aside = yield* file(
          client,
          project,
          'Aside',
          `defer ${NodePath.join(data, 'never')}`,
        )
        yield* file(client, project, 'Holder', 'hang')
        const { run } = yield* client['run.start']({
          project,
          mode: RunMode.cases.tickets.make({}),
          flags: noFlags,
        })
        yield* requests.until(list => list.some(isReviewOf(aside)))

        // Its records' stream ends once the run is gone.
        const ended = yield* client['run.watchEvents']({
          project,
          run: Option.some(run),
          resume: Option.none(),
        }).pipe(Stream.runDrain, Effect.forkScoped)
        yield* client['run.stop']({ project })
        yield* Fiber.join(ended)
        expect(
          (yield* client['attention.list']({
            project: Option.some(project),
          })).find(isReviewOf(aside)),
        ).toMatchObject({ title: 'Aside', reason: 'DEFERRED' })

        // With no run going, the work graph's change closes it.
        yield* client['tickets.update']({
          project,
          ticket: aside,
          changes: { status: 'open' },
        })
        yield* requests.until(list => !list.some(isReviewOf(aside)))
      }),
  )
})
