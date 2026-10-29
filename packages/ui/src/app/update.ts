import { Effect, Option, Schema } from 'effect'
import { Command, Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import { ProjectId } from '@fabrica/contracts'

import * as History from '../console/history'
import * as Sidebar from '../console/sidebar'
import * as Stats from '../console/stats'
import { dayOf, sameDay } from './clock'
import {
  Connection,
  type EngineConnectionService,
  retryAfter,
} from './connection'
import { commandFor, commandsFor } from './keys'
import { Message } from './message'
import { type Model, Overlay } from './model'
import { Screen } from './screen'
import {
  applyAttention,
  applyBacklog,
  applyEvents,
  applyLoad,
  applyRunView,
} from './streams'

// The root's update (spec §18.1): routing, the keys through the screen's command list, the
// connection's lifecycle, and each stream's items applied to the part of the Model they change.

/** Waits before the next connection attempt. */
export const WaitToReconnect = Command.define('WaitToReconnect', {
  messages: [Message.WaitedToReconnect],
  execute: Effect.as(Effect.sleep(retryAfter), Message.WaitedToReconnect()),
})

type Return = Update.Return<Model, Message, EngineConnectionService>

/** The stats row's Messages, folded into its submodel; a run it started is watched afresh. */
const foldStats = Update.foldChild({
  update: Stats.update,
  read: (model: Model) => Option.some(model.console.stats),
  write: (model, stats) =>
    modifyFields(model, {
      console: parts => modifyFields(parts, { stats: () => stats }),
    }),
  toParentMessage: (message: Stats.Message): Message =>
    Message.GotStatsMessage({ message }),
  foldOutMessage: (outMessage: Stats.OutMessage) => (model: Model) =>
    Stats.OutMessage.match(outMessage, {
      StartedRun: ({ project }) => ({
        model: Option.contains(model.scope, project)
          ? modifyFields(model, { runWatch: watch => watch + 1 })
          : model,
      }),
    }),
})

const foldHistory = Update.foldChild({
  update: History.update,
  read: (model: Model) => Option.some(model.console.history),
  write: (model: Model, history: History.Model) =>
    modifyFields(model, {
      console: parts => modifyFields(parts, { history: () => history }),
    }),
  toParentMessage: (message: History.Message) =>
    Message.GotHistoryMessage({ message }),
})

/** Whether the Model's overlay is open. */
export const isOverlayOpen = (model: Model): boolean =>
  !Overlay.guards.Closed(model.overlay)

/** The command list of the screen shown, with its overlay's. */
export const modelCommands = (model: Model) =>
  commandsFor({ screen: model.screen, overlayOpen: isOverlayOpen(model) })

const sameScreen = Schema.toEquivalence(Screen)

/** Selecting the scope already chosen keeps the Model: its streams aren't subscribed again. */
const sameScope = Schema.toEquivalence(Schema.Option(ProjectId))

/** Shows `screen`, closing any overlay; the same screen again keeps the Model as it is. */
const showScreen = (model: Model, screen: Screen): Model =>
  sameScreen(model.screen, screen) && !isOverlayOpen(model)
    ? model
    : modifyFields(model, {
        screen: () => screen,
        overlay: () => Overlay.Closed(),
        backlog: backlog =>
          Screen.guards.Backlog(screen) ? backlog : Option.none(),
      })

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    PressedKey: pressed =>
      Option.match(commandFor(modelCommands(model), pressed), {
        onNone: () => ({ model }),
        onSome: command => update(model, command.message),
      }),
    RequestedScreen: ({ screen }) => ({ model: showScreen(model, screen) }),
    RequestedPalette: () => ({
      model: modifyFields(model, { overlay: () => Overlay.Palette() }),
    }),
    RequestedKeyHelp: () => ({
      model: modifyFields(model, { overlay: () => Overlay.KeyHelp() }),
    }),
    DismissedOverlay: () => ({
      model: modifyFields(model, { overlay: () => Overlay.Closed() }),
    }),
    SelectedScope: ({ project }) => ({
      model: sameScope(model.scope, project)
        ? model
        : modifyFields(model, {
            scope: () => project,
            runView: () => Option.none(),
            events: () => Option.none(),
            attention: () => Option.none(),
            backlog: () => Option.none(),
            usage: () => Option.none(),
          }),
    }),
    RequestedAddProject: () => ({
      model: showScreen(model, Screen.Engines()),
    }),
    GotHistoryMessage: ({ message }) => foldHistory(model, message),

    ConnectedToEngine: ({ engine, release, protocol }) => ({
      model: modifyFields(model, {
        connection: () => Connection.Up({ engine, release, protocol }),
      }),
    }),
    LostEngine: () => ({
      model: modifyFields(model, { connection: () => Connection.Down() }),
    }),
    ReleasedEngine: () => ({
      model: modifyFields(model, {
        runView: () => Option.none(),
        events: () => Option.none(),
        attention: () => Option.none(),
        backlog: () => Option.none(),
        load: () => Option.none(),
        usage: () => Option.none(),
        console: parts =>
          modifyFields(parts, { sidebar: () => Sidebar.init() }),
      }),
    }),
    FailedToConnect: ({ reason }) => ({
      model: modifyFields(model, {
        connection: () => Connection.Failed({ reason }),
      }),
      commands: [WaitToReconnect()],
    }),
    RefusedByEngine: ({ client, engine, update }) => ({
      model: modifyFields(model, {
        connection: () => Connection.Refused({ client, engine, update }),
      }),
    }),
    WaitedToReconnect: () => ({
      model: modifyFields(model, {
        attempt: attempt => attempt + 1,
        connection: () => Connection.Connecting(),
      }),
    }),

    ReceivedRunView: ({ project, items }) =>
      Option.contains(model.scope, project)
        ? {
            model: modifyFields(model, {
              runView: runView => applyRunView(runView, items),
            }),
          }
        : { model },
    EndedRunView: ({ project }) =>
      Option.contains(model.scope, project)
        ? { model: modifyFields(model, { runView: () => Option.none() }) }
        : { model },
    ReceivedEvents: ({ project, items }) =>
      Option.contains(model.scope, project)
        ? {
            model: modifyFields(model, {
              events: events => applyEvents(events, items),
            }),
          }
        : { model },
    ReceivedAttention: ({ items }) => ({
      model: modifyFields(model, {
        attention: attention => applyAttention(attention, items),
      }),
    }),
    ReceivedBacklog: ({ project, items }) =>
      Option.contains(model.scope, project)
        ? {
            model: modifyFields(model, {
              backlog: backlog => applyBacklog(backlog, items),
            }),
          }
        : { model },
    ReceivedLoad: ({ items }) => ({
      model: modifyFields(model, { load: load => applyLoad(load, items) }),
    }),
    ReceivedProjects: ({ engine, name, items }) => ({
      model: modifyFields(model, {
        console: parts =>
          modifyFields(parts, {
            sidebar: sidebar =>
              Sidebar.receivedProjects(sidebar, { engine, name, items }),
          }),
      }),
    }),
    Ticked: ({ now }) => ({
      model: modifyFields(model, {
        now: () => Option.some(now),
        today: today =>
          Option.exists(today, day => sameDay(now, day))
            ? today
            : Option.some(dayOf(now)),
      }),
    }),

    GotStatsMessage: ({ message }) => foldStats(model, message),
  })
