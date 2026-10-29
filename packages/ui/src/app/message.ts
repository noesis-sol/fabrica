import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

import {
  EngineId,
  ProjectId,
  ProjectStatusItem,
  ProtocolVersion,
  ReleaseVersion,
  RunId,
  TalkId,
  TranscriptItem,
  UpdateSide,
} from '@fabrica/contracts'

import * as Attention from '../console/attention'
import * as History from '../console/history'
import * as Stats from '../console/stats'
import * as TalkPanel from '../console/talk-panel'
import * as Backlog from '../screens/backlog'
import * as Engines from '../screens/engines'
import * as Palette from '../screens/palette'
import * as Review from '../screens/review'
import * as Settings from '../screens/settings'
import * as Talks from '../screens/talks'
import { Theme } from '../theme/theme'
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

// The root's Messages: keys pressed and commands asked for, the connection's lifecycle, and each
// stream's items, a frame's worth at a time (spec §18.1, §18.5), and the app's notifications.

export const Message = defineMessageUnion({
  /** A key went down anywhere in the window; `inField` while focus is in a text field. */
  PressedKey: {
    key: Schema.String,
    mod: Schema.Boolean,
    alt: Schema.Boolean,
    inField: Schema.Boolean,
  },
  RequestedScreen: { screen: Screen },
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
  /** A project chosen in the sidebar, or none for every project. */
  SelectedScope: { project: Schema.Option(ProjectId) },
  /** The sidebar's "+ Add project": the engines screen's add-project flow (§10.1). */
  RequestedAddProject: {},
  GotHistoryMessage: { message: History.Message },
  /** A Message of the Backlog screen's. */
  GotBacklogMessage: { message: Backlog.Message },
  /** A Message of the Engines and projects screen's. */
  GotEnginesMessage: { message: Engines.Message },
  /** A Message of the Settings screen's. */
  GotSettingsMessage: { message: Settings.Message },
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
  RefusedByEngine: {
    client: ProtocolVersion,
    engine: ProtocolVersion,
    update: UpdateSide,
  },
  WaitedToReconnect: {},

  ReceivedRunView: { project: ProjectId, items: itemsOf(RunViewItem) },
  /** The project's run view ended: no run, or the project gone. */
  EndedRunView: { project: ProjectId, reason: Schema.String },
  /** The pause after the project's run view ended NoRun while its row showed `run` going. */
  WaitedToRewatchRunView: { project: ProjectId, run: RunId },
  ReceivedEvents: { project: ProjectId, items: itemsOf(EventsItem) },
  ReceivedAttention: { items: itemsOf(AttentionItem) },
  ReceivedBacklog: { project: ProjectId, items: itemsOf(BacklogItem) },
  ReceivedLoad: { items: itemsOf(LoadItem) },
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

  /** Every project's attention requests, read for those to notify (§18.5). */
  ReceivedAttentionToNotify: { items: itemsOf(AttentionItem) },
  /** A run's events, read for those to notify. */
  ReceivedRunEvents: {
    project: ProjectId,
    run: RunId,
    items: itemsOf(EventsItem),
  },
  /** A run's events ended: the run is over, or can't be read. */
  EndedRunEvents: { project: ProjectId, run: RunId },
  CompletedShowNotification: {},
  /** A notification was clicked: the console focuses its target. */
  ClickedNotification: { target: NotificationTarget },
})
export type Message = typeof Message.Type
