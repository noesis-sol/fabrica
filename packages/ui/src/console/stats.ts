import { Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

// The console's stats row, with the run's controls and the hold strip above it (spec §18.3; Appendix A.2).
// A placeholder submodel: the app's frame draws it in its place, and its own ticket fills it.

export const Model = Schema.Struct({})
export type Model = typeof Model.Type

export const init = (): Model => ({})

export const view = <Message>(_model: Model, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class('flex flex-wrap')])
