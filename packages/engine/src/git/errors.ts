import { Data } from 'effect'

// What a git command that couldn't give an answer comes to (spec §13.7, H59).

/**
 * A git read that still failed after its retries: "can't tell", for the decision it was to steer
 * (`GIT_FAILED`, for that ticket). It is never taken as an answer: not as a clean worktree, a branch
 * on Base, or Base unmoved.
 */
export class CantTell extends Data.TaggedError('CantTell')<{
  /** The read, as `Git.status` and the rest name it. */
  readonly read: string
  /** What git, or the command's run, said. */
  readonly reason: string
}> {}

/**
 * A git command that didn't run to an exit code: it didn't start, timed out, was cut or ended by a
 * signal; or a write that exited in a way its outcome has no case for.
 */
export class GitFailed extends Data.TaggedError('GitFailed')<{
  /** The command's arguments, after `git`. */
  readonly command: string
  readonly reason: string
}> {}
