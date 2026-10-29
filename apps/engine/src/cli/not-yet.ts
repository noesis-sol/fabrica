import { Data, Effect } from 'effect'
import { Argument, CliError, Command, Param } from 'effect/cli'

import { versionLine } from '../version'

// A command of spec §19 whose ticket hasn't built it yet: it is registered, listed in the help, and
// says it isn't in this release, whatever it is given. The ticket that builds it replaces it.

/** A command this release doesn't have yet. */
export class NotYet extends Data.TaggedError('NotYet')<{
  /** The command as it is typed: `fabrica token create`. */
  readonly command: string
}> {
  override get message() {
    return `\`${this.command}\` is not in ${versionLine} yet`
  }
}

/** The command `name` under `group`, which only says it isn't built yet. */
export const notYet = (options: {
  readonly group: ReadonlyArray<string>
  readonly name: string
  readonly description: string
}) =>
  Command.make(
    options.name,
    // Whatever it is given is taken, so the command says it isn't built rather than refuse an argument.
    {
      given: Argument.String('argument').pipe(
        Argument.variadic(),
        Param.withHidden,
      ),
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
 * The group `fabrica <name>` with its subcommands, none built yet. Where `starts` is given, the group's
 * own command (`fabrica run`) does something too, and isn't built either.
 */
export const notYetGroup = (options: {
  readonly name: string
  readonly description: string
  readonly starts?: boolean
  readonly commands: ReadonlyArray<readonly [name: string, description: string]>
}) =>
  Command.make(
    options.name,
    {},
    (): Effect.Effect<void, NotYet | CliError.ShowHelp> =>
      options.starts === true
        ? Effect.fail(new NotYet({ command: `fabrica ${options.name}` }))
        : Effect.fail(
            new CliError.ShowHelp({
              commandPath: ['fabrica', options.name],
              errors: [],
            }),
          ),
  ).pipe(
    Command.withDescription(options.description),
    Command.withSubcommands(
      options.commands.map(([name, description]) =>
        notYet({ group: [options.name], name, description }),
      ),
    ),
  )
