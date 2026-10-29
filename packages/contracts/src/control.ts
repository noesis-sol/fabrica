import { Schema } from 'effect'
import { Headers } from 'effect/http'
import { Rpc, RpcGroup, RpcMiddleware } from 'effect/rpc'

import { ToolCallId } from './ids'
import { PermissionDecision, PermissionShown } from './rpc/attention'
import { Text } from './ticket'
import {
  AddNoteParameters,
  AskQuestionParameters,
  Awaited,
  DeferParameters,
  Ended,
  FileTicketParameters,
  Filed,
  FinishParameters,
  GetTicketParameters,
  Noted,
  TicketView,
  ToolRefusal,
  WaitForParameters,
} from './tools'

// The worker's control channel (spec §12.2, §12.3, §20.2): what the first-party extension sends the
// engine over its agent's own Unix socket, in the Schema RPC protocol. The worker's tools, one request
// each, named and shaped as `tools.ts` has them; the gate's permission requests (§12.6); and the
// extension's report of a session that settled twice with no outcome. The socket's path and the token
// arrive in the agent's environment; every request carries the token in a header, which the engine
// checks before it acts on the request, and which scopes the session to its own ticket and the tickets
// linked to it.

/** The variable holding the path of the agent's control socket. */
export const ControlSocketVariable = 'FABRICA_CONTROL_SOCKET'

/** The variable holding the agent's control token. */
export const ControlTokenVariable = 'FABRICA_CONTROL_TOKEN'

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
  /** The gate's request, answered once the maintainer decides. */
  Rpc.make('request_permission', {
    payload: PermissionAsked,
    success: PermissionDecision,
  }),
  /** The session settled a second time with no outcome tool called: it ends unfinished (§12.3). */
  Rpc.make('report_unfinished', { payload: {} }),
).middleware(ControlToken)
export type ControlRpcs = typeof ControlRpcs
