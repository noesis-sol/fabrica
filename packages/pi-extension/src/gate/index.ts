import { Cause, Context, Data, Effect, Option, Schema } from 'effect'

import {
  type GateDecided,
  GateVerdict,
  type MergeStanding,
  type PermissionAsked,
  PermissionDecision,
  PermissionShown,
  type Permissions,
  Text,
  ToolCallId,
} from '@fabrica/contracts'

import type { Control } from '../control'
import { Ruling, analyze, rule } from './policy'

// The gate in Pi's `tool_call` step (spec §12.2, §12.6, §20.2): the permission policy's decision on
// each call to a tool other than the extension's own, which are always allowed. A refusal is final;
// a call the level asks about goes to the engine whole, as a permission request, and waits for the
// maintainer's answer; a write to the branch first reads the merge queue from the engine, and is
// refused while the ticket waits to merge or merges (H59). Every decision is reported to the engine
// for its log. A gate that fails blocks the call, saying why.

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

/** What the gate decides with: the project's level, the worktree, and the home folder where known. */
export interface GateFacts {
  readonly permissions: Permissions
  readonly worktree: string
  readonly home: Option.Option<string>
}

/** What the gate needs of the engine (§12.2): the merge queue, the maintainer's answers, its log. */
export interface GateEngineShape {
  readonly mergeStanding: Effect.Effect<MergeStanding, unknown>
  readonly requestPermission: (
    asked: PermissionAsked,
  ) => Effect.Effect<PermissionDecision, unknown>
  readonly report: (decided: GateDecided) => Effect.Effect<void, unknown>
}

export class GateEngine extends Context.Service<GateEngine, GateEngineShape>()(
  '@fabrica/pi-extension/GateEngine',
) {}

/** The gate's engine over the session's control channel. */
export const gateEngine = (control: Control['Service']): GateEngineShape => ({
  mergeStanding: control.merge_standing({}),
  requestPermission: asked => control.request_permission(asked),
  report: decided => control.report_gate_decision(decided),
})

const EditInput = Schema.Struct({
  path: Text,
  edits: Schema.Array(
    Schema.Struct({ oldText: Schema.String, newText: Schema.String }),
  ),
})
const WriteInput = Schema.Struct({ path: Text, content: Schema.String })
const CommandInput = Schema.Struct({ command: Schema.String })

const lines = (text: string, prefix: string): string =>
  text
    .split('\n')
    .map(line => `${prefix}${line}`)
    .join('\n')

/** The call as the maintainer is shown it, whole (§15.1, H62). */
const shown = (call: GateCall, input: Schema.Json): PermissionShown => {
  const fallback = PermissionShown.cases.call.make({ input })
  if (call.tool === 'bash' || call.tool === 'powershell')
    return Option.match(Schema.decodeUnknownOption(CommandInput)(call.input), {
      onNone: () => fallback,
      onSome: ({ command }) => {
        const [first = '', ...rest] = command.split('\n')
        return PermissionShown.cases.command.make({ lines: [first, ...rest] })
      },
    })
  if (call.tool === 'edit')
    return Option.match(Schema.decodeUnknownOption(EditInput)(call.input), {
      onNone: () => fallback,
      onSome: ({ path, edits }) =>
        PermissionShown.cases.edit.make({
          path,
          diff: edits
            .map(
              ({ oldText, newText }) =>
                `${lines(oldText, '-')}\n${lines(newText, '+')}`,
            )
            .join('\n'),
        }),
    })
  if (call.tool === 'write')
    return Option.match(Schema.decodeUnknownOption(WriteInput)(call.input), {
      onNone: () => fallback,
      onSome: ({ path, content }) =>
        PermissionShown.cases.write.make({ path, content }),
    })
  return fallback
}

const mergeHeld = (
  standing: Exclude<MergeStanding, 'not_queued'>,
  command: string,
): string =>
  `${command} waits: your ticket is ${standing === 'merging' ? 'merging' : 'waiting to merge'}, and its branch takes no commits or other writes until the merge is over, so that the commit checked is the commit merged`

const blockedBy = (reason: string): string =>
  `Fabrica’s gate refused this call: ${reason}`

const answered = (
  why: string,
): ((decision: PermissionDecision) => GateDecision) =>
  PermissionDecision.match({
    allow_once: (): GateDecision => GateDecision.Allowed(),
    allow_run: (): GateDecision => GateDecision.Allowed(),
    refuse: ({ note }): GateDecision =>
      GateDecision.Blocked({
        reason: blockedBy(
          Option.match(note, {
            onNone: () => `the maintainer refused it (${why})`,
            onSome: given => `the maintainer refused it: ${given}`,
          }),
        ),
      }),
  })

const failure = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

/** The gate's decision on `call`, reported to the engine. */
const decideCall = (facts: GateFacts) =>
  Effect.fnUntraced(function* (call: GateCall) {
    const engine = yield* GateEngine
    const toolCall = yield* Schema.decodeUnknownEffect(ToolCallId)(
      call.toolCallId,
    )
    const tool = yield* Schema.decodeUnknownEffect(Text)(call.tool)
    const report = (verdict: GateVerdict) =>
      engine.report({ toolCall, tool, verdict })
    const refused = (reason: string): Effect.Effect<GateDecision, unknown> =>
      Effect.as(
        report(GateVerdict.cases.refused.make({ reason })),
        GateDecision.Blocked({ reason: blockedBy(reason) }),
      )
    const asked = Effect.fnUntraced(function* (
      why: string,
    ): Effect.fn.Return<GateDecision, unknown, never> {
      const input = yield* Schema.decodeUnknownEffect(Schema.Json)(call.input)
      const decision = yield* engine.requestPermission({
        toolCall,
        tool,
        input,
        shown: shown(call, input),
        why,
      })
      yield* report(GateVerdict.cases.asked.make({ why, decision }))
      return answered(why)(decision)
    })
    const weighed = (
      asks: ReadonlyArray<string>,
    ): Effect.Effect<GateDecision, unknown> =>
      asks.length === 0
        ? Effect.as(
            report(GateVerdict.cases.allowed.make({})),
            GateDecision.Allowed(),
          )
        : asked(asks.join('; '))

    return yield* Ruling.$match(
      rule(facts.permissions, analyze(call.tool, call.input, facts)),
      {
        Refuse: ({ reason }) => refused(reason),
        Weigh: ({ branchWrite, asks }) =>
          Option.match(branchWrite, {
            onNone: () => weighed(asks),
            onSome: command =>
              Effect.flatMap(engine.mergeStanding, standing =>
                standing === 'not_queued'
                  ? weighed(asks)
                  : refused(mergeHeld(standing, command)),
              ),
          }),
      },
    )
  })

/** The gate's decision on `call`, reported to the engine; a gate that fails blocks the call, saying why. */
export const decide = (facts: GateFacts) =>
  Effect.fn('Gate.decide')(function* (call: GateCall) {
    return yield* decideCall(facts)(call).pipe(
      Effect.catchCause(cause =>
        Effect.succeed<GateDecision>(
          GateDecision.Blocked({
            reason: blockedBy(
              `the gate failed while deciding on ${call.tool}, so the call is blocked: ${failure(cause)}`,
            ),
          }),
        ),
      ),
    )
  })
