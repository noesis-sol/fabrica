import { Deferred, Effect, Fiber, Option, PubSub, Ref } from 'effect'
import { TestClock } from 'effect/testing'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { type Actor, type TicketId } from '@fabrica/contracts'

import { ENV_PROBE, EnvironmentProbe, ProbeOutcome } from '../src/holds'
import { WakeReason, makeRunControl, runProject } from '../src/run'
import { RunLog } from '../src/runlog'
import { WorkGraph } from '../src/workgraph'
import {
  configOf,
  eventsOf,
  file,
  ofKind,
  options,
  project,
  setUpRuns,
  settings,
  withRuns,
} from './run-harness'

// A ticket's turn counts toward the environment hold before its worker's end moves it (spec §14.1), so on a
// loaded machine the probe can pass and the hold lift with that end still on its way: the ticket goes
// straight back in the queue, as there is no probe left to wait for, and the run lasts until its wake. Each
// run here parks the tickets' workers in their ends until the hold has lifted.

beforeAll(setUpRuns)

const maintainer: Actor = { _tag: 'maintainer' }

type Graph = WorkGraph['Service']

/**
 * Which of the run's work graph's calls park, given the graph itself; what they may wait on: `parked` says
 * one has come there, `lifted` waits for the hold's lift and `lookedAgain` for a look past it, one woken by
 * a change of the work graph, to be over.
 */
type Parks = (input: {
  readonly graph: Graph
  readonly parked: Effect.Effect<void>
  readonly lifted: Effect.Effect<void>
  readonly lookedAgain: Effect.Effect<void>
}) => Partial<Graph>

/**
 * Runs the project until `workers` tickets' workers are parked by `parks`, with the environment hold on;
 * only then does the probe pass, doing `probe`. `afterLift` runs once the hold has lifted. The run's end.
 */
const runParked = (input: {
  readonly fixture: ReturnType<typeof project>
  readonly workers: number
  readonly probe: Effect.Effect<void>
  readonly afterLift: Effect.Effect<void>
  readonly parks: Parks
}) =>
  Effect.gen(function* () {
    const graph = yield* WorkGraph
    const records = yield* (yield* RunLog).subscribe
    const control = yield* makeRunControl
    const lifted = yield* Deferred.make<void>()
    const allParked = yield* Deferred.make<void>()
    const probing = yield* Deferred.make<void>()
    const lookedAgain = yield* Deferred.make<void>()
    const parkedSoFar = yield* Ref.make(0)
    const looking = yield* Ref.make(false)
    const parked = Effect.flatMap(
      Ref.updateAndGet(parkedSoFar, n => n + 1),
      n =>
        n === input.workers
          ? Deferred.succeed(allParked, undefined)
          : Effect.void,
    )
    const running = yield* Effect.forkChild(
      runProject(configOf(input.fixture, options()), {
        ...control,
        wakes: {
          wake: reason =>
            Effect.andThen(
              control.wakes.wake(reason),
              WakeReason.$is('HoldsChanged')(reason) &&
                reason.holds.on.length === 0
                ? Deferred.succeed(lifted, undefined)
                : Effect.void,
            ),
          next: Effect.gen(function* () {
            if (yield* Ref.get(looking))
              yield* Deferred.succeed(lookedAgain, undefined)
            const reasons = yield* control.wakes.next
            if (
              (yield* Deferred.isDone(lifted)) &&
              reasons.some(WakeReason.$is('TicketsChanged'))
            )
              yield* Ref.set(looking, true)
            return reasons
          }),
        },
      }).pipe(
        Effect.provideService(WorkGraph, {
          ...graph,
          ...input.parks({
            graph,
            parked,
            lifted: Deferred.await(lifted),
            lookedAgain: Deferred.await(lookedAgain),
          }),
        }),
        Effect.provideService(EnvironmentProbe, {
          probe: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(probing, undefined)
              yield* Deferred.await(allParked)
              yield* input.probe
              return ProbeOutcome.Passed()
            }),
        }),
      ),
    )
    // A run that ends without the hold is the test's failure, not its time limit.
    yield* Effect.raceFirst(
      Effect.gen(function* () {
        while (true) {
          const event = yield* PubSub.take(records)
          if (event.kind === 'hold' && event.hold === 'ENVIRONMENT') return
        }
      }),
      Fiber.await(running),
    )
    while (
      !(yield* Deferred.isDone(probing)) &&
      running.pollUnsafe() === undefined
    ) {
      yield* TestClock.adjust(ENV_PROBE)
      yield* TestClock.withLive(Effect.sleep('50 millis'))
    }
    yield* Effect.raceFirst(Deferred.await(lifted), Fiber.await(running))
    yield* input.afterLift
    return yield* Fiber.join(running)
  })

const finishes = (tickets: ReadonlyArray<TicketId>, graph: Graph) =>
  Effect.forEach(
    tickets,
    id =>
      Effect.orDie(
        graph.update({
          id,
          changes: { description: Option.some('stub: finish') },
          actor: maintainer,
        }),
      ),
    { discard: true },
  )

describe('a worker ending after the probe passed', () => {
  it.effect(
    'puts its ticket straight back in the queue, the run lasting until its wake',
    () => {
      const fixture = project({ ...settings, concurrent: 3 })
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const graph = yield* WorkGraph
          const tickets = yield* Effect.forEach(
            ['One', 'Two', 'Three'],
            title => Effect.map(file(title, 'nothing'), ({ id }) => id),
          )
          // Past the lift, the first end parks again, out of its slot and with its wake to come (those
          // behind it wait their turn to be put back), while a look comes for a change of the work graph.
          const undeferring = yield* Deferred.make<void>()
          const end = yield* runParked({
            fixture,
            workers: tickets.length,
            probe: finishes(tickets, graph),
            afterLift: Effect.andThen(
              Deferred.await(undeferring),
              finishes(tickets, graph),
            ),
            parks: ({ graph: inner, parked, lifted, lookedAgain }) => ({
              defer: request =>
                Effect.andThen(
                  Effect.andThen(parked, lifted),
                  inner.defer(request),
                ),
              undefer: request =>
                Effect.andThen(
                  Effect.andThen(
                    Deferred.succeed(undeferring, undefined),
                    lookedAgain,
                  ),
                  inner.undefer(request),
                ),
            }),
          })
          expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
          const events = yield* eventsOf(fixture)
          expect(
            ofKind(events, 'reopened').map(({ detail }) => detail),
          ).toEqual(
            tickets.map(
              () =>
                'the environment probe passed as its worker ended (it was set aside UNFINISHED)',
            ),
          )
          expect(
            ofKind(events, 'closed')
              .map(({ ticket }) => ticket)
              .toSorted(),
          ).toEqual([...tickets].toSorted())
        }),
      )
    },
  )

  it.effect(
    'sets up again a ticket whose setup failed, the probe gone by',
    () => {
      const marks = realpathSync(mkdtempSync(join(tmpdir(), 'fab-mended-')))
      const mended = join(marks, 'mended')
      // The first three trip the hold, and the fourth's failure comes while it is on.
      const fixture = project({
        ...settings,
        concurrent: 4,
        setup: `test -f ${mended}`,
      })
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const tickets = yield* Effect.forEach(
            ['One', 'Two', 'Three', 'Four'],
            title => Effect.map(file(title, 'finish'), ({ id }) => id),
          )
          const end = yield* runParked({
            fixture,
            workers: tickets.length,
            probe: Effect.sync(() => writeFileSync(mended, '')),
            afterLift: Effect.void,
            parks: ({ graph: inner, parked, lifted }) => ({
              release: request =>
                Effect.andThen(
                  Effect.andThen(parked, lifted),
                  inner.release(request),
                ),
            }),
          })
          expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
          expect(
            ofKind(yield* eventsOf(fixture), 'closed')
              .map(({ ticket }) => ticket)
              .toSorted(),
          ).toEqual([...tickets].toSorted())
        }),
      )
    },
  )
})
