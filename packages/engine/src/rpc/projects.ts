import { ProjectRpcs } from '@fabrica/contracts'

import { notImplemented } from './not-implemented'

// The Projects group's handlers (spec §8.1, §10). Not served yet: each answers `NotImplemented` until the
// ticket that builds the group fills this file, with the service layers its handlers need.

/** The Projects group's handlers. */
export const projectsHandlers = ProjectRpcs.toLayer({
  'projects.add': notImplemented('projects.add'),
  'projects.list': notImplemented('projects.list'),
  'projects.remove': notImplemented('projects.remove'),
  'projects.settings.get': notImplemented('projects.settings.get'),
  'projects.settings.set': notImplemented('projects.settings.set'),
  'projects.init': notImplemented('projects.init'),
  'projects.watchStatus': notImplemented('projects.watchStatus'),
})
