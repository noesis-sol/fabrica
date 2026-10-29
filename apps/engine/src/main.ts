#!/usr/bin/env node
import { Cause, Console, Effect } from 'effect'

import { NodeRuntime } from '@effect/platform-node'

import { bridge } from './bridge'
import { serve } from './serve'
import { versionLine } from './version'

// The `fabrica` command. `serve` and `bridge` run the engine and reach it; with no command it says its
// version.

const command = (
  name: string | undefined,
): Effect.Effect<void, { readonly message: string }> => {
  switch (name) {
    case 'serve':
      return serve
    case 'bridge':
      return bridge
    default:
      return Console.log(versionLine)
  }
}

command(process.argv[2]).pipe(
  Effect.tapError(error => Console.error(`fabrica: ${error.message}`)),
  Effect.tapCause(cause =>
    Cause.hasDies(cause) ? Console.error(Cause.pretty(cause)) : Effect.void,
  ),
  NodeRuntime.runMain({ disableErrorReporting: true }),
)
