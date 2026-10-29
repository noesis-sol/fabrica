import { notYetGroup } from './not-yet'

// `fabrica project add <path|url>|list|remove` (spec §19, §10): the engine's projects.

export const project = notYetGroup({
  name: 'project',
  description: 'Projects',
  commands: [
    ['add', 'Adds a project from a checkout, or a clone of a URL'],
    ['list', 'The projects'],
    ['remove', 'Removes a project'],
  ],
})
