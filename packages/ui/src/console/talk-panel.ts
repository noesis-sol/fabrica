import { Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

// The console's talk panel: the scope's run talk, or the answer talk while questions wait (spec §18.3, H44; Appendix A.2).
// A placeholder submodel: the app's frame draws it in its place, and its own ticket fills it.

export const Model = Schema.Struct({})
export type Model = typeof Model.Type

export const init = (): Model => ({})

export const view = <Message>(_model: Model, h: HtmlBuilder<Message>): Html =>
  h.h2([h.Class('text-sm font-extrabold')], ['Run talk'])
