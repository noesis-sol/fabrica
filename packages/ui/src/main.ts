import { Schema } from 'effect'
import { Runtime, type Update } from 'foldkit'
import type { Document, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { Button } from '@foldkit/ui'

// MODEL

export const Model = Schema.Struct({ count: Schema.Number })
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedDecrement: {},
  ClickedIncrement: {},
  ClickedReset: {},
})
export type Message = typeof Message.Type

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedDecrement: () => ({
      model: modifyFields(model, { count: count => count - 1 }),
    }),
    ClickedIncrement: () => ({
      model: modifyFields(model, { count: count => count + 1 }),
    }),
    ClickedReset: () => ({ model: modifyFields(model, { count: () => 0 }) }),
  })

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: { count: 0 },
})

// VIEW

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `Counter: ${model.count}`,
  body: h.div(
    [
      h.Class(
        'min-h-screen bg-bg flex flex-col items-center justify-center gap-24 p-24',
      ),
    ],
    [
      h.p([h.Class('text-6xl font-bold text-fg')], [model.count.toString()]),
      h.div(
        [h.Class('flex flex-wrap justify-center gap-16')],
        [
          Button.view(
            {
              onClick: Message.ClickedDecrement(),
              toView: attributes =>
                h.button([...attributes.button, h.Class(buttonStyle)], ['-']),
            },
            h,
          ),
          Button.view(
            {
              onClick: Message.ClickedReset(),
              toView: attributes =>
                h.button(
                  [...attributes.button, h.Class(buttonStyle)],
                  ['Reset'],
                ),
            },
            h,
          ),
          Button.view(
            {
              onClick: Message.ClickedIncrement(),
              toView: attributes =>
                h.button([...attributes.button, h.Class(buttonStyle)], ['+']),
            },
            h,
          ),
        ],
      ),
    ],
  ),
})

// STYLE

const buttonStyle =
  'bg-c1 text-ink font-bold rounded-button shadow-glow1 px-16 py-8 transition'
