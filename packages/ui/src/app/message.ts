import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

import {
  EngineId,
  ProjectId,
  ProjectStatusItem,
  ProtocolVersion,
  ReleaseVersion,
  RunId,
  UpdateSide,
} from '@fabrica/contracts'

import * as Attention from '../console/attention'
import * as History from '../console/history'
import * as Stats from '../console/stats'
import * as Engines from '../screens/engines'
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
  RequestedKeyHelp: {},
  DismissedOverlay: {},
  /** A project chosen in the sidebar, or none for every project. */
  SelectedScope: { project: Schema.Option(ProjectId) },
  /** The sidebar's "+ Add project": the engines screen's add-project flow (§10.1). */
  RequestedAddProject: {},
  GotHistoryMessage: { message: History.Message },
  /** A Message of the Engines and projects screen's. */
  GotEnginesMessage: { message: Engines.Message },

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
