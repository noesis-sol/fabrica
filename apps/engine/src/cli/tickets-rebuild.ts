import { Effect } from 'effect'
import { Command } from 'effect/cli'

import { Rebuilt } from '@fabrica/contracts'

import { printAnswer } from './output'
import { projectFlag, withProject } from './tickets-project'

// `fabrica tickets rebuild` (spec §11.3, §19): the project's work graph rebuilt from its tickets ref,
// through the Backlog group's `tickets.rebuild`, so the engine, its only writer, does it. What the store
// has that the ref hasn't (a change not committed yet) goes; a result too large for the ref stays.

const counted = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`

/** What a rebuild brought back, in words. */
const rebuiltText = ({ tickets, tombstones, quarantined }: Rebuilt) =>
  [
    `rebuilt ${counted(tickets, 'ticket', 'tickets')} and ${counted(tombstones, 'tombstone', 'tombstones')} from the tickets ref`,
    ...(quarantined === 0
      ? []
      : [
          `${counted(quarantined, "file doesn't", "files don't")} decode: skipped, the local copies kept`,
        ]),
  ].join('\n')

export const ticketsRebuild = Command.make(
  'rebuild',
  { project: projectFlag },
  options =>
    withProject(options.project, (client, project) =>
      client.rpc['tickets.rebuild']({ project }),
    ).pipe(
      Effect.flatMap(value =>
        printAnswer({ schema: Rebuilt, value, text: rebuiltText }),
      ),
    ),
).pipe(Command.withDescription('Rebuilds the backlog from its ref'))
