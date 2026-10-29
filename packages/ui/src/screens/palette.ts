import { Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

// The command palette (spec §18.5): the screen's commands, drawn from its one command list, each with
// its key where it has one. A placeholder submodel listing them; its own ticket adds the search.

export const Model = Schema.Struct({})
export type Model = typeof Model.Type

export const init = (): Model => ({})

/** One of the screen's commands, as the palette lists it. */
export interface Entry<Message> {
  readonly id: string
  readonly title: string
  readonly key: string | undefined
  readonly run: Message
}

export const view = <Message>(
  _model: Model,
  entries: ReadonlyArray<Entry<Message>>,
  h: HtmlBuilder<Message>,
): Html =>
  h.ul(
    [h.Class('flex flex-col')],
    entries.map(entry =>
      h.keyed('li')(
        entry.id,
        [],
        [
          h.button(
            [
              h.Type('button'),
              h.OnClick(entry.run),
              h.Class('flex w-full gap-8 px-12 py-6 text-left text-sm'),
            ],
            [
              h.span([h.Class('flex-1')], [entry.title]),
              ...(entry.key === undefined
                ? []
                : [
                    h.kbd(
                      [h.Class('font-mono text-xs text-muted')],
                      [entry.key],
                    ),
                  ]),
            ],
          ),
        ],
      ),
    ),
  )
