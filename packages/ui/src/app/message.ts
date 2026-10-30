import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

import {
  EngineName,
  KeepAnswer,
  KnownEnginesAnswer,
  SshPrompt,
} from '@fabrica/client'
import {
  EngineId,
  ProjectId,
  ProjectStatusItem,
  ProtocolVersion,
  ReleaseVersion,
  RunId,
  TalkId,
  TicketId,
  TranscriptItem,
  UpdateSide,
} from '@fabrica/contracts'

import * as Attention from '../console/attention'
import * as History from '../console/history'
import * as Stats from '../console/stats'
import * as TalkPanel from '../console/talk-panel'
import * as Backlog from '../screens/backlog'
import * as Engines from '../screens/engines'
import * as Insights from '../screens/insights'
import * as Palette from '../screens/palette'
import * as Review from '../screens/review'
import * as Settings from '../screens/settings'
import * as Talks from '../screens/talks'
import * as Worker from '../screens/worker'
import { Theme } from '../theme/theme'
import { EngineProject } from './engine-project'
import { NotificationTarget } from './notify'
import { Screen } from './screen'
import {
  AttentionItem,
  BacklogItem,
  EventsItem,
  LoadItem,
  RunViewItem,
  itemsOf,
} from './streams'

// The root's Messages: keys pressed and commands asked for, the connection's lifecycle and what ssh
// asks as it connects, the known engines on other hosts and each one's connection (§9.1), and each
// stream's items, a frame's worth at a time (spec §18.1, §18.5, §9.1), and the app's notifications.

/** How the user answers what ssh asked: yes, no (a cancel, a dismissal), or the secret typed. */
export const SshReply = Schema.Literals(['Accepted', 'Declined', 'Entered'])
export type SshReply = typeof SshReply.Type

export const Message = defineMessageUnion({
  /** A key went down anywhere in the window; `inField` while focus is in a text field. */
  PressedKey: {
    key: Schema.String,
    mod: Schema.Boolean,
    alt: Schema.Boolean,
    inField: Schema.Boolean,
  },
  RequestedScreen: { screen: Screen },
  /** The worker view of a ticket of a run in the scope, on its project: under All projects, one of many. */
  RequestedWorker: { project: EngineProject, ticket: TicketId },
  /** A Message of the Worker view's. */
  GotWorkerMessage: { message: Worker.Message },
  /** A Worker view's key (§18.5). */
  PressedWorkerKey: { key: Worker.Key },
  RequestedPalette: {},
  /** A Message of the command palette's: its query changed. */
  GotPaletteMessage: { message: Palette.Message },
  /** The palette's selection moved `by` places. */
  MovedPaletteSelection: { by: Schema.Int },
  /** The palette's selected entry run: Enter in its search field. */
  RanPaletteSelection: {},
  /** The palette's entry `id` run: a click on it. */
  RanPaletteEntry: { id: Schema.String },
  RequestedKeyHelp: {},
  DismissedOverlay: {},
  /** A project chosen in the sidebar, named with its engine, or none for every project. */
  SelectedScope: { project: Schema.Option(EngineProject) },
  /** The sidebar's "+ Add project": the engines screen's add-project flow (§10.1). */
  RequestedAddProject: {},
  GotHistoryMessage: { message: History.Message },
  /** A Message of the Backlog screen's. */
  GotBacklogMessage: { message: Backlog.Message },
  /** A Message of the Engines and projects screen's. */
  GotEnginesMessage: { message: Engines.Message },
  /** A Message of the Settings screen's. */
  GotSettingsMessage: { message: Settings.Message },
  /** A Message of the Insights screen's. */
  GotInsightsMessage: { message: Insights.Message },
  /** A theme chosen, in Settings or the palette: applied at once, and kept as the install's (§18.2). */
  ChoseTheme: { theme: Theme },
  CompletedShowTheme: {},
  /** A Message of the Review screen's. */
  GotReviewMessage: { message: Review.Message },
  /** A Review screen's key for one of its views. */
  PressedReviewTab: { tab: Review.Tab },

  ConnectedToEngine: {
    engine: EngineId,
    release: ReleaseVersion,
    protocol: ProtocolVersion,
  },
  LostEngine: {},
  ReleasedEngine: {},
  FailedToConnect: { reason: Schema.String },
  /** The connection was refused in a way trying again won't mend: ssh refused the engine's host. */
  StoppedConnecting: { reason: Schema.String },
  /** The user asked to try a connection that stopped again. */
  RequestedReconnect: {},
  /** ssh asked something, numbered `id`, as the app connects (§9.1). */
  AskedSsh: { id: Schema.Int, prompt: SshPrompt },
  /** ssh went on, or ended, without the answer to prompt `id`. */
  WithdrewSsh: { id: Schema.Int },
  /** The secret typed for the prompt shown. */
  ChangedSshSecret: { secret: Schema.Redacted(Schema.String) },
  /** The user answered prompt `id`. */
  RepliedToSsh: { id: Schema.Int, reply: SshReply },
  CompletedAnswerSsh: {},
  RefusedByEngine: {
    client: ProtocolVersion,
    engine: ProtocolVersion,
    update: UpdateSide,
  },
  WaitedToReconnect: {},
  /** Main handed the page a new engine port, the connection's dead with the relay that served it. */
  ReplacedEnginePort: {},

  /** The known engines, as the app's state holds them (§9.1). */
  LoadedKnownEngines: { answer: KnownEnginesAnswer },
  /** A known engine kept in the app's state, or why it wasn't. */
  CompletedKeepEngine: { name: EngineName, answer: KeepAnswer },
  /** The known engine named `name` took the app's hello. */
  ConnectedToRemote: {
    name: EngineName,
    engine: EngineId,
    release: ReleaseVersion,
    protocol: ProtocolVersion,
  },
  /** The known engine's link was lost; its client is reconnecting. */
  LostRemote: { name: EngineName },
  /** The known engine couldn't be reached; another attempt follows. */
  FailedToConnectRemote: { name: EngineName, reason: Schema.String },
  /** The known engine's connection was refused in a way trying again won't mend: ssh refused its host. */
  StoppedConnectingRemote: { name: EngineName, reason: Schema.String },
  /** The known engine and the app share no protocol version. */
  RefusedByRemote: {
    name: EngineName,
    client: ProtocolVersion,
    engine: ProtocolVersion,
    update: UpdateSide,
  },

  ReceivedRunView: { project: EngineProject, items: itemsOf(RunViewItem) },
  /** The project's run view ended: no run, or the project gone. */
  EndedRunView: { project: EngineProject, reason: Schema.String },
  /** The pause after the project's run view ended NoRun while its row showed `run` going. */
  WaitedToRewatchRunView: { project: EngineProject, run: RunId },
  ReceivedEvents: { project: EngineProject, items: itemsOf(EventsItem) },
  /** The scope's open attention requests, on the engine named `engine`. */
  ReceivedAttention: { engine: Schema.String, items: itemsOf(AttentionItem) },
  ReceivedBacklog: { project: EngineProject, items: itemsOf(BacklogItem) },
  /** The host's load of the engine named `engine`, the scoped project's. */
  ReceivedLoad: { engine: Schema.String, items: itemsOf(LoadItem) },
  /** An engine's project rows, for the sidebar; `name` is the engine's, as the app knows it. */
  ReceivedProjects: {
    engine: EngineId,
    name: Schema.String,
    items: itemsOf(ProjectStatusItem),
  },
  /** The clock's tick: the time now, in the viewer's zone. */
  Ticked: { now: Schema.DateTimeZoned },

  GotStatsMessage: { message: Stats.Message },
  GotAttentionMessage: { message: Attention.Message },
  /** A key 1–9 for the option at `place` (from 0) of the attention request `key`'s drawn options. */
  PressedAnswerKey: { key: Schema.String, place: Schema.Int },
  /** A Message of the console's talk panel. */
  GotTalkPanelMessage: { message: TalkPanel.Message },
  /** A Message of the Talks screen's. */
  GotTalksMessage: { message: Talks.Message },
  /** The maintainer's key for the answer talk (§15.3, §18.5): it takes the talk panel. */
  RequestedAnswerTalk: {},
  /** A frame of a talk's transcript, for the panel or the Talks screen that holds the talk. */
  ReceivedTranscript: { talk: TalkId, items: itemsOf(TranscriptItem) },
  /** A talk's transcript ended: the engine no longer has the talk. */
  EndedTranscript: { talk: TalkId },
  /** A frame of the shown worker's transcript (§18.4). */
  ReceivedWorkerTranscript: {
    worker: Worker.Shown,
    items: itemsOf(TranscriptItem),
  },
  /** The worker's transcript ended: the worker has finished. */
  EndedWorkerTranscript: { worker: Worker.Shown },
  /** The worker's transcript couldn't be read. */
  FailedWorkerTranscript: { worker: Worker.Shown, reason: Schema.String },

  /** Every project's attention requests on the engine named `engine`, read for those to notify (§18.5). */
  ReceivedAttentionToNotify: {
    engine: Schema.String,
    items: itemsOf(AttentionItem),
  },
  /** A run's events on the engine named `engine`, read for those to notify. */
  ReceivedRunEvents: {
    engine: Schema.String,
    project: ProjectId,
    run: RunId,
    items: itemsOf(EventsItem),
  },
  /** A run's events ended: the run is over, or can't be read. */
  EndedRunEvents: { engine: Schema.String, project: ProjectId, run: RunId },
  CompletedShowNotification: {},
  /** A notification was clicked: the console focuses its target. */
  ClickedNotification: { target: NotificationTarget },
})
export type Message = typeof Message.Type
