import { Data } from 'effect'

import type {
  CheckOwnPass,
  TicketId,
  TicketResult,
  Verdict,
} from '@fabrica/contracts'

import type { CheckRecord } from '../checks'

// What a worker's session came to, as its control channel heard it (spec §12.3, §13.5, §12.8), and a
// verifier's verdict (§13.6): the run loop reads one stream of these per session and does what each
// asks of the run (the verifier and the merge queue, a freed slot, a resume once a question is
// answered). The work graph already holds each one's effect when it is published.

/** What a `finish` stood on: a `check_own` pass on HEAD's tree, or none, the project's `check_own` being `"none"` (H62). */
export type OwnCheck = Data.TaggedEnum<{
  /** `check_own` passed on the tree finished. */
  Passed: { readonly pass: CheckOwnPass }
  /** The project's `check_own` is `"none"`: the work finished unchecked, and says so. */
  Unchecked: {}
}>
export const OwnCheck = Data.taggedEnum<OwnCheck>()

export type Outcome = Data.TaggedEnum<{
  /** `finish`: the worktree clean, what `check_own` came to on HEAD's tree, the result recorded on the ticket. */
  Finished: { readonly result: TicketResult; readonly checkOwn: OwnCheck }
  /** `defer`: the ticket set aside, its worktree and session kept, the reason its note. */
  Deferred: { readonly reason: string }
  /** `wait_for`: the ticket linked as blocked by `ticket`, which must merge first. */
  WaitsFor: { readonly ticket: TicketId; readonly needs: string }
  /** `ask_question` about its own ticket, or `ask_and_wait` unanswered in `question_wait`: the ticket waits on `question`. */
  Asked: { readonly question: TicketId }
  /** The session settled a second time with no outcome tool called: it ends unfinished, set aside (§12.3). */
  Unfinished: {}
  /** `check_own` ran (or couldn't): its record for the event stream (§13.12); the turn goes on. */
  Checked: { readonly check: CheckRecord }
  /** The verifier's `verdict` on what the ticket's worker finished (§13.6). */
  Verdict: { readonly verdict: Verdict }
  /** A tool failed in the engine (the work graph, git), not on its arguments: a `ToolDefect` (§12.8). */
  ToolFailed: { readonly tool: string; readonly reason: string }
}>
export const Outcome = Data.taggedEnum<Outcome>()
