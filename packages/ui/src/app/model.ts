import { Option, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import {
  AttentionRequest,
  HostLoad,
  Platform,
  ProjectId,
  ReleaseVersion,
  RunEvents,
  RunView,
  Ticket,
  UsageWindow,
} from '@fabrica/contracts'

import * as Attention from '../console/attention'
import * as History from '../console/history'
import * as InProgress from '../console/in-progress'
import * as Sidebar from '../console/sidebar'
import * as Stats from '../console/stats'
import * as TalkPanel from '../console/talk-panel'
import * as Titlebar from '../console/titlebar'
import * as UpNext from '../console/up-next'
import * as Backlog from '../screens/backlog'
import * as Engines from '../screens/engines'
import * as Insights from '../screens/insights'
import * as Palette from '../screens/palette'
import * as Review from '../screens/review'
import * as Settings from '../screens/settings'
import * as Talks from '../screens/talks'
import * as Worker from '../screens/worker'
import { Connection } from './connection'
import { Screen } from './screen'

// The root Model (spec §18.1): the screen shown and any overlay over it, the scope the sidebar chose,
// the connection, each stream's latest value, and every part's submodel. Each part draws its own slice,
// and a slice a patch leaves alone keeps its identity, so the part isn't redrawn (§18.5).

/** What opens over the screen. */
export const Overlay = defineTaggedUnion({
  Closed: {},
  KeyHelp: {},
  Palette: {},
})
export type Overlay = typeof Overlay.Type

/** What the app starts with: facts of its host, injected. */
export const Flags = Schema.Struct({
  /** Where the app runs: it names the command key (⌘ or Ctrl). */
  platform: Platform,
  /** The app's release, said in its hello to the engine. */
  release: ReleaseVersion,
})
export type Flags = typeof Flags.Type

export const ConsoleParts = Schema.Struct({
  titlebar: Titlebar.Model,
  sidebar: Sidebar.Model,
  stats: Stats.Model,
  talkPanel: TalkPanel.Model,
  history: History.Model,
  inProgress: InProgress.Model,
  attention: Attention.Model,
  upNext: UpNext.Model,
})
export type ConsoleParts = typeof ConsoleParts.Type

export const Screens = Schema.Struct({
  worker: Worker.Model,
  talks: Talks.Model,
  backlog: Backlog.Model,
  review: Review.Model,
  insights: Insights.Model,
  engines: Engines.Model,
  settings: Settings.Model,
  palette: Palette.Model,
})
export type Screens = typeof Screens.Type

export const Model = Schema.Struct({
  platform: Platform,
  release: ReleaseVersion,
  /** The connection attempt: each new one acquires the client afresh. */
  attempt: Schema.Int,
  connection: Connection,
  screen: Screen,
  overlay: Overlay,
  /** The project the sidebar chose; none for every project. */
  scope: Schema.Option(ProjectId),
  /** The scoped project's run view, while it has a run. */
  runView: Schema.Option(RunView),
  /** The scoped project's run's events, newest first, as History shows them. */
  events: Schema.Option(RunEvents),
  /** The scope's open attention requests. */
  attention: Schema.Option(Schema.Array(AttentionRequest)),
  /** The scoped project's tickets, while the Backlog screen shows them. */
  backlog: Schema.Option(Schema.Array(Ticket)),
  /** The engine host's load. */
  load: Schema.Option(HostLoad),
  /** The scoped project's provider account's usage windows, from the model proxy (§12.9, H90). */
  usage: Schema.Option(Schema.Array(UsageWindow)),
  /** The time now in the viewer's zone, from the clock's ticks (spec §18.3, H80). */
  now: Schema.Option(Schema.DateTimeZoned),
  /** The start of the viewer's day, from the same ticks: kept until the day changes (§7.7). */
  today: Schema.Option(Schema.DateTimeZoned),
  /** Bumped to watch the scoped project's run view afresh: a run started from the app. */
  runWatch: Schema.Int,
  console: ConsoleParts,
  screens: Screens,
})
export type Model = typeof Model.Type

export const initialModel = (flags: Flags): Model => ({
  platform: flags.platform,
  release: flags.release,
  attempt: 1,
  connection: Connection.Connecting(),
  screen: Screen.Console(),
  overlay: Overlay.Closed(),
  scope: Option.none(),
  runView: Option.none(),
  events: Option.none(),
  attention: Option.none(),
  backlog: Option.none(),
  load: Option.none(),
  usage: Option.none(),
  now: Option.none(),
  today: Option.none(),
  runWatch: 0,
  console: {
    titlebar: Titlebar.init(),
    sidebar: Sidebar.init(),
    stats: Stats.init(),
    talkPanel: TalkPanel.init(),
    history: History.init(),
    inProgress: InProgress.init(),
    attention: Attention.init(),
    upNext: UpNext.init(),
  },
  screens: {
    worker: Worker.init(),
    talks: Talks.init(),
    backlog: Backlog.init(),
    review: Review.init(),
    insights: Insights.init(),
    engines: Engines.init(),
    settings: Settings.init(),
    palette: Palette.init(),
  },
})
