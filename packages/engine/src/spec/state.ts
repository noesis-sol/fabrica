import { Data, Effect, Option } from 'effect'

import {
  SpecCommitKey,
  SpecSha256Key,
  type Ticket,
  type TicketId,
} from '@fabrica/contracts'

import type { WorkGraphShape } from '../workgraph'
import { descendants } from '../workgraph'
import { SpecProblem } from './read'

// Where a spec stands (spec §15.5): the root epic an earlier run filed for it is the epic with no parent
// whose `spec` metadata is the spec's path, and its `spec_sha256`, set last of all, says the version
// its tree was filed for. A run carries on from it by that SHA-256: no breakdown for the same text, an
// update for a changed one, and with none the breakdown that filed it is carried on.

export type SpecState = Data.TaggedEnum<{
  /** No root epic: a breakdown from the start. */
  New: {}
  /** The breakdown that filed the root epic didn't finish: it is carried on. */
  Unfinished: { readonly root: TicketId }
  /** The tree is filed for this version: the run carries on with what is left. */
  Unchanged: { readonly root: TicketId; readonly closed: boolean }
  /** The tree is filed for an earlier version: the breakdown updates it. */
  Changed: {
    readonly root: TicketId
    readonly filedFor: string
    /** The commit of the version it was filed for, where the root epic records it. */
    readonly commit: Option.Option<string>
  }
}>
export const SpecState = Data.taggedEnum<SpecState>()

const textKey = (ticket: Ticket, key: string): Option.Option<string> =>
  Option.filter(
    Option.fromUndefinedOr(ticket.metadata[key]),
    (value): value is string => typeof value === 'string',
  )

/** The tickets under `root`, itself left out; what a breakdown's tree is made of so far. */
export const treeUnder = Effect.fn('Spec.treeUnder')(function* (input: {
  readonly graph: WorkGraphShape
  readonly root: TicketId
}) {
  const { graph, root } = input
  const [tickets, edges] = yield* Effect.all([graph.list(), graph.edges()], {
    concurrency: 2,
  })
  const under = descendants(root, edges)
  return {
    tickets: tickets.filter(
      ticket => ticket.id !== root && under.has(ticket.id),
    ),
    edges,
  }
})

/** The spec's state in the work graph, or the problem where it has two root epics. */
export const specState = Effect.fn('Spec.state')(function* (input: {
  readonly graph: WorkGraphShape
  readonly path: string
  readonly sha256: string
}) {
  const { graph, path, sha256 } = input
  const [epics, edges] = yield* Effect.all(
    [graph.list({ types: ['epic'] }), graph.edges()],
    { concurrency: 2 },
  )
  const children = new Set(
    edges.filter(({ kind }) => kind === 'parent').map(({ to }) => to),
  )
  const roots = epics.filter(
    epic => Option.contains(epic.metadata.spec, path) && !children.has(epic.id),
  )
  const [root, second] = roots
  if (second !== undefined)
    return yield* new SpecProblem({
      problem: `the spec ${path} has ${roots.length} root epics (${roots.map(({ id }) => id).join(', ')}): close and remove all but one`,
    })
  if (root === undefined) return SpecState.New()
  const filedFor = textKey(root, SpecSha256Key)
  if (Option.isNone(filedFor)) return SpecState.Unfinished({ root: root.id })
  return filedFor.value === sha256
    ? SpecState.Unchanged({ root: root.id, closed: root.status === 'closed' })
    : SpecState.Changed({
        root: root.id,
        filedFor: filedFor.value,
        commit: textKey(root, SpecCommitKey),
      })
})

/** The root epic the state knows of. */
export const rootOf: (state: SpecState) => Option.Option<TicketId> =
  SpecState.$match({
    New: () => Option.none(),
    Unfinished: ({ root }) => Option.some(root),
    Unchanged: ({ root }) => Option.some(root),
    Changed: ({ root }) => Option.some(root),
  })

/** Whether the state asks for a breakdown. */
export const needsBreakdown: (state: SpecState) => boolean = SpecState.$match({
  New: () => true,
  Unfinished: () => true,
  Unchanged: () => false,
  Changed: () => true,
})
