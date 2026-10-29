import type { Html, HtmlBuilder } from 'foldkit/html'

// A dialog over the app (spec §18.1): the key help, the palette, what ssh asks. Each draws its body in
// the same frame, under the title bar.

/** A modal dialog labelled `label`, holding `body`. */
export const dialog = <Message>(
  label: string,
  body: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Class('fixed inset-0 flex items-start justify-center'),
      h.Style({ paddingTop: '96px' }),
    ],
    [
      h.div(
        [
          h.Role('dialog'),
          h.AriaModal(true),
          h.AriaLabel(label),
          h.Class(
            'flex w-full flex-col gap-8 rounded-window border border-line bg-panel py-12 shadow-glow1',
          ),
          h.Style({ maxWidth: '520px' }),
        ],
        body,
      ),
    ],
  )
