import { Data, Option } from 'effect'

import type { OutcomeToolNames } from '@fabrica/contracts'

// The settle nudge (spec §12.3): a turn about to end with no outcome tool gets one nudge, inside Pi,
// an extra model call asking for one; a second settle with none ends the session as unfinished. A
// turn runs from a prompt (the first, a hand-back, a maintainer's message, a resume) until Pi has
// settled, and each turn starts with no outcome and no nudge.

/** An outcome tool, the call that ended the turn. */
export type OutcomeTool = (typeof OutcomeToolNames)[number]

/** The turn so far: the outcome tool that ended it, if one has, and whether it was nudged. */
export interface Turn {
  readonly outcome: Option.Option<OutcomeTool>
  readonly nudged: boolean
}

/** A turn as it starts. */
export const freshTurn: Turn = { outcome: Option.none(), nudged: false }

/** The turn once `tool` has ended it. */
export const ended = (turn: Turn, tool: OutcomeTool): Turn => ({
  ...turn,
  outcome: Option.some(tool),
})

/** What the extension does as Pi is about to settle. */
export type Settling = Data.TaggedEnum<{
  /** Let Pi settle: the turn has its outcome, or it was aborted or failed, which the engine handles. */
  Settle: {}
  /** Ask for one more model call, with the nudge. */
  Nudge: {}
  /** Let Pi settle, and report the session unfinished: it was nudged and still has no outcome. */
  Unfinished: {}
}>
export const Settling = Data.taggedEnum<Settling>()

/**
 * What to do as the turn is about to settle, and the turn after: `completed` is false when the turn
 * was aborted or ended on an error, which aren't the agent's to answer for.
 */
export const settle = (
  turn: Turn,
  completed: boolean,
): readonly [Settling, Turn] => {
  if (Option.isSome(turn.outcome) || !completed)
    return [Settling.Settle(), turn]
  if (!turn.nudged) return [Settling.Nudge(), { ...turn, nudged: true }]
  return [Settling.Unfinished(), turn]
}

/** The custom type of the nudge's message in the session. */
export const NudgeType = 'fabrica-nudge'

/** The nudge, as the agent reads it. */
export const NudgeText =
  'Your turn is about to end with no outcome. End it through one of your tools: finish when the ' +
  'work is done, defer when you cannot finish, wait_for when another ticket must merge first, or ' +
  'ask_question when only the maintainer can decide. A turn that ends without one ends your work ' +
  'on the ticket unfinished.'

/** The custom type of the entry recording, in the session, how each turn settled. */
export const SettledType = 'fabrica-settled'

/** How a turn settled, as the session records it. */
export interface SettledEntry {
  readonly outcome: OutcomeTool | null
  readonly nudged: boolean
  readonly aborted: boolean
}

export const settledEntry = (turn: Turn, aborted: boolean): SettledEntry => ({
  outcome: Option.getOrNull(turn.outcome),
  nudged: turn.nudged,
  aborted,
})
