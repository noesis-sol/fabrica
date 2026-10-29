import { Data } from 'effect'

// What starting an external command came to (spec §12.1, §20.2). Each is a tagged union made by its
// constructors and matched exhaustively: a caller never tells two apart by their fields.

/** How a command that ran ended: its exit code, or the signal that ended it. */
export type ExitStatus = Data.TaggedEnum<{
  Code: { readonly code: number }
  Signal: { readonly signal: string }
}>
export const ExitStatus = Data.taggedEnum<ExitStatus>()

/** Why a command didn't start. */
export type StartFailure = Data.TaggedEnum<{
  /** No executable regular file of that name on the PATH the command would run with (spec §24). */
  NotOnPath: { readonly command: string; readonly path: string }
  /** The system refused to start it: its folder missing, its file not executable, no processes left. */
  SpawnFailed: { readonly command: string; readonly message: string }
}>
export const StartFailure = Data.taggedEnum<StartFailure>()

/** The stream whose output passed its size cap. */
export type OutputStream = 'stdout' | 'stderr'

/** A command run to its end by `ProcessRunner.run`. */
export type CommandOutcome = Data.TaggedEnum<{
  /** It exited within its time limit; its output as read until it exited and the grace after. */
  Exited: {
    readonly status: ExitStatus
    readonly stdout: string
    readonly stderr: string
  }
  /** Its time limit ran out, and its whole tree was ended; the output it had written by then. */
  TimedOut: { readonly stdout: string; readonly stderr: string }
  /** One of its streams passed the size cap, and its whole tree was ended: its output is never parsed. */
  Cut: { readonly stream: OutputStream; readonly limit: number }
  /** It never started. */
  FailedToStart: { readonly reason: StartFailure }
}>
export const CommandOutcome = Data.taggedEnum<CommandOutcome>()

/** `ProcessRunner.start` couldn't start the command. */
export class StartFailed extends Data.TaggedError('StartFailed')<{
  readonly reason: StartFailure
}> {}

/** A write to a started command's stdin that its pipe didn't take: it was never opened, or has closed. */
export class StdinClosed extends Data.TaggedError('StdinClosed')<{
  readonly pid: number
}> {}
