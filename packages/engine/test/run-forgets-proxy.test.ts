import { Deferred, Effect, Fiber, Ref } from 'effect'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { RunId } from '@fabrica/contracts'

import { ModelProxy } from '../src/proxy'
import { makeRunControl, runProject } from '../src/run'
import {
  configOf,
  file,
  options,
  project,
  setUpRuns,
  withRuns,
} from './run-harness'

// What the engine's model proxy kept of a run goes with the run (spec §7.1, H77), however it ends: the
// proxy outlives its runs. Whole runs on the harness, the live proxy's `forgetRun` noted as it is called.

beforeAll(() => {
  setUpRuns()
})

const run = RunId.make('run-1')

/** What `body` gives, and the runs the proxy was asked to forget as it ran. */
const noted = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const forgotten = yield* Ref.make<ReadonlyArray<RunId>>([])
    const result = yield* body.pipe(
      Effect.updateService(ModelProxy, live =>
        ModelProxy.of({
          ...live,
          forgetRun: id =>
            Effect.andThen(
              Ref.update(forgotten, all => [...all, id]),
              live.forgetRun(id),
            ),
        }),
      ),
    )
    return { result, forgotten: yield* Ref.get(forgotten) }
  })

describe('a run ending', () => {
  it.live('that ran out of tickets forgets itself on the proxy', () => {
    const fixture = project()
    const config = configOf(fixture, options())
    return withRuns(
      fixture,
      noted(runProject(config)).pipe(
        Effect.tap(({ result, forgotten }) =>
          Effect.sync(() => {
            expect(result.code).toBe(0)
            expect(forgotten).toEqual([run])
          }),
        ),
      ),
    )
  })

  it.live('that was stopped with a worker going forgets itself', () => {
    const fixture = project()
    const config = configOf(fixture, options())
    return withRuns(
      fixture,
      Effect.gen(function* () {
        yield* file('Never done', 'hang')
        const control = yield* makeRunControl
        const going = yield* noted(runProject(config, control)).pipe(
          Effect.forkChild,
        )
        yield* Deferred.await(control.checked)
        yield* control.stop
        const { result, forgotten } = yield* Fiber.join(going)
        expect(result.code).toBe(130)
        expect(forgotten).toEqual([run])
      }),
    )
  })

  it.live('that its start checks refused forgets itself', () => {
    const fixture = project()
    const config = configOf(fixture, options())
    return withRuns(
      fixture,
      noted(runProject(config)).pipe(
        Effect.tap(({ result, forgotten }) =>
          Effect.sync(() => {
            expect(result.code).toBe(2)
            expect(forgotten).toEqual([run])
          }),
        ),
      ),
      'refuses',
    )
  })
})
