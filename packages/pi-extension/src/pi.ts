import type { TUnsafe } from 'typebox'

import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  AgentSettledEvent,
  AgentToolResult,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ProjectTrustEvent,
  ProjectTrustEventResult,
  ProviderConfig,
  SessionShutdownEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'

// The part of Pi's extension API (spec §12.2) the first-party extension uses, as Pi 1.4.0 types it:
// `ExtensionAPI` is one, and a test's fake is another. The handlers take only the event, and a tool
// only its call's ID, its arguments and its abort signal, since the extension reads nothing else Pi
// passes them.

/** What a handler may answer: `R`, or nothing, leaving Pi's course as it is. */
type Answer<R> = Promise<R | undefined> | R | undefined

/**
 * A worker tool as the extension registers it: its arguments' JSON Schema wrapped as a TypeBox schema
 * of unknown values, which the handler decodes again with the tool's Effect Schema.
 */
export interface PiTool extends Omit<
  ToolDefinition<TUnsafe<unknown>, unknown>,
  'execute'
> {
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ): Promise<AgentToolResult<unknown>>
}

export interface PiApi {
  on(
    event: 'project_trust',
    handler: (event: ProjectTrustEvent) => Answer<ProjectTrustEventResult>,
  ): () => void
  on(
    event: 'before_agent_start',
    handler: (
      event: BeforeAgentStartEvent,
    ) => Answer<BeforeAgentStartEventResult>,
  ): () => void
  on(
    event: 'tool_call',
    handler: (event: ToolCallEvent) => Answer<ToolCallEventResult>,
  ): () => void
  on(
    event: 'agent_before_settle',
    handler: (
      event: AgentBeforeSettleEvent,
    ) => Answer<AgentBeforeSettleEventResult>,
  ): () => void
  on(
    event: 'agent_settled',
    handler: (event: AgentSettledEvent) => Answer<never>,
  ): () => void
  on(
    event: 'session_shutdown',
    handler: (event: SessionShutdownEvent) => Answer<never>,
  ): () => void
  registerTool(tool: PiTool): void
  registerProvider(name: string, config: ProviderConfig): void
  appendEntry(customType: string, data?: unknown): void
}

/** Pi's own API is the extension's: this fails to compile when a Pi upgrade changes what it uses. */
export const fromExtensionApi = (pi: ExtensionAPI): PiApi => pi
