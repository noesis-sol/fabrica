import { Effect, HashSet, Option, Schema } from 'effect'

import { describe, expect, it, test } from '@effect/vitest'
import { Ticket, TicketId } from '@fabrica/contracts'

import * as Backlog from '../src/screens/backlog'
import {
  drawGraph,
  graphKey,
  graphOf,
  nodeLabel,
  nodeTitle,
} from '../src/screens/backlog-graph'
import { themeAttribute } from '../src/theme/theme'

// The Backlog screen's graph marks a ticket's status by more than colour (H63, §18.2): each node is
// labelled with its status mark's glyph beside its ID, as the list beside it is, and shows its mark's
// word and its title on hover.

const id = (ticket: string) => TicketId.make(ticket)
const at = 1_793_268_900_000

const decodeTicket = Schema.decodeUnknownSync(Schema.toCodecJson(Ticket))

/** A ticket's JSON, as the engine sends it, with `fields` over a plain open task. */
const ticket = (
  ticketId: string,
  title: string,
  fields: Record<string, unknown> = {},
): Ticket =>
  decodeTicket({
    id: ticketId,
    type: 'task',
    title,
    description: null,
    design: null,
    acceptance: null,
    status: 'open',
    resolution: null,
    priority: 2,
    deferUntil: null,
    assignee: null,
    model: null,
    metadata: {},
    result: null,
    question: null,
    mergedCommit: null,
    closeReason: null,
    createdAt: at,
    updatedAt: at,
    ...fields,
  })

const tickets: ReadonlyArray<Ticket> = [
  ticket('fa-1', 'Sign-in'),
  ticket('fa-2', 'Login form'),
  ticket('fa-3', 'Refresh tokens', {
    status: 'in_progress',
    assignee: { engine: 'e-1', session: 's-1' },
  }),
  ticket('fa-4', 'Document sign-in', {
    status: 'deferred',
    deferUntil: Date.parse('2026-10-30T09:00:00.000Z'),
  }),
  ticket('fa-5', 'User schema', { status: 'closed', resolution: 'done' }),
  ticket('fa-q1', 'Keep the old endpoint?', {
    type: 'question',
    question: {
      choices: {
        options: [
          { label: 'Keep it', tradeOff: 'Old clients go on working' },
          { label: 'Drop it', tradeOff: 'Less to maintain' },
        ],
        recommended: 0,
      },
      consequential: false,
      maintainerOnly: false,
      answer: null,
    },
  }),
]

const edges = [
  { from: id('fa-5'), to: id('fa-2'), kind: 'blocks' as const },
  { from: id('fa-1'), to: id('fa-2'), kind: 'parent' as const },
]

/** fa-1 is ready; fa-2, blocked, waits. */
const readiness: Backlog.Readiness = {
  ready: HashSet.make(id('fa-1')),
  waiting: new Map(),
}

const graphWith = (shown: Option.Option<Backlog.Readiness>) =>
  graphOf({
    tickets,
    edges,
    markOf: drawn => Backlog.markOf(drawn, shown),
  })

describe('a node of the graph', () => {
  test('is labelled with its mark’s glyph beside its ID, the same glyph the list shows', () => {
    const graph = graphWith(Option.some(readiness))
    expect(graph.nodes.map(nodeLabel)).toEqual([
      '○ fa-1',
      '◌ fa-2',
      '● fa-3',
      '‖ fa-4',
      '✓ fa-5',
      '? fa-q1',
    ])
    for (const node of graph.nodes) {
      const shown = tickets.find(drawn => drawn.id === node.id)
      expect(shown).toBeDefined()
      if (shown !== undefined) {
        const mark = Backlog.markOf(shown, Option.some(readiness))
        expect([node.role, node.glyph, node.word]).toEqual([
          mark.role,
          mark.glyph,
          mark.word,
        ])
      }
    }
  })

  test('tells apart the statuses one colour fills: ready from waiting, both c5', () => {
    const graph = graphWith(Option.some(readiness))
    const [ready, waiting] = graph.nodes
    expect([ready?.role, waiting?.role]).toEqual(['c5', 'c5'])
    expect(ready?.glyph).not.toBe(waiting?.glyph)
  })

  test('shows its ID, its mark’s word and its title on hover', () => {
    const graph = graphWith(Option.some(readiness))
    expect(graph.nodes.map(nodeTitle)).toEqual([
      'fa-1 · ready: Sign-in',
      'fa-2 · waiting: Login form',
      'fa-3 · in progress: Refresh tokens',
      'fa-4 · deferred: Document sign-in',
      'fa-5 · closed: User schema',
      'fa-q1 · for you: Keep the old endpoint?',
    ])
  })

  test('changes the graph’s key as its mark changes, its colour alike', () => {
    expect(graphKey(graphWith(Option.none()))).not.toBe(
      graphKey(graphWith(Option.some(readiness))),
    )
  })

  it.effect(
    'drawn, carries its label, and lends its title to the graph’s element while hovered',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          document.documentElement.setAttribute(themeAttribute, 'classic')
          // An SVG element: Cytoscape is given no container and draws headless, since happy-dom has no canvas.
          const element = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'g',
          )
          document.body.append(element)
          const { instance } = yield* drawGraph({
            element,
            graph: graphWith(Option.some(readiness)),
            selected: Option.none(),
            onTap: () => {},
          })
          const node = instance.getElementById('fa-2')
          expect(node.style('label')).toBe('◌ fa-2')
          expect(element.getAttribute('title')).toBeNull()
          node.emit('mouseover')
          expect(element.getAttribute('title')).toBe(
            'fa-2 · waiting: Login form',
          )
          node.emit('mouseout')
          expect(element.getAttribute('title')).toBeNull()
        }),
      ),
  )
})
