import { Effect } from 'effect'
import { Command, Flag } from 'effect/cli'

import { Imported } from '@fabrica/contracts'

import { printAnswer } from './output'
import { sanitiseLine } from './sanitise'
import { projectFlag, refused, withProject } from './tickets-project'

// `fabrica tickets import --beads <file>` (spec §11.6, §19): a `bd export` JSONL file brought into the
// project's work graph through the Backlog group's `tickets.import`. The CLI reads the file and sends
// its text, so a remote engine needn't reach it. A file the engine refuses is refused with every
// problem; otherwise the command says what it created, merged and changed, and what it left out.

/** What an import did, in words. */
const importedText = ({ created, merged, changed, dropped }: Imported) =>
  [
    `${created} created, ${merged} merged${changed.length === 0 ? '' : `, ${changed.length} of them changed`}`,
    ...changed.map(
      ({ ticket, fields }) =>
        `changed ${sanitiseLine(ticket)}: ${fields.map(sanitiseLine).join(', ')}`,
    ),
    ...dropped.map(each => `left out: ${sanitiseLine(each)}`),
  ].join('\n')

export const ticketsImport = Command.make(
  'import',
  {
    project: projectFlag,
    beads: Flag.FileText('beads').pipe(
      Flag.withDescription('The Beads backlog: a `bd export` JSONL file'),
    ),
  },
  options =>
    withProject(options.project, (client, project) =>
      client.rpc['tickets.import']({ project, beads: options.beads }).pipe(
        Effect.catchTag('ImportFailed', ({ problems }) =>
          Effect.fail(
            refused(
              [
                'the Beads file was refused:',
                ...problems.map(problem => `- ${sanitiseLine(problem)}`),
              ].join('\n'),
            ),
          ),
        ),
      ),
    ).pipe(
      Effect.flatMap(value =>
        printAnswer({ schema: Imported, value, text: importedText }),
      ),
    ),
).pipe(Command.withDescription('Imports a Beads backlog into the project'))
