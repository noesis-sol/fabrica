import { Context, Effect, Layer, type Option } from 'effect'

import type {
  PermissionDecision,
  PermissionShown,
  ProjectId,
  SessionId,
  TicketId,
  ToolCallId,
  TreeHash,
} from '@fabrica/contracts'

import {
  type CheckOwnPassOf,
  type StoreFailed,
  type TicketNotFound,
  WorkGraph,
} from '../workgraph'

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

/**
 * The passes of `check_own`, each kept with the tree it ran on: HEAD's, with the uncommitted and
 * untracked files (§13.6). They live in the work graph's store, so a carried-over ticket's passes
 * outlast the engine's restart, and go as the ticket closes.
 */
export interface CheckOwnPassesShape {
  /** Keeps a pass of the ticket's `check_own` on `tree`. */
  readonly record: (
    pass: CheckOwnPassOf,
  ) => Effect.Effect<void, TicketNotFound | StoreFailed>
  /** Whether a pass of the ticket's `check_own` is kept on `tree`. */
  readonly passed: (pass: CheckOwnPassOf) => Effect.Effect<boolean, StoreFailed>
  /** The tree the ticket's last pass ran on, `FABRICA_CHECK_OWN_PASSED_AT` for its next run; none before its first. */
  readonly last: (
    ticket: TicketId,
  ) => Effect.Effect<Option.Option<TreeHash>, StoreFailed>
}

export class CheckOwnPasses extends Context.Service<
  CheckOwnPasses,
  CheckOwnPassesShape
>()('@fabrica/engine/CheckOwnPasses') {}

/** The passes the project's work graph keeps. */
export const makeCheckOwnPasses: Effect.Effect<
  CheckOwnPassesShape,
  never,
  WorkGraph
> = Effect.map(WorkGraph, graph => ({
  record: graph.recordCheckOwnPass,
  passed: graph.checkOwnPassed,
  last: graph.lastCheckOwnPass,
}))

export const checkOwnPassesLayer: Layer.Layer<
  CheckOwnPasses,
  never,
  WorkGraph
> = Layer.effect(CheckOwnPasses, makeCheckOwnPasses)
