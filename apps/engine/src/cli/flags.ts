import { Effect } from 'effect'
import { Flag, GlobalFlag, Param, Primitive } from 'effect/cli'

// The flags every command takes (spec §19): `--json`, and `--engine <name>` (`-e`), the engine the command
// talks to. Each is a setting a command's handler reads (`yield* Json`). And how a flag whose value may
// be left out is read.

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

/**
 * Any value, read as the parser reads a switch's (`Boolean` is the tag it goes by): given inline
 * (`--flag=<value>`) or not at all, never taken from the next word.
 */
const optionalValue: Primitive.Primitive<string> = Object.assign(
  Object.create(Object.getPrototypeOf(Primitive.String)),
  { _tag: 'Boolean', parse: (value: string) => Effect.succeed(value) },
)

/** A flag whose value may be left out: `--auto-answer[=<duration>]`; given alone, its value is `true`. */
export const optionalValueFlag = (name: string) =>
  Param.makeSingle({
    name,
    primitiveType: optionalValue,
    kind: Param.flagKind,
  })
