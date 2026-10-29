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
  type RunView,
  type RunViewPatch,
  type Ticket,
} from '@fabrica/contracts'

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
import { Screen } from './screen'
import { watchOf } from './streams'

// The streams the app listens to (spec §18.1, §18.5): the keys, the client's link, and the engine's
// streams, each subscribed only while a part that draws it is shown: the run view and attention for
// the console's scope, the backlog while its screen is open, the host's load while connected. Each
// stream's items go on once per animation frame, so a burst of patches costs one update.

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

export const makeSubscriptions = ({
  nextFrame,
  keys,
  ticks,
}: SubscriptionEnvironment) =>
  Subscription.make<Model, Message, EngineConnectionService>()(entry => ({
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
      { project: Schema.Option(ProjectId), watch: Schema.Int },
      {
        modelToDependencies: model => ({
          project: isLive(model.connection) ? model.scope : Option.none(),
          watch: model.runWatch,
        }),
        dependenciesToStream: ({ project }) =>
          Option.match(project, {
            onNone: () => Stream.empty,
            onSome: project =>
              withClient(client => runViewMessages(client, project, nextFrame)),
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
  }))
