import { Effect, Fiber, Layer, PubSub, Ref } from 'effect'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  Host,
  HostFacts,
  type RunEvent,
  type TicketId,
  decodeEngineSettings,
} from '@fabrica/contracts'

import {
  MachineBudget,
  type RunSeat,
  makeMachineBudget,
} from '../src/engine/budget'
import { runProject } from '../src/run'
import { RunLog } from '../src/runlog'
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

// The merge train takes no rider while the machine budget holds (spec §13.7, §14.3): the run gives its
// queue the budget's word where it builds it. Here a test's seat stands for another run's workers, so
// the budget is reached with this run's tickets in line, and each run has one ticket's check under way,
// two waiting: the next to check would take the other beside it.

beforeAll(setUpRuns)

const WORKERS = 3

/** A budget of `WORKERS`, and a seat for what the test counts as another run's live workers. */
const budgetWithOthers = Effect.gen(function* () {
  const others = yield* Ref.make(0)
  const budget = yield* Effect.flatMap(
    decodeEngineSettings({ machine_workers: WORKERS }),
    makeMachineBudget,
  ).pipe(
    Effect.provide(
      Layer.succeed(
        Host,
        Host.of({
          facts: Effect.succeed(
            new HostFacts({
              cores: 10,
              memoryBytes: 8 * 1024 ** 3,
              load: 0,
              home: '/nonexistent/fabrica-test-home',
            }),
          ),
        }),
      ),
    ),
  )
  const seat: RunSeat = yield* budget.join(Ref.get(others))
  /** `count` workers are live in the other run. */
  const othersLive = (count: number) =>
    Effect.andThen(Ref.set(others, count), seat.moved)
  return { budget, othersLive }
})

/** Takes records from `records` until `count` of them are ones `found` takes. */
const until = (
  records: PubSub.Subscription<RunEvent>,
  count: number,
  found: (event: RunEvent) => boolean,
) =>
  Effect.gen(function* () {
    for (let left = count; left > 0;)
      if (found(yield* PubSub.take(records))) left -= 1
  })

/** One of `tickets` moving to the phase `to`. */
const movedTo =
  (tickets: ReadonlyArray<TicketId>, to: string) => (event: RunEvent) =>
    event.kind === 'phase' && event.to === to && tickets.includes(event.ticket)

/** A project whose merge checks say so at `waiting`, for the tickets that wait on the first, and wait for `go`. */
const trainProject = () => {
  const folder = mkdtempSync(join(tmpdir(), 'fab-mt-'))
  const waiting = join(folder, 'first-checking')
  const go = join(folder, 'go')
  const fixture = project({
    ...settings,
    concurrent: WORKERS,
    check_fast: `touch ${waiting}; until [ -e ${go} ]; do sleep 0.05; done`,
  })
  return { fixture, waiting, go }
}

/**
 * Runs the project: one ticket's merge check under way and two more in line, it does `meanwhile` with the
 * two's IDs, and then the check goes on. The merge checks the run recorded.
 */
const runWithTwoInLine = <E, R>(
  { fixture, waiting, go }: ReturnType<typeof trainProject>,
  {
    budget,
    meanwhile,
  }: {
    readonly budget: Effect.Success<typeof budgetWithOthers>['budget']
    readonly meanwhile: (input: {
      readonly records: PubSub.Subscription<RunEvent>
      readonly release: Effect.Effect<void>
      readonly inLine: ReadonlyArray<TicketId>
    }) => Effect.Effect<void, E, R>
  },
) =>
  Effect.gen(function* () {
    const records = yield* (yield* RunLog).subscribe
    const first = yield* file('First', 'finish')
    const second = yield* file('Second', `wait ${waiting}`)
    const third = yield* file('Third', `wait ${waiting}`)
    const inLine = [second.id, third.id]
    const running = yield* Effect.forkChild(
      runProject(configOf(fixture, options())).pipe(
        Effect.provideService(MachineBudget, budget),
      ),
    )
    yield* until(records, 2, movedTo(inLine, 'waiting_to_merge'))
    yield* meanwhile({
      records,
      release: Effect.sync(() => writeFileSync(go, '')),
      inLine,
    })
    yield* Fiber.join(running)
    const merged = ofKind(yield* eventsOf(fixture), 'check').filter(
      check => check.suite === 'merge',
    )
    return { merged, first: first.id, inLine }
  })

describe('the merge train under the machine budget', () => {
  it.effect('takes a rider while the budget has room', () => {
    const train = trainProject()
    return withRuns(
      train.fixture,
      Effect.gen(function* () {
        const { budget } = yield* budgetWithOthers
        const { merged, first, inLine } = yield* runWithTwoInLine(train, {
          budget,
          meanwhile: ({ release }) => release,
        })
        const ridden = merged.filter(check => check.train === true)
        expect(ridden).toHaveLength(1)
        expect(inLine).toContain(ridden[0]?.ticket)
        expect(merged.map(check => check.ticket)).toContain(first)
      }),
    )
  })

  it.effect(
    'takes none under HOLD: MACHINE, and each merges by its own check',
    () => {
      const train = trainProject()
      return withRuns(
        train.fixture,
        Effect.gen(function* () {
          const { budget, othersLive } = yield* budgetWithOthers
          const { merged, first, inLine } = yield* runWithTwoInLine(train, {
            budget,
            meanwhile: ({ records, release, inLine }) =>
              Effect.gen(function* () {
                // Past their work the run's tickets hold no slot: the others' workers reach the budget.
                yield* othersLive(WORKERS)
                const later = yield* file('Later', 'finish')
                yield* until(
                  records,
                  1,
                  event =>
                    event.kind === 'hold' &&
                    event.hold === 'MACHINE' &&
                    event.lifted !== true,
                )
                yield* release
                yield* until(records, 2, movedTo(inLine, 'merged'))
                // Only what was in line went on under the hold: the ticket it held waits for a slot.
                expect(yield* eventsOf(train.fixture)).not.toContainEqual(
                  expect.objectContaining({
                    kind: 'dispatch',
                    ticket: later.id,
                  }),
                )
                yield* othersLive(0)
              }),
          })
          expect(merged.filter(check => check.train === true)).toEqual([])
          expect(merged.map(check => check.ticket)).toEqual(
            expect.arrayContaining([first, ...inLine]),
          )
          expect(merged).toHaveLength(4)
        }),
      )
    },
  )
})
