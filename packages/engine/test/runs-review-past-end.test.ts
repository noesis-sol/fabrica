import { Effect, Layer, Option, Queue, Stream } from 'effect'
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

import { type EnginePaths, pathsIn, startEngine } from '../src/engine'
import {
  type ScriptedPlaces,
  engineGit,
  makeCheckout,
  makeScriptedPlaces,
  scriptedHosting,
  scriptedSettings,
} from './scripted-run'

// The Review cards an ended run left (spec §15.1, §15.6, §18.3), over RPC on a scripted agent: a ticket
// its worker defers keeps its card through an engine's restart and through a next run that leaves it
// where it is, and the card closes as that run takes the ticket up.

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

/** A test engine over `paths`, its runs on the scripted agent, and a client of it. */
const engineAt = (paths: EnginePaths) =>
  Effect.gen(function* () {
    yield* startEngine({
      paths,
      host,
      release: '1.2.3',
      git: engineGit(places),
      runs: scriptedHosting(places, paths.data),
    })
    return yield* clientAt(paths.socket)
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

describe('the Review card of a ticket an ended run set aside', () => {
  it.live(
    "says why from the run's records, past its end and an engine's restart",
    () =>
      Effect.gen(function* () {
        const data = yield* Effect.promise(() =>
          mkdtemp(NodePath.join(places.root, 'e')),
        )
        const paths = pathsIn({ data, socketFolder: data })
        // Its own check fails, so its worker never finishes, and the run sets it aside as unfinished.
        const checkout = makeCheckout(places, {
          ...scriptedSettings,
          check_own: 'false',
        })
        const { project, aside } = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* engineAt(paths)
            const { id: project } = yield* client['projects.add']({
              source: ProjectSource.cases.path.make({ path: checkout }),
              name: Option.some('work'),
            })
            const aside = yield* file(client, project, 'Aside', 'finish')
            const { run } = yield* client['run.start']({
              project,
              mode: RunMode.cases.tickets.make({}),
              flags: noFlags,
            })
            // With nothing else to do, the run ends by itself, and its records' stream with it.
            yield* client['run.watchEvents']({
              project,
              run: Option.some(run),
              resume: Option.none(),
            }).pipe(Stream.runDrain)
            expect(
              (yield* client['attention.list']({
                project: Option.some(project),
              })).find(isReviewOf(aside)),
            ).toMatchObject({ title: 'Aside', reason: 'UNFINISHED' })
            return { project, aside }
          }),
        )

        const client = yield* engineAt(paths)
        expect(
          (yield* client['attention.list']({
            project: Option.some(project),
          })).find(isReviewOf(aside)),
        ).toMatchObject({ title: 'Aside', reason: 'UNFINISHED' })
      }),
  )

  it.live('is there after the engine restarts, with its reason', () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() =>
        mkdtemp(NodePath.join(places.root, 'e')),
      )
      const paths = pathsIn({ data, socketFolder: data })
      // The first engine stops with its run going, which ends with it.
      const { project, aside } = yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* engineAt(paths)
          const added = yield* client['projects.add']({
            source: ProjectSource.cases.path.make({
              path: makeCheckout(places),
            }),
            name: Option.some('work'),
          })
          const requests = yield* followRequests(client, added.id)
          const aside = yield* file(
            client,
            added.id,
            'Aside',
            `defer ${NodePath.join(data, 'never')}`,
          )
          yield* file(client, added.id, 'Holder', 'hang')
          yield* client['run.start']({
            project: added.id,
            mode: RunMode.cases.tickets.make({}),
            flags: noFlags,
          })
          yield* requests.until(list => list.some(isReviewOf(aside)))
          return { project: added.id, aside }
        }),
      )

      const client = yield* engineAt(paths)
      expect(
        (yield* client['attention.list']({
          project: Option.some(project),
        })).find(isReviewOf(aside)),
      ).toMatchObject({ _tag: 'review', title: 'Aside', reason: 'DEFERRED' })
      // And across the engine's projects, with nothing asked of this one first.
      expect(
        (yield* client['attention.list']({ project: Option.none() })).some(
          isReviewOf(aside),
        ),
      ).toBe(true)
    }),
  )

  it.live(
    'stays through a next run that leaves its ticket, and closes as that run takes it up',
    () =>
      Effect.gen(function* () {
        const data = yield* Effect.promise(() =>
          mkdtemp(NodePath.join(places.root, 'e')),
        )
        const paths = pathsIn({ data, socketFolder: data })
        const client = yield* engineAt(paths)
        const { id: project } = yield* client['projects.add']({
          source: ProjectSource.cases.path.make({ path: makeCheckout(places) }),
          name: Option.some('work'),
        })
        const requests = yield* followRequests(client, project)
        const go = NodePath.join(data, 'go')
        const aside = yield* file(client, project, 'Aside', `defer ${go}`)
        const { run: first } = yield* client['run.start']({
          project,
          mode: RunMode.cases.tickets.make({}),
          flags: noFlags,
        })
        yield* requests.until(list => list.some(isReviewOf(aside)))
        // With nothing else to do, the run ends by itself, and its records' stream with it.
        yield* client['run.watchEvents']({
          project,
          run: Option.some(first),
          resume: Option.none(),
        }).pipe(Stream.runDrain)

        // The next run has other work, and leaves the ticket deferred, its card open.
        const hold = NodePath.join(data, 'hold')
        yield* file(client, project, 'Holder', `wait ${hold}`)
        const { run: next } = yield* client['run.start']({
          project,
          mode: RunMode.cases.tickets.make({}),
          flags: noFlags,
        })
        yield* client['run.watchEvents']({
          project,
          run: Option.some(next),
          resume: Option.none(),
        }).pipe(
          Stream.flatMap(({ value }) => Stream.fromIterable(value)),
          Stream.filter(({ kind }) => kind === 'dispatch'),
          Stream.runHead,
        )
        expect(
          (yield* client['attention.list']({
            project: Option.some(project),
          })).some(isReviewOf(aside)),
        ).toBe(true)

        // Undeferred, the run takes it up, and its card closes.
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
})
