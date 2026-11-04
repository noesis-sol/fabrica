import {
  DateTime,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Stream,
} from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeSocket } from '@effect/platform-node'
import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  AgentRoleVariable,
  EngineHost,
  FabricaRpcs,
  Host,
  HostFacts,
  type NewTicket,
  type ProjectId,
  ProjectSource,
  type RunEvent,
  type RunFlags,
  RunId,
  RunMode,
  decodeEngineSettings,
} from '@fabrica/contracts'

import { type AgentStart, PiAgent } from '../src/agent'
import { pathsIn, startEngine } from '../src/engine'
import {
  MachineBudget,
  coreShare,
  makeMachineBudget,
  withCommandShare,
} from '../src/engine/budget'
import { LoadProcesses, type SampledTree } from '../src/engine/load'
import { clockHeld, makeHolds, workersHeld } from '../src/holds'
import { runProject } from '../src/run'
import { apartFromMachine, makeRunMachine } from '../src/run/machine'
import { RunLog, layerRunLog } from '../src/runlog'
import {
  configOf,
  file as fileTicket,
  project as harnessProject,
  settings as harnessSettings,
  options,
  setUpRuns,
  withRuns,
} from './run-harness'
import {
  type ScriptedPlaces,
  engineGit,
  makeCheckout,
  makeScriptedPlaces,
  scriptedHosting,
  scriptedSettings,
} from './scripted-run'

// The machine budget (spec §7.3, §14.3, H35, H56): `machine_workers`, half the host's cores and at least
// 2 by default, caps the workers live across every run; a run with a free slot and a ticket to take holds
// (`HOLD: MACHINE`) while it is reached, and goes on as one ends. It counts the slots the scheduler counts,
// so a ticket past its work isn't live. Each worker's and engine command's share of the cores is the cores
// divided among what is live, the engine's own commands counted. The host's cores are injected.

let places: ScriptedPlaces

beforeAll(() => {
  places = makeScriptedPlaces()
  setUpRuns()
})

/** A run log in a folder of its own: a hold's records are holds.test.ts's. */
const aLog = () =>
  layerRunLog({
    root: mkdtempSync(NodePath.join(places.root, 'l')),
    run: RunId.make('run-budget'),
  }).pipe(Layer.provide(DateTime.layerCurrentZoneOffset(0)))

/** The host's facts, on `cores`. */
const hostOn = (cores: number) =>
  Layer.succeed(
    Host,
    Host.of({
      facts: Effect.succeed(
        new HostFacts({
          cores,
          memoryBytes: 8 * 1024 ** 3,
          load: 0,
          home: '/nonexistent/fabrica-test-home',
        }),
      ),
    }),
  )

/** The budget of engine settings `document` on `cores`. */
const budgetOn = (cores: number, document: object = {}) =>
  Effect.flatMap(decodeEngineSettings(document), makeMachineBudget).pipe(
    Effect.provide(hostOn(cores)),
  )

describe('the budget', () => {
  const defaults: ReadonlyArray<readonly [number, number]> = [
    [2, 2],
    [3, 2],
    [10, 5],
  ]
  it.effect.each(defaults)(
    'on %d cores defaults to %d workers',
    ([cores, workers]) =>
      Effect.gen(function* () {
        expect((yield* budgetOn(cores)).limit).toBe(workers)
      }),
  )

  it.effect('takes machine_workers from the settings', () =>
    Effect.gen(function* () {
      expect((yield* budgetOn(10, { machine_workers: 3 })).limit).toBe(3)
    }),
  )

  it.effect('holds across two runs, and frees as a slot does', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const budget = yield* budgetOn(2)
        const first = yield* Ref.make(2)
        const second = yield* Ref.make(0)
        const seat = yield* budget.join(Ref.get(first))
        const other = yield* budget.join(Ref.get(second))
        expect(yield* budget.holds).toBe(true)
        expect(yield* other.claim(1)).toBe(0)

        yield* Ref.set(first, 1)
        yield* seat.moved
        expect(yield* budget.holds).toBe(false)
        expect(yield* budget.left).toBe(1)
        // The last slot goes to one claim, the other run's second ticket waiting.
        expect(yield* other.claim(2)).toBe(1)
        expect(yield* seat.claim(1)).toBe(0)
        expect(yield* budget.holds).toBe(true)

        // Its ticket's slot counts it now: the claim is over, and nothing is counted twice.
        yield* Ref.set(second, 1)
        yield* other.release
        expect(yield* budget.left).toBe(0)
      }),
    ),
  )

  it.effect(
    'says each change of the live workers, and a run gone from it',
    () =>
      Effect.gen(function* () {
        const budget = yield* budgetOn(4)
        const seen = yield* Queue.unbounded<number>()
        yield* budget.changes.pipe(
          Stream.runForEach(live => Queue.offer(seen, live)),
          Effect.forkScoped,
        )
        expect(yield* Queue.take(seen)).toBe(0)
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* budget.join(Effect.succeed(3))
            expect(yield* Queue.take(seen)).toBe(3)
          }),
        )
        expect(yield* Queue.take(seen)).toBe(0)
      }).pipe(Effect.scoped),
  )
})

describe('the shares', () => {
  it('divides the cores among what is live, at least 1', () => {
    expect(coreShare(10, { workers: 0, commands: 0 })).toBe(10)
    expect(coreShare(10, { workers: 2, commands: 0 })).toBe(5)
    expect(coreShare(10, { workers: 4, commands: 1 })).toBe(2)
    expect(coreShare(2, { workers: 2, commands: 1 })).toBe(1)
  })

  it.effect("counts the engine's own commands while they run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const budget = yield* budgetOn(12)
        yield* budget.join(Effect.succeed(3))
        expect(yield* budget.shareOf(1)).toBe(4)
        const within = yield* budget.counted(1, share =>
          Effect.map(
            budget.counted(1, inner => Effect.succeed(inner)),
            inner => [share, inner],
          ),
        )
        expect(within).toEqual([3, 2])
        expect(yield* budget.shareOf(1)).toBe(4)
        // A command isn't a worker: it holds no run.
        expect(yield* budget.counted(1, () => budget.left)).toBe(3)
      }),
    ),
  )

  it.effect('keeps the share it was given with no budget', () =>
    Effect.gen(function* () {
      expect(yield* withCommandShare(7, Effect.succeed)).toBe(7)
    }),
  )

  it.effect('gives a command the share of the budget it runs under', () =>
    withCommandShare(7, Effect.succeed).pipe(
      Effect.flatMap(share => Effect.sync(() => expect(share).toBe(10))),
      Effect.provideServiceEffect(MachineBudget, budgetOn(10)),
    ),
  )
})

describe('the holds', () => {
  it.effect("stop the hand-backs' clock, and not the workers' quiet", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const holds = yield* makeHolds({
          log: yield* RunLog,
          running: Effect.succeed(0),
        })
        yield* holds.raise({ hold: 'MACHINE', why: 'the budget is reached' })
        const snapshot = yield* holds.current
        expect(clockHeld(snapshot)).toBe(true)
        expect(workersHeld(snapshot)).toBe(false)
        expect(apartFromMachine(snapshot).on).toEqual([])
      }).pipe(Effect.provide(aLog())),
    ),
  )

  it.effect('hold a run short of what it would take, and no other', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const budget = yield* budgetOn(2)
        const taken = yield* Ref.make(2)
        const holds = yield* makeHolds({
          log: yield* RunLog,
          running: Ref.get(taken),
        })
        const machine = yield* makeRunMachine({
          holds,
          slots: Ref.get(taken),
        }).pipe(Effect.provideService(MachineBudget, budget))
        const on = Effect.map(holds.current, ({ on }) =>
          on.map(({ hold }) => hold),
        )

        // Nothing it would take: it doesn't wait on the machine.
        expect(yield* machine.claim(0)).toBe(0)
        yield* machine.settle(false)
        expect(yield* on).toEqual([])

        expect(yield* machine.claim(1)).toBe(0)
        yield* machine.settle(true)
        expect(yield* on).toEqual(['MACHINE'])

        // Lifted with room, by the look or as the budget's change is watched.
        yield* Ref.set(taken, 1)
        expect(yield* machine.left).toBe(1)
        yield* machine.settle(false)
        expect(yield* on).toEqual([])

        // A worker ended before its raise: it doesn't hold for it.
        yield* machine.settle(true)
        expect(yield* on).toEqual([])
      }).pipe(Effect.provide(aLog())),
    ),
  )
})

describe("a look's word on the hold", () => {
  it.effect('publishes the holds only where it changes them', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const budget = yield* budgetOn(2)
        const taken = yield* Ref.make(0)
        const holds = yield* makeHolds({
          log: yield* RunLog,
          running: Ref.get(taken),
        })
        const published = yield* Ref.make(0)
        yield* holds.changes.pipe(
          Stream.runForEach(() => Ref.update(published, count => count + 1)),
          Effect.forkScoped,
        )
        yield* Effect.yieldNow
        const machine = yield* makeRunMachine({
          holds,
          slots: Ref.get(taken),
        }).pipe(Effect.provideService(MachineBudget, budget))
        yield* machine.watch.pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        // Each publication wakes the run, whose look says this again: a word that changes nothing would spin it.
        const look = (short: boolean) =>
          Effect.andThen(machine.settle(short), Effect.yieldNow)
        const settled = Effect.andThen(Effect.yieldNow, Ref.get(published))
        const atStart = yield* settled

        yield* look(false)
        yield* look(false)
        expect(yield* settled).toBe(atStart)

        yield* Ref.set(taken, 2)
        yield* look(true)
        yield* look(true)
        expect(yield* settled).toBe(atStart + 1)

        yield* Ref.set(taken, 1)
        yield* look(false)
        yield* look(false)
        expect(yield* settled).toBe(atStart + 2)
      }).pipe(Effect.provide(aLog())),
    ),
  )
})

/** The agents a run is given, the services' own, their starts and processes noted. */
const notingAgents = (agents: Array<AgentStart>, pids: Array<number>) =>
  Layer.effect(
    PiAgent,
    Effect.map(PiAgent, real =>
      PiAgent.of({
        close: real.close,
        start: start => {
          agents.push(start)
          return Effect.tap(real.start(start), agent =>
            Effect.sync(() => pids.push(agent.pid)),
          )
        },
      }),
    ),
  )

describe("a worker's start", () => {
  it.effect("runs its own check on its share, not as the engine's own", () => {
    const folder = mkdtempSync(NodePath.join(places.root, 'o'))
    const own = NodePath.join(folder, 'own')
    const fixture = harnessProject({
      ...harnessSettings,
      check_own: `echo "$FABRICA_CORES" > ${own}`,
    })
    return withRuns(
      fixture,
      Effect.gen(function* () {
        yield* fileTicket('Build one', 'finish')
        const budget = yield* budgetOn(10)
        yield* runProject(configOf(fixture, options())).pipe(
          Effect.provideService(MachineBudget, budget),
        )
        // Counted among the live as a command of the engine's, it would have 5.
        expect(readFileSync(own, 'utf8').trim()).toBe('10')
      }),
    )
  })

  it.effect(
    "gives the verifier its ticket's share, and measures it too",
    () => {
      const fixture = harnessProject({
        ...harnessSettings,
        verifier: { enabled: true },
      })
      const agents: Array<AgentStart> = []
      const pids: Array<number> = []
      const tracked: Array<SampledTree> = []
      return withRuns(
        fixture,
        Effect.gen(function* () {
          yield* fileTicket('Build one', 'finish')
          const budget = yield* budgetOn(10)
          // The harness's stub is no verifier: whatever comes of its round, it started as one.
          yield* runProject(configOf(fixture, options())).pipe(
            Effect.provide(notingAgents(agents, pids)),
            Effect.provideService(MachineBudget, budget),
            Effect.provideService(LoadProcesses, {
              track: tree => Effect.sync(() => tracked.push(tree)),
            }),
          )
          const verifier = agents.findIndex(
            agent => agent.env[AgentRoleVariable] === 'verifier',
          )
          expect(verifier).toBeGreaterThan(0)
          expect(agents[verifier]?.env['FABRICA_CORES']).toBe('10')
          expect(tracked.map(({ pid }) => pid)).toEqual(
            expect.arrayContaining([pids[0], pids[verifier]]),
          )
        }),
      )
    },
  )

  it.effect('carries its share in its environment', () => {
    const fixture = harnessProject(harnessSettings)
    const agents: Array<AgentStart> = []
    return withRuns(
      fixture,
      Effect.gen(function* () {
        yield* fileTicket('Build one', 'finish')
        const budget = yield* budgetOn(10)
        yield* runProject(configOf(fixture, options())).pipe(
          Effect.provide(
            Layer.effect(
              PiAgent,
              Effect.map(PiAgent, real =>
                PiAgent.of({
                  close: real.close,
                  start: start => {
                    agents.push(start)
                    return real.start(start)
                  },
                }),
              ),
            ),
          ),
          Effect.provideService(MachineBudget, budget),
        )
        // Its slot alone on 10 cores, not the `cores: 1` the run was given.
        expect(agents[0]?.env['FABRICA_CORES']).toBe('10')
        expect(agents[0]?.env['GOFLAGS']).toBe('-p=10')
      }),
    )
  })
})

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test-host',
  cores: 4,
})

/** A test engine on the scripted agent, on `cores`, and a protocol client on its local socket. */
const newEngine = (cores: number) =>
  Effect.gen(function* () {
    const data = yield* Effect.promise(() =>
      mkdtemp(NodePath.join(places.root, 'e')),
    )
    const paths = pathsIn({ data, socketFolder: data })
    yield* startEngine({
      paths,
      host,
      release: '1.2.3',
      git: engineGit(places),
      facts: hostOn(cores),
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

type Client = Effect.Success<ReturnType<typeof newEngine>>

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

const file = (
  client: Client,
  project: ProjectId,
  title: string,
  script: string,
  files: ReadonlyArray<string> = [],
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
      metadata:
        files.length === 0
          ? Option.none()
          : Option.some({
              files: Option.some(files),
              spec: Option.none(),
              predicted_files: Option.none(),
              result_kind: Option.none(),
            }),
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

/** Starts the project's run: `until` takes its records up to one `found` matches, `seen` is every record so far, `ended` waits for its end. */
const startRun = Effect.fn(function* (
  client: Client,
  project: ProjectId,
  flags: RunFlags = noFlags,
) {
  const { run } = yield* client['run.start']({
    project,
    mode: RunMode.cases.tickets.make({}),
    flags,
  })
  const queue = yield* Queue.unbounded<RunEvent>()
  const seen = yield* Ref.make<ReadonlyArray<RunEvent>>([])
  const fiber = yield* client['run.watchEvents']({
    project,
    run: Option.some(run),
    resume: Option.none(),
  }).pipe(
    Stream.flatMap(item => Stream.fromIterable(item.value)),
    Stream.runForEach(event =>
      Effect.andThen(
        Ref.update(seen, all => [...all, event]),
        Queue.offer(queue, event),
      ),
    ),
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
  return { until, seen: Ref.get(seen), ended: Fiber.join(fiber) }
})

const isDispatch = (event: RunEvent) => event.kind === 'dispatch'
const isMachineHold = (event: RunEvent) =>
  event.kind === 'hold' && event.hold === 'MACHINE' && event.lifted !== true
const isMachineLift = (event: RunEvent) =>
  event.kind === 'hold' && event.hold === 'MACHINE' && event.lifted === true

describe('a run on the engine', () => {
  it.live(
    'holds while another run has the budget, and goes on as it ends',
    () =>
      Effect.gen(function* () {
        const client = yield* newEngine(2)
        const busy = yield* addProject(client, 'busy', {
          ...scriptedSettings,
          concurrent: 2,
        })
        yield* file(client, busy, 'First', 'hang')
        yield* file(client, busy, 'Second', 'hang')
        const waiting = yield* addProject(client, 'waiting', scriptedSettings)
        yield* file(client, waiting, 'Third', 'hang')

        const busyRun = yield* startRun(client, busy)
        yield* busyRun.until(2, isDispatch)
        const waitingRun = yield* startRun(client, waiting)
        yield* waitingRun.until(1, isMachineHold)
        expect((yield* waitingRun.seen).filter(isDispatch)).toEqual([])
        expect((yield* client['engine.status']()).liveWorkers).toBe(2)

        yield* client['run.stop']({ project: busy })
        yield* busyRun.ended
        yield* waitingRun.until(1, isMachineLift)
        yield* waitingRun.until(1, isDispatch)

        yield* client['run.stop']({ project: waiting })
        yield* waitingRun.ended
      }),
  )

  it.live('holds once what it took reaches the budget, a slot still free', () =>
    Effect.gen(function* () {
      const client = yield* newEngine(2)
      const folder = yield* Effect.promise(() =>
        mkdtemp(NodePath.join(places.root, 'g')),
      )
      const go = NodePath.join(folder, 'go')
      const ending = yield* addProject(client, 'ending', scriptedSettings)
      yield* file(client, ending, 'Ends', `wait ${go}`)
      const wanting = yield* addProject(client, 'wanting', {
        ...scriptedSettings,
        concurrent: 2,
      })
      yield* file(client, wanting, 'One', 'hang')
      yield* file(client, wanting, 'Two', 'hang')

      const endingRun = yield* startRun(client, ending)
      yield* endingRun.until(1, isDispatch)
      // One of the budget's two is left: it takes it, and waits for the other.
      const wantingRun = yield* startRun(client, wanting)
      yield* wantingRun.until(1, isDispatch)
      yield* wantingRun.until(1, isMachineHold)
      expect((yield* client['engine.status']()).liveWorkers).toBe(2)

      // Nothing of its own wakes it: the other run's worker ending does.
      writeFileSync(go, '')
      yield* endingRun.ended
      yield* wantingRun.until(1, isMachineLift)
      yield* wantingRun.until(1, isDispatch)

      yield* client['run.stop']({ project: wanting })
      yield* wantingRun.ended
    }),
  )

  it.live('holds no ticket back for one that has no slot', () =>
    Effect.gen(function* () {
      const client = yield* newEngine(2)
      const busy = yield* addProject(client, 'busy', {
        ...scriptedSettings,
        concurrent: 2,
      })
      yield* file(client, busy, 'First', 'hang')
      yield* file(client, busy, 'Second', 'hang')
      const overlapping = yield* addProject(client, 'overlapping', {
        ...scriptedSettings,
        concurrent: 2,
      })
      yield* file(client, overlapping, 'One', 'hang', ['a.ts'])
      yield* file(client, overlapping, 'Two', 'hang', ['a.ts'])

      const busyRun = yield* startRun(client, busy)
      yield* busyRun.until(2, isDispatch)
      const overlappingRun = yield* startRun(client, overlapping)
      yield* overlappingRun.until(1, isMachineHold)
      const seen = yield* overlappingRun.seen
      expect(seen.filter(isDispatch)).toEqual([])
      expect(
        seen.filter(
          event => event.kind === 'phase' && event.to === 'held_back',
        ),
      ).toEqual([])

      // Once one has a slot, the other waits on it, in words.
      yield* client['run.stop']({ project: busy })
      yield* busyRun.ended
      yield* overlappingRun.until(
        1,
        event => event.kind === 'phase' && event.to === 'held_back',
      )
      yield* overlappingRun.until(1, isDispatch)
      expect((yield* overlappingRun.seen).filter(isDispatch)).toHaveLength(1)

      yield* client['run.stop']({ project: overlapping })
      yield* overlappingRun.ended
    }),
  )

  it.live('ends at its limit, while another run has the budget', () =>
    Effect.gen(function* () {
      const client = yield* newEngine(2)
      const busy = yield* addProject(client, 'busy', {
        ...scriptedSettings,
        concurrent: 2,
      })
      yield* file(client, busy, 'First', 'hang')
      yield* file(client, busy, 'Second', 'hang')
      const limited = yield* addProject(client, 'limited', scriptedSettings)
      const folder = yield* Effect.promise(() =>
        mkdtemp(NodePath.join(places.root, 'g')),
      )
      const go = NodePath.join(folder, 'go')
      yield* file(client, limited, 'Third', `wait ${go}`)
      yield* file(client, limited, 'Fourth', `wait ${go}`)

      // Its worker's end gives the other run the budget's last slot, and it has only a ticket past its limit.
      const limitedRun = yield* startRun(client, limited, {
        ...noFlags,
        limit: Option.some(1),
      })
      yield* limitedRun.until(1, isDispatch)
      const busyRun = yield* startRun(client, busy)
      yield* busyRun.until(1, isDispatch)
      writeFileSync(go, '')
      yield* busyRun.until(1, isDispatch)
      yield* limitedRun.ended
      expect((yield* limitedRun.seen).filter(isDispatch)).toHaveLength(1)
      expect((yield* limitedRun.seen).filter(isMachineHold)).toEqual([])

      yield* client['run.stop']({ project: busy })
      yield* busyRun.ended
    }),
  )

  it.live(
    "doesn't count a merging ticket, whose check gets its own share",
    () =>
      Effect.gen(function* () {
        const client = yield* newEngine(4)
        const folder = yield* Effect.promise(() =>
          mkdtemp(NodePath.join(places.root, 'g')),
        )
        const go = NodePath.join(folder, 'go')
        const share = NodePath.join(folder, 'share')
        const merging = yield* addProject(client, 'merging', {
          ...scriptedSettings,
          check_fast: `echo "$FABRICA_CORES" > ${share}.taking; mv ${share}.taking ${share}; until [ -e ${go} ]; do sleep 0.05; done`,
        })
        yield* file(client, merging, 'Merges', 'finish')
        const mergingRun = yield* startRun(client, merging)
        yield* mergingRun.until(
          1,
          event => event.kind === 'phase' && event.to === 'merging',
        )

        // The merge check alone on 4 cores.
        const taken = yield* Effect.promise(async () => {
          for (;;) {
            const text = await readFile(share, 'utf8').catch(() => '')
            if (text !== '') return text.trim()
            await new Promise(resume => setTimeout(resume, 20))
          }
        })
        expect(taken).toBe('4')

        // 4 cores: two workers, and the merging ticket leaves both slots free.
        const other = yield* addProject(client, 'other', {
          ...scriptedSettings,
          concurrent: 2,
        })
        yield* file(client, other, 'One', 'hang')
        yield* file(client, other, 'Two', 'hang')
        const otherRun = yield* startRun(client, other)
        yield* otherRun.until(2, isDispatch)
        expect((yield* otherRun.seen).filter(isMachineHold)).toEqual([])
        expect((yield* mergingRun.seen).filter(isMachineHold)).toEqual([])

        writeFileSync(go, '')
        yield* mergingRun.ended
        yield* client['run.stop']({ project: other })
        yield* otherRun.ended
      }),
  )
})
