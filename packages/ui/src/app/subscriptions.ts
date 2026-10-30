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
  type EngineSession,
  clientName,
  isLive,
  localEngineName,
} from './connection'
import {
  type EngineServices,
  EngineSessions,
  type EngineSessionsShape,
  ProjectRoute,
  engineOf,
  routes,
  scopeEngine,
  withEngineClient,
  withEngineSession,
} from './engine-route'
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
// connection's, the client's link, and the engine's streams, each subscribed only while a part that
// draws it is shown: the run view and attention for the console's scope (under All projects, every
// connected engine's attention), History's events (under All projects, every project's run going), the
// backlog while its screen is open, the host's load while connected. Each project's streams go through
// the engine whose sidebar row holds it, while that engine is connected (engine-route.ts), and the
// load is the scoped project's engine's. Each stream's items go on once per animation frame, so a
// burst of patches costs one update. The scope's run talk is opened as the scope changes, and every
// talk the app holds has its transcript watched. For the app's notifications (§18.5), every connected
// engine's attention requests and the events of each run going, and the clicks on the notifications
// shown; and what ssh asks as the app connects (§9.1).

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

/** The open attention requests on the engine named `engine`, of one project or every one. */
export const attentionMessages = (
  client: EngineClientShape,
  {
    engine,
    project,
  }: { readonly engine: string; readonly project: Option.Option<ProjectId> },
  nextFrame: Effect.Effect<void>,
): Stream.Stream<Message> =>
  watchOf<ReadonlyArray<AttentionRequest>, typeof AttentionPatch.Type>(client)(
    resume => client.rpc['attention.watch']({ project, resume }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedAttention({ engine, items })),
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

/** The host's load of the engine named `engine`. */
export const loadMessages = (
  client: EngineClientShape,
  engine: string,
  nextFrame: Effect.Effect<void>,
): Stream.Stream<Message> =>
  watchOf<HostLoad, HostLoad>(client)(resume =>
    client.rpc['engine.watchLoad']({ resume }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedLoad({ engine, items })),
    Stream.catch(() => Stream.empty),
  )

/** Every project's open attention requests on the engine named `engine`, read for those to notify. */
export const attentionToNotifyMessages = (
  client: EngineClientShape,
  engine: string,
  nextFrame: Effect.Effect<void>,
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
  nextFrame: Effect.Effect<void>,
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

/** The talks the app holds, the console's and the Talks screen's, each once, with its project's engine, while it is connected. */
const heldTalks = (
  model: Model,
): ReadonlyArray<{ readonly engine: string; readonly talk: TalkId }> =>
  Array.dedupeWith(
    [
      ...TalkPanel.heldTalks(model.console.talkPanel),
      ...Talks.heldTalks(model.screens.talks),
    ].map(({ project, talk }) => ({
      engine: engineOf(model.console.sidebar, project),
      talk,
    })),
    (first, second) => first.talk === second.talk,
  ).filter(({ engine }) => RemoteEngines.isEngineLive(model, engine))

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

/** A run, with the name of the engine it runs on. */
const EngineRun = Schema.Struct({
  engine: Schema.String,
  project: ProjectId,
  run: RunId,
})

/** Of `runs`, those on an engine connected now. */
const onLiveEngines = <Run extends { readonly engine: string }>(
  model: Model,
  runs: ReadonlyArray<Run>,
): ReadonlyArray<Run> =>
  runs.filter(({ engine }) => RemoteEngines.isEngineLive(model, engine))

/**
 * The runs whose events History shows (§18.3): the scoped project's viewed run, or under All projects
 * every run going that the sidebar's rows show, each on its engine.
 */
const historyRuns = (model: Model): ReadonlyArray<typeof EngineRun.Type> =>
  onLiveEngines(
    model,
    Option.match(model.scope, {
      onSome: () =>
        Option.match(model.runView, {
          onNone: () => [],
          onSome: view => [
            {
              engine: engineOf(model.console.sidebar, view.header.project),
              project: view.header.project,
              run: view.header.run,
            },
          ],
        }),
      onNone: () => liveRuns(Sidebar.engineStatuses(model.console.sidebar)),
    }),
  )

/**
 * The engines whose attention requests the console shows: the scoped project's, or under All projects
 * every one connected now.
 */
const attentionEngines = (model: Model): ReadonlyArray<string> =>
  Option.match(model.scope, {
    onSome: () => {
      const engine = scopeEngine(model.console.sidebar, model.scope)
      return RemoteEngines.isEngineLive(model, engine) ? [engine] : []
    },
    onNone: () => RemoteEngines.liveEngines(model),
  })

/** What the app says where no app is around the renderer to reach its known engines. */
export const noAppToReachEngines =
  'only the desktop app reaches engines on other hosts'

/**
 * A known engine on another host's connection, attempt after attempt, with its project rows, its
 * session held by its name while it is connected; its ports come from the app around the renderer.
 */
export const remoteConnection =
  ({
    host,
    sessions,
    release,
    nextFrame,
  }: {
    readonly host: AppHostShape
    readonly sessions: EngineSessionsShape
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
          keep: session => sessions.keep(name, session),
        }),
    })

/**
 * The services the subscriptions use: the engines' connections and sessions, the notifier, ssh's
 * prompts, the app around the renderer, and the known engines' connections.
 */
type Services =
  | EngineServices
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
          live ? withEngineClient(localEngineName, linkMessages) : Stream.empty,
      },
    ),
    // Each project's streams go through the engine whose sidebar row holds it (engine-route.ts).
    routes: entry(
      { routes: Schema.Array(ProjectRoute) },
      {
        modelToDependencies: model => ({
          routes: routes(model.console.sidebar),
        }),
        dependenciesToStream: ({ routes }) =>
          Stream.fromEffectDrain(
            Effect.flatMap(EngineSessions, sessions => sessions.route(routes)),
          ),
      },
    ),
    runView: entry(
      {
        engine: Schema.String,
        project: Schema.Option(ProjectId),
        run: Schema.Option(RunId),
        watch: Schema.Int,
      },
      {
        modelToDependencies: model => {
          const engine = scopeEngine(model.console.sidebar, model.scope)
          const project = RemoteEngines.isEngineLive(model, engine)
            ? model.scope
            : Option.none()
          return {
            engine,
            project,
            run: Option.flatMap(project, scoped => viewedRun(model, scoped)),
            watch: model.runWatch,
          }
        },
        dependenciesToStream: ({ engine, project }) =>
          Option.match(project, {
            onNone: () => Stream.empty,
            onSome: project =>
              withEngineClient(engine, client =>
                runViewMessages(client, project, nextFrame),
              ),
          }),
      },
    ),
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
    // The scoped project's requests on its engine, or under All projects every connected engine's.
    attention: entry(
      {
        engines: Schema.Array(Schema.String),
        project: Schema.Option(ProjectId),
      },
      {
        modelToDependencies: model => ({
          engines: attentionEngines(model),
          project: model.scope,
        }),
        dependenciesToStream: ({ engines, project }) =>
          Stream.mergeAll(
            engines.map(engine =>
              withEngineClient(engine, client =>
                attentionMessages(client, { engine, project }, nextFrame),
              ),
            ),
            { concurrency: 'unbounded' },
          ),
      },
    ),
    backlog: entry(
      { engine: Schema.String, project: Schema.Option(ProjectId) },
      {
        modelToDependencies: model => {
          const engine = scopeEngine(model.console.sidebar, model.scope)
          return {
            engine,
            project:
              RemoteEngines.isEngineLive(model, engine) &&
              Screen.guards.Backlog(model.screen)
                ? model.scope
                : Option.none(),
          }
        },
        dependenciesToStream: ({ engine, project }) =>
          Option.match(project, {
            onNone: () => Stream.empty,
            onSome: project =>
              withEngineClient(engine, client =>
                backlogMessages(client, project, nextFrame),
              ),
          }),
      },
    ),
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
              const sessions = yield* EngineSessions
              const connections = yield* RemoteEngines.RemoteConnections
              yield* connections.hold(
                engines,
                remoteConnection({ host, sessions, release, nextFrame }),
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
        modelToDependencies: model => ({
          live: RemoteEngines.liveEngines(model).length > 0,
        }),
        dependenciesToStream: ({ live }) =>
          live
            ? Stream.map(ticks, now => Message.Ticked({ now }))
            : Stream.empty,
      },
    ),
    // The stats row's load: the scoped project's engine's host's.
    load: entry(
      { engine: Schema.String, live: Schema.Boolean },
      {
        modelToDependencies: model => {
          const engine = scopeEngine(model.console.sidebar, model.scope)
          return { engine, live: RemoteEngines.isEngineLive(model, engine) }
        },
        dependenciesToStream: ({ engine, live }) =>
          live
            ? withEngineClient(engine, client =>
                loadMessages(client, engine, nextFrame),
              )
            : Stream.empty,
      },
    ),
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
          runs: onLiveEngines(model, watchedRuns(model.notify)),
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
    runTalk: entry(
      { engine: Schema.String, project: Schema.Option(ProjectId) },
      {
        modelToDependencies: model => {
          const engine = scopeEngine(model.console.sidebar, model.scope)
          return {
            engine,
            project: RemoteEngines.isEngineLive(model, engine)
              ? model.scope
              : Option.none(),
          }
        },
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
      {
        talks: Schema.Array(
          Schema.Struct({ engine: Schema.String, talk: TalkId }),
        ),
      },
      {
        modelToDependencies: model => ({ talks: heldTalks(model) }),
        dependenciesToStream: ({ talks }) =>
          Stream.mergeAll(
            talks.map(({ engine, talk }) =>
              withEngineClient(engine, client =>
                transcriptMessages(client, talk, nextFrame),
              ),
            ),
            { concurrency: 'unbounded' },
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
