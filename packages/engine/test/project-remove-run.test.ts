import { Cause, Effect, Exit, Layer, Option, Stream } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { mkdtemp } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeSocket } from '@effect/platform-node'
import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  EngineHost,
  FabricaRpcs,
  type NewTicket,
  ProjectNotFound,
  ProjectSource,
  type RunFlags,
  RunGoing,
  RunMode,
} from '@fabrica/contracts'

import { pathsIn, startEngine } from '../src/engine'
import {
  type ScriptedPlaces,
  engineGit,
  makeCheckout,
  makeScriptedPlaces,
  scriptedHosting,
} from './scripted-run'

// Removing a project while its run goes (spec §10.1, §7.1, §8.1): the removal is refused, naming the
// run, and leaves the project and its work graph as they were; once the run
// has ended, the project is removed, and a run asked of it after is of no project.

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

/** A test engine running on the scripted agent, with one project, `work`, on a new checkout. */
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
  const checkout = makeCheckout(places)
  const added = yield* client['projects.add']({
    source: ProjectSource.cases.path.make({ path: checkout }),
    name: Option.some('work'),
  })
  return { client, project: added.id, checkout }
})

const ticket = (title: string, script: string): NewTicket => ({
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
})

const noFlags: RunFlags = {
  limit: Option.none(),
  offline: false,
  settings: {},
  preflight: Option.none(),
}

/** The error `exit` failed with. */
const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : expect.fail('it succeeded')

describe('removing a project with a run going', () => {
  it.live(
    'refuses it while the run goes, and removes it once the run has ended',
    () =>
      Effect.gen(function* () {
        const { client, project } = yield* newEngine
        const { id } = yield* client['tickets.create']({
          project,
          ticket: ticket('Never done', 'hang'),
        })
        const { run } = yield* client['run.start']({
          project,
          mode: RunMode.cases.tickets.make({}),
          flags: noFlags,
        })
        const events = client['run.watchEvents']({
          project,
          run: Option.some(run),
          resume: Option.none(),
        })
        yield* events.pipe(
          Stream.flatMap(item => Stream.fromIterable(item.value)),
          Stream.takeUntil(event => event.kind === 'dispatch'),
          Stream.runDrain,
        )

        const refused = yield* Effect.exit(
          client['projects.remove']({ project }),
        )
        expect(failureOf(refused)).toEqual(new RunGoing({ project, run }))
        const listed = yield* client['projects.list']()
        expect(listed.map(info => info.id)).toEqual([project])
        // Its work graph is still open: the run's ticket reads as it did.
        const shown = yield* client['tickets.show']({ project, ticket: id })
        expect(shown.ticket.status).toBe('in_progress')

        yield* client['run.stop']({ project })
        yield* events.pipe(Stream.runDrain)
        yield* client['projects.remove']({ project })
        expect(yield* client['projects.list']()).toEqual([])
        expect(
          failureOf(
            yield* Effect.exit(
              client['run.start']({
                project,
                mode: RunMode.cases.tickets.make({}),
                flags: noFlags,
              }),
            ),
          ),
        ).toEqual(new ProjectNotFound({ project }))
      }),
  )
})
