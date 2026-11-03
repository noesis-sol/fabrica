import { Data, Effect, Option } from 'effect'
import { constants } from 'node:fs'
import { type FileHandle, lstat, open } from 'node:fs/promises'
import { join } from 'node:path'

// The standing rules (spec §12.4): orchestra's worker prompt, adapted, which the extension puts in
// Pi's system prompt as a section of its own, so that they survive compaction; the project's own
// `.fabrica/worker-rules.md` is appended, or, where it is refused, a line saying why it is left out.
// Rules about one action live in its tool's description (`@fabrica/contracts` tools), not here. Pi
// runs `before_agent_start` again for a resumed session and records a changed section in it (spike
// fab-mgi.2.1).

/**
 * The template's version. A change to the rules' text is a new version: the engine records the
 * version per project (`settings.templates`) and tells a resumed session what changed.
 */
export const StandingRulesVersion = 1

/** The template's name, as `settings.templates` records its version. */
export const StandingRulesTemplate = 'standing-rules'

/** The system prompt section the rules are in, a tag Pi wraps them in. */
export const StandingRulesSection = 'fabrica_rules'

/** The project's own rules, from its root. */
export const ProjectRulesPath = join('.fabrica', 'worker-rules.md')

const rules = `Fabrica's standing rules, version ${StandingRulesVersion}.

You are responsible for exactly one ticket, the one your first prompt names. Do not work on any other ticket. Read it with get_ticket.

- You are in your own git worktree, on your ticket's branch. Work and commit there. Do not switch branches, stash, merge, rebase onto anything, or touch any other checkout: Fabrica merges your branch. Never push.
- Check your own change before you finish: run the project's suites on what it touches (the modules or packages it changes and their tests, existing ones included), and lint and type checks on the files you changed. While iterating, run only the checks you need. Before you finish, run check_own once, after your last change, and read its output file rather than running it again.
- Run every check once, in the foreground, its whole output kept in a file, and read or search that file rather than running the check again to see its output. Never run a check in the background: while you wait on it you hold your place in the run doing nothing. Give a check its time: pass no time limit shorter than the check takes.
- Where the project has test suites, a change of behaviour adds or updates tests for it, in those suites and their frameworks. Never add a new test framework: setting one up is a ticket of its own.
- Other tickets run beside yours and merge first, so don't add where they all add: put new tests in a new test file named after the feature, not at the end of an existing one; add new fields, constants and helpers next to the code they belong to, not at the end of a list; add a changelog entry as new lines, without rewording or moving the others.
- Other workers run the same programs and tests on this machine. Never stop processes by name or pattern (pkill, killall); stop only those you started, by their process ID.
- Put throwaway files in a new folder of a scratchpad outside the worktree and leave them there: nothing needs cleaning up. Never remove a target built from a variable or a glob; a file that must go is removed by its literal path.
- Commit only the files you changed for this ticket, with the ticket's ID in the message.
- File anything new you discover with file_ticket. A ticket's text names a file only where that ticket will change it: the files a ticket names hold it apart from the tickets changing them.

Working unattended:
- Nobody reads your turns as they happen, and nothing reads your final message. Everything you tell Fabrica goes through your tools: notes with add_note, follow-ups with file_ticket, decisions with ask_question.
- Make the choices that are yours, note them on the ticket, and go on. Never end a turn with a summary that announces your next step, an offer to go on, or a question in your reply.
- Your turn ends only through an outcome tool: finish once the work is done and checked, defer when you cannot finish, wait_for when another ticket must merge first, ask_question when only the maintainer can decide about your ticket. A turn that ends without one ends your work on the ticket unfinished.
- The maintainer may send you a message: follow it, then carry on with the ticket.
- Your context is compacted as it fills, so don't cut work short because the conversation is long; keep the ticket's notes current, so that you can carry on after it.`

/**
 * The verifier's standing rules (§13.6), in place of the worker's: it reads and runs checks, changes
 * nothing, and answers through `verdict`.
 */
export const verifierRules = `Fabrica's standing rules for the verifier, version ${StandingRulesVersion}.

You verify a change another agent made for one ticket, the one your prompt names, in that ticket's worktree. You see the ticket and the change, not the reasoning that produced them.

- Change nothing: no edits, no commits, no stashes, no branch switches, nothing written in the worktree. Bash is for reading and for running the checks.
- Where the prompt says check_own passed on the tree you verify, its results stand: quote its output file rather than run it again, and run only a suite it leaves out that covers what the change touches. Otherwise run the project's suites on what the change touches, and lint and type checks on the files it changed.
- Run every check once, in the foreground, its whole output kept in a file of a scratchpad outside the worktree, and read or search that file rather than running the check again. Give a check its time: pass no time limit shorter than the check takes.
- Other workers run the same programs and tests on this machine. Never stop processes by name or pattern (pkill, killall); stop only those you started, by their process ID.
- Never remove a target built from a variable or a glob.
- Report only gaps that affect correctness or the ticket's requirements as blocking; leave out style preferences, and don't ask for defensive code or tests of cases that can't happen.
- Nobody reads your turns or your final message: your turn ends only through verdict, given once, PASS or FAIL with its findings. A turn that ends without one gives the change no verdict.`

/**
 * An organ session's standing rules (§16), in place of the worker's: it reads the repository, changes
 * nothing, and answers through `answer`.
 */
export const organRules = `Fabrica's standing rules for an organ's session, version ${StandingRulesVersion}.

You advise Fabrica on the question your prompt asks, in the project's checkout, with read-only tools.

- Change nothing: you have no tool that writes, and nothing you say changes the code or the tickets by itself.
- Read only what the question needs: your session is short, and its cost is counted.
- Nobody reads your turns or your final message: your turn ends only through answer, given once, its arguments fitting its schema. An answer that doesn't fit is refused with why, and you may give it once more. A turn that ends without one gives no answer.`

/** The rules for a project: the standing rules, then the project's own where it has any. */
export const standingRules = (projectRules: Option.Option<string>): string =>
  Option.match(
    Option.filter(
      Option.map(projectRules, text => text.trim()),
      text => text.length > 0,
    ),
    {
      onNone: () => rules,
      onSome: text => `${rules}\n\nThe project's own rules:\n\n${text}`,
    },
  )

/** The project's rules file is there but couldn't be read. */
export class ProjectRulesUnreadable extends Data.TaggedError(
  'ProjectRulesUnreadable',
)<{ readonly path: string; readonly reason: string }> {
  override get message() {
    return `the project's worker rules ${this.path} couldn't be read: ${this.reason}`
  }
}

/** The most the project's rules may hold: more is refused rather than put in every prompt. */
export const ProjectRulesMaxBytes = 64 * 1024

const hasCode = (error: unknown, code: string) =>
  error instanceof Error && 'code' in error && error.code === code

const missing = (error: unknown) => hasCode(error, 'ENOENT')

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * The rules file's text, or none where there is none. The worktree is the agent's and the file a
 * merged ticket's (spec §20.2, H62): `.fabrica` must be a real folder, the file is opened without
 * following a link and without waiting on a named pipe, kept only when it is a regular file, and
 * read only up to the cap, so a link to a key or a pipe or device at its path never reaches the prompt.
 */
const readRegularText = async (
  root: string,
  path: string,
): Promise<Option.Option<string>> => {
  const folder = await lstat(join(root, '.fabrica')).catch((error: unknown) =>
    missing(error) ? undefined : Promise.reject(error),
  )
  if (folder === undefined) return Option.none()
  if (!folder.isDirectory()) throw new Error('.fabrica is not a folder')
  const handle: FileHandle | undefined = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) =>
    missing(error)
      ? undefined
      : Promise.reject(
          hasCode(error, 'ELOOP') ? new Error('it is a symbolic link') : error,
        ),
  )
  if (handle === undefined) return Option.none()
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error('it is not a regular file')
    if (stats.size > ProjectRulesMaxBytes)
      throw new Error(
        `it has ${stats.size} bytes, more than the ${ProjectRulesMaxBytes} allowed`,
      )
    const buffer = Buffer.alloc(ProjectRulesMaxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      )
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > ProjectRulesMaxBytes)
      throw new Error(
        `it has more than the ${ProjectRulesMaxBytes} bytes allowed`,
      )
    return Option.some(buffer.toString('utf8', 0, length))
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** The project's own rules, or none where it has no `.fabrica/worker-rules.md`. */
export const readProjectRules = Effect.fn('Rules.readProjectRules')(function* (
  root: string,
) {
  const path = join(root, ProjectRulesPath)
  return yield* Effect.tryPromise({
    try: () => readRegularText(root, path),
    catch: error =>
      new ProjectRulesUnreadable({ path, reason: reasonOf(error) }),
  })
})

/** The rules for a project whose own were refused: the standing rules, and why its own are left out. */
const rulesWithoutProject = (refused: ProjectRulesUnreadable): string =>
  `${rules}\n\nThe project's own rules are left out of this prompt: ${refused.message}. Note that on your ticket with add_note, and go on without them.`

/**
 * A worker's rules in the worktree at `root`. It never fails: Pi only reports a handler's error, so a
 * refused rules file that escaped `before_agent_start` would start the agent with no rules at all.
 */
export const workerRules = (root: string) =>
  readProjectRules(root).pipe(
    Effect.match({
      onFailure: rulesWithoutProject,
      onSuccess: standingRules,
    }),
  )
