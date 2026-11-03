import { Effect } from 'effect'

import {
  type ProjectId,
  type ProjectNotFound,
  type RequirementFound,
  RequirementsNotChecked,
} from '@fabrica/contracts'

import type { Projects } from '../projects/service'
import {
  RequirementsList,
  checkRequirements,
  requirementsAt,
} from '../requirements'
import { RunHostingShape } from '../run/hosting'
import { describeProblem } from '../settings'

// The Projects group's requirements request (spec §17, §19): Base's list checked on the engine's host as
// a run's start checks it, what can be installed installed, by the services the engine's runs run on. A
// remote engine's requirements are its own. Only Base's commit's list runs, whatever the checkout holds.

/** How each entry of the project's list on Base is found now. */
export const projectRequirements =
  (projects: Projects['Service'], hosting: RunHostingShape) =>
  ({
    project,
  }: {
    readonly project: ProjectId
  }): Effect.Effect<
    ReadonlyArray<RequirementFound>,
    ProjectNotFound | RequirementsNotChecked
  > =>
    RunHostingShape.$match(hosting, {
      Refused: ({ reason }) =>
        Effect.fail(new RequirementsNotChecked({ reason })),
      Ready: ({ services }) =>
        Effect.gen(function* () {
          const record = yield* projects.find(project)
          const settings = yield* projects.settings(project)
          const read = yield* requirementsAt({
            repo: record.path,
            revision: `refs/heads/${record.base}`,
          })
          if (RequirementsList.$is('Unreadable')(read))
            return yield* new RequirementsNotChecked({ reason: read.reason })
          return yield* checkRequirements({
            list: read.list,
            checkout: record.path,
            installLimit: settings.check_timeout,
          })
        }).pipe(
          Effect.catchTag('SettingsProblems', ({ problems }) =>
            Effect.fail(
              new RequirementsNotChecked({
                reason: problems.map(describeProblem).join('; '),
              }),
            ),
          ),
          Effect.provideContext(services),
        ),
    })
