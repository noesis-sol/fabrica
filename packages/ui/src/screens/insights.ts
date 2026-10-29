import { Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

// The Insights screen, from the engine's telemetry (spec §18.4, §21).
// A placeholder submodel: the app's frame draws it in its place, and its own ticket fills it.

export const Model = Schema.Struct({})
export type Model = typeof Model.Type

export const init = (): Model => ({})

export const view = <Message>(_model: Model, h: HtmlBuilder<Message>): Html =>
  h.h2([h.Class('text-sm font-extrabold')], ['Insights'])
