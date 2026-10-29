import { Effect } from 'effect'

import { describe, expect, it } from '@effect/vitest'
import { Host, HostFacts } from '@fabrica/contracts'

import { type HostReads, layerHostFrom, readHostFacts } from '../src/host'

// The live `Host` layer, given its reads of `node:os`: the machine's own are never read here (H55).

const reads = (overrides: Partial<HostReads> = {}): HostReads => ({
  availableParallelism: () => 3,
  totalmem: () => 16 * 1024 ** 3,
  loadavg: () => [1.5, 1.25, 1],
  homedir: () => '/home/ada',
  ...overrides,
})

describe('readHostFacts', () => {
  it('takes the cores, memory, 1-minute load and home folder', () => {
    expect(readHostFacts(reads())).toEqual(
      new HostFacts({
        cores: 3,
        memoryBytes: 16 * 1024 ** 3,
        load: 1.5,
        home: '/home/ada',
      }),
    )
  })

  it('gives a load of 0 where the OS keeps none', () => {
    expect(readHostFacts(reads({ loadavg: () => [0, 0, 0] })).load).toBe(0)
    expect(readHostFacts(reads({ loadavg: () => [] })).load).toBe(0)
  })
})

describe('layerHostFrom', () => {
  it.effect('reads the host again on every read of its facts', () =>
    Effect.gen(function* () {
      let load = 0.5
      const layer = layerHostFrom(reads({ loadavg: () => [load, 0, 0] }))
      const [first, second] = yield* Effect.gen(function* () {
        const host = yield* Host
        const first = yield* host.facts
        load = 2
        const second = yield* host.facts
        return [first, second] as const
      }).pipe(Effect.provide(layer))
      expect(first.load).toBe(0.5)
      expect(second.load).toBe(2)
    }),
  )
})
