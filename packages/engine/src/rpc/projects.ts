import { Context, Effect, Option, Stream } from 'effect'

import { Host, InvalidSettings, ProjectRpcs } from '@fabrica/contracts'

import { listFolders } from '../projects/folders'
import { Projects } from '../projects/service'
import { ModelProxy, usageProvider, watchUsageWindows } from '../proxy'
import { RunHosting, RunHostingShape } from '../run/hosting'
import { describeProblem } from '../settings'
import { notImplemented } from './not-implemented'

// The Projects group's handlers (spec §8.1, §10) on the daemon's Projects service: adding a checkout
// or a clone, the host's folders a client browses for one (from the home folder its `Host` gives where
// no path is given), listing and removing projects, the user's trust in each, their settings and the status
// stream, and a project's usage windows, from the model proxy its runs are hosted with (none where
// they are refused). A settings file that can't be read or doesn't decode is the project's to fix, a
// defect of the request that met it (the usage stream takes it as naming no model); settings a client
// sends that would leave the file invalid are refused with every problem. `init` is its own ticket's
// (M5).

/** The Projects group's handlers. */
export const projectsHandlers = ProjectRpcs.toLayer(
  Effect.gen(function* () {
    const projects = yield* Projects
    const host = yield* Host
    const proxy = RunHostingShape.$match(yield* RunHosting, {
      Ready: ({ services }) => Option.some(Context.get(services, ModelProxy)),
      Refused: () => Option.none(),
    })
    return ProjectRpcs.of({
      'projects.add': ({ source, name }) => projects.add({ source, name }),
      'projects.folders': ({ path }) =>
        Option.match(path, {
          onNone: () => Effect.map(host.facts, ({ home }) => home),
          onSome: Effect.succeed,
        }).pipe(Effect.flatMap(listFolders)),
      'projects.list': () => projects.list,
      'projects.remove': ({ project }) => projects.remove(project),
      'projects.trust': ({ project, trusted }) =>
        projects.setTrusted({ project, trusted }),
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
      'projects.watchUsage': ({ project }) =>
        projects.settings(project).pipe(
          Effect.map(Option.some),
          Effect.catchTag('SettingsProblems', () =>
            Effect.succeed(Option.none()),
          ),
          Effect.map(settings =>
            watchUsageWindows({ proxy, provider: usageProvider(settings) }),
          ),
          Stream.unwrap,
        ),
    })
  }),
)
