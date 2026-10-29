import { Duration, Effect, Schedule } from 'effect'

import {
  CommandOutcome,
  ExitStatus,
  type ProcessRunnerShape,
  StartFailure,
} from '../process'
import { CantTell, GitFailed } from './errors'

// How every git command the engine runs is run (spec §11.7, §13.7, §20.2, H59, H85): through the
// process runner, so it gets the allowlisted environment and never git's local variables; with no
// prompt, no pager and no editor, so it never waits for input; in the C locale, so its output parses
// the same everywhere. Revisions go after `--end-of-options` and pathspecs after `--`, in each command.

/** The variables every git command gets, over the allowlisted environment. */
export const GIT_ENVIRONMENT: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  LC_ALL: 'C',
}

/** What reads add: a read never takes the index's lock, so it never refuses another process one. */
const READ_ENVIRONMENT: Readonly<Record<string, string>> = {
  ...GIT_ENVIRONMENT,
  GIT_OPTIONAL_LOCKS: '0',
}

/** How the git service runs its commands. */
export interface GitConfig {
  /** Each git command's time limit. */
  readonly timeLimit: Duration.Input
  /** How a read that failed is tried again before it is "can't tell": that many times, so far apart. */
  readonly readRetries: {
    readonly times: number
    readonly spacing: Duration.Input
  }
}

export const defaultConfig: GitConfig = {
  timeLimit: Duration.minutes(5),
  readRetries: { times: 3, spacing: Duration.millis(250) },
}

/** A git command: its arguments after `git`, and the folder it runs in. */
export interface GitCommand {
  readonly cwd: string
  readonly args: ReadonlyArray<string>
}

/** A git command that ran to an exit code. */
export interface GitExit {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const describeStart = StartFailure.$match({
  NotOnPath: ({ path }) => `git is not on the PATH (${path})`,
  SpawnFailed: ({ message }) => `git didn't start: ${message}`,
})

/** Runs git commands through one runner and configuration. */
export const makeCommands = ({
  runner,
  config,
}: {
  readonly runner: ProcessRunnerShape
  readonly config: GitConfig
}) => {
  /** Runs `git <args>` in `cwd` with `environment` over the allowlisted one, as the runner ends it. */
  const invoke = (
    environment: Readonly<Record<string, string>>,
    { cwd, args }: GitCommand,
  ): Effect.Effect<CommandOutcome> =>
    runner.run({
      command: 'git',
      args: ['--no-pager', ...args],
      cwd,
      env: environment,
      timeLimit: config.timeLimit,
    })

  const runIn = (
    environment: Readonly<Record<string, string>>,
    command: GitCommand,
  ): Effect.Effect<GitExit, GitFailed> => {
    const failed = (reason: string) =>
      Effect.fail(new GitFailed({ command: command.args.join(' '), reason }))
    return Effect.flatMap(
      invoke(environment, command),
      CommandOutcome.$match({
        Exited: ({ status, stdout, stderr }) =>
          ExitStatus.$match(status, {
            Code: ({ code }) => Effect.succeed({ code, stdout, stderr }),
            Signal: ({ signal }) => failed(`ended by ${signal}`),
          }),
        TimedOut: () =>
          failed(
            `timed out after ${Duration.format(Duration.fromInputUnsafe(config.timeLimit))}`,
          ),
        Cut: ({ stream, limit }) =>
          failed(`its ${stream} passed ${limit} bytes`),
        FailedToStart: ({ reason }) => failed(describeStart(reason)),
      }),
    )
  }

  /** A command that writes: run once. */
  const write = (command: GitCommand) => runIn(GIT_ENVIRONMENT, command)

  /** A command that only reads, run as `read`'s attempts are. */
  const query = (command: GitCommand) => runIn(READ_ENVIRONMENT, command)

  /**
   * A read: `attempt` tried again on the configured schedule while it fails, then "can't tell", named
   * `name`. An attempt fails for an exit code its reader has no answer for, as for a command that didn't run.
   */
  const read = <A>(
    name: string,
    attempt: Effect.Effect<A, GitFailed>,
  ): Effect.Effect<A, CantTell> =>
    attempt.pipe(
      Effect.retry({
        schedule: Schedule.spaced(config.readRetries.spacing),
        times: config.readRetries.times,
      }),
      Effect.mapError(
        error =>
          new CantTell({
            read: name,
            reason: `git ${error.command}: ${error.reason}`,
          }),
      ),
    )

  /** An exit its reader has no answer for, as an attempt's failure. */
  const unexpected = (args: ReadonlyArray<string>, exit: GitExit) =>
    Effect.fail(
      new GitFailed({
        command: args.join(' '),
        reason: `exit ${exit.code}: ${exit.stderr.trim() || exit.stdout.trim()}`,
      }),
    )

  /** A read's command, its outcome as the runner gave it: for a read that tells why git didn't run. */
  const queryOutcome = (command: GitCommand) =>
    invoke(READ_ENVIRONMENT, command)

  return { write, query, queryOutcome, read, unexpected }
}

export type Commands = ReturnType<typeof makeCommands>
