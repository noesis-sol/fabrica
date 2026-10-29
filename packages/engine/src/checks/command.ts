import { Option, Schema } from 'effect'

import { type CheckSuite, CommandLine, type TicketId } from '@fabrica/contracts'

// How a check's or the setup's command is run (spec §13.7, §13.8, §13.9): which setting each suite
// runs, where its log is kept, and the shell that runs it.

/** The project setting whose command a check or a setup runs. */
export type CheckSetting = 'check_own' | 'check_fast' | 'check_full' | 'setup'

const SETTINGS: Readonly<Record<CheckSuite, CheckSetting>> = {
  own: 'check_own',
  merge: 'check_fast',
  recheck: 'check_fast',
  fix: 'check_fast',
  base: 'check_fast',
  full: 'check_full',
  setup: 'setup',
}

/** The setting whose command `suite` runs: the merge check, its recheck and a fix's run `check_fast`. */
export const suiteSetting = (suite: CheckSuite): CheckSetting => SETTINGS[suite]

/** Where check logs are kept, below the project's checkout. */
export const checksFolder = '.fabrica/run/checks'

/** A check's log below the project's checkout: `<ticket>.<suite>.log`, or `<suite>.log` for the run's own. */
export const checkLogPath = ({
  suite,
  ticket,
}: {
  readonly suite: CheckSuite
  readonly ticket: Option.Option<TicketId>
}): string =>
  `${checksFolder}/${Option.match(ticket, {
    onNone: () => suite,
    onSome: id => `${id}.${suite}`,
  })}.log`

/**
 * Whether a command can run: on one line, without control characters, as the settings take it. A
 * newline in a command hides what runs after it from one who reads it as one line.
 */
export const runnable: (command: string) => boolean = Schema.is(CommandLine)

/**
 * The shell's arguments that run `command` with its stderr sent to its stdout, so the log keeps its
 * output in the order it was written. The command is a line of its own, after the redirect.
 */
export const shellArgs = (command: string): ReadonlyArray<string> => [
  '-c',
  `exec 2>&1\n${command}`,
]
