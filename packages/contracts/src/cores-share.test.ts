import { Effect } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import { coresShare, decodeEngineSettings, machineWorkersOf } from './settings'

// The machine budget's share of the cores (spec §7.3): the workers live across every run, the
// engine's `machine_workers` or half the cores, and each worker's and check's share of the cores.

describe('the machine budget', () => {
  it.effect.each([
    [{}, 10, 5, 2],
    [{}, 3, 2, 1],
    [{ machine_workers: 3 }, 10, 3, 3],
    [{ machine_workers: 16 }, 8, 16, 1],
    [{ machine_workers: 1 }, 1, 1, 1],
  ])(
    'settings %j on %d cores: %d workers, each with %d cores',
    ([settings, cores, workers, share]) =>
      Effect.gen(function* () {
        const decoded = yield* decodeEngineSettings(settings)
        expect(machineWorkersOf(decoded, cores)).toBe(workers)
        expect(coresShare(decoded, cores)).toBe(share)
      }),
  )
})
