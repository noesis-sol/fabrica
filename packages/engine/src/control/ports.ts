import {
  Context,
  Effect,
  HashMap,
  HashSet,
  Layer,
  type Option,
  Ref,
} from 'effect'

import type {
  PermissionDecision,
  PermissionShown,
  ProjectId,
  SessionId,
  TicketId,
  ToolCallId,
  TreeHash,
} from '@fabrica/contracts'

// What the control server needs from the rest of the engine beyond the work graph and git: the
// attention service, which takes the gate's permission requests to the maintainer (spec §12.6,
// §15.1), and the record of `check_own`'s passes by tree, which `finish` stands on (H89).

/** A tool call the gate couldn't decide, from one agent's session, for the maintainer. */
export interface PermissionRequest {
  readonly project: ProjectId
  readonly ticket: TicketId
  readonly session: SessionId
  readonly toolCall: ToolCallId
  readonly tool: string
  /** The call's arguments, whole. */
  readonly input: unknown
  readonly shown: PermissionShown
  readonly why: string
}

/** The attention service's side the control server calls (§15.1). */
export interface AttentionShape {
  /**
   * Opens a permission request and waits for its decision. Interrupted (the agent's session closed
   * meanwhile), the request is withdrawn.
   */
  readonly permission: (
    request: PermissionRequest,
  ) => Effect.Effect<PermissionDecision>
}

export class Attention extends Context.Service<Attention, AttentionShape>()(
  '@fabrica/engine/Attention',
) {}

/** The passes of `check_own`, each kept with the tree it ran on: HEAD's, with the uncommitted and untracked files (§13.6). */
export interface CheckOwnPassesShape {
  /** Keeps a pass of the ticket's `check_own` on `tree`. */
  readonly record: (pass: {
    readonly ticket: TicketId
    readonly tree: TreeHash
  }) => Effect.Effect<void>
  /** Whether a pass of the ticket's `check_own` is kept on `tree`. */
  readonly passed: (pass: {
    readonly ticket: TicketId
    readonly tree: TreeHash
  }) => Effect.Effect<boolean>
  /** The tree the ticket's last pass ran on, `FABRICA_CHECK_OWN_PASSED_AT` for its next run; none before its first. */
  readonly last: (ticket: TicketId) => Effect.Effect<Option.Option<TreeHash>>
}

export class CheckOwnPasses extends Context.Service<
  CheckOwnPasses,
  CheckOwnPassesShape
>()('@fabrica/engine/CheckOwnPasses') {}

const passKey = (pass: {
  readonly ticket: TicketId
  readonly tree: TreeHash
}): string => `${pass.ticket} ${pass.tree}`

/** Passes kept in memory for the engine's life, each ticket's last one beside them. */
export const makeCheckOwnPasses: Effect.Effect<CheckOwnPassesShape> =
  Effect.map(
    Ref.make({
      passes: HashSet.empty<string>(),
      last: HashMap.empty<TicketId, TreeHash>(),
    }),
    kept => ({
      record: pass =>
        Ref.update(kept, ({ passes, last }) => ({
          passes: HashSet.add(passes, passKey(pass)),
          last: HashMap.set(last, pass.ticket, pass.tree),
        })),
      passed: pass =>
        Effect.map(Ref.get(kept), ({ passes }) =>
          HashSet.has(passes, passKey(pass)),
        ),
      last: ticket =>
        Effect.map(Ref.get(kept), ({ last }) => HashMap.get(last, ticket)),
    }),
  )

export const checkOwnPassesLayer: Layer.Layer<CheckOwnPasses> = Layer.effect(
  CheckOwnPasses,
  makeCheckOwnPasses,
)
