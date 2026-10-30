import type Cytoscape from 'cytoscape'
import type CytoscapeDagre from 'cytoscape-dagre'
import { Array, Effect, HashSet, Option, Schema } from 'effect'

import { type Edge, EdgeKind, type Ticket, TicketId } from '@fabrica/contracts'

import type { Role } from '../console/history'
import { themeAttribute } from '../theme/theme'

// The Backlog screen's ticket graph (spec §18.1, §18.4, H40): the tickets and their links as nodes and
// edges, built from the backlog and its edges alone, and drawn by Cytoscape.js in a layered dagre
// layout styled from the theme's tokens, restyled as the theme changes; the ticket chosen in the list or
// the graph is selected and centred in it. Cytoscape and its layout are loaded only as the graph is
// first drawn, so the renderer's first paint doesn't wait for them.

/** A ticket as the graph draws it: its ID, its title on hover, and its status mark's role. */
export const GraphNode = Schema.Struct({
  id: TicketId,
  title: Schema.String,
  role: Schema.Literals(['c1', 'c2', 'c3', 'c4', 'c5']),
})
export type GraphNode = typeof GraphNode.Type

export const GraphEdge = Schema.Struct({
  from: TicketId,
  to: TicketId,
  kind: EdgeKind,
})
export type GraphEdge = typeof GraphEdge.Type

export const Graph = Schema.Struct({
  nodes: Schema.Array(GraphNode),
  edges: Schema.Array(GraphEdge),
})
export type Graph = typeof Graph.Type

/**
 * The graph of `tickets` and `edges`: every ticket not closed, with the closed ones linked to one of
 * them (a blocker merged, an epic's finished child), and the links between the tickets drawn.
 */
export const graphOf = ({
  tickets,
  edges,
  roleOf,
}: {
  readonly tickets: ReadonlyArray<Ticket>
  readonly edges: ReadonlyArray<Edge>
  readonly roleOf: (ticket: Ticket) => Role
}): Graph => {
  const open = HashSet.fromIterable(
    tickets
      .filter(ticket => ticket.status !== 'closed')
      .map(ticket => ticket.id),
  )
  const linkedToOpen = HashSet.fromIterable(
    Array.flatMap(edges, edge =>
      HashSet.has(open, edge.from) || HashSet.has(open, edge.to)
        ? [edge.from, edge.to]
        : [],
    ),
  )
  const nodes = tickets
    .filter(
      ticket =>
        HashSet.has(open, ticket.id) || HashSet.has(linkedToOpen, ticket.id),
    )
    .map((ticket): GraphNode => ({
      id: ticket.id,
      title: ticket.title,
      role: roleOf(ticket),
    }))
  const drawn = HashSet.fromIterable(nodes.map(node => node.id))
  return {
    nodes,
    edges: edges
      .filter(
        ({ from, to }) => HashSet.has(drawn, from) && HashSet.has(drawn, to),
      )
      .map(({ from, to, kind }): GraphEdge => ({ from, to, kind })),
  }
}

/** A short key of the graph's content: the element drawing it is drawn afresh when it changes. */
export const graphKey = (graph: Graph): string => {
  const text = JSON.stringify([
    graph.nodes.map(node => [node.id, node.role, node.title]),
    graph.edges.map(edge => [edge.from, edge.to, edge.kind]),
  ])
  // FNV-1a, 32 bits: a key, not a check.
  let hash = 0x81_1c_9d_c5
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01_00_01_93)
  }
  return `graph-${(hash >>> 0).toString(36)}-${graph.nodes.length}`
}

/** The theme's tokens the graph is styled from, read off the document's root, which data-theme sets them on. */
const tokensOf = (element: Element) => {
  const style = getComputedStyle(element.ownerDocument.documentElement)
  const token = (name: string) => style.getPropertyValue(`--${name}`).trim()
  return {
    roles: {
      c1: token('c1'),
      c2: token('c2'),
      c3: token('c3'),
      c4: token('c4'),
      c5: token('c5'),
    } satisfies Record<Role, string>,
    fg: token('fg'),
    ink: token('ink'),
    muted: token('muted'),
    line: token('line'),
    mono: token('mono'),
  }
}

/** How each kind of link is drawn: a blocker and a parent with an arrow, the others dashed or dotted. */
const edgeStyles: Record<
  EdgeKind,
  { readonly line: 'solid' | 'dashed' | 'dotted'; readonly arrow: boolean }
> = {
  blocks: { line: 'solid', arrow: true },
  parent: { line: 'dotted', arrow: true },
  discovered_from: { line: 'dashed', arrow: true },
  related: { line: 'dashed', arrow: false },
}

/** The graph's stylesheet, from the theme's tokens. */
const styleOf = (
  tokens: ReturnType<typeof tokensOf>,
): Cytoscape.StylesheetJson => [
  {
    selector: 'node',
    style: {
      shape: 'round-rectangle',
      width: 72,
      height: 20,
      label: 'data(id)',
      'font-family': tokens.mono,
      'font-size': 10,
      color: tokens.ink,
      'text-valign': 'center',
      'text-halign': 'center',
      'border-width': 0,
    },
  },
  ...Object.entries(tokens.roles).map(
    ([role, colour]): Cytoscape.StylesheetStyle => ({
      selector: `node[role = "${role}"]`,
      style: { 'background-color': colour },
    }),
  ),
  {
    selector: 'node:selected',
    style: { 'border-width': 2, 'border-color': tokens.fg },
  },
  ...Object.entries(edgeStyles).map(
    ([kind, drawn]): Cytoscape.StylesheetStyle => ({
      selector: `edge[kind = "${kind}"]`,
      style: {
        width: 1,
        'curve-style': 'bezier',
        'line-color': tokens.line,
        'line-style': drawn.line,
        'target-arrow-color': tokens.muted,
        'target-arrow-shape': drawn.arrow ? 'triangle' : 'none',
        'arrow-scale': 0.8,
      },
    }),
  ),
]

/**
 * Selects `ticket`'s node in `instance`, alone, and centres the view on it; a ticket the graph doesn't
 * draw leaves it as it is, and so does one already selected alone (a node just tapped).
 */
export const focusNode = (instance: Cytoscape.Core, ticket: TicketId): void => {
  const node = instance.getElementById(ticket)
  const selected = instance.$(':selected')
  if (node.empty() || (selected.length === 1 && node.selected())) {
    return
  }
  selected.unselect()
  node.select()
  instance.center(node)
}

/** The graphs drawn now: a ticket chosen in the list is selected in each. */
const drawnGraphs = new Set<Cytoscape.Core>()

/** Selects `ticket` in every graph drawn and centres it there. */
export const focusTicket = (ticket: TicketId): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const instance of drawnGraphs) {
      focusNode(instance, ticket)
    }
  })

const decodeTicketId = Schema.decodeUnknownOption(TicketId)

/**
 * Draws `graph` in `element` with Cytoscape.js and its dagre layout, `selected` selected and centred,
 * calling `onTap` with a tapped ticket's ID. The graph is styled afresh as the theme changes (data-theme
 * on the document's root), and the instance destroyed as the element goes.
 */
export const drawGraph = ({
  element,
  graph,
  selected,
  onTap,
}: {
  readonly element: Element
  readonly graph: Graph
  readonly selected: Option.Option<TicketId>
  readonly onTap: (ticket: TicketId) => void
}) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const [{ default: cytoscape }, { default: dagre }] = await Promise.all([
        import('cytoscape'),
        import('cytoscape-dagre'),
      ])
      cytoscape.use(dagre)
      const layout: CytoscapeDagre.DagreLayoutOptions = {
        name: 'dagre',
        rankDir: 'TB',
        nodeSep: 12,
        rankSep: 24,
      }
      // An element that isn't HTML has no box to draw in: the graph is kept headless there.
      const instance = cytoscape({
        ...(element instanceof HTMLElement
          ? { container: element }
          : { headless: true, styleEnabled: true }),
        elements: [
          ...graph.nodes.map(node => ({
            group: 'nodes' as const,
            data: { id: node.id, title: node.title, role: node.role },
          })),
          ...graph.edges.map(edge => ({
            group: 'edges' as const,
            data: {
              id: `${edge.kind}:${edge.from}:${edge.to}`,
              source: edge.from,
              target: edge.to,
              kind: edge.kind,
            },
          })),
        ],
        layout,
        style: styleOf(tokensOf(element)),
      })
      instance.on('tap', 'node', event => {
        Option.map(decodeTicketId(event.target.id()), onTap)
      })
      instance.ready(() => {
        Option.map(selected, ticket => focusNode(instance, ticket))
      })
      const themes = new MutationObserver(() => {
        instance.style(styleOf(tokensOf(element)))
      })
      themes.observe(element.ownerDocument.documentElement, {
        attributes: true,
        attributeFilter: [themeAttribute],
      })
      drawnGraphs.add(instance)
      return { instance, themes }
    }),
    ({ instance, themes }) =>
      Effect.sync(() => {
        drawnGraphs.delete(instance)
        themes.disconnect()
        instance.destroy()
      }),
  )
