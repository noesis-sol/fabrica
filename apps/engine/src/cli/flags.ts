import { Flag, GlobalFlag } from 'effect/cli'

// The flags every command takes (spec §19): `--json`, and `--engine <name>` (`-e`), the engine the command
// talks to. Each is a setting a command's handler reads (`yield* Json`).

/** `--json`: the command's answer as JSON, for scripts and agents. */
export const Json = GlobalFlag.Setting('json')({
  flag: Flag.Boolean('json').pipe(
    Flag.withDescription('Print the answer as JSON, for scripts and agents'),
    Flag.withDefault(false),
  ),
})

/** `--engine <name>`: the engine to talk to, `local` or `ssh://<destination>`, the local engine where it isn't given. */
export const EngineName = GlobalFlag.Setting('engine')({
  flag: Flag.String('engine').pipe(
    Flag.withAlias('e'),
    Flag.withDescription(
      'The engine to talk to: local (the default), or ssh://[user@]host[:port] for one on another host',
    ),
    Flag.optional,
  ),
})
