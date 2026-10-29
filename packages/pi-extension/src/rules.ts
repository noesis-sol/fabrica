import { Data, Effect, Option } from 'effect'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// The standing rules (spec §12.4): orchestra's worker prompt, adapted, which the extension puts in
// Pi's system prompt as a section of its own, so that they survive compaction; the project's own
// `.fabrica/worker-rules.md` is appended. Rules about one action live in its tool's description
// (`@fabrica/contracts` tools), not here. Pi runs `before_agent_start` again for a resumed session
// and records a changed section in it (spike fab-mgi.2.1).

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

const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

/** The project's own rules, or none where it has no `.fabrica/worker-rules.md`. */
export const readProjectRules = Effect.fn('Rules.readProjectRules')(function* (
  root: string,
) {
  const path = join(root, ProjectRulesPath)
  return yield* Effect.tryPromise({
    try: () =>
      readFile(path, 'utf8').then(Option.some, (error: unknown) =>
        missing(error) ? Option.none<string>() : Promise.reject(error),
      ),
    catch: error =>
      new ProjectRulesUnreadable({
        path,
        reason: error instanceof Error ? error.message : String(error),
      }),
  })
})
