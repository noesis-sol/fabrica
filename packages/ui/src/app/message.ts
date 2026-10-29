import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

import {
  EngineId,
  ProjectId,
  ProtocolVersion,
  ReleaseVersion,
  UpdateSide,
} from '@fabrica/contracts'

import { Screen } from './screen'
import {
  AttentionItem,
  BacklogItem,
  LoadItem,
  RunViewItem,
  itemsOf,
} from './streams'

// The root's Messages: keys pressed and commands asked for, the connection's lifecycle, and each
// stream's items, a frame's worth at a time (spec §18.1, §18.5).

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
  ReceivedAttention: { items: itemsOf(AttentionItem) },
  ReceivedBacklog: { project: ProjectId, items: itemsOf(BacklogItem) },
  ReceivedLoad: { items: itemsOf(LoadItem) },
})
export type Message = typeof Message.Type
