import { Data } from 'effect'

import type { CheckOwnPass, TicketId, TicketResult } from '@fabrica/contracts'

// What a worker's session came to, as its control channel heard it (spec §12.3, §13.5, §12.8): the
// run loop reads one stream of these per session and does what each asks of the run (the verifier and
// the merge queue, a freed slot, a resume once a question is answered). The work graph already holds
// each one's effect when it is published.

export type Outcome = Data.TaggedEnum<{
  /** `finish`: the worktree clean, `check_own` passed on HEAD's tree, the result recorded on the ticket. */
  Finished: { readonly result: TicketResult; readonly checkOwn: CheckOwnPass }
  /** `defer`: the ticket set aside, its worktree and session kept, the reason its note. */
  Deferred: { readonly reason: string }
  /** `wait_for`: the ticket linked as blocked by `ticket`, which must merge first. */
  WaitsFor: { readonly ticket: TicketId; readonly needs: string }
  /** `ask_question` about its own ticket, or `ask_and_wait` unanswered in `question_wait`: the ticket waits on `question`. */
  Asked: { readonly question: TicketId }
  /** The session settled a second time with no outcome tool called: it ends unfinished, set aside (§12.3). */
  Unfinished: {}
  /** A tool failed in the engine (the work graph, git), not on its arguments: a `ToolDefect` (§12.8). */
  ToolFailed: { readonly tool: string; readonly reason: string }
}>
export const Outcome = Data.taggedEnum<Outcome>()
