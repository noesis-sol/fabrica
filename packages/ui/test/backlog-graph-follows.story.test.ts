import { Effect, Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, it, test, vi } from '@effect/vitest'
import { TicketId } from '@fabrica/contracts'

import * as Backlog from '../src/screens/backlog'
import {
  type Graph,
  drawGraph,
  focusTicket,
} from '../src/screens/backlog-graph'
import { type Theme, themeAttribute } from '../src/theme/theme'
import themesCss from '../src/theme/themes.css?raw'

// The Backlog screen's graph follows the ticket chosen and the theme (spec §18.4): a ticket chosen in
// the list is selected and centred in the graph drawn, one chosen as the graph is drawn is selected in
// it from the start, and switching the theme restyles the graph from the new theme's tokens.

const id = (ticket: string) => TicketId.make(ticket)

const graph: Graph = {
  nodes: [
    { id: id('fa-1'), title: 'Sign-in', role: 'c5', glyph: '○', word: 'ready' },
    {
      id: id('fa-2'),
      title: 'Login form',
      role: 'c1',
      glyph: '●',
      word: 'in progress',
    },
    {
      id: id('fa-3'),
      title: 'Session store',
      role: 'c3',
      glyph: '‖',
      word: 'deferred',
    },
  ],
  edges: [
    { from: id('fa-1'), to: id('fa-2'), kind: 'parent' },
    { from: id('fa-2'), to: id('fa-3'), kind: 'blocks' },
  ],
}

const style = document.createElement('style')
style.textContent = themesCss
document.head.append(style)

/**
 * An element to draw the graph in, its document's root naming `theme`: an SVG one, not HTML, so
 * Cytoscape is given no container and draws headless, since happy-dom has no canvas.
 */
const page = (theme: Theme) => {
  document.documentElement.setAttribute(themeAttribute, theme)
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  document.body.append(element)
  return element
}

const draw = (selected: Option.Option<TicketId>, theme: Theme = 'classic') =>
  drawGraph({ element: page(theme), graph, selected, onTap: () => {} })

/** The IDs of the nodes selected in `instance`. */
const selectedIn = (instance: Effect.Success<ReturnType<typeof draw>>) =>
  instance.instance.$(':selected').map(node => node.id())

describe('the ticket chosen', () => {
  test('in the list, is selected and centred in the graph drawn; chosen again, nothing is sent', () => {
    story(
      Backlog.update,
      given(Backlog.init()),
      message(Backlog.Message.SelectedTicket({ ticket: id('fa-3') })),
      Command.resolve(
        Backlog.FocusGraph({ ticket: id('fa-3') }),
        Backlog.Message.CompletedFocusGraph(),
      ),
      message(Backlog.Message.SelectedTicket({ ticket: id('fa-3') })),
      Command.expectNone(),
      model(shown => {
        expect(shown.selected).toEqual(Option.some(id('fa-3')))
      }),
    )
  })

  it.effect('is selected alone in the graph drawn, and centred there', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drawn = yield* draw(Option.none())
        // Headless, the graph has no box to pan in: what it is centred on is what is asked.
        const centred = vi.spyOn(drawn.instance, 'center')
        const centredOn = () =>
          centred.mock.calls.map(([nodes]) =>
            nodes === undefined ? [] : nodes.map(node => node.id()),
          )
        expect(selectedIn(drawn)).toEqual([])
        yield* focusTicket(id('fa-3'))
        expect(selectedIn(drawn)).toEqual(['fa-3'])
        yield* focusTicket(id('fa-1'))
        expect(selectedIn(drawn)).toEqual(['fa-1'])
        expect(centredOn()).toEqual([['fa-3'], ['fa-1']])
        // Already selected alone (a node just tapped), or not drawn: the graph is left as it is.
        yield* focusTicket(id('fa-1'))
        yield* focusTicket(id('fa-9'))
        expect(selectedIn(drawn)).toEqual(['fa-1'])
        expect(centredOn()).toEqual([['fa-3'], ['fa-1']])
      }),
    ),
  )

  it.effect('as the graph is drawn, is selected in it from the start', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drawn = yield* draw(Option.some(id('fa-2')))
        expect(selectedIn(drawn)).toEqual(['fa-2'])
      }),
    ),
  )
})

describe('the theme', () => {
  it.effect('switched, restyles the graph drawn from its tokens', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const colours = (drawn: Effect.Success<ReturnType<typeof draw>>) =>
          drawn.instance
            .elements()
            .map(element => [
              element.id(),
              element.isNode()
                ? element.style('background-color')
                : element.style('line-color'),
            ])
        const drawn = yield* draw(Option.none(), 'classic')
        const classic = colours(drawn)
        document.documentElement.setAttribute(themeAttribute, 'neon-grid')
        // MutationObserver's callback runs as a microtask.
        yield* Effect.promise(() => Promise.resolve())
        const afresh = yield* draw(Option.none(), 'neon-grid')
        expect(colours(drawn)).not.toEqual(classic)
        expect(colours(drawn)).toEqual(colours(afresh))
      }),
    ),
  )
})
