import { Context, type Duration, Effect, Layer, Option, Result } from 'effect'

import type {
  CheckResult,
  CheckSuite,
  CommitHash,
  TicketId,
  TreeHash,
} from '@fabrica/contracts'

import { openFileTruncating } from '../files'
import { Git } from '../git'
import {
  CommandOutcome,
  ExitStatus,
  ProcessRunner,
  coreShareVariables,
} from '../process'
import { toSeconds } from '../runlog'
import { elapsed, startStopwatch } from '../time'
import { checkLogPath, runnable, shellArgs } from './command'
import {
  CheckOutcome,
  type CheckRecord,
  Leftovers,
  NotRun,
  leftovers,
} from './outcome'

// The Checks service (spec §13.6–§13.9, §20.2): the engine's one way to run a project's check or
// setup in a worktree. The command runs in the shell through the process runner, so it gets the
// allowlisted environment, a group of its own and a time limit its deadlines count in time awake;
// its output, stderr in its stdout, is kept in its log under the checkout's `.fabrica/run/checks/`,
// opened as every engine file is. Git's status before and after it says what it left.

/** A check or a setup to run. */
export interface CheckInput {
  readonly suite: CheckSuite
  /** The ticket it checks; none for the run's own (the full check, its setup, a pre-flight's). */
  readonly ticket: Option.Option<TicketId>
  /** The setting's command, a shell command line. */
  readonly command: string
  /** The worktree it runs in. */
  readonly worktree: string
  /** The project's checkout, whose `.fabrica/run/checks/` keeps the log. */
  readonly checkout: string
  /** `check_timeout`, counted in time awake by the runner's deadlines. */
  readonly timeLimit: Duration.Input
  /** Its share of the machine's cores (spec §7.3, H56), at least 1. */
  readonly cores: number
  /** The tree the ticket's last passing `check_own` ran on, as `FABRICA_CHECK_OWN_PASSED_AT` (spec §13.6). */
  readonly passedAt: Option.Option<TreeHash>
  /** The nice value it runs at (a worker's `check_own`); none for the engine's own priority. */
  readonly nice: Option.Option<number>
}

export interface ChecksShape {
  readonly run: (input: CheckInput) => Effect.Effect<CheckOutcome>
}

export class Checks extends Context.Service<Checks, ChecksShape>()(
  '@fabrica/engine/Checks',
) {}

export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner
  const git = yield* Git

  const run = Effect.fn('Checks.run')(function* (input: CheckInput) {
    const { suite, command, worktree } = input
    const record = ({
      result,
      commit,
      seconds,
      output,
    }: {
      readonly result: CheckResult
      readonly commit: Option.Option<CommitHash>
      readonly seconds: number
      readonly output: Option.Option<string>
    }): CheckRecord => ({
      kind: 'check',
      suite,
      ...Option.match(input.ticket, {
        onNone: () => ({}),
        onSome: ticket => ({ ticket }),
      }),
      command,
      ...Option.match(commit, {
        onNone: () => ({}),
        onSome: hash => ({ commit: hash }),
      }),
      seconds,
      result,
      ...Option.match(output, {
        onNone: () => ({}),
        onSome: path => ({ output: path }),
      }),
    })
    const notRun = (commit: Option.Option<CommitHash>, reason: NotRun) =>
      CheckOutcome.CouldNotRun({
        record: record({
          result: 'not_run',
          commit,
          seconds: 0,
          output: Option.none(),
        }),
        reason,
      })

    if (!runnable(command))
      return notRun(Option.none(), NotRun.CommandRefused({ command }))

    const logPath = checkLogPath(input)
    const { writer, before, commit } = yield* Effect.all(
      {
        writer: Effect.result(
          openFileTruncating({ root: input.checkout, path: logPath }),
        ),
        before: Effect.result(git.status({ worktree })),
        commit: Effect.map(
          Effect.option(git.commitHash({ repo: worktree, revision: 'HEAD' })),
          Option.flatten,
        ),
      },
      { concurrency: 'unbounded' },
    )
    if (Result.isFailure(writer))
      return notRun(commit, NotRun.LogNotKept({ error: writer.failure }))
    const log = writer.success

    const stopwatch = yield* startStopwatch
    const outcome = yield* runner.run({
      command: 'sh',
      args: shellArgs(command),
      cwd: worktree,
      env: {
        ...coreShareVariables(input.cores),
        ...Option.match(input.passedAt, {
          onNone: () => ({}),
          onSome: tree => ({ FABRICA_CHECK_OWN_PASSED_AT: tree }),
        }),
      },
      timeLimit: input.timeLimit,
      ...Option.match(input.nice, {
        onNone: () => ({}),
        onSome: nice => ({ nice }),
      }),
    })
    const seconds = toSeconds(yield* elapsed(stopwatch))

    /** Keeps the output in the log, then reads what the check left; none where the log can't be kept. */
    const keep = Effect.fnUntraced(function* (output: string) {
      const kept = yield* Effect.result(
        Effect.andThen(log.write(output), log.sync),
      )
      if (Result.isFailure(kept)) return Result.fail(kept.failure)
      const left = Result.isFailure(before)
        ? Leftovers.CantTell({ reason: before.failure.reason })
        : yield* Effect.match(git.status({ worktree }), {
            onFailure: ({ reason }) => Leftovers.CantTell({ reason }),
            onSuccess: after => leftovers(before.success, after),
          })
      return Result.succeed(left)
    })
    const ended = Effect.fnUntraced(function* (
      output: string,
      result: CheckResult,
      outcomeOf: (left: Leftovers, record: CheckRecord) => CheckOutcome,
    ) {
      const left = yield* keep(output)
      if (Result.isFailure(left))
        return notRun(commit, NotRun.LogNotKept({ error: left.failure }))
      return outcomeOf(
        left.success,
        record({
          result,
          commit,
          seconds,
          output: result === 'passed' ? Option.none() : Option.some(logPath),
        }),
      )
    })

    return yield* CommandOutcome.$match(outcome, {
      Exited: ({ status, stdout, stderr }) => {
        const passed = ExitStatus.$match(status, {
          Code: ({ code }) => code === 0,
          Signal: () => false,
        })
        return ended(
          stdout + stderr,
          passed ? 'passed' : 'failed',
          (left, record) =>
            passed
              ? CheckOutcome.Passed({ record, log: log.path, left })
              : CheckOutcome.Failed({
                  record,
                  log: log.path,
                  left,
                  status,
                }),
        )
      },
      TimedOut: ({ stdout, stderr }) =>
        ended(stdout + stderr, 'timed_out', (left, record) =>
          CheckOutcome.TimedOut({ record, log: log.path, left }),
        ),
      Cut: ({ limit }) =>
        Effect.succeed(notRun(commit, NotRun.OutputCut({ limit }))),
      FailedToStart: ({ reason }) =>
        Effect.succeed(notRun(commit, NotRun.DidNotStart({ reason }))),
    })
  }, Effect.scoped)

  return Checks.of({ run })
})

/** The Checks service, over the runner and git the engine runs its commands with. */
export const layer: Layer.Layer<Checks, never, ProcessRunner | Git> =
  Layer.effect(Checks, make)
