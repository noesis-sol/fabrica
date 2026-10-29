import { Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { TicketId } from '@fabrica/contracts'

// The Worker view (spec §18.4, H91): the ticket on top, figures that move during a turn, the
// transcript as it happens, and a composer to message or interrupt the worker.
// A placeholder submodel: the app's frame draws it in its place, and its own ticket fills it.

export const Model = Schema.Struct({})
export type Model = typeof Model.Type

export const init = (): Model => ({})

export const view = <Message>(
  _model: Model,
  ticket: TicketId,
  h: HtmlBuilder<Message>,
): Html => h.h2([h.Class('text-sm font-extrabold')], [`Worker ${ticket}`])
