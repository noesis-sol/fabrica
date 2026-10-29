import { Data, Effect, Option, Schema } from 'effect'
import { Argument, Command, Flag } from 'effect/cli'
import * as NodePath from 'node:path'

import { ProjectId, ProjectInfo, ProjectSource } from '@fabrica/contracts'

import { withEngine } from './connect'
import { printAnswer } from './output'
import { sanitiseLine } from './sanitise'

// `fabrica project add <path|url>|list|remove` (spec §19, §10.1): the engine's projects. `add` takes
// a git URL (`https://…`, `ssh://…`, `file://…`, or `user@host:path`), which the engine clones, or a
// checkout's path, made absolute from where the command runs; a project with no settings yet is
// offered `fabrica init`. Values the engine sends are printed one to a line.

/** The engine refused what the command asked: the project couldn't be added, or isn't there. */
export class ProjectRefused extends Data.TaggedError('ProjectRefused')<{
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

/** A git URL: a scheme and `://`, or scp's `user@host:path`. */
const isUrl = (text: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//iu.test(text) || /^[^/\s:@]+@[^/\s:]+:/u.test(text)

/** What `add` was given, as the engine takes it: a URL, or the absolute path of a folder. */
export const projectSource = (text: string): ProjectSource =>
  isUrl(text)
    ? ProjectSource.cases.url.make({ url: text })
    : ProjectSource.cases.path.make({ path: NodePath.resolve(text) })

const infoLines = (project: ProjectInfo): ReadonlyArray<string> => [
  `project  ${sanitiseLine(project.id)}`,
  `name     ${sanitiseLine(project.name)}`,
  `path     ${sanitiseLine(project.path)}`,
  `origin   ${project.origin}${Option.match(project.url, {
    onNone: () => '',
    onSome: url => ` from ${sanitiseLine(url)}`,
  })}`,
  `base     ${sanitiseLine(project.base)}`,
]

const addedText = (project: ProjectInfo): string =>
  [
    ...infoLines(project),
    project.setUp
      ? 'set up   yes'
      : 'set up   no: it has no .fabrica/settings.json yet; set it up with `fabrica init`',
  ].join('\n')

const listText = (projects: ReadonlyArray<ProjectInfo>): string => {
  if (projects.length === 0)
    return 'no projects: add one with `fabrica project add <path|url>`'
  const rows = projects.map(project => [
    sanitiseLine(project.id),
    sanitiseLine(project.base),
    project.setUp ? 'set up' : 'not set up',
    sanitiseLine(project.path),
  ])
  const widths = [0, 1, 2].map(column =>
    Math.max(...rows.map(row => row[column]?.length ?? 0)),
  )
  return rows
    .map(row =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

/** `fabrica project remove`'s answer. */
const RemovedAnswer = Schema.Struct({ removed: ProjectId })

const add = Command.make(
  'add',
  {
    source: Argument.String('path|url').pipe(
      Argument.withDescription("A checkout's path, or a git URL to clone"),
    ),
    name: Flag.String('name').pipe(
      Flag.withDescription(
        "The project's name; its folder's or repository's where it isn't given",
      ),
      Flag.optional,
    ),
  },
  ({ source, name }) =>
    withEngine(client =>
      client.rpc['projects.add']({ source: projectSource(source), name }),
    ).pipe(
      Effect.catchTag('AddFailed', ({ reason }) =>
        Effect.fail(
          new ProjectRefused({
            reason: `the project couldn't be added: ${sanitiseLine(reason)}`,
          }),
        ),
      ),
      Effect.flatMap(value =>
        printAnswer({ schema: ProjectInfo, value, text: addedText }),
      ),
    ),
).pipe(
  Command.withDescription(
    'Adds a project from a checkout, or a clone of a URL',
  ),
)

const list = Command.make('list', {}, () =>
  withEngine(client => client.rpc['projects.list']()).pipe(
    Effect.flatMap(value =>
      printAnswer({ schema: Schema.Array(ProjectInfo), value, text: listText }),
    ),
  ),
).pipe(Command.withDescription('The projects'))

const remove = Command.make(
  'remove',
  {
    project: Argument.String('project').pipe(
      Argument.withDescription(
        "The project's ID, as `fabrica project list` gives it",
      ),
    ),
  },
  ({ project }) =>
    Effect.gen(function* () {
      const id = yield* Option.match(ProjectId.makeOption(project), {
        onNone: () =>
          Effect.fail(
            new ProjectRefused({
              reason: `${sanitiseLine(project)} isn't a project's ID`,
            }),
          ),
        onSome: Effect.succeed,
      })
      yield* withEngine(client =>
        client.rpc['projects.remove']({ project: id }),
      ).pipe(
        Effect.catchTag('ProjectNotFound', () =>
          Effect.fail(
            new ProjectRefused({
              reason: `the engine has no project ${sanitiseLine(id)}`,
            }),
          ),
        ),
      )
      yield* printAnswer({
        schema: RemovedAnswer,
        value: { removed: id },
        text: ({ removed }) =>
          `removed ${sanitiseLine(removed)}: a registered checkout stays where it is`,
      })
    }),
).pipe(Command.withDescription('Removes a project'))

export const project = Command.make('project').pipe(
  Command.withDescription('Projects'),
  Command.withSubcommands([add, list, remove]),
)
