import { Effect, Layer, Ref } from 'effect'

import { beforeAll, describe, expect, it } from '@effect/vitest'

import { Telemetry, type TelemetryRow, nothingMeasured } from '../src/telemetry'
import {
  project,
  run,
  runOne,
  setUpFixtures,
  wholeRun,
} from './verifier-harness'

// The gate's decisions in a whole run (spec §12.6): what a ticket's worker and its verifier report is
// recorded under the run and the ticket, which the run's counts are read by.

beforeAll(setUpFixtures)

describe('a run', () => {
  it.effect(
    "records the gate's decisions of a ticket's worker and verifier under the run and the ticket",
    () =>
      Effect.gen(function* () {
        const rows = yield* Ref.make<ReadonlyArray<TelemetryRow>>([])
        const { id, end } = yield* runOne(
          project(),
          'GATE',
          () => Effect.void,
          Layer.succeed(Telemetry)(
            Telemetry.of({
              record: row => Ref.update(rows, all => [...all, row]),
              flush: Effect.void,
              projectSpent: () => Effect.succeed(nothingMeasured),
            }),
          ),
        )
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        const recorded = yield* Ref.get(rows)
        expect(
          recorded.flatMap(row =>
            row._tag === 'ToolCall'
              ? [[row.run, row.ticket, row.tool, row.allowed, row.reason]]
              : [],
          ),
        ).toEqual([
          [run, id, 'read', true, undefined],
          [run, id, 'bash', false, 'git push: workers never push'],
        ])
      }),
    wholeRun,
  )
})
