import { Data, Effect, Option, Schema } from 'effect'

import {
  type Actor,
  Edge,
  FiledItem,
  FiledTree,
  type TicketId,
  TicketMetadata,
  type TreeItem,
} from '@fabrica/contracts'

import { InvalidTicket } from './errors'
import type { WorkGraphShape } from './service'

// A tree of tickets filed at once (spec §15.4, §15.5): the refine and feature talks' `file_tree`.
// The tree is checked whole before anything is filed: its keys, its one root epic, the parents and
// the items each waits on, the files each ticket names, and cycles among parents and waits together
// (an epic waits on the tickets under it, so a ticket waiting on its own epic is a cycle). Every
// reason is given at once, so the tree comes back corrected in one go. A tree that passes is filed
// parents first, each ticket as its parent's next child, then its waits as `blocks` links.

/** The tree was refused, with every reason. */
export class TreeRefused extends Data.TaggedError('TreeRefused')<{
  readonly problems: ReadonlyArray<string>
}> {
  override get message() {
    return `the tree was refused: ${this.problems.join('; ')}`
  }
}

/** The items each waits on, by key: an epic on the items under it, an item on those it names. */
const waitsOf = (items: ReadonlyArray<TreeItem>) => {
  const keys = new Set(items.map(item => item.key))
  const waits = new Map<string, Array<string>>(
    items.map(item => [item.key, []]),
  )
  for (const item of items) {
    for (const parent of Option.toArray(item.parent))
      if (keys.has(parent) && parent !== item.key)
        waits.get(parent)?.push(item.key)
    for (const waited of Option.getOrElse(item.waitsOn, () => []))
      if (keys.has(waited) && waited !== item.key)
        waits.get(item.key)?.push(waited)
  }
  return waits
}

/** Each cycle among the waits, as the keys around it, each cycle once. */
const cyclesOf = (
  items: ReadonlyArray<TreeItem>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const waits = waitsOf(items)
  const done = new Set<string>()
  const path: Array<string> = []
  const onPath = new Set<string>()
  const found = new Map<string, ReadonlyArray<string>>()
  const visit = (key: string) => {
    path.push(key)
    onPath.add(key)
    for (const next of waits.get(key) ?? []) {
      if (onPath.has(next)) {
        const cycle = path.slice(path.indexOf(next))
        // The same cycle reached from another of its keys is named once, from its least key.
        const least = cycle.indexOf([...cycle].sort()[0] ?? next)
        const named = [...cycle.slice(least), ...cycle.slice(0, least)]
        found.set(named.join(' '), named)
      } else if (!done.has(next)) visit(next)
    }
    path.pop()
    onPath.delete(key)
    done.add(key)
  }
  for (const item of items) if (!done.has(item.key)) visit(item.key)
  return [...found.values()]
}

/** Every reason the tree can't be filed, in words; none when it can. */
export const treeProblems = (
  items: ReadonlyArray<TreeItem>,
): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const byKey = new Map<string, TreeItem>()
  const counts = new Map<string, number>()
  for (const item of items) {
    counts.set(item.key, (counts.get(item.key) ?? 0) + 1)
    if (!byKey.has(item.key)) byKey.set(item.key, item)
  }
  for (const [key, count] of counts)
    if (count > 1) problems.push(`the key ${key} is given to ${count} items`)

  const roots = items.filter(item => Option.isNone(item.parent))
  if (roots.length === 0)
    problems.push(
      'no item is the root: one epic, with no parent, holds the rest',
    )
  if (roots.length > 1)
    problems.push(
      `${roots.length} items have no parent (${roots.map(root => root.key).join(', ')}): one epic, the root, holds the rest`,
    )
  for (const root of roots)
    if (root.type !== 'epic')
      problems.push(
        `the root ${root.key} is a ${root.type}: the root is an epic`,
      )

  for (const item of items) {
    for (const parent of Option.toArray(item.parent)) {
      const found = byKey.get(parent)
      if (parent === item.key)
        problems.push(`${item.key} names itself as its parent`)
      else if (found === undefined)
        problems.push(`${item.key}'s parent ${parent} isn't in the tree`)
      else if (found.type !== 'epic')
        problems.push(
          `${item.key}'s parent ${parent} is a ${found.type}: only an epic holds others`,
        )
    }
    for (const waited of Option.getOrElse(item.waitsOn, () => [])) {
      if (waited === item.key) problems.push(`${item.key} waits on itself`)
      else if (!byKey.has(waited))
        problems.push(`${item.key} waits on ${waited}, which isn't in the tree`)
    }
    if (item.type === 'epic' && Option.isSome(item.files))
      problems.push(
        `the epic ${item.key} names files: an epic changes none, its tickets do`,
      )
    if (item.type !== 'epic' && Option.isNone(item.files))
      problems.push(
        `${item.key} names no files: give the files it will change, or "unknown"`,
      )
  }

  for (const cycle of cyclesOf(items))
    problems.push(
      `${cycle.join(', ')} wait on one another, through their parents and the items they wait on: ${[...cycle, cycle[0]].join(' → ')}`,
    )
  return problems
}

/** The items in the order they are filed: each after its parent, otherwise as the tree gives them. */
const parentsFirst = (items: ReadonlyArray<TreeItem>) => {
  const ordered: Array<TreeItem> = []
  const queue = items.filter(item => Option.isNone(item.parent))
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) break
    ordered.push(next)
    queue.push(...items.filter(item => Option.contains(item.parent, next.key)))
  }
  return ordered
}

/**
 * Files the tree, once it is checked whole: each item as a ticket, under its parent's, carrying
 * `spec` where it is given; then each wait as a `blocks` link from the ticket waited on.
 */
export const fileTree = Effect.fn('WorkGraph.fileTree')(function* (options: {
  readonly graph: WorkGraphShape
  readonly items: ReadonlyArray<TreeItem>
  /** The spec the tree is part of, in every ticket's metadata. */
  readonly spec: Option.Option<string>
  readonly actor: Actor
}) {
  const { graph, items, actor } = options
  const problems = treeProblems(items)
  if (problems.length > 0) return yield* new TreeRefused({ problems })

  const ids = new Map<string, TicketId>()
  const filed: Array<FiledItem> = []
  for (const item of parentsFirst(items)) {
    const metadata = yield* Schema.decodeUnknownEffect(TicketMetadata)({
      ...Option.match(item.files, {
        onNone: () => ({}),
        onSome: files => (files === 'unknown' ? {} : { files }),
      }),
      ...Option.match(options.spec, {
        onNone: () => ({}),
        onSome: spec => ({ spec }),
      }),
    }).pipe(
      Effect.mapError(issue => new InvalidTicket({ issue: issue.message })),
    )
    const parent = Option.flatMap(item.parent, key =>
      Option.fromUndefinedOr(ids.get(key)),
    )
    const ticket = yield* graph.create({
      ticket: {
        type: item.type,
        title: item.title,
        description: item.description,
        ...Option.match(item.design, {
          onNone: () => ({}),
          onSome: design => ({ design }),
        }),
        ...Option.match(item.acceptance, {
          onNone: () => ({}),
          onSome: acceptance => ({ acceptance }),
        }),
        ...Option.match(item.priority, {
          onNone: () => ({}),
          onSome: priority => ({ priority }),
        }),
        ...Option.match(item.labels, {
          onNone: () => ({}),
          onSome: labels => ({ labels }),
        }),
        ...Option.match(parent, {
          onNone: () => ({}),
          onSome: id => ({ parent: id }),
        }),
        metadata,
      },
      actor,
    })
    ids.set(item.key, ticket.id)
    filed.push(new FiledItem({ key: item.key, id: ticket.id }))
  }

  for (const item of items)
    for (const waited of Option.getOrElse(item.waitsOn, () => [])) {
      const [from, to] = [ids.get(waited), ids.get(item.key)]
      if (from !== undefined && to !== undefined)
        yield* graph.addDependency({
          edge: new Edge({ from, to, kind: 'blocks' }),
          actor,
        })
    }

  const [root] = filed
  if (root === undefined)
    return yield* new TreeRefused({ problems: ['the tree has no items'] })
  return new FiledTree({ root: root.id, items: filed })
})
