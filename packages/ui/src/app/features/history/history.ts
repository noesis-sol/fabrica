import { Option, Schema, Stream } from 'effect'
import { Subscription, Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import type { EngineClientShape } from '@fabrica/client'
import type { ProjectId, RunEvent, RunId } from '@fabrica/contracts'

import * as History from '../../../console/history'
import * as Sidebar from '../../../console/sidebar'
import { EngineRun } from '../../engine-project'
import { withEngineClient } from '../../engine-route'
import type { Handlers, SubscriptionServices } from '../../feature'
import { perFrame } from '../../frame'
import { Message } from '../../message'
import type { Model } from '../../model'
import { liveRuns } from '../../notify'
import * as RemoteEngines from '../../remote-engines'
import { applyProjectEvents, watchOf } from '../../streams'
import type { SubscriptionEnvironment } from '../../subscriptions'
import type { messages } from './message'

// History (spec §18.3): the events of the scoped project's run, or under All projects of every project's
// run going, each row with its project's chip.

const foldHistory = Update.foldChild({
  update: History.update,
  read: (model: Model) => Option.some(model.console.history),
  write: (model: Model, history: History.Model) =>
    modifyFields(model, {
      console: parts => modifyFields(parts, { history: () => history }),
    }),
  toParentMessage: (message: History.Message) =>
    Message.GotHistoryMessage({ message }),
})

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  GotHistoryMessage: ({ message }) => foldHistory(model, message),
  ReceivedEvents: ({ project, items }) =>
    Option.isNone(model.scope) || Option.contains(model.scope, project)
      ? {
          model: modifyFields(model, {
            events: events => applyProjectEvents(events, project, items),
          }),
        }
      : { model },
})

const toHistoryMessage = (message: History.Message): Message =>
  Message.GotHistoryMessage({ message })

/** History, given the scope's events: under All projects each row carries its project's chip (§18.3). */
export const historyView = (
  history: History.Model,
  events: Model['events'],
  scope: Model['scope'],
  sidebar: Sidebar.Model,
  today: Model['today'],
  h: HtmlBuilder<Message>,
): Html =>
  History.view(
    history,
    {
      events: events.map(({ project, events }) => ({
        project,
        events,
        chip: Option.isNone(scope)
          ? Sidebar.projectChip(sidebar, project)
          : Option.none(),
      })),
      today,
      toParentMessage: toHistoryMessage,
    },
    h,
  )

/**
 * The events of a run on the engine named `engine`, a frame's at a time; the stream ends with the run,
 * its events kept.
 */
export const eventMessages = (
  client: EngineClientShape,
  {
    engine,
    project,
    run,
  }: {
    readonly engine: string
    readonly project: ProjectId
    readonly run: RunId
  },
  nextFrame: SubscriptionEnvironment['nextFrame'],
): Stream.Stream<Message> =>
  watchOf<ReadonlyArray<RunEvent>, ReadonlyArray<RunEvent>>(client)(resume =>
    client.rpc['run.watchEvents']({
      project,
      run: Option.some(run),
      resume,
    }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items =>
      Message.ReceivedEvents({ project: { engine, project }, items }),
    ),
    Stream.catch(() => Stream.empty),
  )

/**
 * The runs whose events History shows (§18.3): the scoped project's viewed run, or under All projects
 * every run going that the sidebar's rows show, each on its engine.
 */
const historyRuns = (model: Model): ReadonlyArray<EngineRun> =>
  RemoteEngines.onLiveEngines(
    model,
    Option.match(model.scope, {
      onSome: ({ engine }) =>
        Option.match(model.runView, {
          onNone: () => [],
          onSome: view => [
            {
              engine,
              project: view.header.project,
              run: view.header.run,
            },
          ],
        }),
      onNone: () => liveRuns(Sidebar.engineStatuses(model.console.sidebar)),
    }),
  )

export const subscriptions = ({ nextFrame }: SubscriptionEnvironment) =>
  Subscription.make<Model, Message, SubscriptionServices>()(entry => ({
    events: entry(
      { runs: Schema.Array(EngineRun) },
      {
        modelToDependencies: model => ({ runs: historyRuns(model) }),
        dependenciesToStream: ({ runs }) =>
          Stream.mergeAll(
            runs.map(run =>
              withEngineClient(run.engine, client =>
                eventMessages(client, run, nextFrame),
              ),
            ),
            { concurrency: 'unbounded' },
          ),
      },
    ),
  }))
