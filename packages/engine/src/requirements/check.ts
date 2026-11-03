import { Context, Duration, Effect, Option, Result } from 'effect'

import {
  type Requirement,
  RequirementFound,
  RequirementMeets,
  RequirementState,
} from '@fabrica/contracts'

import { NotRun, notRunReason, shellArgs } from '../checks'
import { openFileTruncating } from '../files'
import { CommandOutcome, ExitStatus, ProcessRunner } from '../process'

// Checking the requires list on the engine's host (spec §17), the one way a run's start, a merge that
// changed the list, `init` and `fabrica requires` do it: every check side by side in the project's
// checkout, each within a minute, its output dropped; for one that fails, its install, one at a time
// (package managers lock their own state) within `check_timeout`, its output kept in its log under
// `.fabrica/run/`, and the check again. An entry limited to other platforms isn't checked. The commands
// get the allowlisted environment, a group of their own and stdin from /dev/null, as every command the
// engine starts: an install can't ask for anything.

/** The platform the engine runs on, which `platforms` is read for; a test gives its own. */
export const RequirementsPlatform = Context.Reference<string>(
  '@fabrica/engine/RequirementsPlatform',
  { defaultValue: () => process.platform },
)

/** How long each check may run: it only looks, so it is short. */
const CHECK_LIMIT = Duration.minutes(1)

/** The most checks run side by side. */
const CHECKS_AT_ONCE = 8

/** Where the output of an entry's last install is kept, below the project's checkout. */
export const requirementLogPath = (name: string): string =>
  `.fabrica/run/requires-${name}.log`

/** What a check of the list works from. */
export interface RequirementsCheck {
  readonly list: ReadonlyArray<Requirement>
  /** The project's checkout, where every command runs and the logs are kept. */
  readonly checkout: string
  /** Each install's time limit: `check_timeout`. */
  readonly installLimit: Duration.Input
  /** Wraps each install as it runs, to say it and show it as a step; a check of its own says nothing. */
  readonly installing?: (entry: {
    readonly name: string
    readonly command: string
  }) => <A, E, R>(install: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/** Whether a command ran and exited 0. */
const exitedZero: (outcome: CommandOutcome) => boolean = CommandOutcome.$match({
  Exited: ({ status }) =>
    ExitStatus.$match(status, {
      Code: ({ code }) => code === 0,
      Signal: () => false,
    }),
  TimedOut: () => false,
  Cut: () => false,
  FailedToStart: () => false,
})

/** Why a command that didn't exit 0 failed, in words. */
const failureWords: (outcome: CommandOutcome) => string = CommandOutcome.$match(
  {
    Exited: ({ status }) =>
      ExitStatus.$match(status, {
        Code: ({ code }) => `exited ${code}`,
        Signal: ({ signal }) => `was ended by ${signal}`,
      }),
    TimedOut: () => 'ran past check_timeout',
    Cut: ({ limit }) => `wrote more than ${limit} bytes`,
    FailedToStart: ({ reason }) => notRunReason(NotRun.DidNotStart({ reason })),
  },
)

/** The output a command wrote, as far as it was read. */
const outputOf: (outcome: CommandOutcome) => string = CommandOutcome.$match({
  Exited: ({ stdout, stderr }) => stdout + stderr,
  TimedOut: ({ stdout, stderr }) => stdout + stderr,
  Cut: () => '',
  FailedToStart: () => '',
})

/** Runs an install, its output kept in its log: what it came to, and where its output is, or why not. */
const runInstall = Effect.fn('Requirements.install')(function* (
  runner: ProcessRunner['Service'],
  {
    name,
    command,
    checkout,
    timeLimit,
  }: {
    readonly name: string
    readonly command: string
    readonly checkout: string
    readonly timeLimit: Duration.Input
  },
) {
  const outcome = yield* runner.run({
    command: 'sh',
    args: shellArgs(command),
    cwd: checkout,
    timeLimit,
  })
  const kept = yield* Effect.scoped(
    Effect.gen(function* () {
      const log = yield* openFileTruncating({
        root: checkout,
        path: requirementLogPath(name),
      })
      yield* log.write(outputOf(outcome))
      yield* log.sync
      return log.path
    }),
  ).pipe(Effect.result)
  return {
    outcome,
    output: Result.match(kept, {
      onSuccess: path => `its output is in ${path}`,
      onFailure: failure => `its output couldn't be kept: ${failure.message}`,
    }),
  }
})

/** Checks every entry of the list, installing what can be: how each was found, in the list's order. */
export const checkRequirements = Effect.fn('Requirements.check')(function* (
  input: RequirementsCheck,
) {
  const runner = yield* ProcessRunner
  const platform = yield* RequirementsPlatform
  const { list, checkout } = input
  /** The platforms an entry is limited to, where this isn't one of them. */
  const elsewhere = ({ platforms }: Requirement) =>
    Option.filter(platforms, only => !only.some(each => each === platform))
  const passes = (command: string) =>
    Effect.map(
      runner.run({
        command: 'sh',
        args: shellArgs(command),
        cwd: checkout,
        timeLimit: CHECK_LIMIT,
      }),
      exitedZero,
    )
  const met = yield* Effect.forEach(
    list.filter(requirement => Option.isNone(elsewhere(requirement))),
    ({ name, check }) =>
      Effect.map(passes(check), passed => ({ name, passed })),
    { concurrency: CHECKS_AT_ONCE },
  ).pipe(
    Effect.map(
      checks =>
        new Set(checks.filter(({ passed }) => passed).map(({ name }) => name)),
    ),
  )

  /** Its install and its check again, for an entry whose check failed; a manual step is only said. */
  const failed = ({ name, check, meets }: Requirement) =>
    RequirementMeets.match(meets, {
      Manual: ({ instruction }) =>
        Effect.succeed<RequirementState>(
          RequirementState.cases.missing.make({ instruction }),
        ),
      Install: ({ command }) =>
        Effect.gen(function* () {
          const install = runInstall(runner, {
            name,
            command,
            checkout,
            timeLimit: input.installLimit,
          })
          const { outcome, output } = yield* input.installing === undefined
            ? install
            : input.installing({ name, command })(install)
          if (!exitedZero(outcome))
            return RequirementState.cases.missing.make({
              instruction: `\`${command}\` ${failureWords(outcome)}; ${output}`,
            })
          return (yield* passes(check))
            ? RequirementState.cases.installed.make({ command })
            : RequirementState.cases.missing.make({
                instruction: `\`${command}\` ran, but \`${check}\` still fails; ${output}`,
              })
        }),
    })

  // One at a time, in the list's order: only installs do anything here.
  return yield* Effect.forEach(list, requirement =>
    Effect.map(
      Option.match(elsewhere(requirement), {
        onSome: platforms =>
          Effect.succeed<RequirementState>(
            RequirementState.cases.other_platform.make({ platforms }),
          ),
        onNone: () =>
          met.has(requirement.name)
            ? Effect.succeed<RequirementState>(
                RequirementState.cases.met.make({}),
              )
            : failed(requirement),
      }),
      state => new RequirementFound({ name: requirement.name, state }),
    ),
  )
})

/** The entries of `found` still missing, each with what to do: `docker (start Docker Desktop)`. */
export const missingItems = (
  found: ReadonlyArray<RequirementFound>,
): ReadonlyArray<string> =>
  found.flatMap(({ name, state }) =>
    RequirementState.guards.missing(state)
      ? [`${name} (${state.instruction})`]
      : [],
  )

/** How the entries of `found` were found, as a run says it: `jq met; node installed; docker missing`. */
export const foundWords = (found: ReadonlyArray<RequirementFound>): string =>
  (
    [
      ['met', 'met'],
      ['installed', 'installed'],
      ['other_platform', 'not for this platform'],
      ['missing', 'missing'],
    ] as const
  )
    .flatMap(([tag, said]) => {
      const names = found
        .filter(({ state }) => state._tag === tag)
        .map(({ name }) => name)
      return names.length === 0 ? [] : [`${names.join(', ')} ${said}`]
    })
    .join('; ')
