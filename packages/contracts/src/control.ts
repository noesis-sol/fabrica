import { Schema } from 'effect'
import { Headers } from 'effect/http'
import { Rpc, RpcGroup, RpcMiddleware } from 'effect/rpc'

import { ToolCallId } from './ids'
import { PermissionDecision, PermissionShown } from './rpc/attention'
import { Text } from './ticket'
import {
  AddNoteParameters,
  AnswerParameters,
  AskQuestionParameters,
  Awaited,
  CheckOwnParameters,
  CheckOwnRan,
  DeferParameters,
  Ended,
  FileTicketParameters,
  Filed,
  FinishParameters,
  GetTicketParameters,
  Noted,
  TicketView,
  ToolRefusal,
  VerdictParameters,
  WaitForParameters,
} from './tools'

// The worker's control channel (spec §12.2, §12.3, §20.2): what the first-party extension sends the
// engine over its agent's own Unix socket, in the Schema RPC protocol. The worker's tools, one request
// each, named and shaped as `tools.ts` has them, and the verifier's `verdict` (§13.6), an organ session's `answer` (§16) and a talk's calls to its mode's tools (§15.4); the gate's permission requests, its reading of the
// merge queue and its reports of what it decided (§12.6); and the extension's report of a session
// that settled twice with no outcome. The socket's path and the token arrive in the agent's
// environment; every request carries the token in a header, which the engine checks before it acts on
// the request, and which scopes the session to its own ticket and the tickets linked to it.

/** The variable holding the path of the agent's control socket. */
export const ControlSocketVariable = 'FABRICA_CONTROL_SOCKET'

/**
 * The variable holding the address of the agent's control channel, `<host>:<port>`, where a mounted
 * socket can't be connected from its container: Podman Machine's (§12.7, fab-mgi.61).
 */
export const ControlAddressVariable = 'FABRICA_CONTROL_ADDRESS'

/** The variable holding the agent's control token. */
export const ControlTokenVariable = 'FABRICA_CONTROL_TOKEN'

/**
 * The variable saying the user trusts the agent's project (§12.1, §20.2): `1` when they do. Until
 * then the extension refuses the project's own Pi settings and packages at Pi's `project_trust` step.
 */
export const ProjectTrustedVariable = 'FABRICA_PROJECT_TRUSTED'

/** The variable holding the project's `permissions` (§12.6), the level the extension's gate enforces. */
export const PermissionsVariable = 'FABRICA_PERMISSIONS'

/**
 * The variable naming the agent's role (§13.6, §16): `verifier` for the verifier's read-only session,
 * whose one tool is `verdict`; `organ` for an organ's read-only session, whose one tool is `answer`;
 * `talk` for a talk's read-only session (§15.4), whose tools are its mode's; a worker's, otherwise.
 */
export const AgentRoleVariable = 'FABRICA_AGENT_ROLE'

/** An agent's role, as `AgentRoleVariable` holds it. */
export const AgentRole = Schema.Literals([
  'worker',
  'verifier',
  'organ',
  'talk',
])
export type AgentRole = typeof AgentRole.Type

/**
 * The variable holding an organ session's `answer` tool as JSON (§16): each organ's schema is its own,
 * so the engine gives the tool's description and its arguments' JSON Schema at spawn.
 */
export const AnswerToolVariable = 'FABRICA_ANSWER_TOOL'

/** An organ session's `answer` tool, as `AnswerToolVariable` holds it. */
export const AnswerToolGiven = Schema.fromJsonString(
  Schema.Struct({
    description: Schema.String,
    parameters: Schema.Record(Schema.String, Schema.Unknown),
  }),
)
export type AnswerToolGiven = typeof AnswerToolGiven.Type

/**
 * The variable holding a talk's tools as JSON (§15.4): each mode's are its own, so the engine gives
 * each tool's name, description and arguments' JSON Schema at spawn.
 */
export const TalkToolsVariable = 'FABRICA_TALK_TOOLS'

/** A talk's tools, as `TalkToolsVariable` holds them. */
export const TalkToolsGiven = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      parameters: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
)
export type TalkToolsGiven = typeof TalkToolsGiven.Type

/** The header every control request carries its token in. */
export const ControlTokenHeader = 'x-fabrica-control-token'

/** The request carried no token, or not this socket's. */
export class ControlUnauthorized extends Schema.TaggedError<ControlUnauthorized>()(
  'ControlUnauthorized',
  {},
) {}

/** The token check: the client sets its header (`controlTokenClient`), the engine checks it. */
export class ControlToken extends RpcMiddleware.Service<ControlToken>()(
  'ControlToken',
  { error: ControlUnauthorized, requiredForClient: true },
) {}

/** The client's side of the token check: every request carries `token` in its header. */
export const controlTokenClient = (token: string) =>
  RpcMiddleware.layerClient(ControlToken, ({ request, next }) =>
    next({
      ...request,
      headers: Headers.set(request.headers, ControlTokenHeader, token),
    }),
  )

/** A tool call the gate can't decide, for the maintainer (§12.6, §15.1): the call whole, and why it asks. */
export const PermissionAsked = Schema.Struct({
  toolCall: ToolCallId,
  tool: Text,
  input: Schema.Json,
  shown: PermissionShown,
  why: Text,
})
export type PermissionAsked = typeof PermissionAsked.Type

/**
 * Where the session's ticket stands in the merge queue (§12.6, §13.7, H59): not in it, waiting in
 * line, or merging. While it waits or merges, the gate refuses commits and other writes to its branch.
 */
export const MergeStanding = Schema.Literals([
  'not_queued',
  'waiting',
  'merging',
])
export type MergeStanding = typeof MergeStanding.Type

/** What the gate decided on a tool call (§12.6): allowed, asked and answered, or refused. */
export const GateVerdict = Schema.TaggedUnion({
  allowed: {},
  asked: { why: Text, decision: PermissionDecision },
  refused: { reason: Text },
})
export type GateVerdict = typeof GateVerdict.Type

/** The gate's decision on one call, reported to the engine for its log and the reviewer's counts (§12.6). */
export const GateDecided = Schema.Struct({
  toolCall: ToolCallId,
  tool: Text,
  verdict: GateVerdict,
})
export type GateDecided = typeof GateDecided.Type

export const ControlRpcs = RpcGroup.make(
  Rpc.make('get_ticket', {
    payload: GetTicketParameters,
    success: TicketView,
    error: ToolRefusal,
  }),
  Rpc.make('file_ticket', {
    payload: FileTicketParameters,
    success: Filed,
    error: ToolRefusal,
  }),
  Rpc.make('ask_question', {
    payload: AskQuestionParameters,
    success: Filed,
    error: ToolRefusal,
  }),
  Rpc.make('add_note', {
    payload: AddNoteParameters,
    success: Noted,
    error: ToolRefusal,
  }),
  Rpc.make('check_own', {
    payload: CheckOwnParameters,
    success: CheckOwnRan,
    error: ToolRefusal,
  }),
  Rpc.make('finish', {
    payload: FinishParameters,
    success: Ended,
    error: ToolRefusal,
  }),
  Rpc.make('defer', {
    payload: DeferParameters,
    success: Ended,
    error: ToolRefusal,
  }),
  Rpc.make('wait_for', {
    payload: WaitForParameters,
    success: Ended,
    error: ToolRefusal,
  }),
  Rpc.make('ask_and_wait', {
    payload: AskQuestionParameters,
    success: Awaited,
    error: ToolRefusal,
  }),
  /** The verifier's verdict on what its ticket's worker finished (§13.6). */
  Rpc.make('verdict', {
    payload: VerdictParameters,
    success: Ended,
    error: ToolRefusal,
  }),
  /** An organ session's answer, which the engine decodes with the organ's schema (§16). */
  Rpc.make('answer', {
    payload: AnswerParameters,
    success: Ended,
    error: ToolRefusal,
  }),
  /** A talk's call to one of its mode's tools, by name: the engine decodes the input and answers with the result encoded (§15.4). */
  Rpc.make('talk_tool', {
    payload: { tool: Schema.String, input: Schema.Unknown },
    success: Schema.Unknown,
    error: ToolRefusal,
  }),
  /** The gate's request, answered once the maintainer decides. */
  Rpc.make('request_permission', {
    payload: PermissionAsked,
    success: PermissionDecision,
  }),
  /** Where the session's ticket stands in the merge queue, which the gate reads before a write to its branch. */
  Rpc.make('merge_standing', { payload: {}, success: MergeStanding }),
  /** Every decision of the gate, for the engine's log. */
  Rpc.make('report_gate_decision', { payload: GateDecided }),
  /** The session settled a second time with no outcome tool called: it ends unfinished (§12.3). */
  Rpc.make('report_unfinished', { payload: {} }),
).middleware(ControlToken)
export type ControlRpcs = typeof ControlRpcs
