import { DateTime, Duration, Effect, Layer, Option, PubSub } from 'effect'

import { beforeAll, describe, expect, it } from '@effect/vitest'

import { runProject } from '../src/run'
import { SleepCause, Slept, Wake } from '../src/time'
import {
  configOf,
  eventsOf,
  ofKind,
  options,
  project,
  setUpRuns,
  withRuns,
} from './run-harness'

// A run says each sleep of its host (spec §7.7): the wake service that counts the run's limits tells
// it of a sleep, and the run writes its `slept` record and `SLEPT:` line, after its start. The run is
// a whole run on the harness, with no tickets; its wake service is the harness's, a sleep told to
// whatever subscribes to it.

beforeAll(setUpRuns)

/** 12:03 to 12:37 in the harness's zone, UTC; the lid closed. */
const slept = new Slept({
  from: DateTime.makeUnsafe(Date.UTC(2026, 9, 29, 12, 3)),
  to: DateTime.makeUnsafe(Date.UTC(2026, 9, 29, 12, 37)),
  span: Duration.minutes(34),
  cause: Option.some(SleepCause.LidClosed()),
})

/** The harness's wake service, telling `slept` to each subscriber as it subscribes. */
const sleeping = Layer.effect(
  Wake,
  Effect.map(Wake, real =>
    Wake.of({
      ...real,
      subscribe: Effect.gen(function* () {
        const sleeps = yield* PubSub.unbounded<Slept>()
        const subscription = yield* PubSub.subscribe(sleeps)
        yield* PubSub.publish(sleeps, slept)
        return subscription
      }),
    }),
  ),
)

describe('the sleeps of a run', () => {
  it.effect("records each sleep the run's wake service sees", () =>
    Effect.gen(function* () {
      const fixture = project()
      const events = yield* withRuns(
        fixture,
        Effect.gen(function* () {
          const end = yield* runProject(configOf(fixture, options())).pipe(
            Effect.provide(sleeping),
          )
          expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
          return yield* eventsOf(fixture)
        }),
      )
      expect(
        ofKind(events, 'slept').map(({ from, to, seconds, cause, text }) => ({
          from,
          to,
          seconds,
          cause,
          text,
        })),
      ).toEqual([
        {
          from: '2026-10-29T12:03:00.000+00:00',
          to: '2026-10-29T12:37:00.000+00:00',
          seconds: 2040,
          cause: 'lid closed',
          text: "SLEPT: the host slept 34m (12:03–12:37, lid closed); limits don't count it",
        },
      ])
      const start = events.findIndex(event => event.kind === 'start')
      const sleep = events.findIndex(event => event.kind === 'slept')
      expect(start).toBeGreaterThanOrEqual(0)
      expect(sleep).toBeGreaterThan(start)
    }),
  )
})
