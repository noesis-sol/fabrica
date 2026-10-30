import { type DateTime, Match, Option } from 'effect'

import {
  AttentionClosed,
  AttentionRef,
  type AttentionRequest,
  type RunView,
  type RunViewPatch,
  type TicketId,
  attentionKey,
} from '@fabrica/contracts'

// A run view's patch (spec §8.3): the parts of the view that changed, told by their identity, since the
// projection keeps every part and row that says what it said before (`project.ts`). A small part goes
// whole; a list of rows by its rows changed or new and those gone. A view the same as before is no patch.

/** The rows of `after` not in `before` as they were, and the keys of those gone. */
const rowsChanged = <A, K>(
  before: ReadonlyArray<A>,
  after: ReadonlyArray<A>,
  keyOf: (row: A) => string,
  goneOf: (row: A) => K,
): Option.Option<{
  readonly upsert: ReadonlyArray<A>
  readonly remove: ReadonlyArray<K>
}> => {
  if (before === after) return Option.none()
  const earlier = new Map(before.map(row => [keyOf(row), row]))
  const now = new Set(after.map(keyOf))
  const upsert = after.filter(row => earlier.get(keyOf(row)) !== row)
  const remove = before.filter(row => !now.has(keyOf(row))).map(goneOf)
  return upsert.length === 0 && remove.length === 0
    ? Option.none()
    : Option.some({ upsert, remove })
}

/** The ref that names a request. */
const refOf = (request: AttentionRequest): AttentionRef =>
  Match.valueTags(request, {
    question: ({ project, ticket }) =>
      AttentionRef.cases.question.make({ project, ticket }),
    permission: ({ project, id }) =>
      AttentionRef.cases.permission.make({ project, id }),
    task: ({ project, ticket }) =>
      AttentionRef.cases.task.make({ project, ticket }),
    review: ({ project, ticket }) =>
      AttentionRef.cases.review.make({ project, ticket }),
  })

const byTicket = ({ ticket }: { readonly ticket: TicketId }) => ticket

/** The patch from `before` to `after`, a request gone closed `at`; none where no part changed. */
export const viewPatch = (
  before: RunView,
  after: RunView,
  at: DateTime.Utc,
): Option.Option<RunViewPatch> => {
  const whole = <K extends keyof RunView>(key: K) =>
    before[key] === after[key] ? {} : { [key]: after[key] }
  const rows = <K extends 'tickets' | 'workers'>(key: K) =>
    Option.match(rowsChanged(before[key], after[key], byTicket, byTicket), {
      onNone: () => ({}),
      onSome: patch => ({ [key]: patch }),
    })
  const attention = Option.match(
    rowsChanged(
      before.attention,
      after.attention,
      attentionKey,
      request =>
        new AttentionClosed({ ref: refOf(request), by: Option.none(), at }),
    ),
    { onNone: () => ({}), onSome: patch => ({ attention: patch }) },
  )
  const patch: RunViewPatch = {
    ...whole('header'),
    ...whole('totals'),
    ...rows('tickets'),
    ...rows('workers'),
    ...whole('queue'),
    ...whole('holds'),
    ...whole('banners'),
    ...attention,
    ...whole('load'),
    ...whole('steps'),
  }
  return Object.keys(patch).length === 0 ? Option.none() : Option.some(patch)
}
