import { Effect, Option, Schema, Stream } from 'effect'
import { Subscription } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import type { EngineClientShape } from '@fabrica/client'
import type {
  AttentionPatch,
  AttentionRequest,
  ProjectId,
  RunEvent,
  RunId,
} from '@fabrica/contracts'

import * as Sidebar from '../../../console/sidebar'
import {
  type EngineAttentionRef,
  type EngineProject,
  EngineRun,
  sameProject,
} from '../../engine-project'
import { withEngineClient } from '../../engine-route'
import type { Handlers, Return, SubscriptionServices } from '../../feature'
import { perFrame } from '../../frame'
import { Message } from '../../message'
import type { Model } from '../../model'
import { Notifier, ShowNotification } from '../../notifier'
import * as Notify from '../../notify'
import * as RemoteEngines from '../../remote-engines'
import { Screen } from '../../screen'
import { watchOf } from '../../streams'
import type { SubscriptionEnvironment } from '../../subscriptions'
import { selectScope } from '../scope/scope'
import { showScreen } from '../screen/screen'
import type { messages } from './message'

// The app's notifications (spec §18.5): every connected engine's attention requests and the events of
// each run going, read for those to notify, and a click on one focusing its target.

/** A project's name as the sidebar's rows have it; its ID while they don't. */
const projectName =
  (model: Model): Notify.ProjectName =>
  project =>
    Option.getOrElse(
      Sidebar.projectName(model.console.sidebar, project),
      () => project.project,
    )

/** `told`'s model as the Model's, and its notifications shown. */
const tell = (model: Model, told: Notify.Told): Return => ({
  model: modifyFields(model, { notify: () => told.model }),
  commands: told.notifications.map(notification =>
    ShowNotification({ notification }),
  ),
})

/**
 * The console, focused on a clicked notification's `project` and `request`: the scope stays where it
 * already shows the project (every project, or that one), and moves to the project otherwise.
 */
const focusOn = (
  model: Model,
  {
    project,
    request,
  }: {
    readonly project: EngineProject
    readonly request: Option.Option<EngineAttentionRef>
  },
): Return => {
  const scoped = Option.match(model.scope, {
    onNone: () => model,
    onSome: scope =>
      sameProject(scope, project)
        ? model
        : selectScope(model, Option.some(project)).model,
  })
  return {
    model: modifyFields(showScreen(scoped, Screen.Console()), {
      focusedRequest: () => request,
    }),
  }
}

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  ReceivedAttentionToNotify: ({ engine, items }) =>
    tell(
      model,
      Notify.receivedAttention(model.notify, engine, items, projectName(model)),
    ),
  ReceivedRunEvents: ({ engine, project, run, items }) =>
    tell(
      model,
      Notify.receivedRunEvents(
        model.notify,
        { engine, project, run, items },
        projectName(model),
      ),
    ),
  EndedRunEvents: ({ engine, project, run }) => ({
    model: modifyFields(model, {
      notify: notify => Notify.endedRunEvents(notify, { engine, project, run }),
    }),
  }),
  CompletedShowNotification: () => ({ model }),
  ClickedNotification: ({ target }) =>
    Notify.NotificationTarget.match(target, {
      Request: ({ engine, ref }) =>
        focusOn(model, {
          project: { engine, project: ref.project },
          request: Option.some({ engine, ref }),
        }),
      Project: ({ engine, project }) =>
        focusOn(model, {
          project: { engine, project },
          request: Option.none(),
        }),
    }),
})

/** Every project's open attention requests on the engine named `engine`, read for those to notify. */
export const attentionToNotifyMessages = (
  client: EngineClientShape,
  engine: string,
  nextFrame: SubscriptionEnvironment['nextFrame'],
): Stream.Stream<Message> =>
  watchOf<ReadonlyArray<AttentionRequest>, typeof AttentionPatch.Type>(client)(
    resume => client.rpc['attention.watch']({ project: Option.none(), resume }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedAttentionToNotify({ engine, items })),
    Stream.catch(() => Stream.empty),
  )

/**
 * A run's events on the engine named `engine`, read for those to notify; their end, or a failure to
 * read them, as a Message.
 */
export const runEventMessages = (
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
    client.rpc['run.watchEvents']({ project, run: Option.some(run), resume }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items =>
      Message.ReceivedRunEvents({ engine, project, run, items }),
    ),
    Stream.catch(() => Stream.empty),
    Stream.concat(
      Stream.make(Message.EndedRunEvents({ engine, project, run })),
    ),
  )

export const subscriptions = ({ nextFrame }: SubscriptionEnvironment) =>
  Subscription.make<Model, Message, SubscriptionServices>()(entry => ({
    attentionToNotify: entry(
      { engines: Schema.Array(Schema.String) },
      {
        modelToDependencies: model => ({
          engines: RemoteEngines.liveEngines(model),
        }),
        dependenciesToStream: ({ engines }) =>
          Stream.mergeAll(
            engines.map(engine =>
              withEngineClient(engine, client =>
                attentionToNotifyMessages(client, engine, nextFrame),
              ),
            ),
            { concurrency: 'unbounded' },
          ),
      },
    ),
    runEvents: entry(
      { runs: Schema.Array(EngineRun) },
      {
        modelToDependencies: model => ({
          runs: RemoteEngines.onLiveEngines(
            model,
            Notify.watchedRuns(model.notify),
          ),
        }),
        dependenciesToStream: ({ runs }) =>
          Stream.mergeAll(
            runs.map(run =>
              withEngineClient(run.engine, client =>
                runEventMessages(client, run, nextFrame),
              ),
            ),
            { concurrency: 'unbounded' },
          ),
      },
    ),
    notificationClicks: Subscription.persistentEntry(
      Stream.unwrap(
        Effect.gen(function* () {
          const notifier = yield* Notifier
          return Stream.map(notifier.clicks, target =>
            Message.ClickedNotification({ target }),
          )
        }),
      ),
    ),
  }))
