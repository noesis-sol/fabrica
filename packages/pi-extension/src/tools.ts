import { Data, Effect, Option, Ref, Schema } from 'effect'
import { Type } from 'typebox'

import {
  AddNoteTool,
  AskAndWaitTool,
  AskQuestionTool,
  Awaited,
  CheckOwnTool,
  ControlUnauthorized,
  DeferTool,
  FileTicketTool,
  FinishTool,
  GetTicketTool,
  type TicketId,
  type Tool,
  ToolRefusal,
  WaitForTool,
  WorkerTools,
  decodeArguments,
  parametersJsonSchema,
} from '@fabrica/contracts'

import { Control } from './control'
import type { PiTool } from './pi'
import { type OutcomeTool, type Turn, ended } from './settle'

// The worker's tools (spec §12.2, §12.3), registered with Pi: each one's arguments' JSON Schema from
// `@fabrica/contracts`, wrapped as a TypeBox schema for Pi to check first; its handler decodes the
// arguments again with the Effect Schema, which has the last word, and forwards them to the engine
// over the control channel. An invalid payload, or the engine's refusal, fails the call inside Pi's
// loop, so the agent reads why and tries again. A call that ends the turn says so to the settle
// nudge, and asks Pi to stop after it.

/** The names of the worker's tools, which the gate always allows. */
export const WorkerToolNames: ReadonlySet<string> = new Set(
  WorkerTools.map(tool => tool.name),
)

/** A worker tool's call failed: its arguments didn't decode, the engine refused it, or it couldn't reach the engine. */
export class ToolCallFailed extends Data.TaggedError('ToolCallFailed')<{
  readonly tool: string
  readonly reason: string
}> {
  override get message() {
    return `${this.tool} failed: ${this.reason}`
  }
}

/** The engine's refusal, as the agent reads it. */
export const describeRefusal = ToolRefusal.match({
  invalid: ({ issue }) => `the arguments are invalid: ${issue}`,
  out_of_scope: ({ ticket }) =>
    `${ticket} is neither your ticket nor one linked to it`,
  worktree_dirty: ({ uncommitted, untracked }) =>
    [
      'the worktree is not clean, so commit or remove what is left first',
      ...(uncommitted.length > 0
        ? [`uncommitted: ${uncommitted.join(', ')}`]
        : []),
      ...(untracked.length > 0 ? [`untracked: ${untracked.join(', ')}`] : []),
    ].join('; '),
  check_own_not_passed: ({ tree }) =>
    `check_own has no pass recorded on the tree ${tree}: run check_own on what you finish, and finish with the tree it passed on`,
  wrong_result_kind: ({ expected, given }) =>
    `your ticket's result is a ${expected}, not a ${given}`,
})

const isRefusal = Schema.is(ToolRefusal)
const isUnauthorized = Schema.is(ControlUnauthorized)

/** Whatever failed a forwarded call, as the agent reads it. */
const reasonOf = (error: unknown): string =>
  isRefusal(error)
    ? describeRefusal(error)
    : isUnauthorized(error)
      ? "the engine refused the control token: this session's channel is closed"
      : error instanceof Error
        ? error.message
        : String(error)

/** The worker's own ticket, as `get_ticket` with no ID gives it. */
const ownTicket = Effect.gen(function* () {
  const control = yield* Control
  const view = yield* control.get_ticket({ id: Option.none() })
  return view.ticket.id
})

/** Whether a question blocking `blocks` (its asker's own ticket when none) is about the worker's own ticket. */
const aboutOwnTicket = (blocks: Option.Option<TicketId>) =>
  Option.match(blocks, {
    onNone: () => Effect.succeed(true),
    onSome: ticket => Effect.map(ownTicket, own => own === ticket),
  })

/** Which of a tool's answers ends the turn, told before the call is forwarded, so that nothing the engine did is undone by a failure after it. */
type Ending<Answer> = (answer: Answer) => Option.Option<OutcomeTool>

const never = Effect.succeed(() => Option.none<OutcomeTool>())
const always = (tool: OutcomeTool) =>
  Effect.succeed(() => Option.some<OutcomeTool>(tool))

/** A question's ending: the turn's outcome when it is about the worker's own ticket, and `ends` says so of the answer. */
const question = <Answer>(
  tool: OutcomeTool,
  blocks: Option.Option<TicketId>,
  ends: (answer: Answer) => boolean,
): Effect.Effect<Ending<Answer>, unknown, Control> =>
  Effect.map(
    aboutOwnTicket(blocks),
    own => answer => (own && ends(answer) ? Option.some(tool) : Option.none()),
  )

/** A worker tool wired to the engine: how its arguments reach it, and which answers end the turn. */
interface Wiring<
  Parameters extends Schema.Struct<Schema.Struct.Fields> & {
    readonly DecodingServices: never
  },
  Success extends Schema.Top & { readonly EncodingServices: never },
> {
  readonly tool: Tool<Parameters, Success>
  readonly forward: (
    params: Parameters['Type'],
  ) => Effect.Effect<Success['Type'], unknown, Control>
  readonly ends: (
    params: Parameters['Type'],
  ) => Effect.Effect<Ending<Success['Type']>, unknown, Control>
}

/** Runs an effect needing the control channel, for Pi, interrupted when Pi aborts the call. */
export type RunControl = <A, E>(
  effect: Effect.Effect<A, E, Control>,
  signal: AbortSignal | undefined,
) => Promise<A>

const piTool = <
  Parameters extends Schema.Struct<Schema.Struct.Fields> & {
    readonly DecodingServices: never
  },
  Success extends Schema.Top & { readonly EncodingServices: never },
>(
  { tool, forward, ends }: Wiring<Parameters, Success>,
  { run, turn }: { readonly run: RunControl; readonly turn: Ref.Ref<Turn> },
): PiTool => {
  const failed = (error: unknown) =>
    new ToolCallFailed({ tool: tool.name, reason: reasonOf(error) })
  const call = Effect.fn(`Tool.${tool.name}`)(function* (params: unknown) {
    const decoded = yield* decodeArguments(tool)(params).pipe(
      Effect.mapError(failed),
    )
    const ending = yield* ends(decoded).pipe(Effect.mapError(failed))
    const answer = yield* forward(decoded).pipe(Effect.mapError(failed))
    const outcome = ending(answer)
    if (Option.isSome(outcome))
      yield* Ref.update(turn, current => ended(current, outcome.value))
    const encoded = yield* Schema.encodeEffect(tool.success)(answer).pipe(
      Effect.mapError(failed),
    )
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(encoded, null, 2) },
      ],
      details: encoded,
      ...(Option.isSome(outcome) ? { terminate: true } : {}),
    }
  })
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: Type.Unsafe<unknown>(parametersJsonSchema(tool)),
    executionMode: 'sequential',
    execute: (_toolCallId, params, signal) => run(call(params), signal),
  }
}

/** The worker's tools, in `WorkerTools`' order, each call run by `run` and ending turns in `turn`. */
export const workerTools = (context: {
  readonly run: RunControl
  readonly turn: Ref.Ref<Turn>
}): ReadonlyArray<PiTool> => [
  piTool(
    {
      tool: GetTicketTool,
      forward: params => Effect.flatMap(Control, c => c.get_ticket(params)),
      ends: () => never,
    },
    context,
  ),
  piTool(
    {
      tool: FileTicketTool,
      forward: params => Effect.flatMap(Control, c => c.file_ticket(params)),
      ends: () => never,
    },
    context,
  ),
  piTool(
    {
      tool: AskQuestionTool,
      forward: params => Effect.flatMap(Control, c => c.ask_question(params)),
      ends: params => question('ask_question', params.blocks, () => true),
    },
    context,
  ),
  piTool(
    {
      tool: AddNoteTool,
      forward: params => Effect.flatMap(Control, c => c.add_note(params)),
      ends: () => never,
    },
    context,
  ),
  piTool(
    {
      tool: CheckOwnTool,
      forward: params => Effect.flatMap(Control, c => c.check_own(params)),
      ends: () => never,
    },
    context,
  ),
  piTool(
    {
      tool: FinishTool,
      forward: params => Effect.flatMap(Control, c => c.finish(params)),
      ends: () => always('finish'),
    },
    context,
  ),
  piTool(
    {
      tool: DeferTool,
      forward: params => Effect.flatMap(Control, c => c.defer(params)),
      ends: () => always('defer'),
    },
    context,
  ),
  piTool(
    {
      tool: WaitForTool,
      forward: params => Effect.flatMap(Control, c => c.wait_for(params)),
      ends: () => always('wait_for'),
    },
    context,
  ),
  piTool(
    {
      tool: AskAndWaitTool,
      forward: params => Effect.flatMap(Control, c => c.ask_and_wait(params)),
      // Answered, the agent goes on with the answer; unanswered, the turn ends as `ask_question`'s.
      ends: params =>
        question(
          'ask_and_wait',
          params.blocks,
          Awaited.match({ answered: () => false, unanswered: () => true }),
        ),
    },
    context,
  ),
]
