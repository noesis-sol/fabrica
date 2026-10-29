import { Effect } from 'effect'

import { describe, expect, it } from '@effect/vitest'
import { layerHostFrom } from '@fabrica/engine'

import { engineHost, hostFacts } from './host'

// The command's host: its home folder and cores are the `Host` service's, never the machine's (H55).

const layer = layerHostFrom({
  availableParallelism: () => 3,
  totalmem: () => 8 * 1024 ** 3,
  loadavg: () => [0, 0, 0],
  homedir: () => '/home/ada',
})

describe('host', () => {
  it.effect("gives the engine's status the Host's cores", () =>
    Effect.gen(function* () {
      const host = yield* hostFacts.pipe(Effect.flatMap(engineHost))
      expect(host.cores).toBe(3)
    }).pipe(Effect.provide(layer)),
  )
})
