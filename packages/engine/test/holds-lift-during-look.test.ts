import { Deferred, Duration, Effect, Fiber, Option, PubSub, Ref } from 'effect'
import { TestClock } from 'effect/testing'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { type Actor, TicketId } from '@fabrica/contracts'

import { ENV_PROBE, EnvironmentProbe, ProbeOutcome } from '../src/holds'
import { WakeReason, makeRunControl, runProject } from '../src/run'
import { keepsRun } from '../src/run/holds'
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

// A look that reads its tickets as waiting for the probe, and the holds only at its end (spec §14, §14.1):
// the probe's outcome landing between the two is not a run with nothing left to do. Each run here parks
// such a look in the footprints gate, past its read of the run's state, until the outcome's wake is given.

beforeAll(setUpRuns)

const maintainer: Actor = { _tag: 'maintainer' }

/**
 * Runs the project until the tickets settle idle and the environment hold probes. The probe wakes a look
 * with a change of the work graph, gives `outcome` once that look is parked in the gate, and the look goes
 * on once a wake says the outcome is in; the run's end.
 */
const runParked = (input: {
  readonly fixture: ReturnType<typeof project>
  readonly tickets: ReadonlyArray<TicketId>
  readonly outcome: ProbeOutcome
  readonly outcomeIn: (reason: WakeReason) => boolean
}) =>
  Effect.gen(function* () {
    const graph = yield* WorkGraph
    const records = yield* (yield* RunLog).subscribe
    const armed = yield* Ref.make(false)
    const parked = yield* Deferred.make<void>()
    const goOn = yield* Deferred.make<void>()
    const probing = yield* Deferred.make<void>()
    const control = yield* makeRunControl
    const probe = Effect.gen(function* () {
      yield* Deferred.succeed(probing, undefined)
      yield* Ref.set(armed, true)
      // The tickets' workers finish once taken again; the update wakes the look that parks.
      yield* Effect.forEach(
        input.tickets,
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
      yield* Deferred.await(parked)
      return input.outcome
    })
    const running = yield* Effect.forkChild(
      runProject(configOf(input.fixture, options()), {
        ...control,
        wakes: {
          ...control.wakes,
          wake: reason =>
            Effect.andThen(
              control.wakes.wake(reason),
              input.outcomeIn(reason)
                ? Deferred.succeed(goOn, undefined)
                : Effect.void,
            ),
        },
      }).pipe(
        Effect.provideService(WorkGraph, {
          ...graph,
          unfinishedParents: found =>
            Effect.andThen(
              Effect.flatMap(Ref.getAndSet(armed, false), park =>
                park
                  ? Effect.andThen(
                      Deferred.succeed(parked, undefined),
                      Deferred.await(goOn),
                    )
                  : Effect.void,
              ),
              graph.unfinishedParents(found),
            ),
        }),
        Effect.provideService(EnvironmentProbe, { probe: () => probe }),
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
    // The probe's wait begins as the hold's tickets are put back: the clock moves on until it probes.
    while (
      !(yield* Deferred.isDone(probing)) &&
      running.pollUnsafe() === undefined
    ) {
      yield* TestClock.adjust(ENV_PROBE)
      yield* TestClock.withLive(Effect.sleep(Duration.millis(50)))
    }
    return yield* Fiber.join(running)
  })

describe('the probe answering during a look', () => {
  it.effect(
    'takes the tickets it freed again, rather than ending the run',
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
          const end = yield* runParked({
            fixture,
            tickets,
            outcome: ProbeOutcome.Passed(),
            outcomeIn: reason =>
              WakeReason.$is('HoldsChanged')(reason) &&
              reason.holds.on.length === 0,
          })
          expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
          expect(
            ofKind(yield* eventsOf(fixture), 'closed')
              .map(({ ticket }) => ticket)
              .toSorted(),
          ).toEqual([...tickets].toSorted())
          for (const id of tickets)
            expect((yield* graph.show(id)).ticket.status).toBe('closed')
        }),
      )
    },
    // Six dispatches and three merges, each a process of its own.
    30_000,
  )

  it.effect(
    'stops the run with exit 7 where it failed, rather than ending it as empty',
    () => {
      const fixture = project({ ...settings, concurrent: 3 })
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const tickets = yield* Effect.forEach(
            ['One', 'Two', 'Three'],
            title => Effect.map(file(title, 'nothing'), ({ id }) => id),
          )
          const end = yield* runParked({
            fixture,
            tickets,
            outcome: ProbeOutcome.Failed({ reason: 'Pi did not start' }),
            outcomeIn: WakeReason.$is('Stopped'),
          })
          expect(end).toEqual({ kind: 'ENVIRONMENT', code: 7 })
        }),
      )
    },
    // Three dispatches, each a process of its own.
    30_000,
  )
})

describe('whether the holds keep a look from ending the run', () => {
  const none = { on: [], gaveUp: Option.none() }
  const on = {
    on: [
      {
        hold: 'ENVIRONMENT' as const,
        provider: Option.none(),
        why: '3 tickets in a row settled idle',
        since: 0,
        lifts: Option.none(),
      },
    ],
    gaveUp: Option.none(),
  }
  const gaveUp = {
    ...on,
    gaveUp: Option.some({
      kind: 'ENVIRONMENT' as const,
      ticket: Option.none<TicketId>(),
      detail: 'the environment probe failed',
    }),
  }

  it('lets it end with none on, as it heard them', () => {
    expect(keepsRun({ holds: none, heard: none })).toBe(false)
  })

  it('keeps the run on a hold that can lift', () => {
    expect(keepsRun({ holds: on, heard: on })).toBe(true)
  })

  it('lets it end on a hold that gave up, as it heard it', () => {
    expect(keepsRun({ holds: gaveUp, heard: gaveUp })).toBe(false)
  })

  it('keeps the run on a change it has not heard of', () => {
    expect(keepsRun({ holds: { ...none }, heard: on })).toBe(true)
    expect(keepsRun({ holds: gaveUp, heard: on })).toBe(true)
  })
})
