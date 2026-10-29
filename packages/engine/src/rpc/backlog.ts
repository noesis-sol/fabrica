import { BacklogRpcs } from '@fabrica/contracts'

import { notImplemented } from './not-implemented'

// The Backlog group's handlers (spec §8.1, §11). Not served yet: each answers `NotImplemented` until the
// ticket that builds the group fills this file, with the service layers its handlers need.

/** The Backlog group's handlers. */
export const backlogHandlers = BacklogRpcs.toLayer({
  'tickets.list': notImplemented('tickets.list'),
  'tickets.show': notImplemented('tickets.show'),
  'tickets.create': notImplemented('tickets.create'),
  'tickets.update': notImplemented('tickets.update'),
  'tickets.close': notImplemented('tickets.close'),
  'tickets.dep.add': notImplemented('tickets.dep.add'),
  'tickets.dep.remove': notImplemented('tickets.dep.remove'),
  'tickets.label': notImplemented('tickets.label'),
  'tickets.note': notImplemented('tickets.note'),
  'tickets.ready': notImplemented('tickets.ready'),
  'tickets.why': notImplemented('tickets.why'),
  'tickets.import': notImplemented('tickets.import'),
  'tickets.watch': notImplemented('tickets.watch'),
})
