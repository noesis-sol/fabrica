import { Option } from 'effect'

import type { Edge, Ticket, TicketId } from '@fabrica/contracts'

import { descendants } from '../workgraph/tree'

// A tree's shape (spec §15.5, tutti-kkb.55): how its `blocks` links let its open tickets run, by their
// count, the longest chain of tickets each waiting on the one before, and the hubs, the tickets three
// or more others wait on directly. Its tickets over its chain is how many run at a time on average,
// the tickets taken as equal. A narrow tree is warned of, and the run goes on all the same.

/** How many others must wait directly on a ticket for it to be a hub. */
export const hubHolds = 3

/** The longest chain a tree may have unwarned. */
export const longChain = 3

export interface Hub {
  readonly id: TicketId
  readonly holds: number
}

export interface TreeShape {
  /** How many open tickets it has, its epics left out. */
  readonly tickets: number
  /** The longest chain, the ticket first waited on first; empty for no tickets. */
  readonly chain: ReadonlyArray<TicketId>
  /** The most held first. */
  readonly hubs: ReadonlyArray<Hub>
}

/** The longest path through `ids` along `after`; a link back to a ticket on the path isn't followed. */
const longestChain = (
  ids: ReadonlyArray<TicketId>,
  after: ReadonlyMap<TicketId, ReadonlyArray<TicketId>>,
): ReadonlyArray<TicketId> => {
  const depth = new Map<TicketId, number>()
  const next = new Map<TicketId, TicketId>()
  const onPath = new Set<TicketId>()
  const walk = (id: TicketId): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    onPath.add(id)
    let best = 0
    for (const waiting of after.get(id) ?? []) {
      if (onPath.has(waiting)) continue
      const below = walk(waiting)
      if (below > best) {
        best = below
        next.set(id, waiting)
      }
    }
    onPath.delete(id)
    depth.set(id, best + 1)
    return best + 1
  }
  let start: TicketId | undefined
  let most = 0
  for (const id of ids) {
    const length = walk(id)
    if (length > most) {
      start = id
      most = length
    }
  }
  const chain: Array<TicketId> = []
  for (let id = start; id !== undefined; id = next.get(id)) chain.push(id)
  return chain
}

/**
 * The shape of `tickets` (epics and closed tickets left out) and the edges among them. A ticket waiting
 * on an open epic waits on each ticket under it, so a chain goes through epics; what an epic waits on
 * holds none of its tickets back, as the ready rule has it.
 */
export const treeShape = (
  tickets: ReadonlyArray<Pick<Ticket, 'id' | 'type' | 'status'>>,
  edges: ReadonlyArray<Pick<Edge, 'from' | 'to' | 'kind'>>,
): TreeShape => {
  const ids = tickets
    .filter(ticket => ticket.type !== 'epic' && ticket.status !== 'closed')
    .map(ticket => ticket.id)
  const open = new Set(ids)
  const epics = new Set(
    tickets
      .filter(ticket => ticket.type === 'epic' && ticket.status !== 'closed')
      .map(ticket => ticket.id),
  )
  /** The open tickets that must end before what waits on `id` starts. */
  const waitedOn = (id: TicketId): ReadonlyArray<TicketId> =>
    epics.has(id)
      ? [...descendants(id, edges)].filter(under => open.has(under))
      : open.has(id)
        ? [id]
        : []
  const after = new Map<TicketId, Array<TicketId>>()
  for (const { from, to, kind } of edges) {
    if (kind !== 'blocks' || !open.has(to)) continue
    for (const waited of waitedOn(from)) {
      const waiting = after.get(waited) ?? []
      if (waited !== to && !waiting.includes(to))
        after.set(waited, [...waiting, to])
    }
  }
  const hubs = ids
    .map(id => ({ id, holds: after.get(id)?.length ?? 0 }))
    .filter(hub => hub.holds >= hubHolds)
    .sort((one, other) => other.holds - one.holds)
  return { tickets: ids.length, chain: longestChain(ids, after), hubs }
}

/** How many tickets the shape lets run at a time on average. */
export const widthOf = (shape: TreeShape): number =>
  shape.chain.length === 0 ? 0 : shape.tickets / shape.chain.length

/**
 * The warning of a tree that keeps workers waiting on one another: its longest chain is over
 * `longChain`, or it lets fewer tickets run at a time on average than the run's `concurrent`, or than
 * its tickets where they are fewer. It names the chain and the hubs. None for a tree that isn't narrow.
 */
export const narrowWarning = (
  shape: TreeShape,
  concurrent: number,
): Option.Option<string> => {
  const width = widthOf(shape)
  const why = [
    ...(shape.chain.length > longChain
      ? [`its longest chain is over ${longChain}`]
      : []),
    ...(width < Math.min(concurrent, shape.tickets)
      ? [`it runs fewer than the run's ${concurrent} tickets at a time`]
      : []),
  ]
  if (why.length === 0) return Option.none()
  const hubs =
    shape.hubs.length === 0
      ? ''
      : `; hubs: ${shape.hubs.map(hub => `${hub.id} holds ${hub.holds}`).join(', ')}`
  return Option.some(
    `a narrow ticket tree, as ${why.join(' and ')}: ${shape.tickets} tickets, longest chain ${shape.chain.length} (${shape.chain.join(' > ')}), about ${Math.round(width * 10) / 10} at a time${hubs}. A ticket needs a blocks link only to one whose code it builds on, so that the rest run side by side`,
  )
}
