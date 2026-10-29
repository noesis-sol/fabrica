import { Effect } from 'effect'

import { InvalidSettings, ProjectRpcs } from '@fabrica/contracts'

import { Projects } from '../projects/service'
import { describeProblem } from '../settings'
import { notImplemented } from './not-implemented'

// The Projects group's handlers (spec §8.1, §10) on the daemon's Projects service: adding a checkout
// or a clone, listing and removing projects, their settings and the status stream. A settings file
// that can't be read or doesn't decode is the project's to fix, a defect of the request that met it;
// settings a client sends that would leave the file invalid are refused with every problem. `init`
// is its own ticket's (M5).

/** The Projects group's handlers. */
export const projectsHandlers = ProjectRpcs.toLayer(
  Effect.gen(function* () {
    const projects = yield* Projects
    return ProjectRpcs.of({
      'projects.add': ({ source, name }) => projects.add({ source, name }),
      'projects.list': () => projects.list,
      'projects.remove': ({ project }) => projects.remove(project),
      'projects.settings.get': ({ project }) =>
        projects
          .settings(project)
          .pipe(Effect.catchTag('SettingsProblems', Effect.die)),
      'projects.settings.set': ({ project, settings }) =>
        projects.setSettings({ project, settings }).pipe(
          Effect.catchTag('SettingsProblems', ({ problems }) =>
            Effect.fail(
              new InvalidSettings({
                problems: [
                  describeProblem(problems[0]),
                  ...problems.slice(1).map(describeProblem),
                ],
              }),
            ),
          ),
        ),
      'projects.init': notImplemented('projects.init'),
      'projects.watchStatus': ({ resume }) => projects.watchStatus(resume),
    })
  }),
)
