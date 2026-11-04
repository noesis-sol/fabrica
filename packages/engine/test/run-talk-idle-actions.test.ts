import { Effect, Exit, Layer, Option, PubSub, Queue, Stream } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { mkdtemp } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeSocket } from '@effect/platform-node'
import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  EngineHost,
  FabricaRpcs,
  ProjectId,
  ProjectSource,
  Resume,
  type RunEvent,
  RunEventsItem,
  type RunFlags,
  RunMode,
  type RunView,
  SessionId,
  StreamEpoch,
  type TicketId,
  applyRunViewPatch,
} from '@fabrica/contracts'

import type { PiEvent } from '../src/agent'
import { pathsIn, startEngine } from '../src/engine'
import { TalkAgents, registeredModes } from '../src/talks'
import {
  type ScriptedPlaces,
  engineGit,
  makeCheckout,
  makeScriptedPlaces,
  scriptedHosting,
  scriptedSettings,
} from './scripted-run'

// The run talk's actions with no run going (spec §15.4, §18.3): `run.watchTalkActions` sends those since
// the project's last run, then each as `Runs.record` writes it, on a test engine whose talk is a scripted
// Pi session; a run's own actions stay on its events stream, and the stream goes on past its end.

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

const noFlags: RunFlags = {
  limit: Option.none(),
  offline: false,
  settings: {},
  environment: {},
  preflight: Option.none(),
}

type Call = { readonly tool: string; readonly input: unknown }

/** Talks' agents whose every message plays the calls waiting, then settles. */
const scriptedAgents = (
  calls: Queue.Queue<Call>,
  answered: Queue.Queue<Exit.Exit<unknown, unknown>>,
) =>
  Layer.succeed(TalkAgents)({
    start: options =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<PiEvent>()
        yield* Effect.addFinalizer(() => PubSub.shutdown(events))
        const scope = yield* Effect.scope
        const play = () =>
          Effect.gen(function* () {
            const waiting = yield* Queue.clear(calls)
            yield* Effect.forEach(
              waiting,
              call =>
                Effect.flatMap(Effect.exit(options.call(call)), answer =>
                  Queue.offer(answered, answer),
                ),
              { discard: true },
            )
            yield* PubSub.publish(events, {
              type: 'agent_settled',
              aborted: false,
            })
          })
        return {
          session: {
            id: SessionId.make(`s-${options.talk}`),
            file: Option.none(),
          },
          events: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
          prompt: play,
          steer: () => Effect.asVoid(Effect.forkIn(play(), scope)),
        }
      }),
  })

/** A test engine with one project, its run talk open on a scripted session. */
const newEngine = Effect.gen(function* () {
  const data = yield* Effect.promise(() =>
    mkdtemp(NodePath.join(places.root, 'e')),
  )
  const paths = pathsIn({ data, socketFolder: data })
  const calls = yield* Queue.unbounded<Call>()
  const answered = yield* Queue.unbounded<Exit.Exit<unknown, unknown>>()
  yield* startEngine({
    paths,
    host,
    release: '1.2.3',
    git: engineGit(places),
    runs: scriptedHosting(places, paths.data),
    talks: Layer.merge(registeredModes, scriptedAgents(calls, answered)),
  })
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide([
        NodeSocket.layerNet({ path: paths.socket }),
        RpcSerialization.layerNdjson,
      ]),
    ),
  )
  const client = yield* RpcClient.make(FabricaRpcs).pipe(
    Effect.provide(protocol),
  )
  const { id: project } = yield* client['projects.add']({
    source: ProjectSource.cases.path.make({
      path: makeCheckout(places, {
        ...scriptedSettings,
        model: 'anthropic/claude-opus-5-5',
      }),
    }),
    name: Option.some('work'),
  })
  const { talk } = yield* client['talk.open']({
    project,
    context: { _tag: 'run' },
    model: Option.none(),
  })
  /** A task whose stub does `script`, filed through the engine. */
  const file = (title: string, script = 'hang') =>
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
        },
      }),
      ({ id }) => id,
    )
  /** The run talk labels `ticket` `label`, as the maintainer asks: an action it records. */
  const label = Effect.fn(function* (ticket: TicketId, name: string) {
    yield* Queue.offer(calls, {
      tool: 'label_ticket',
      input: { id: ticket, add: [name] },
    })
    yield* client['talk.send']({ talk, text: `label it ${name}` })
    const answer = yield* Queue.take(answered)
    expect(Exit.isSuccess(answer)).toBe(true)
  })
  /** Each item of the stream, as it comes, on a queue. */
  const watch = Effect.fn(function* () {
    const items = yield* Queue.unbounded<RunEventsItem>()
    yield* client['run.watchTalkActions']({
      project,
      resume: Option.none(),
    }).pipe(
      Stream.runForEach(item => Queue.offer(items, item)),
      Effect.forkScoped,
    )
    return items
  })
  return { client, project, file, label, watch }
})

type Engine = Effect.Success<typeof newEngine>

/** The tool each action of `events` records. */
const tools = (events: ReadonlyArray<RunEvent>) =>
  events.map(event =>
    event.kind === 'talk_action' ? event.tool : expect.fail(event.kind),
  )

/** Starts a run whose worker hangs; its ID once its view shows the worker there. */
const startedRun = Effect.fn(function* ({ client, project }: Engine) {
  const { run } = yield* client['run.start']({
    project,
    mode: RunMode.cases.tickets.make({}),
    flags: noFlags,
  })
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
  return run
})

/** The run stopped, and gone: its records all written. */
const stoppedRun = Effect.fn(function* (
  { client, project }: Engine,
  run: RunEvent['run'],
) {
  yield* client['run.stop']({ project })
  yield* client['run.watchEvents']({
    project,
    run: Option.some(run),
    resume: Option.none(),
  }).pipe(Stream.runDrain)
})

/** A real run on the scripted agent starts a Pi stub's process, slow on a machine under load. */
const runTimeout = 60_000

describe('run.watchTalkActions', () => {
  it.live(
    'sends each action recorded with no run going as it is written, on a project that has never run',
    () =>
      Effect.gen(function* () {
        const engine = yield* newEngine
        const ticket = yield* engine.file('Later')
        const items = yield* engine.watch()
        expect(yield* Queue.take(items)).toMatchObject({
          _tag: 'snapshot',
          seq: 0,
          value: [],
        })

        yield* engine.label(ticket, 'one')
        const first = yield* Queue.take(items)
        expect(first).toMatchObject({
          _tag: 'patch',
          seq: 1,
          value: [{ kind: 'talk_action', actor: 'run_talk', ticket }],
        })
        expect(tools(first.value)).toEqual(['label_ticket'])

        yield* engine.label(ticket, 'two')
        expect(yield* Queue.take(items)).toMatchObject({
          _tag: 'patch',
          seq: 2,
        })

        // A new watcher, and one coming back to another engine's copy, are sent them together.
        const again = yield* engine.client['run.watchTalkActions']({
          project: engine.project,
          resume: Option.some(
            new Resume({ epoch: StreamEpoch.make('events-gone'), after: 1 }),
          ),
        }).pipe(Stream.take(1), Stream.runCollect)
        expect(again).toMatchObject([{ _tag: 'snapshot', seq: 2 }])
        expect(again[0]?.value).toHaveLength(2)
      }).pipe(Effect.scoped),
    runTimeout,
  )

  it.live(
    "leaves a run's own actions to its events stream, and goes on past its end",
    () =>
      Effect.gen(function* () {
        const engine = yield* newEngine
        const ticket = yield* engine.file('Never done')
        yield* engine.label(ticket, 'before')
        const items = yield* engine.watch()
        expect(tools((yield* Queue.take(items)).value)).toEqual([
          'label_ticket',
        ])

        const run = yield* startedRun(engine)
        // While a run goes a new watcher has nothing, and an action goes on the run's log.
        const during = yield* engine.client['run.watchTalkActions']({
          project: engine.project,
          resume: Option.none(),
        }).pipe(Stream.take(1), Stream.runCollect)
        expect(during).toMatchObject([{ _tag: 'snapshot', value: [] }])
        yield* engine.label(ticket, 'during')
        yield* stoppedRun(engine, run)

        // The next item is the action after the run's end: the one during it never came.
        yield* engine.label(ticket, 'after')
        const after = yield* Queue.take(items)
        expect(after).toMatchObject({
          _tag: 'patch',
          seq: 2,
          value: [{ kind: 'talk_action', run }],
        })

        // A new watcher has the actions since the run alone.
        const since = yield* engine.client['run.watchTalkActions']({
          project: engine.project,
          resume: Option.none(),
        }).pipe(Stream.take(1), Stream.runCollect)
        expect(since).toMatchObject([{ _tag: 'snapshot', seq: 1 }])
        expect(since[0]?.value).toEqual(after.value)
      }).pipe(Effect.scoped),
    runTimeout,
  )

  it.live('refuses a project the engine has not', () =>
    Effect.gen(function* () {
      const { client } = yield* newEngine
      const exit = yield* client['run.watchTalkActions']({
        project: ProjectId.make('gone'),
        resume: Option.none(),
      }).pipe(Stream.runDrain, Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }).pipe(Effect.scoped),
  )
})
