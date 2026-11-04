import { Duration, Effect, Layer, Option } from 'effect'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import {
  InsightsQuery,
  ProjectId,
  Retention as RetentionSetting,
  RunId,
  TicketId,
} from '@fabrica/contracts'

import { eventsPath } from '../src/runlog'
import { Telemetry, makeTelemetry, telemetryStoreLayer } from '../src/telemetry'
import { TelemetryDb, telemetryDbLayer } from '../src/telemetry/duckdb'
import { runNamedQuery } from '../src/telemetry/queries'

// A question `--auto-answer` answered in Insights' `waits` (spec §15.2, §21): answered at once, its
// `auto_answered` is usually written before its worker's `asked`, as the session takes longer to close
// than the answer to give. That is no wait, and no question left waiting.

const project = ProjectId.make('project-1')
const run = RunId.make('run-1')
const ticket = TicketId.make('fa-a1b2')

const retention = {
  raw: RetentionSetting.cases.For.make({ duration: Duration.days(90) }),
  daily: RetentionSetting.cases.Forever.make({}),
}

const queryLayer = Layer.mergeAll(
  Layer.effect(Telemetry, makeTelemetry({ retention })),
  telemetryDbLayer(':memory:'),
).pipe(Layer.provideMerge(telemetryStoreLayer(':memory:')))

/** A record of the run's stream, at `clock`. */
const record = (
  clock: string,
  kind: string,
  fields: Readonly<Record<string, unknown>>,
) => ({ v: 1, time: `2026-10-29T${clock}.000+02:00`, run, kind, ...fields })

const asked = (clock: string, question: string) =>
  record(clock, 'asked', {
    ticket,
    title: 'First',
    question,
    detail: `${question} Which?`,
    text: 'asked',
  })

const autoAnswered = (clock: string, question: string) =>
  record(clock, 'auto_answered', {
    ticket,
    question,
    title: 'Which?',
    option: 'SQLite',
    text: 'answered',
  })

/** The `question` row of the `waits` query over a stream of `events`. */
const questionWaits = (events: ReadonlyArray<unknown>) =>
  Effect.acquireUseRelease(
    Effect.promise(() =>
      mkdtemp(NodePath.join(tmpdir(), 'fabrica-auto-answer-insights-')),
    ),
    checkout =>
      Effect.gen(function* () {
        const file = NodePath.join(checkout, eventsPath)
        yield* Effect.promise(async () => {
          await mkdir(NodePath.dirname(file), { recursive: true })
          await writeFile(
            file,
            `${events.map(line => JSON.stringify(line)).join('\n')}\n`,
          )
        })
        yield* (yield* TelemetryDb).refresh([])
        const table = yield* runNamedQuery(
          InsightsQuery.cases.waits.make({
            project: Option.some(project),
            since: Option.none(),
          }),
          { events: [{ project, file }], sessions: [] },
        )
        return table.rows
          .map(row =>
            Object.fromEntries(
              table.columns.map(({ name }, index) => [
                name,
                Option.getOrNull(row[index] ?? Option.none()),
              ]),
            ),
          )
          .find(row => row['wait'] === 'question')
      }),
    checkout =>
      Effect.promise(() => rm(checkout, { recursive: true, force: true })),
  )

describe('a question --auto-answer answered, in the waits', () => {
  it.effect(
    'answered before its asked was written, it waited for nothing',
    () =>
      Effect.gen(function* () {
        expect(
          yield* questionWaits([
            autoAnswered('10:00:00', 'fa-q1'),
            asked('10:00:05', 'fa-q1'),
          ]),
        ).toMatchObject({ asked: 1, median: 0, longest: 0, waiting: 0 })
      }).pipe(Effect.provide(queryLayer)),
  )

  it.effect('answered after a wait, it waited that long', () =>
    Effect.gen(function* () {
      expect(
        yield* questionWaits([
          asked('10:00:00', 'fa-q1'),
          autoAnswered('10:10:00', 'fa-q1'),
        ]),
      ).toMatchObject({
        asked: 1,
        median: 600_000,
        longest: 600_000,
        waiting: 0,
      })
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect("another question's earlier answer doesn't answer it", () =>
    Effect.gen(function* () {
      expect(
        yield* questionWaits([
          autoAnswered('10:00:00', 'fa-q1'),
          asked('10:00:05', 'fa-q1'),
          asked('10:05:00', 'fa-q2'),
        ]),
      ).toMatchObject({ asked: 2, waiting: 1 })
    }).pipe(Effect.provide(queryLayer)),
  )
})
