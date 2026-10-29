import { Effect, Exit, Option } from 'effect'

import { describe, expect, it, layer } from '@effect/vitest'
import { InsightsColumn, InsightsTable } from '@fabrica/contracts'
import { layerToolbox } from '@fabrica/testkit'

import { tableText } from '../src/cli/insights'
import { fabrica, onlyJson, testEngine } from './tickets-engine'

// `fabrica insights [<query>]` (spec §19, §21): run as the CLI's entry runs it, against an engine
// started in a temporary data folder with the project `work`, whose telemetry holds nothing yet; the
// engine opens its query layer, DuckDB, on the first request.

describe('tableText', () => {
  it('shows each cell by its column’s unit, under the columns’ names', () => {
    const table = new InsightsTable({
      columns: [
        new InsightsColumn({ name: 'model', unit: 'text' }),
        new InsightsColumn({ name: 'median', unit: 'millis' }),
        new InsightsColumn({ name: 'cost', unit: 'usd' }),
        new InsightsColumn({ name: 'share', unit: 'share' }),
        new InsightsColumn({ name: 'last', unit: 'time' }),
        new InsightsColumn({ name: 'tokens', unit: 'tokens' }),
      ],
      rows: [
        [
          Option.some('claude-opus-5-5'),
          Option.some(90_000),
          Option.some(0.125),
          Option.some(0.5),
          Option.some(Date.UTC(2026, 9, 29, 8)),
          Option.some(1200),
        ],
        [
          Option.some('gpt-5\u001b[31m'),
          Option.none(),
          Option.none(),
          Option.none(),
          Option.none(),
          Option.none(),
        ],
      ],
    })
    expect(tableText(table).split('\n')).toEqual([
      'model            median  cost   share  last                      tokens',
      'claude-opus-5-5  1m30s   $0.13  50%    2026-10-29T08:00:00.000Z  1200',
      'gpt-5\\u001b[31m  -       -      -      -                         -',
    ])
  })

  it('says so where nothing is recorded', () => {
    expect(
      tableText(
        new InsightsTable({
          columns: [new InsightsColumn({ name: 'suite', unit: 'text' })],
          rows: [],
        }),
      ),
    ).toBe('nothing recorded yet')
  })
})

// The engine runs on the live clock: its sockets and its git's time limits are real.
layer(layerToolbox({ tools: ['git'] }), { excludeTestServices: true })(
  'fabrica insights',
  it => {
    it.effect('sums up the telemetry, and runs a named query', () =>
      Effect.gen(function* () {
        const { socket } = yield* testEngine
        const summary = yield* fabrica(
          socket,
          'insights',
          '--project',
          'work',
          '--json',
        )
        expect(summary.exit).toStrictEqual(Exit.void)
        expect(onlyJson(summary.out)).toStrictEqual({
          runs: 0,
          merged: 0,
          setAside: 0,
          handBacks: { resolve: 0, fix: 0 },
          tokens: {},
          costUsd: null,
          readyToMerged: null,
        })
        const text = yield* fabrica(socket, 'insights')
        expect(text.out.join('\n')).toContain('cost             not priced')

        const rates = yield* fabrica(socket, 'insights', 'hand_back_rates')
        expect(rates.exit).toStrictEqual(Exit.void)
        expect(rates.out.join('\n').split('\n')).toEqual([
          'outcome            tickets  share',
          'hand_back:fix      0        -',
          'hand_back:resolve  0        -',
          'merged             0        -',
          'set_aside          0        -',
        ])

        const checks = yield* fabrica(
          socket,
          'insights',
          'check_durations',
          '--suite',
          'merge',
          '--since',
          '2026-10-25',
        )
        expect(checks.exit).toStrictEqual(Exit.void)
        expect(checks.out).toStrictEqual(['nothing recorded yet'])

        const time = yield* fabrica(
          socket,
          'insights',
          'ticket_time',
          '--project',
          'work',
          '--ticket',
          'fa-a1b2',
          '--json',
        )
        expect(time.exit).toStrictEqual(Exit.void)
        expect(onlyJson(time.out)).toMatchObject({ rows: [] })
      }).pipe(Effect.scoped),
    )

    it.effect('refuses a project the engine doesn’t have', () =>
      Effect.gen(function* () {
        const { socket } = yield* testEngine
        const missing = yield* fabrica(
          socket,
          'insights',
          'waits',
          '--project',
          'nope',
        )
        expect(Exit.isFailure(missing.exit)).toBe(true)
        expect(missing.err).toStrictEqual([
          'fabrica: the engine has no project nope',
        ])
      }).pipe(Effect.scoped),
    )
  },
)
