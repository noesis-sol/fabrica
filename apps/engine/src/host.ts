import { Effect, Option, Schema } from 'effect'
import { arch, availableParallelism, homedir, hostname } from 'node:os'

import { EngineHost, Platform } from '@fabrica/contracts'
import { Daemon } from '@fabrica/engine'

// The engine's host, read once as `fabrica serve` or `fabrica bridge` starts: where the engine's files
// are (spec §7.2) and what its status says of the machine (§8.1).

/** The engine's files on this host. */
export const hostPaths = Effect.suspend(() =>
  Effect.fromResult(
    Daemon.enginePaths({
      platform: process.platform,
      home: homedir(),
      environment: process.env,
    }),
  ),
)

/** The machine the engine runs on. */
export const engineHost = Effect.suspend(() =>
  Option.match(Schema.decodeUnknownOption(Platform)(process.platform), {
    onNone: () =>
      Effect.fail(
        new Daemon.UnsupportedPlatform({ platform: process.platform }),
      ),
    onSome: platform =>
      Effect.succeed(
        new EngineHost({
          platform,
          arch: arch(),
          hostname: hostname(),
          cores: availableParallelism(),
        }),
      ),
  }),
)
