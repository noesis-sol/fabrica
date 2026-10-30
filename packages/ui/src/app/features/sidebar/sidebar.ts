import { Option, Schema, Stream } from 'effect'
import { Subscription } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import type { ProjectStatus, ProjectStatusPatch } from '@fabrica/contracts'

import * as Sidebar from '../../../console/sidebar'
import { type EngineSession, isLive, localEngineName } from '../../connection'
import { withEngineSession } from '../../engine-route'
import type { Handlers, SubscriptionServices } from '../../feature'
import { perFrame } from '../../frame'
import { Message } from '../../message'
import type { Model } from '../../model'
import * as Notify from '../../notify'
import { watchOf } from '../../streams'
import type { SubscriptionEnvironment } from '../../subscriptions'
import type { messages } from './message'

// The sidebar (spec §18.3): every engine's projects and their runs' states, and the scope they choose.

/**
 * Under All projects, the run views of runs the sidebar's rows still show going, each run's own: a run
 * ended, or followed by another, drops its view. The same list where every one is kept.
 */
const goingRunViews = (
  runViews: Model['runViews'],
  sidebar: Sidebar.Model,
): Model['runViews'] => {
  const kept = runViews.filter(({ project, view }) =>
    Option.contains(Sidebar.goingRun(sidebar, project), view.header.run),
  )
  return kept.length === runViews.length ? runViews : kept
}

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  ReceivedProjects: ({ engine, name, items }) => {
    const sidebar = Sidebar.receivedProjects(model.console.sidebar, {
      engine,
      name,
      items,
    })
    return {
      model: modifyFields(model, {
        console: parts => modifyFields(parts, { sidebar: () => sidebar }),
        runViews: runViews => goingRunViews(runViews, sidebar),
        notify: notify =>
          Notify.receivedRuns(
            notify,
            Notify.liveRuns(Sidebar.engineStatuses(sidebar)),
          ),
      }),
    }
  },
})

/** The sidebar's Messages, made once, so its memo holds across renders. */
const sidebarMessages: Sidebar.Messages<Message> = {
  select: project => Message.SelectedScope({ project }),
  addProject: Message.RequestedAddProject(),
}

export const view = (
  sidebar: Sidebar.Model,
  scope: Model['scope'],
  h: HtmlBuilder<Message>,
): Html => Sidebar.view(sidebar, { scope, messages: sidebarMessages }, h)

/** The engine's projects and their runs' states, for the sidebar's rows, under `name`, the app's name for it. */
export const projectMessages = (
  { client, hello }: EngineSession,
  name: string,
  nextFrame: SubscriptionEnvironment['nextFrame'],
): Stream.Stream<Message> =>
  watchOf<ReadonlyArray<ProjectStatus>, typeof ProjectStatusPatch.Type>(client)(
    resume => client.rpc['projects.watchStatus']({ resume }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items =>
      Message.ReceivedProjects({ engine: hello.engine, name, items }),
    ),
    Stream.catch(() => Stream.empty),
  )

export const subscriptions = ({ nextFrame }: SubscriptionEnvironment) =>
  Subscription.make<Model, Message, SubscriptionServices>()(entry => ({
    projects: entry(
      { live: Schema.Boolean },
      {
        modelToDependencies: model => ({ live: isLive(model.connection) }),
        dependenciesToStream: ({ live }) =>
          live
            ? withEngineSession(localEngineName, session =>
                projectMessages(session, localEngineName, nextFrame),
              )
            : Stream.empty,
      },
    ),
  }))
