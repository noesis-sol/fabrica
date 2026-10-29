import { Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

// The Review screen: a ticket's branch diff, a run's merged diff, run reports, the log (spec §18.4).
// A placeholder submodel: the app's frame draws it in its place, and its own ticket fills it.

export const Model = Schema.Struct({})
export type Model = typeof Model.Type

export const init = (): Model => ({})

export const view = <Message>(_model: Model, h: HtmlBuilder<Message>): Html =>
  h.h2([h.Class('text-sm font-extrabold')], ['Review'])
