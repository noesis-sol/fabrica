import { type DateTime, Effect, Option, Schema, Stream } from 'effect'
import { Subscription } from 'foldkit'

import { type EngineClientShape, Link } from '@fabrica/client'
import {
  type AttentionPatch,
  type AttentionRequest,
  type BacklogPatch,
  type HostLoad,
  ProjectId,
  type ProjectStatus,
  type ProjectStatusPatch,
  type RunEvent,
  RunId,
  type RunView,
  type RunViewPatch,
  type Ticket,
} from '@fabrica/contracts'

import * as Sidebar from '../console/sidebar'
import {
  type EngineConnectionService,
  type EngineSession,
  isLive,
  localEngineName,
  withClient,
  withSession,
} from './connection'
import { perFrame } from './frame'
import type { Pressed } from './keys'
import { Message } from './message'
import type { Model } from './model'
import { Notifier } from './notifier'
import { watchedRuns } from './notify'
import { Screen } from './screen'
import { watchOf } from './streams'

// The streams the app listens to (spec §18.1, §18.5): the keys, the client's link, and the engine's
// streams, each subscribed only while a part that draws it is shown: the run view and attention for
// the console's scope, the backlog while its screen is open, the host's load while connected. Each
// stream's items go on once per animation frame, so a burst of patches costs one update. For the
// app's notifications (§18.5), every project's attention requests and the events of each run going,
// while connected, and the clicks on the notifications shown.

/** What the subscriptions need from their host, injected so tests drive them. */
export interface SubscriptionEnvironment {
  /** Waits for the next animation frame. */
  readonly nextFrame: Effect.Effect<void>
  /** The keys going down in the window. */
  readonly keys: Stream.Stream<Pressed>
  /** The time now in the viewer's zone, about every second (clock.ts). */
  readonly ticks: Stream.Stream<DateTime.Zoned>
}

/** The keys going down in `target`'s window, each with whether focus was in a text field. */
export const documentKeys = (target: Document): Stream.Stream<Pressed> =>
  Stream.fromEventListener<KeyboardEvent>(target, 'keydown').pipe(
    Stream.map(event => ({
      key: event.key,
      mod: event.metaKey || event.ctrlKey,
      alt: event.altKey,
      inField:
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable),
    })),
  )

const linkMessage = Link.$match({
  Up: ({ hello }) =>
    Message.ConnectedToEngine({
      engine: hello.engine,
      release: hello.release,
      protocol: hello.protocol,
    }),
  Down: () => Message.LostEngine(),
  Refused: ({ mismatch }) =>
    Message.RefusedByEngine({
      client: mismatch.client,
      engine: mismatch.engine,
      update: mismatch.update,
    }),
})

/** The tag of an error that ended a stream, as its reason. */
const reasonOf = (error: { readonly _tag: string }): string => error._tag

/** Each change of the client's link. */
export const linkMessages = (
  client: EngineClientShape,
): Stream.Stream<Message> => Stream.map(client.links, linkMessage)

/** The project's run view, a frame's items at a time; its end, when the project has no run, as a Message. */
export const runViewMessages = (
  client: EngineClientShape,
  project: ProjectId,
  nextFrame: Effect.Effect<void>,
): Stream.Stream<Message> =>
  watchOf<RunView, RunViewPatch>(client)(resume =>
    client.rpc['run.watchView']({ project, resume }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedRunView({ project, items })),
    Stream.catch(error =>
      Stream.make(Message.EndedRunView({ project, reason: reasonOf(error) })),
    ),
  )

/** The run's events, a frame's at a time; the stream ends with the run, its events kept. */
export const eventMessages = (
  client: EngineClientShape,
  { project, run }: { readonly project: ProjectId; readonly run: RunId },
  nextFrame: Effect.Effect<void>,
): Stream.Stream<Message> =>
  watchOf<ReadonlyArray<RunEvent>, ReadonlyArray<RunEvent>>(client)(resume =>
    client.rpc['run.watchEvents']({
      project,
      run: Option.some(run),
      resume,
    }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedEvents({ project, items })),
    Stream.catch(() => Stream.empty),
  )

/** The open attention requests, of one project or every one. */
export const attentionMessages = (
  client: EngineClientShape,
  project: Option.Option<ProjectId>,
  nextFrame: Effect.Effect<void>,
): Stream.Stream<Message> =>
  watchOf<ReadonlyArray<AttentionRequest>, typeof AttentionPatch.Type>(client)(
    resume => client.rpc['attention.watch']({ project, resume }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedAttention({ items })),
    Stream.catch(() => Stream.empty),
  )

/** The project's tickets. */
export const backlogMessages = (
  client: EngineClientShape,
  project: ProjectId,
  nextFrame: Effect.Effect<void>,
): Stream.Stream<Message> =>
  watchOf<ReadonlyArray<Ticket>, typeof BacklogPatch.Type>(client)(resume =>
    client.rpc['tickets.watch']({ project, resume }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedBacklog({ project, items })),
    Stream.catch(() => Stream.empty),
  )

/** The engine host's load. */
export const loadMessages = (
  client: EngineClientShape,
  nextFrame: Effect.Effect<void>,
): Stream.Stream<Message> =>
  watchOf<HostLoad, HostLoad>(client)(resume =>
    client.rpc['engine.watchLoad']({ resume }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedLoad({ items })),
    Stream.catch(() => Stream.empty),
  )

/** Every project's open attention requests, read for those to notify. */
export const attentionToNotifyMessages = (
  client: EngineClientShape,
  nextFrame: Effect.Effect<void>,
): Stream.Stream<Message> =>
  watchOf<ReadonlyArray<AttentionRequest>, typeof AttentionPatch.Type>(client)(
    resume => client.rpc['attention.watch']({ project: Option.none(), resume }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedAttentionToNotify({ items })),
    Stream.catch(() => Stream.empty),
  )

/** A run's events, read for those to notify; their end, or a failure to read them, as a Message. */
export const runEventMessages = (
  client: EngineClientShape,
  { project, run }: { readonly project: ProjectId; readonly run: RunId },
  nextFrame: Effect.Effect<void>,
): Stream.Stream<Message> =>
  watchOf<ReadonlyArray<RunEvent>, ReadonlyArray<RunEvent>>(client)(resume =>
    client.rpc['run.watchEvents']({ project, run: Option.some(run), resume }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedRunEvents({ project, run, items })),
    Stream.catch(() => Stream.empty),
    Stream.concat(Stream.make(Message.EndedRunEvents({ project, run }))),
  )

/** The engine's projects and their runs' states, for the sidebar's rows. */
export const projectMessages = (
  { client, hello }: EngineSession,
  nextFrame: Effect.Effect<void>,
): Stream.Stream<Message> =>
  watchOf<ReadonlyArray<ProjectStatus>, typeof ProjectStatusPatch.Type>(client)(
    resume => client.rpc['projects.watchStatus']({ resume }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items =>
      Message.ReceivedProjects({
        engine: hello.engine,
        name: localEngineName,
        items,
      }),
    ),
    Stream.catch(() => Stream.empty),
  )

/**
 * The run whose view the scoped project's watch follows: the one its sidebar row shows going, wherever
 * it was started (the app, the CLI, the run talk), else the one the view shows, so a run's end keeps
 * its last view rather than watching afresh.
 */
const viewedRun = (model: Model, project: ProjectId): Option.Option<RunId> =>
  Option.orElse(Sidebar.goingRun(model.console.sidebar, project), () =>
    Option.map(model.runView, view => view.header.run),
  )

/** The services the subscriptions use: the engine connection, and the notifier. */
type Services = EngineConnectionService | Notifier

export const makeSubscriptions = ({
  nextFrame,
  keys,
  ticks,
}: SubscriptionEnvironment) =>
  Subscription.make<Model, Message, Services>()(entry => ({
    keys: Subscription.persistentEntry(
      Stream.map(keys, pressed => Message.PressedKey(pressed)),
    ),
    link: entry(
      { live: Schema.Boolean },
      {
        modelToDependencies: model => ({ live: isLive(model.connection) }),
        dependenciesToStream: ({ live }) =>
          live ? withClient(linkMessages) : Stream.empty,
      },
    ),
    runView: entry(
      {
        project: Schema.Option(ProjectId),
        run: Schema.Option(RunId),
        watch: Schema.Int,
      },
      {
        modelToDependencies: model => {
          const project = isLive(model.connection) ? model.scope : Option.none()
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
              withClient(client => runViewMessages(client, project, nextFrame)),
          }),
      },
    ),
    events: entry(
      {
        run: Schema.Option(Schema.Struct({ project: ProjectId, run: RunId })),
      },
      {
        modelToDependencies: model => ({
          run: isLive(model.connection)
            ? Option.map(model.runView, view => ({
                project: view.header.project,
                run: view.header.run,
              }))
            : Option.none(),
        }),
        dependenciesToStream: ({ run }) =>
          Option.match(run, {
            onNone: () => Stream.empty,
            onSome: of =>
              withClient(client => eventMessages(client, of, nextFrame)),
          }),
      },
    ),
    attention: entry(
      { live: Schema.Boolean, project: Schema.Option(ProjectId) },
      {
        modelToDependencies: model => ({
          live: isLive(model.connection),
          project: model.scope,
        }),
        dependenciesToStream: ({ live, project }) =>
          live
            ? withClient(client =>
                attentionMessages(client, project, nextFrame),
              )
            : Stream.empty,
      },
    ),
    backlog: entry(
      { project: Schema.Option(ProjectId) },
      {
        modelToDependencies: model => ({
          project:
            isLive(model.connection) && Screen.guards.Backlog(model.screen)
              ? model.scope
              : Option.none(),
        }),
        dependenciesToStream: ({ project }) =>
          Option.match(project, {
            onNone: () => Stream.empty,
            onSome: project =>
              withClient(client => backlogMessages(client, project, nextFrame)),
          }),
      },
    ),
    projects: entry(
      { live: Schema.Boolean },
      {
        modelToDependencies: model => ({ live: isLive(model.connection) }),
        dependenciesToStream: ({ live }) =>
          live
            ? withSession(session => projectMessages(session, nextFrame))
            : Stream.empty,
      },
    ),
    clock: entry(
      { live: Schema.Boolean },
      {
        modelToDependencies: model => ({ live: isLive(model.connection) }),
        dependenciesToStream: ({ live }) =>
          live
            ? Stream.map(ticks, now => Message.Ticked({ now }))
            : Stream.empty,
      },
    ),
    load: entry(
      { live: Schema.Boolean },
      {
        modelToDependencies: model => ({ live: isLive(model.connection) }),
        dependenciesToStream: ({ live }) =>
          live
            ? withClient(client => loadMessages(client, nextFrame))
            : Stream.empty,
      },
    ),
    attentionToNotify: entry(
      { live: Schema.Boolean },
      {
        modelToDependencies: model => ({ live: isLive(model.connection) }),
        dependenciesToStream: ({ live }) =>
          live
            ? withClient(client => attentionToNotifyMessages(client, nextFrame))
            : Stream.empty,
      },
    ),
    runEvents: entry(
      {
        runs: Schema.Array(Schema.Struct({ project: ProjectId, run: RunId })),
      },
      {
        modelToDependencies: model => ({
          runs: isLive(model.connection) ? watchedRuns(model.notify) : [],
        }),
        dependenciesToStream: ({ runs }) =>
          runs.length === 0
            ? Stream.empty
            : withClient(client =>
                Stream.mergeAll(
                  runs.map(run => runEventMessages(client, run, nextFrame)),
                  { concurrency: 'unbounded' },
                ),
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
