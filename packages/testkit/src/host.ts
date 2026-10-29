import { Effect, Layer } from 'effect'

import { Host, HostFacts } from '@fabrica/contracts'

// Injected host facts (spec §24, H55): a test is given its host's cores, memory, load and home, never
// the machine's. The defaults are a CI runner's: 2 cores, as on the runner where a test that read the
// machine's cores failed, and a home folder that doesn't exist, so a test writing there names one.

/** Host facts: the defaults, with `overrides`. */
export const hostFacts = (
  overrides: Partial<ConstructorParameters<typeof HostFacts>[0]> = {},
): HostFacts =>
  new HostFacts({
    cores: 2,
    memoryBytes: 8 * 1024 ** 3,
    load: 0,
    home: '/nonexistent/fabrica-test-home',
    ...overrides,
  })

/** The `Host` service, giving `facts` on every read. */
export const layerHost = (facts: HostFacts = hostFacts()): Layer.Layer<Host> =>
  Layer.succeed(Host, Host.of({ facts: Effect.succeed(facts) }))
