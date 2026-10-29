#!/usr/bin/env node
import { Effect, Layer } from 'effect'

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Host } from '@fabrica/contracts'
import { layerNodeHost } from '@fabrica/engine'

import { LocalEngine } from './cli/connect'
import { runCli } from './cli/main'
import { hostPaths } from './host'

// The `fabrica` command's entry: the CLI (`cli/main.ts`) on this host's Node services and its `Host`,
// the local engine found where this host keeps its files. Its exit code is 1 when the command fails.

const localEngine = Layer.effect(
  LocalEngine,
  Effect.gen(function* () {
    const host = yield* Host
    return {
      socket: host.facts.pipe(
        Effect.flatMap(hostPaths),
        Effect.map(paths => paths.socket),
      ),
    }
  }),
)

runCli(process.argv.slice(2)).pipe(
  Effect.provide([NodeServices.layer, localEngine]),
  Effect.provide(layerNodeHost),
  NodeRuntime.runMain({ disableErrorReporting: true }),
)
