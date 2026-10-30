import { Effect, Exit } from 'effect'
import { readdir } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { expect, layer } from '@effect/vitest'
import { layerToolbox, tempFolder } from '@fabrica/testkit'

import { fabrica, onlyJson, testEngine } from './tickets-engine'

// `fabrica insights export <folder>` (spec §19, §21): run as the CLI's entry runs it, against an engine
// started in a temporary data folder, whose telemetry holds nothing yet; the engine writes a Parquet
// file per recorded table in the folder, making it, and the command lists them.

/** The tables an export writes, one file each. */
const tables = [
  'model_calls',
  'tool_calls',
  'checks',
  'merges',
  'hand_backs',
  'holds',
  'worker_sessions',
  'organ_calls',
  'host_samples',
  'process_samples',
  'daily',
]

// The engine runs on the live clock: its sockets and its git's time limits are real.
layer(layerToolbox({ tools: ['git'] }), { excludeTestServices: true })(
  'fabrica insights export',
  it => {
    it.effect('writes the recorded rows as Parquet files, and lists them', () =>
      Effect.gen(function* () {
        const { socket } = yield* testEngine
        const folder = NodePath.join(
          yield* tempFolder('insights-export'),
          'today',
        )
        const listed = yield* fabrica(socket, 'insights', 'export', folder)
        expect(listed.exit).toStrictEqual(Exit.void)
        expect(listed.out.join('\n').split('\n')).toEqual(
          tables.map(table => NodePath.join(folder, `${table}.parquet`)),
        )
        expect(
          (yield* Effect.promise(() => readdir(folder))).toSorted(),
        ).toEqual(tables.map(table => `${table}.parquet`).toSorted())

        const json = yield* fabrica(
          socket,
          'insights',
          'export',
          folder,
          '--json',
        )
        expect(json.exit).toStrictEqual(Exit.void)
        expect(onlyJson(json.out)).toStrictEqual({
          files: tables.map(table => NodePath.join(folder, `${table}.parquet`)),
        })
      }).pipe(Effect.scoped),
    )

    it.effect('says why where the folder can’t be made', () =>
      Effect.gen(function* () {
        const { socket } = yield* testEngine
        const root = yield* tempFolder('insights-export')
        // A file where a folder is wanted.
        const first = yield* fabrica(
          socket,
          'insights',
          'export',
          NodePath.join(root, 'out'),
        )
        expect(first.exit).toStrictEqual(Exit.void)
        const failed = yield* fabrica(
          socket,
          'insights',
          'export',
          NodePath.join(root, 'out', 'checks.parquet', 'more'),
        )
        expect(Exit.isFailure(failed.exit)).toBe(true)
        expect(failed.err.join('\n')).toMatch(/^fabrica: the export failed: /u)
      }).pipe(Effect.scoped),
    )
  },
)
