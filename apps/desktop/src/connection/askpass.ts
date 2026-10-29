import { Option } from 'effect'

// The Node the connection process's `SSH_ASKPASS` helper runs on (spec §9.1), as main names it: one
// argument as it forks the process, none where ssh is to ask nothing.

const askpassNodeFlag = '--askpass-node='

/** The connection process's arguments naming `node`. */
export const askpassArguments = (node: Option.Option<string>): Array<string> =>
  Option.match(node, {
    onNone: () => [],
    onSome: path => [`${askpassNodeFlag}${path}`],
  })

/** The Node the connection process's arguments name. */
export const askpassNodeOf = (
  argv: ReadonlyArray<string>,
): Option.Option<string> =>
  Option.filter(
    Option.map(
      Option.fromUndefinedOr(
        argv.find(argument => argument.startsWith(askpassNodeFlag)),
      ),
      argument => argument.slice(askpassNodeFlag.length),
    ),
    path => path !== '',
  )
