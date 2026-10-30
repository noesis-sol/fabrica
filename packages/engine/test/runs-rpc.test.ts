import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Scope,
  Stream,
} from 'effect'
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
  NoRun,
  type ProjectId,
  ProjectSource,
  RunEnded,
  type RunEvent,
  type RunEventsItem,
  type RunFlags,
  RunGoing,
  RunId,
  RunMode,
  RunNotFound,
  RunRefused,
} from '@fabrica/contracts'

import { type EnginePaths, pathsIn, startEngine } from '../src/engine'
import { readEvents } from '../src/runlog'
import {
  type ScriptedPlaces,
  engineGit,
  makeCheckout,
  makeScriptedPlaces,
  scriptedHosting,
} from './scripted-run'

// The Runs group over RPC (spec §8.1, §13.1, §13.10, §13.11, §13.12): a test engine, started in a
// temporary data folder with a project on a real checkout, runs its tickets on a scripted agent. A
// start answers with the run once its start checks pass, or with their problems; the run's events
// stream sends its records so far, then each as it is written, and ends with the run; a stop ends it
// `INTERRUPTED` with exit code 130, a drain `DRAINED`; its status says where it is, and how the last
// one ended; and as the engine stops, its run is stopped and ends `INTERRUPTED`.

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

/** An engine's files in a new folder of the fixture's root, short as a socket's path must be. */
const newPaths = Effect.map(
  Effect.promise(() => mkdtemp(NodePath.join(places.root, 'e'))),
  data => pathsIn({ data, socketFolder: data }),
)

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

/** A test engine with one project, `work`, on a new checkout; its runs on the scripted agent where `runs` says so. */
const newEngine = Effect.fn(function* (
  options: { readonly runs?: boolean; readonly settings?: object } = {},
) {
  const paths: EnginePaths = yield* newPaths
  const serve: ServeOptionsOf = {
    paths,
    host,
    release: '1.2.3',
    git: engineGit(places),
    ...(options.runs === false
      ? {}
      : { runs: scriptedHosting(places, paths.data) }),
  }
  yield* startEngine(serve)
  const client = yield* clientAt(paths.socket)
  const checkout = makeCheckout(places, options.settings)
  const added = yield* client['projects.add']({
    source: ProjectSource.cases.path.make({ path: checkout }),
    name: Option.some('work'),
  })
  return { client, project: added.id, checkout }
})

type ServeOptionsOf = Parameters<typeof startEngine>[0]

/** A task whose stub does `script`, filed through the engine. */
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
  preflight: Option.none(),
}

const tickets = RunMode.cases.tickets.make({})

/** The records an events stream's items carry, in order. */
const recordsOf = (item: RunEventsItem): ReadonlyArray<RunEvent> => item.value

/**
 * The run's records as they come: `until` takes them up to the first that `found` matches, `rest`
 * the others once the stream has ended with the run.
 */
const follow = Effect.fn(function* (
  client: Client,
  project: ProjectId,
  run: RunId,
) {
  const queue = yield* Queue.unbounded<RunEvent>()
  const fiber = yield* client['run.watchEvents']({
    project,
    run: Option.some(run),
    resume: Option.none(),
  }).pipe(
    Stream.flatMap(item => Stream.fromIterable(recordsOf(item))),
    Stream.runForEach(event => Queue.offer(queue, event)),
    Effect.forkScoped,
  )
  const until = (found: (event: RunEvent) => boolean) =>
    Effect.gen(function* () {
      const taken: Array<RunEvent> = []
      while (true) {
        const event = yield* Queue.take(queue)
        taken.push(event)
        if (found(event)) return taken
      }
    })
  const rest = Effect.andThen(Fiber.join(fiber), () =>
    Effect.map(Queue.takeAll(queue), all => [...all]),
  )
  return { until, rest }
})

const ofKind = <K extends RunEvent['kind']>(
  events: ReadonlyArray<RunEvent>,
  kind: K,
): ReadonlyArray<Extract<RunEvent, { readonly kind: K }>> =>
  events.filter(
    (event): event is Extract<RunEvent, { readonly kind: K }> =>
      event.kind === kind,
  )

/** The error `exit` failed with. */
const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : expect.fail('it succeeded')

describe('runs over RPC', () => {
  it.live(
    'start a run that merges its ticket, its events streamed to its end, and say how it ended',
    () =>
      Effect.gen(function* () {
        const { client, project } = yield* newEngine()
        const ticket = yield* file(client, project, 'Add the page', 'finish')
        const { run } = yield* client['run.start']({
          project,
          mode: tickets,
          flags: noFlags,
        })
        const events = yield* follow(client, project, run)
        const all = yield* events.rest

        expect(ofKind(all, 'start')).toHaveLength(1)
        expect(ofKind(all, 'closed').map(closed => closed.ticket)).toEqual([
          ticket,
        ])
        expect(ofKind(all, 'done').map(done => done.detail)).toEqual([
          'READY_EMPTY',
        ])
        expect(all.at(-1)).toMatchObject({ kind: 'end', code: 0, run })

        const status = yield* client['run.status']({ project })
        expect(status._tag).toBe('idle')
        if (status._tag === 'idle')
          expect(Option.map(status.last, last => [last.run, last.end])).toEqual(
            Option.some([run, 'READY_EMPTY']),
          )

        // The run's records again, as an earlier run's: a snapshot of them all, then the end.
        const again = yield* client['run.watchEvents']({
          project,
          run: Option.some(run),
          resume: Option.none(),
        }).pipe(Stream.runCollect)
        expect(again.map(item => item._tag)).toEqual(['snapshot'])
        expect(again.flatMap(recordsOf)).toEqual(all)
      }),
  )

  it.live(
    'stop a run now: its worker interrupted, it ends INTERRUPTED with exit code 130',
    () =>
      Effect.gen(function* () {
        const { client, project } = yield* newEngine()
        const ticket = yield* file(client, project, 'Never done', 'hang')
        const { run } = yield* client['run.start']({
          project,
          mode: tickets,
          flags: noFlags,
        })
        const events = yield* follow(client, project, run)
        yield* events.until(event => event.kind === 'dispatch')

        const going = yield* client['run.status']({ project })
        expect(going._tag === 'going' && going.header).toMatchObject({
          run,
          project,
          state: 'running',
        })
        const second = yield* Effect.exit(
          client['run.start']({ project, mode: tickets, flags: noFlags }),
        )
        expect(failureOf(second)).toEqual(new RunGoing({ project, run }))

        yield* client['run.stop']({ project })
        const rest = yield* events.rest
        expect(ofKind(rest, 'stop').map(stop => stop.detail)).toEqual([
          'INTERRUPTED',
        ])
        expect(ofKind(rest, 'ticket_end').map(end => end.ticket)).toContain(
          ticket,
        )
        expect(rest.at(-1)).toMatchObject({ kind: 'end', code: 130 })
        const after = yield* client['run.status']({ project })
        expect(
          after._tag === 'idle' && Option.getOrUndefined(after.last),
        ).toBeInstanceOf(RunEnded)
      }),
  )

  it.live(
    'drain a run: nothing more is dispatched, the running ticket merges, it ends DRAINED',
    () =>
      Effect.gen(function* () {
        const { client, project } = yield* newEngine()
        const go = NodePath.join(places.root, `go-${project}-${Date.now()}`)
        yield* file(client, project, 'First', `wait ${go}`)
        yield* file(client, project, 'Second', `wait ${go}`)
        const { run } = yield* client['run.start']({
          project,
          mode: tickets,
          flags: noFlags,
        })
        const events = yield* follow(client, project, run)
        const [dispatched] = ofKind(
          yield* events.until(event => event.kind === 'dispatch'),
          'dispatch',
        )

        yield* client['run.drain']({ project })
        yield* events.until(event => event.kind === 'drain')
        const draining = yield* client['run.status']({ project })
        expect(draining._tag === 'going' && draining.header.state).toBe(
          'draining',
        )
        // Taken back and asked again: each says so.
        yield* client['run.undrain']({ project })
        yield* client['run.drain']({ project })
        writeFileSync(go, '')

        const rest = yield* events.rest
        expect(ofKind(rest, 'resume')).toHaveLength(1)
        expect(ofKind(rest, 'dispatch')).toHaveLength(0)
        expect(ofKind(rest, 'closed').map(closed => closed.ticket)).toEqual([
          dispatched?.ticket,
        ])
        expect(ofKind(rest, 'done').map(done => done.detail)).toEqual([
          'DRAINED',
        ])
        expect(rest.at(-1)).toMatchObject({ kind: 'end', code: 0 })
      }),
  )

  it.live(
    "refuse a start whose checks fail, a mode not built yet, and a request for a run that isn't there",
    () =>
      Effect.gen(function* () {
        const { client, project, checkout } = yield* newEngine()
        writeFileSync(NodePath.join(checkout, 'README.md'), 'changed\n')
        const dirty = failureOf(
          yield* Effect.exit(
            client['run.start']({ project, mode: tickets, flags: noFlags }),
          ),
        )
        expect(dirty).toBeInstanceOf(RunRefused)
        expect(dirty).toMatchObject({ end: 'SETUP' })
        expect(
          dirty instanceof RunRefused ? dirty.problems.join('\n') : '',
        ).toContain('uncommitted changes: README.md')

        const spec = failureOf(
          yield* Effect.exit(
            client['run.start']({
              project,
              mode: RunMode.cases.spec.make({
                source: 'docs/spec.md',
                refine: false,
              }),
              flags: noFlags,
            }),
          ),
        )
        expect(spec).toBeInstanceOf(RunRefused)
        expect(spec instanceof RunRefused ? spec.problems[0] : '').toContain(
          "a spec run isn't in this engine yet",
        )

        expect(
          failureOf(yield* Effect.exit(client['run.stop']({ project }))),
        ).toEqual(new NoRun({ project }))
        expect(
          failureOf(yield* Effect.exit(client['run.drain']({ project }))),
        ).toEqual(new NoRun({ project }))
        expect(
          failureOf(
            yield* Effect.exit(
              client['run.watchEvents']({
                project,
                run: Option.none(),
                resume: Option.none(),
              }).pipe(Stream.runDrain),
            ),
          ),
        ).toEqual(new NoRun({ project }))
        const unknown = RunId.make('2020-01-01T00:00:00.000+00:00')
        expect(
          failureOf(
            yield* Effect.exit(
              client['run.watchEvents']({
                project,
                run: Option.some(unknown),
                resume: Option.none(),
              }).pipe(Stream.runDrain),
            ),
          ),
        ).toEqual(new RunNotFound({ project, run: unknown }))
      }),
  )

  it.live('refuse every run on an engine given nothing to run them on', () =>
    Effect.gen(function* () {
      const { client, project } = yield* newEngine({ runs: false })
      const refused = failureOf(
        yield* Effect.exit(
          client['run.start']({ project, mode: tickets, flags: noFlags }),
        ),
      )
      expect(refused).toBeInstanceOf(RunRefused)
      expect(
        refused instanceof RunRefused ? refused.problems[0] : '',
      ).toContain("this engine can't run a project yet")
    }),
  )

  it.live('stop the run going as the engine stops: it ends INTERRUPTED', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const { client, project, checkout } = yield* newEngine().pipe(
        Scope.provide(scope),
      )
      yield* file(client, project, 'Never done', 'hang')
      const { run } = yield* client['run.start']({
        project,
        mode: tickets,
        flags: noFlags,
      })
      const events = yield* follow(client, project, run).pipe(
        Scope.provide(scope),
      )
      yield* events.until(event => event.kind === 'dispatch')
      yield* Scope.close(scope, Exit.void)

      const { events: written } = yield* readEvents({
        root: checkout,
        run: Option.some(run),
      })
      expect(ofKind(written, 'stop').map(stop => stop.detail)).toEqual([
        'INTERRUPTED',
      ])
      expect(written.at(-1)).toMatchObject({ kind: 'end', code: 130 })
    }),
  )
})
