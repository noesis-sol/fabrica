import { Effect, Layer } from 'effect'
import * as NodeOs from 'node:os'

import { Host, HostFacts } from '@fabrica/contracts'

// The live `Host` (spec §24, H55): the host's cores, memory, 1-minute load and home folder, read from
// `node:os` on every read of `facts`. It is the one place the engine reads them; every other module
// asks `Host`, so a test injects them (`@fabrica/testkit`'s `layerHost`).

/** The reads of `node:os` the host's facts come from. */
export interface HostReads {
  readonly availableParallelism: () => number
  readonly totalmem: () => number
  readonly loadavg: () => ReadonlyArray<number>
  readonly homedir: () => string
}

/** The host's facts as `reads` give them now. */
export const readHostFacts = (reads: HostReads): HostFacts =>
  new HostFacts({
    cores: reads.availableParallelism(),
    memoryBytes: reads.totalmem(),
    // Windows keeps no load average: `os.loadavg()` gives zeros there.
    load: reads.loadavg()[0] ?? 0,
    home: reads.homedir(),
  })

/** The `Host` service reading `reads` on every read of `facts`. */
export const layerHostFrom = (reads: HostReads): Layer.Layer<Host> =>
  Layer.succeed(
    Host,
    Host.of({
      facts: Effect.sync(() => readHostFacts(reads)).pipe(
        Effect.withSpan('Host.facts'),
      ),
    }),
  )

/** The `Host` service reading this machine, through `node:os`. */
export const layerNodeHost: Layer.Layer<Host> = layerHostFrom(NodeOs)
