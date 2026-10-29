import { Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

// The console's title bar (spec §18.3, H46; Appendix A.2): "Fabrica", the engine host's system stats,
// the selected project's usage windows and the search field that opens the command palette.
// A placeholder submodel: the app's frame draws it in its place, and its own ticket fills it.

export const Model = Schema.Struct({})
export type Model = typeof Model.Type

export const init = (): Model => ({})

/** What the frame gives the bar: the search field's key hint, from the command list, and its Message. */
export interface Config<Message> {
  readonly search: { readonly hint: string; readonly open: Message }
}

export const view = <Message>(
  _model: Model,
  config: Config<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-1 items-center gap-8')],
    [
      h.span([h.Class('text-sm font-bold')], ['Fabrica']),
      h.button(
        [
          h.Type('button'),
          h.OnClick(config.search.open),
          h.AriaKeyshortcuts(config.search.hint),
          h.Class(
            'ml-auto rounded-button border border-line px-8 text-left text-xs text-muted',
          ),
          h.Style({ width: '260px', height: '24px' }),
        ],
        [`Search tickets and sessions ${config.search.hint}`],
      ),
    ],
  )
