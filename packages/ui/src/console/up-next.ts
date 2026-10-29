import { Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

// The console's Up next column: the queue with each waiting ticket's reason in words (spec §18.3, H81).
// A placeholder submodel: the app's frame draws it in its place, and its own ticket fills it.

export const Model = Schema.Struct({})
export type Model = typeof Model.Type

export const init = (): Model => ({})

export const view = <Message>(_model: Model, h: HtmlBuilder<Message>): Html =>
  h.h2([h.Class('text-sm font-extrabold')], ['Up next'])
