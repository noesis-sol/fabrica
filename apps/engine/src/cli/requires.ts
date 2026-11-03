import { Effect, Schema } from 'effect'
import { Command, Flag } from 'effect/cli'

import {
  RequirementFound,
  RequirementState,
  exitCodeOf,
} from '@fabrica/contracts'
import { Requirements } from '@fabrica/engine'

import { printAnswer } from './output'
import { RunExited } from './run'
import { sanitiseLine } from './sanitise'
import { projectFlag, refused, withProject } from './tickets-project'

// `fabrica requires [--markdown]` (spec §19, §17): the requirements' state on the engine's host, for a
// remote engine the server's. The engine checks Base's list as a run's start does, installing what it can,
// and the command says each entry's state, exiting 2 where one is missing (`REQUIREMENTS_MISSING`).
// `--markdown` runs nothing and prints the list as the checkout has it, for the README, its section's
// markers included.

const stateWords: (state: RequirementState) => string = RequirementState.match({
  met: () => 'met',
  installed: ({ command }) => `installed with \`${command}\``,
  missing: ({ instruction }) => `missing: ${instruction}`,
  other_platform: ({ platforms }) =>
    `not checked: only on ${platforms.join(', ')}`,
})

/** Each entry and its state, a line each. */
export const requirementsText = (
  found: ReadonlyArray<RequirementFound>,
): string =>
  found.length === 0
    ? 'the requires list is empty'
    : found
        .map(
          ({ name, state }) =>
            `${sanitiseLine(name)}: ${sanitiseLine(stateWords(state))}`,
        )
        .join('\n')

const markdownAnswer = Schema.Struct({ markdown: Schema.String })

export const requires = Command.make(
  'requires',
  {
    project: projectFlag,
    markdown: Flag.Boolean('markdown').pipe(
      Flag.withDescription(
        'Prints the list for the README, and checks nothing',
      ),
      Flag.withDefault(false),
    ),
  },
  ({ project, markdown }) =>
    markdown
      ? withProject(project, (client, id) =>
          client.rpc['projects.settings.get']({ project: id }),
        ).pipe(
          Effect.flatMap(({ requires: list }) =>
            printAnswer({
              schema: markdownAnswer,
              value: { markdown: Requirements.requirementsMarkdown(list) },
              text: answer => answer.markdown,
            }),
          ),
        )
      : withProject(project, (client, id) =>
          client.rpc['projects.requirements']({ project: id }).pipe(
            Effect.catchTag('RequirementsNotChecked', ({ reason }) =>
              Effect.fail(refused(sanitiseLine(reason))),
            ),
          ),
        ).pipe(
          Effect.tap(found =>
            printAnswer({
              schema: Schema.Array(RequirementFound),
              value: found,
              text: requirementsText,
            }),
          ),
          Effect.flatMap(found =>
            found.some(({ state }) => RequirementState.guards.missing(state))
              ? Effect.fail(
                  new RunExited({
                    code: exitCodeOf('REQUIREMENTS_MISSING'),
                    said: 'requirements are missing',
                  }),
                )
              : Effect.void,
          ),
        ),
).pipe(Command.withDescription("The requirements' state"))
