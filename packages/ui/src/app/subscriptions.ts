import { Array, type DateTime, Effect, Option, Schema, Stream } from 'effect'
import { Subscription } from 'foldkit'

import { type EngineClientShape, Link, SshPromptEvent } from '@fabrica/client'
import {
  type AttentionPatch,
  type AttentionRequest,
  type BacklogPatch,
  type HostLoad,
  ProjectId,
  type ProjectStatus,
  type ProjectStatusPatch,
  ReleaseVersion,
  type RunEvent,
  RunId,
  type RunView,
  type RunViewPatch,
  TalkId,
  type Ticket,
  type TranscriptEntry,
} from '@fabrica/contracts'

import * as Sidebar from '../console/sidebar'
import * as TalkPanel from '../console/talk-panel'
import * as Talks from '../screens/talks'
import {
  type EngineConnectionService,
  type EngineSession,
  clientName,
  isLive,
  localEngineName,
  withClient,
  withSession,
} from './connection'
import { perFrame } from './frame'
import { AppHost, type AppHostShape } from './host'
import type { Pressed } from './keys'
import { Message } from './message'
import type { Model } from './model'
import { Notifier } from './notifier'
import { liveRuns, watchedRuns } from './notify'
import * as RemoteEngines from './remote-engines'
import { Screen } from './screen'
import { SshPromptHost } from './ssh-prompts'
import { watchOf } from './streams'

// The streams the app listens to (spec §18.1, §18.5): the keys, the engine ports that replace the
// connection's, the client's link, and the engine's streams, each subscribed only while a part that draws it is shown: the run view and attention for
// the console's scope, History's events (under All projects, every project's run going), the backlog while its screen is open, the host's load while connected. Each
// stream's items go on once per animation frame, so a burst of patches costs one update. The scope's
// run talk is opened as the scope changes, and every talk the app holds has its transcript watched.
// For the app's notifications (§18.5), every project's attention requests and the events of each run
// going, while connected, and the clicks on the notifications shown; and what ssh asks as the app
// connects (§9.1).

/** What the subscriptions need from their host, injected so tests drive them. */
export interface SubscriptionEnvironment {
  /** Waits for the next animation frame. */
  readonly nextFrame: Effect.Effect<void>
  /** The keys going down in the window. */
  readonly keys: Stream.Stream<Pressed>
  /** The time now in the viewer's zone, about every second (clock.ts). */
  readonly ticks: Stream.Stream<DateTime.Zoned>
  /** Each engine port that replaces the one the connection took (engine-ports.ts). */
  readonly replacedEnginePorts: Stream.Stream<void>
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
  // The client stopped reconnecting: the connection is tried again, with a client of its own.
  Lost: () =>
    Message.FailedToConnect({ reason: 'the client stopped reconnecting' }),
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

/** A talk's transcript, a frame's entries at a time; its end, when the engine no longer has the talk. */
export const transcriptMessages = (
  client: EngineClientShape,
  talk: TalkId,
  nextFrame: Effect.Effect<void>,
): Stream.Stream<Message> =>
  watchOf<ReadonlyArray<TranscriptEntry>, ReadonlyArray<TranscriptEntry>>(
    client,
  )(resume => client.rpc['talk.watchTranscript']({ talk, resume })).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedTranscript({ talk, items })),
    Stream.catch(() => Stream.empty),
    Stream.concat(Stream.make(Message.EndedTranscript({ talk }))),
  )

/** The talks the app holds, the console's and the Talks screen's, each once. */
const heldTalks = (model: Model): ReadonlyArray<TalkId> =>
  Array.dedupe([
    ...TalkPanel.heldTalks(model.console.talkPanel),
    ...Talks.heldTalks(model.screens.talks),
  ])

/** The engine's projects and their runs' states, for the sidebar's rows, under `name`, the app's name for it. */
export const projectMessages = (
  { client, hello }: EngineSession,
  name: string,
  nextFrame: Effect.Effect<void>,
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

/**
 * The run whose view the scoped project's watch follows: the one its sidebar row shows going, wherever
 * it was started (the app, the CLI, the run talk), else the one the view shows, so a run's end keeps
 * its last view rather than watching afresh.
 */
const viewedRun = (model: Model, project: ProjectId): Option.Option<RunId> =>
  Option.orElse(Sidebar.goingRun(model.console.sidebar, project), () =>
    Option.map(model.runView, view => view.header.run),
  )

/**
 * The runs whose events History shows (§18.3): the scoped project's viewed run, or under All projects
 * every run going that the local engine's rows show.
 */
const historyRuns = (
  model: Model,
): ReadonlyArray<{ readonly project: ProjectId; readonly run: RunId }> =>
  Option.match(model.scope, {
    onSome: () =>
      Option.match(model.runView, {
        onNone: () => [],
        onSome: view => [
          { project: view.header.project, run: view.header.run },
        ],
      }),
    onNone: () =>
      liveRuns(Sidebar.localRows(model.console.sidebar).map(row => row.status)),
  })

/** What the app says where no app is around the renderer to reach its known engines. */
export const noAppToReachEngines =
  'only the desktop app reaches engines on other hosts'

/**
 * A known engine on another host's connection, attempt after attempt, with its project rows; its ports
 * come from the app around the renderer.
 */
export const remoteConnection =
  ({
    host,
    release,
    nextFrame,
  }: {
    readonly host: AppHostShape
    readonly release: ReleaseVersion
    readonly nextFrame: Effect.Effect<void>
  }) =>
  ({ name, address }: RemoteEngines.Attempt): Stream.Stream<Message> =>
    Option.match(host.enginePort, {
      onNone: () =>
        Stream.make(
          Message.StoppedConnectingRemote({
            name,
            reason: noAppToReachEngines,
          }),
        ),
      onSome: port =>
        RemoteEngines.remoteEngineMessages({
          name,
          port: port(address),
          client: { name: clientName, kind: 'app', release },
          streams: session => projectMessages(session, name, nextFrame),
        }),
    })

/**
 * The services the subscriptions use: the engine connection, the notifier, ssh's prompts, the app around
 * the renderer, and the known engines' connections.
 */
type Services =
  | EngineConnectionService
  | Notifier
  | SshPromptHost
  | AppHost
  | RemoteEngines.RemoteConnections

export const makeSubscriptions = ({
  nextFrame,
  keys,
  ticks,
  replacedEnginePorts,
}: SubscriptionEnvironment) =>
  Subscription.make<Model, Message, Services>()(entry => ({
    keys: Subscription.persistentEntry(
      Stream.map(keys, pressed => Message.PressedKey(pressed)),
    ),
    enginePort: Subscription.persistentEntry(
      Stream.map(replacedEnginePorts, () => Message.ReplacedEnginePort()),
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
        runs: Schema.Array(Schema.Struct({ project: ProjectId, run: RunId })),
      },
      {
        modelToDependencies: model => ({
          runs: isLive(model.connection) ? historyRuns(model) : [],
        }),
        dependenciesToStream: ({ runs }) =>
          runs.length === 0
            ? Stream.empty
            : withClient(client =>
                Stream.mergeAll(
                  runs.map(run => eventMessages(client, run, nextFrame)),
                  { concurrency: 'unbounded' },
                ),
              ),
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
            ? withSession(session =>
                projectMessages(session, localEngineName, nextFrame),
              )
            : Stream.empty,
      },
    ),
    // Each known engine on another host keeps its connection while the others change (remote-engines.ts).
    remotes: entry(
      { engines: RemoteEngines.Attempts, release: ReleaseVersion },
      {
        modelToDependencies: model => ({
          engines: RemoteEngines.attempts(model.remotes),
          release: model.release,
        }),
        dependenciesToStream: ({ engines, release }) =>
          Stream.fromEffectDrain(
            Effect.gen(function* () {
              const host = yield* AppHost
              const connections = yield* RemoteEngines.RemoteConnections
              yield* connections.hold(
                engines,
                remoteConnection({ host, release, nextFrame }),
              )
            }),
          ),
      },
    ),
    remoteMessages: Subscription.persistentEntry(
      Stream.unwrap(
        Effect.map(
          RemoteEngines.RemoteConnections,
          connections => connections.messages,
        ),
      ),
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
    runTalk: entry(
      { project: Schema.Option(ProjectId) },
      {
        modelToDependencies: model => ({
          project: isLive(model.connection) ? model.scope : Option.none(),
        }),
        dependenciesToStream: ({ project }) =>
          Option.match(project, {
            onNone: () => Stream.empty,
            onSome: project =>
              Stream.fromEffect(
                Effect.map(TalkPanel.openRunTalk(project), message =>
                  Message.GotTalkPanelMessage({ message }),
                ),
              ),
          }),
      },
    ),
    transcripts: entry(
      { talks: Schema.Array(TalkId) },
      {
        modelToDependencies: model => ({
          talks: isLive(model.connection) ? heldTalks(model) : [],
        }),
        dependenciesToStream: ({ talks }) =>
          talks.length === 0
            ? Stream.empty
            : withClient(client =>
                Stream.mergeAll(
                  talks.map(talk =>
                    transcriptMessages(client, talk, nextFrame),
                  ),
                  { concurrency: 'unbounded' },
                ),
              ),
      },
    ),
    sshPrompts: Subscription.persistentEntry(
      Stream.unwrap(
        Effect.gen(function* () {
          const host = yield* SshPromptHost
          return Stream.map(
            host.events,
            SshPromptEvent.match({
              Asked: ({ id, prompt }): Message =>
                Message.AskedSsh({ id, prompt }),
              Withdrawn: ({ id }): Message => Message.WithdrewSsh({ id }),
            }),
          )
        }),
      ),
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
