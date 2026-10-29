import { Effect, ManagedRuntime, Option, Ref } from 'effect'

import { Control, layer as controlLayer } from './control'
import { CopilotProvider, copilotBaseUrl, copilotProvider } from './copilot'
import type { ExtensionEnvironment } from './environment'
import { GateDecision, GateEngine, decide, gateEngine } from './gate'
import type { PiApi } from './pi'
import { StandingRulesSection, readProjectRules, standingRules } from './rules'
import {
  NudgeText,
  NudgeType,
  SettledType,
  Settling,
  freshTurn,
  settle,
  settledEntry,
} from './settle'
import { type RunControl, WorkerToolNames, workerTools } from './tools'
import { projectTrust } from './trust'

// The first-party extension (spec §12.2), loaded into every agent's Pi: the worker's tools over the
// control channel, the gate's place in `tool_call`, the standing rules in `before_agent_start`, the
// settle nudge, the project's trust, and Copilot's provider pointed at the model proxy. Its facts
// come from the environment, read once by the entry that Pi loads (`index.ts`).

/** The extension, for an agent whose environment is `environment`. */
export const makeExtension =
  (environment: ExtensionEnvironment) =>
  async (pi: PiApi): Promise<void> => {
    const runtime = ManagedRuntime.make(controlLayer(environment))
    const run: RunControl = (effect, signal) =>
      runtime.runPromise(effect, { signal })
    const turn = Ref.makeUnsafe(freshTurn)

    const copilot = await Effect.runPromise(
      Option.match(environment.configFolder, {
        onNone: () => Effect.succeedNone,
        onSome: copilotBaseUrl,
      }),
    )
    if (Option.isSome(copilot))
      pi.registerProvider(CopilotProvider, copilotProvider(copilot.value))

    for (const tool of workerTools({ run, turn })) pi.registerTool(tool)

    pi.on('project_trust', () => projectTrust(environment.projectTrusted))

    pi.on('before_agent_start', async event => {
      const options = event.systemPromptOptions
      const projectRules = await Effect.runPromise(
        readProjectRules(options.cwd),
      )
      options.sections[StandingRulesSection] = standingRules(projectRules)
      return undefined
    })

    const gate = decide({
      permissions: environment.permissions,
      worktree: environment.worktree,
      home: environment.home,
    })
    pi.on('tool_call', async event => {
      if (WorkerToolNames.has(event.toolName)) return undefined
      const call = {
        toolCallId: event.toolCallId,
        tool: event.toolName,
        input: { ...event.input },
      }
      const decision = await run(
        Effect.flatMap(Control, control =>
          gate(call).pipe(
            Effect.provideService(GateEngine, gateEngine(control)),
          ),
        ),
        undefined,
      ).catch((error: unknown) =>
        GateDecision.Blocked({
          reason: `Fabrica’s gate refused this call: it couldn’t reach the engine: ${error instanceof Error ? error.message : String(error)}`,
        }),
      )
      return GateDecision.$match(decision, {
        Allowed: () => undefined,
        Blocked: ({ reason }) => ({ block: true, reason }),
      })
    })

    pi.on('agent_before_settle', async event => {
      const settling = await Effect.runPromise(
        Ref.modify(turn, current =>
          settle(current, event.outcome === 'completed'),
        ),
      )
      return Settling.$match(settling, {
        Settle: () => Promise.resolve(undefined),
        Nudge: () =>
          Promise.resolve({
            continue: true,
            entries: [
              {
                type: 'custom_message' as const,
                customType: NudgeType,
                content: NudgeText,
                display: false,
              },
            ],
          }),
        Unfinished: () =>
          run(
            Effect.flatMap(Control, control => control.report_unfinished({})),
            undefined,
          ).then(() => undefined),
      })
    })

    pi.on('agent_settled', async event => {
      const settled = await Effect.runPromise(Ref.getAndSet(turn, freshTurn))
      pi.appendEntry(SettledType, settledEntry(settled, event.aborted))
      return undefined
    })

    pi.on('session_shutdown', async () => {
      await runtime.dispose()
      return undefined
    })
  }
