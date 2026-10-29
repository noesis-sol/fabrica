import { Effect, type Option } from 'effect'

import { FileTreeTool, type TalkMode, ToolRefusal } from '@fabrica/contracts'

import { fileTree } from '../workgraph'
import { type TalkContextOf, type TalkTool, talkTool } from './core'

// `file_tree`, the talks' side (spec §15.4, §15.5): the refine and feature talks file what they decide
// as one tree, on the project's work graph, as the talk's session. A tree refused by its check goes
// back to the talk with every reason; a failure of the store is a defect of the call.

/** `file_tree` for a talk of `M`, its tickets carrying the spec `spec` reads from the talk's context. */
export const fileTreeTool = <M extends TalkMode>(
  spec: (context: TalkContextOf<M>) => Option.Option<string>,
): TalkTool<M> =>
  talkTool(FileTreeTool, ({ items }, { context, graph, actor }) =>
    Effect.flatMap(graph, graph =>
      fileTree({ graph, items, spec: spec(context), actor }),
    ).pipe(
      Effect.catchTag(['TreeRefused', 'InvalidTicket', 'EdgeCycle'], error =>
        Effect.fail(ToolRefusal.cases.invalid.make({ issue: error.message })),
      ),
      Effect.catchTag(['StoreFailed', 'TicketNotFound'], Effect.die),
    ),
  )
