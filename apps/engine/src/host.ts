import { Effect, Option, Schema } from 'effect'
import { arch, hostname } from 'node:os'

import { EngineHost, Host, type HostFacts, Platform } from '@fabrica/contracts'
import { Daemon } from '@fabrica/engine'

// The engine's host, read once as `fabrica serve` or `fabrica bridge` starts: where the engine's files
// are (spec §7.2) and what its status says of the machine (§8.1). Its home folder and cores are the
// `Host` service's facts (§24), read once and passed to both.

/** The host's facts as the command starts. */
export const hostFacts = Effect.gen(function* () {
  const host = yield* Host
  return yield* host.facts
})

/** The engine's files on this host. */
export const hostPaths = (facts: HostFacts) =>
  Effect.suspend(() =>
    Effect.fromResult(
      Daemon.enginePaths({
        platform: process.platform,
        home: facts.home,
        environment: process.env,
      }),
    ),
  )

/** The machine the engine runs on. */
export const engineHost = (facts: HostFacts) =>
  Effect.suspend(() =>
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
            cores: facts.cores,
          }),
        ),
    }),
  )
