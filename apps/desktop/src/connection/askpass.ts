import { Option } from 'effect'

import { AskpassHelper } from '@fabrica/client'

// What the connection process's ssh runs as `SSH_ASKPASS` (spec §9.1), as main names it: one argument as
// it forks the process, none where ssh is to ask nothing.

const nodeFlag = '--askpass-node='
const executableFlag = '--askpass-executable='

/** The connection process's arguments naming `helper`. */
export const askpassArguments = (
  helper: Option.Option<AskpassHelper>,
): Array<string> =>
  Option.match(helper, {
    onNone: () => [],
    onSome: AskpassHelper.$match({
      Node: ({ node }) => [`${nodeFlag}${node}`],
      Executable: ({ path }) => [`${executableFlag}${path}`],
    }),
  })

/** What follows `flag` in the arguments, where it names anything. */
const flagged = (
  argv: ReadonlyArray<string>,
  flag: string,
): Option.Option<string> =>
  Option.filter(
    Option.map(
      Option.fromUndefinedOr(argv.find(argument => argument.startsWith(flag))),
      argument => argument.slice(flag.length),
    ),
    value => value !== '',
  )

/** The helper the connection process's arguments name. */
export const askpassHelperOf = (
  argv: ReadonlyArray<string>,
): Option.Option<AskpassHelper> =>
  Option.orElse(
    Option.map(flagged(argv, nodeFlag), node => AskpassHelper.Node({ node })),
    () =>
      Option.map(flagged(argv, executableFlag), path =>
        AskpassHelper.Executable({ path }),
      ),
  )
