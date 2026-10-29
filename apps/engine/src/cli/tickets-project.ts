import { Data, Effect, Option } from 'effect'
import { Flag } from 'effect/cli'
import type { RpcClientError } from 'effect/rpc'
import * as NodePath from 'node:path'

import type { EngineClientShape } from '@fabrica/client'
import {
  ProjectId,
  type ProjectInfo,
  type ProjectNotFound,
  type Refused,
  type TicketNotFound,
} from '@fabrica/contracts'

import { withEngine } from './connect'
import { sanitiseLine } from './sanitise'

// The project a `fabrica tickets` command works on (spec §19): `--project <id>`, or the one whose
// checkout holds the folder the command runs in; and the engine's refusals, in words.

/** The engine refused what the command asked, or the command can't tell what it was asked. */
export class TicketsRefused extends Data.TaggedError('TicketsRefused')<{
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

export const refused = (reason: string) => new TicketsRefused({ reason })

/** The project whose checkout holds `folder`: the innermost, where checkouts nest. */
export const projectHolding = (
  projects: ReadonlyArray<ProjectInfo>,
  folder: string,
): Option.Option<ProjectInfo> =>
  Option.fromUndefinedOr(
    projects
      .filter(
        ({ path }) =>
          folder === path ||
          folder.startsWith(
            path.endsWith(NodePath.sep) ? path : path + NodePath.sep,
          ),
      )
      .toSorted((a, b) => b.path.length - a.path.length)[0],
  )

/** The project `--project` names, or the one whose checkout holds the folder the command runs in. */
const projectOf = (client: EngineClientShape, given: Option.Option<string>) =>
  Option.match(given, {
    onSome: text =>
      Option.match(ProjectId.makeOption(text), {
        onNone: () =>
          Effect.fail(refused(`${sanitiseLine(text)} isn't a project's ID`)),
        onSome: Effect.succeed,
      }),
    onNone: () =>
      Effect.gen(function* () {
        const folder = NodePath.resolve('.')
        const projects = yield* client.rpc['projects.list']()
        return yield* Option.match(projectHolding(projects, folder), {
          onNone: () =>
            Effect.fail(
              refused(
                `no project's checkout holds ${sanitiseLine(folder)}: name one with --project <id>, as \`fabrica project list\` gives it`,
              ),
            ),
          onSome: ({ id }) => Effect.succeed(id),
        })
      }),
  })

/** Runs `use` with a client of the engine and the project, the engine's refusals in words. */
export const withProject = <A>(
  given: Option.Option<string>,
  use: (
    client: EngineClientShape,
    project: ProjectId,
  ) => Effect.Effect<
    A,
    | TicketsRefused
    | ProjectNotFound
    | TicketNotFound
    | Refused
    | RpcClientError.RpcClientError
  >,
) =>
  withEngine(client =>
    Effect.flatMap(projectOf(client, given), project => use(client, project)),
  ).pipe(
    Effect.catchTags({
      ProjectNotFound: ({ project }) =>
        Effect.fail(
          refused(`the engine has no project ${sanitiseLine(project)}`),
        ),
      TicketNotFound: ({ project, ticket }) =>
        Effect.fail(
          refused(
            `the project ${sanitiseLine(project)} has no ticket ${sanitiseLine(ticket)}`,
          ),
        ),
      Refused: ({ reason }) => Effect.fail(refused(sanitiseLine(reason))),
    }),
  )

export const projectFlag = Flag.String('project').pipe(
  Flag.withDescription(
    "The project's ID; the one whose checkout holds this folder where it isn't given",
  ),
  Flag.optional,
)
