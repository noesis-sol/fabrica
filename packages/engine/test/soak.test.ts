import {
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Stream,
} from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import * as NodePath from 'node:path'
import { queryObjects, setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

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
  type RunId,
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

// The soak (spec §7.1, §24, H77): what a worker, a ticket or a run held goes with it, not with the
// engine. One engine goes through many runs of several tickets, on the scripted agent, with a client
// watching each run's events, view and workers' transcripts as the app does; once the engine has warmed
// up, what this process holds is measured against what it holds at the end, the run going or not.
//
// What is measured is live objects after a full collection (`v8.queryObjects`), so a finished fiber or a
// closed subscription still reachable counts as a live one does, the heap, the open files, and the
// event loop's active resources (sockets, processes, timers). Something held per run would add a fiber
// or a subscription per run, which the tolerances are well under.

let places: ScriptedPlaces

beforeAll(() => {
  places = makeScriptedPlaces()
})

/** A round is a run of each project, side by side: 52 runs, of three tickets each. */
const rounds = 26
const projectsSideBySide = 2
/** What is lazily made once (compiled code, the first run's caches) is made by now. */
const warmUpRounds = 6
/** In these rounds each project's run is stopped with a worker going, carrying its ticket over. */
const isStoppedRound = (round: number) => round % 5 === 2
/** The tickets of each of the two batches a run goes through with its first ticket keeping it open. */
const batchSize = 12

/** How much a look may be above the one it is held to, for what comes and goes on its own. */
const tolerance: Held = {
  heapBytes: 6 * 1024 * 1024,
  files: 4,
  activeResources: 4,
  fibers: 8,
  subscriptions: 6,
}

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test-host',
  cores: 4,
})

const noFlags: RunFlags = {
  limit: Option.none(),
  offline: false,
  settings: {},
  environment: {},
  preflight: Option.none(),
}

setFlagsFromString('--expose-gc')
const collectGarbage: () => void = runInNewContext('gc')

/** What this process holds. */
interface Held {
  readonly heapBytes: number
  readonly files: number
  readonly activeResources: number
  readonly fibers: number
  readonly subscriptions: number
}

/** The classes whose live objects are counted, from one of each. */
const countedClasses = Effect.gen(function* () {
  const fiber = yield* Effect.withFiber(current =>
    Effect.succeed(current.constructor),
  )
  const subscription = yield* PubSub.unbounded<void>().pipe(
    Effect.flatMap(PubSub.subscribe),
    Effect.map(made => made.constructor),
    Effect.scoped,
  )
  return { fiber, subscription }
})

type Counted = Effect.Success<typeof countedClasses>

const look = (counted: Counted): Held => {
  // queryObjects collects too, but not what a finalization or a weak reference lets go only after one.
  collectGarbage()
  collectGarbage()
  return {
    heapBytes: process.memoryUsage().heapUsed,
    files: readdirSync('/dev/fd').length,
    activeResources: process.getActiveResourcesInfo().length,
    fibers: queryObjects(counted.fiber, { format: 'count' }),
    subscriptions: queryObjects(counted.subscription, { format: 'count' }),
  }
}

const measures = [
  'heapBytes',
  'files',
  'activeResources',
  'fibers',
  'subscriptions',
] satisfies ReadonlyArray<keyof Held>

/** Each measure by which `held` is past `baseline` and its tolerance, and by how much; none where it is flat. */
const over = (baseline: Held, held: Held) =>
  Object.fromEntries(
    measures.flatMap(measure => {
      const grown = held[measure] - baseline[measure]
      return grown > tolerance[measure] ? [[measure, grown]] : []
    }),
  )

/**
 * Each measure past `baseline`, once what ended has had its time: a process's pipes and a socket close
 * in the event loop, with no event of the engine's to wait on, so a look past its tolerance looks again.
 */
const grownSince = (baseline: Held, counted: Counted) =>
  Effect.gen(function* () {
    for (let again = 0; again < 20; again += 1) {
      if (Object.keys(over(baseline, look(counted))).length === 0) return {}
      yield* Effect.sleep('250 millis')
    }
    return over(baseline, look(counted))
  })

/** A client on a new engine, whose runs are the scripted agent's. */
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

const newProject = (client: Client, name: string) =>
  client['projects.add']({
    source: ProjectSource.cases.path.make({
      path: makeCheckout(places, { ...scriptedSettings, concurrent: 3 }),
    }),
    name: Option.some(name),
  }).pipe(Effect.map(({ id }) => id))

const fileTicket = (
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

const start = (client: Client, project: ProjectId) =>
  client['run.start']({
    project,
    mode: RunMode.cases.tickets.make({}),
    flags: noFlags,
  }).pipe(Effect.map(({ run }) => run))

/** The run's records as they are written, its stream ending with it. */
const recordsOf = (client: Client, project: ProjectId, run: RunId) =>
  client['run.watchEvents']({
    project,
    run: Option.some(run),
    resume: Option.none(),
  }).pipe(Stream.flatMap(item => Stream.fromIterable(item.value)))

/**
 * One run of the project's tickets, watched by a client: its events, its view and each worker's
 * transcript. `onClosed` hears how many tickets the run has closed, as each closes.
 */
const watchedRun = <E>(
  client: Client,
  project: ProjectId,
  onClosed: (closed: number) => Effect.Effect<void, E>,
) =>
  Effect.gen(function* () {
    const run = yield* start(client, project)
    const view = yield* client['run.watchView']({
      project,
      resume: Option.none(),
    }).pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped)
    const closed = yield* Ref.make(0)
    const records = yield* recordsOf(client, project, run).pipe(
      Stream.tap(event =>
        Effect.gen(function* () {
          if (event.kind === 'dispatch')
            // A worker that ended before this comes is no worker now: the rest watch it to its end.
            yield* client['worker.watchTranscript']({
              project,
              ticket: event.ticket,
              resume: Option.none(),
            }).pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped)
          if (event.kind === 'closed')
            yield* onClosed(yield* Ref.updateAndGet(closed, n => n + 1))
        }),
      ),
      Stream.runCollect,
    )
    yield* Fiber.join(view)
    return { records, closed: yield* Ref.get(closed) }
  }).pipe(Effect.scoped)

const endCode = (records: ReadonlyArray<RunEvent>) =>
  records.findLast(event => event.kind === 'end')?.code

describe('the soak', () => {
  it.live(
    'one engine through many runs of several tickets, what it holds flat at the end',
    () =>
      Effect.gen(function* () {
        const counted = yield* countedClasses
        const client = yield* newEngine
        const projects = yield* Effect.forEach(
          Array.from({ length: projectsSideBySide }, (_, at) => `work-${at}`),
          name => newProject(client, name),
        )
        const filed = yield* Ref.make(0)
        const closed = yield* Ref.make(0)

        const round = (number: number, project: ProjectId) =>
          Effect.gen(function* () {
            const stopped = isStoppedRound(number)
            const go = NodePath.join(places.root, `go-${project}-${number}`)
            const scripts = [
              'finish',
              'say 64',
              stopped ? `wait ${go}` : 'finish',
            ]
            yield* Effect.forEach(scripts, (script, at) =>
              fileTicket(
                client,
                project,
                `Round ${number}, part ${at}`,
                script,
              ),
            )
            yield* Ref.update(filed, n => n + scripts.length)
            const ran = yield* watchedRun(client, project, done =>
              stopped && done === scripts.length - 1
                ? client['run.stop']({ project })
                : Effect.void,
            )
            yield* Ref.update(closed, n => n + ran.closed)
            expect(endCode(ran.records)).toBe(stopped ? 130 : 0)
            // A stopped run's ticket is carried over, and goes on in the next.
            if (stopped) writeFileSync(go, '')
          })

        const roundOf = (number: number) =>
          Effect.forEach(projects, project => round(number, project), {
            concurrency: 'unbounded',
            discard: true,
          })

        for (let number = 0; number < warmUpRounds; number += 1)
          yield* roundOf(number)
        const baseline = look(counted)
        for (let number = warmUpRounds; number < rounds; number += 1)
          yield* roundOf(number)

        expect(yield* grownSince(baseline, counted)).toEqual({})
        expect(yield* Ref.get(closed)).toBe(yield* Ref.get(filed))
      }),
    600_000,
  )

  it.live(
    'what a ticket held goes with it, while its run goes on',
    () =>
      Effect.gen(function* () {
        const counted = yield* countedClasses
        const client = yield* newEngine
        const project = yield* newProject(client, 'work')
        const go = NodePath.join(places.root, `go-${project}`)
        yield* fileTicket(client, project, 'Holds the run open', `wait ${go}`)
        const closing = yield* Queue.unbounded<number>()
        const batch = (from: number, count: number) =>
          Effect.forEach(
            Array.from({ length: count }, (_, at) => from + at),
            at => fileTicket(client, project, `Part ${at}`, 'say 2048'),
          )
        const closedBy = (count: number) =>
          Effect.gen(function* () {
            while ((yield* Queue.take(closing)) < count);
          })
        const run = yield* watchedRun(client, project, closed =>
          Effect.asVoid(Queue.offer(closing, closed)),
        ).pipe(Effect.forkScoped)

        // The second batch asks what the first did: a statement the work graph hasn't prepared yet (one
        // per count of tickets ready) is cached, with its fiber, up to the cache's capacity.
        yield* batch(0, batchSize)
        yield* closedBy(batchSize)
        const baseline = look(counted)
        // Each worker said two megabytes: kept to the run's end, they are past the tolerance.
        yield* batch(batchSize, batchSize)
        yield* closedBy(2 * batchSize)
        const grown = yield* grownSince(baseline, counted)
        writeFileSync(go, '')
        const ran = yield* Fiber.join(run)

        expect(grown).toEqual({})
        expect(ran.closed).toBe(2 * batchSize + 1)
        expect(endCode(ran.records)).toBe(0)
      }),
    180_000,
  )
})
