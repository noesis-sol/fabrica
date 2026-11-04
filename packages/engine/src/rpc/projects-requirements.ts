import { Effect, Option } from 'effect'

import {
  type ProjectId,
  type ProjectNotFound,
  type RequirementFound,
  RequirementsNotChecked,
} from '@fabrica/contracts'

import { Git } from '../git'
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
// remote engine's requirements are its own. Only Base's commit's list runs, and only in a checkout clean
// and on Base, as a run's start asks: Base's `sh check.sh` would otherwise run a branch's `check.sh`.

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
          const git = yield* Git
          const [branch, status] = yield* Effect.all(
            [
              git.currentBranch({ repo: record.path }),
              git.status({ worktree: record.path }),
            ],
            { concurrency: 2 },
          )
          if (!Option.contains(branch, record.base))
            return yield* new RequirementsNotChecked({
              reason: `the checkout ${record.path} isn't on ${record.base}, and the list's commands run there: check it out first`,
            })
          if (status.uncommitted.length > 0)
            return yield* new RequirementsNotChecked({
              reason: `the checkout ${record.path} has uncommitted changes, and the list's commands run there: ${status.uncommitted.join(', ')}`,
            })
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
          Effect.catchTags({
            SettingsProblems: ({ problems }) =>
              Effect.fail(
                new RequirementsNotChecked({
                  reason: problems.map(describeProblem).join('; '),
                }),
              ),
            CantTell: ({ reason }) =>
              Effect.fail(new RequirementsNotChecked({ reason })),
          }),
          Effect.provideContext(services),
        ),
    })
