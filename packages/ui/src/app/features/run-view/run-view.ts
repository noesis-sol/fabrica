import { Duration, Effect, Option, Schema, Stream } from 'effect'
import { Command, Subscription } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import type { EngineClientShape } from '@fabrica/client'
import {
  type NoRun,
  RunId,
  type RunView,
  type RunViewPatch,
} from '@fabrica/contracts'

import * as Sidebar from '../../../console/sidebar'
import { EngineProject, EngineRun, sameProject } from '../../engine-project'
import { withEngineClient } from '../../engine-route'
import type { Handlers, SubscriptionServices } from '../../feature'
import { perFrame } from '../../frame'
import { Message } from '../../message'
import type { Model } from '../../model'
import { liveRuns } from '../../notify'
import * as RemoteEngines from '../../remote-engines'
import { applyProjectRunView, applyRunView, watchOf } from '../../streams'
import type { SubscriptionEnvironment } from '../../subscriptions'
import type { messages } from './message'

// The run view (spec §8.3, §18.3): the scoped project's run view, under All projects the view of every
// project's run going, each through its engine; a watch that ended NoRun while the project's row shows
// a run going is tried again after a pause.

/**
 * How long a run view watch that ended NoRun waits before watching again, while the project's row shows
 * a run going: the row can show a run before the engine has its view.
 */
export const rewatchAfter = Duration.seconds(1)

/** Waits before watching the project's run view again, for the run its row showed going. */
export const WaitToRewatchRunView = Command.define('WaitToRewatchRunView', {
  args: { project: EngineProject, run: RunId },
  messages: [Message.WaitedToRewatchRunView],
  execute: ({ project, run }) =>
    Effect.as(
      Effect.sleep(rewatchAfter),
      Message.WaitedToRewatchRunView({ project, run }),
    ),
})

/** Whether `project`'s run view is one All projects watches: the scope is every project, and its row shows a run going. */
const watchedUnderAll = (model: Model, project: EngineProject): boolean =>
  Option.isNone(model.scope) &&
  Option.isSome(Sidebar.goingRun(model.console.sidebar, project))

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  ReceivedRunView: ({ project, items }) =>
    Option.contains(model.scope, project)
      ? {
          model: modifyFields(model, {
            runView: runView => applyRunView(runView, items),
          }),
        }
      : watchedUnderAll(model, project)
        ? {
            model: modifyFields(model, {
              runViews: runViews =>
                applyProjectRunView(runViews, project, items),
            }),
          }
        : { model },
  EndedRunView: ({ project, reason }) => {
    const scoped = Option.contains(model.scope, project)
    if (!scoped && !watchedUnderAll(model, project)) {
      return { model }
    }
    const ended = scoped
      ? modifyFields(model, { runView: () => Option.none() })
      : modifyFields(model, {
          runViews: runViews =>
            runViews.filter(entry => !sameProject(entry.project, project)),
        })
    const going =
      reason === ('NoRun' satisfies NoRun['_tag'])
        ? Sidebar.goingRun(model.console.sidebar, project)
        : Option.none()
    return Option.match(going, {
      onNone: () => ({ model: ended }),
      onSome: run => ({
        model: ended,
        commands: [WaitToRewatchRunView({ project, run })],
      }),
    })
  },
  WaitedToRewatchRunView: ({ project, run }) => ({
    model:
      Option.contains(Sidebar.goingRun(model.console.sidebar, project), run) &&
      (Option.contains(model.scope, project)
        ? Option.isNone(model.runView)
        : Option.isNone(model.scope) &&
          !model.runViews.some(entry => sameProject(entry.project, project)))
        ? modifyFields(model, { runWatch: watch => watch + 1 })
        : model,
  }),
})

/** The tag of an error that ended a stream, as its reason. */
const reasonOf = (error: { readonly _tag: string }): string => error._tag

/** The project's run view, a frame's items at a time; its end, when the project has no run, as a Message. */
export const runViewMessages = (
  client: EngineClientShape,
  project: EngineProject,
  nextFrame: SubscriptionEnvironment['nextFrame'],
): Stream.Stream<Message> =>
  watchOf<RunView, RunViewPatch>(client)(resume =>
    client.rpc['run.watchView']({ project: project.project, resume }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedRunView({ project, items })),
    Stream.catch(error =>
      Stream.make(Message.EndedRunView({ project, reason: reasonOf(error) })),
    ),
  )

/**
 * The run whose view the scoped project's watch follows: the one its sidebar row shows going, wherever
 * it was started (the app, the CLI, the run talk), else the one the view shows, so a run's end keeps
 * its last view rather than watching afresh.
 */
const viewedRun = (
  model: Model,
  project: EngineProject,
): Option.Option<RunId> =>
  Option.orElse(Sidebar.goingRun(model.console.sidebar, project), () =>
    Option.map(model.runView, view => view.header.run),
  )

/**
 * The runs whose views the console shows under All projects (§18.3): every run going that the
 * sidebar's rows show, each on its engine; none in a project's own scope, whose run `runView` follows.
 */
const allProjectsRuns = (model: Model): ReadonlyArray<EngineRun> =>
  Option.isNone(model.scope)
    ? RemoteEngines.onLiveEngines(
        model,
        liveRuns(Sidebar.engineStatuses(model.console.sidebar)),
      )
    : []

export const subscriptions = ({ nextFrame }: SubscriptionEnvironment) =>
  Subscription.make<Model, Message, SubscriptionServices>()(entry => ({
    runView: entry(
      {
        project: Schema.Option(EngineProject),
        run: Schema.Option(RunId),
        watch: Schema.Int,
      },
      {
        modelToDependencies: model => {
          const project = RemoteEngines.liveScope(model)
          return {
            project,
            run: Option.flatMap(project, scoped => viewedRun(model, scoped)),
            watch: model.runWatch,
          }
        },
        dependenciesToStream: ({ project }) =>
          Option.match(project, {
            onNone: () => Stream.empty,
            onSome: project =>
              withEngineClient(project.engine, client =>
                runViewMessages(client, project, nextFrame),
              ),
          }),
      },
    ),
    // Under All projects, the view of every project's run going, each through its engine.
    runViews: entry(
      { runs: Schema.Array(EngineRun), watch: Schema.Int },
      {
        modelToDependencies: model => ({
          runs: allProjectsRuns(model),
          watch: model.runWatch,
        }),
        dependenciesToStream: ({ runs }) =>
          Stream.mergeAll(
            runs.map(({ engine, project }) =>
              withEngineClient(engine, client =>
                runViewMessages(client, { engine, project }, nextFrame),
              ),
            ),
            { concurrency: 'unbounded' },
          ),
      },
    ),
  }))
