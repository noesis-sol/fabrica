import { notYetGroup, valueFlag } from './not-yet'

// `fabrica tickets list|show|create|update|close|reopen|defer|dep|label|note|ready|why|rebuild` and
// `fabrica tickets import --beads <file>` (spec §19, §11): the backlog.

export const tickets = notYetGroup({
  name: 'tickets',
  description: 'The backlog',
  commands: [
    ['list', 'The tickets'],
    ['show', 'A ticket'],
    ['create', 'Creates a ticket'],
    ['update', 'Updates a ticket'],
    ['close', 'Closes a ticket'],
    ['reopen', 'Reopens a ticket'],
    ['defer', 'Defers a ticket'],
    ['dep', "A ticket's links"],
    ['label', "A ticket's labels"],
    ['note', 'Adds a note to a ticket'],
    ['ready', 'The tickets ready to start'],
    ['why', "Why a ticket isn't ready"],
    ['rebuild', 'Rebuilds the backlog from its ref'],
    [
      'import',
      'Imports a Beads backlog into the project',
      { beads: valueFlag('beads') },
    ],
  ],
})
