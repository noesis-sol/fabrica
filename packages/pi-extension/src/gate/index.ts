import { Data, Effect } from 'effect'

// The gate's place in Pi's `tool_call` step (spec §12.2, §12.6): what the permission policy decides
// for each call to a tool other than the extension's own, which are always allowed. The policy (path
// confinement, the command policy, `git push`, approvals) is the gate ticket's; until then every call
// is allowed.

/** A tool call the gate decides: Pi's call ID, the tool and its arguments. */
export interface GateCall {
  readonly toolCallId: string
  readonly tool: string
  readonly input: Readonly<Record<string, unknown>>
}

export type GateDecision = Data.TaggedEnum<{
  Allowed: {}
  /** Refused: the call doesn't run, and the agent reads `reason` as its error. */
  Blocked: { readonly reason: string }
}>
export const GateDecision = Data.taggedEnum<GateDecision>()

/** The gate's decision on a call. */
export const decide = (_call: GateCall): Effect.Effect<GateDecision> =>
  Effect.succeed(GateDecision.Allowed())
