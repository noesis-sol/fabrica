import { Data, Effect } from 'effect'
import { Argument, CliError, Command, Flag, Param, Primitive } from 'effect/cli'

import { versionLine } from '../version'

// A command of spec §19 whose ticket hasn't built it yet: it is registered, listed in the help, and
// says it isn't in this release, whatever it is given: any argument, and the flags §19 writes for it,
// which it takes hidden from its help. The ticket that builds it replaces it.

/** A command this release doesn't have yet. */
export class NotYet extends Data.TaggedError('NotYet')<{
  /** The command as it is typed: `fabrica token create`. */
  readonly command: string
}> {
  override get message() {
    return `\`${this.command}\` is not in ${versionLine} yet`
  }
}

/** The flags §19 writes for a command not built yet, by name. */
export type StubFlags = Readonly<Record<string, Flag.Flag<unknown>>>

/** A flag of a command not built yet: taken, hidden from the help, never required. */
const stubFlag = <A>(flag: Flag.Flag<A>) =>
  flag.pipe(Flag.withHidden, Flag.optional)

/** A flag that takes no value: `--tickets`. */
export const switchFlag = (name: string) => stubFlag(Flag.Boolean(name))

/** A flag that takes a value: `--ticket <id>`, `--ticket=<id>`. */
export const valueFlag = (name: string) => stubFlag(Flag.String(name))

/**
 * Any value, read as the parser reads a switch's (`Boolean` is the tag it goes by): given inline
 * (`--flag=<value>`) or not at all, never taken from the next word.
 */
const optionalValue: Primitive.Primitive<string> = Object.assign(
  Object.create(Object.getPrototypeOf(Primitive.String)),
  { _tag: 'Boolean', parse: (value: string) => Effect.succeed(value) },
)

/** A flag whose value may be left out: `--auto-answer[=<duration>]`. */
export const optionalValueFlag = (name: string) =>
  stubFlag(
    Param.makeSingle({
      name,
      primitiveType: optionalValue,
      kind: Param.flagKind,
    }),
  )

/** The command `name` under `group`, which only says it isn't built yet. */
export const notYet = (options: {
  readonly group: ReadonlyArray<string>
  readonly name: string
  readonly description: string
  readonly flags?: StubFlags
}) =>
  Command.make(
    options.name,
    // Whatever it is given is taken, so the command says it isn't built rather than refuse an argument.
    {
      given: Argument.String('argument').pipe(
        Argument.variadic(),
        Param.withHidden,
      ),
      flags: options.flags ?? {},
    },
    () =>
      Effect.fail(
        new NotYet({
          command: ['fabrica', ...options.group, options.name].join(' '),
        }),
      ),
  ).pipe(Command.withDescription(options.description))

/** A command of its own, `fabrica <name>`, and not yet built. */
export const notYetCommand = (name: string, description: string) =>
  notYet({ group: [], name, description })

/**
 * The group `fabrica <name>` with its subcommands, none built yet. Where `starts` gives its flags, the
 * group's own command (`fabrica run`) does something too, and isn't built either.
 */
export const notYetGroup = (options: {
  readonly name: string
  readonly description: string
  readonly starts?: StubFlags
  readonly commands: ReadonlyArray<
    readonly [name: string, description: string, flags?: StubFlags]
  >
}) =>
  Command.make(
    options.name,
    { flags: options.starts ?? {} },
    (): Effect.Effect<void, NotYet | CliError.ShowHelp> =>
      options.starts === undefined
        ? Effect.fail(
            new CliError.ShowHelp({
              commandPath: ['fabrica', options.name],
              errors: [],
            }),
          )
        : Effect.fail(new NotYet({ command: `fabrica ${options.name}` })),
  ).pipe(
    Command.withDescription(options.description),
    Command.withSubcommands(
      options.commands.map(([name, description, flags]) =>
        notYet({
          group: [options.name],
          name,
          description,
          ...(flags === undefined ? {} : { flags }),
        }),
      ),
    ),
  )
