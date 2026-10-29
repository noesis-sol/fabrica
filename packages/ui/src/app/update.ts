import { Effect, Option, Schema } from 'effect'
import { Command, type Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import { Connection, retryAfter } from './connection'
import { commandFor, commandsFor } from './keys'
import { Message } from './message'
import { type Model, Overlay } from './model'
import { Screen } from './screen'
import {
  applyAttention,
  applyBacklog,
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

type Return = Update.Return<Model, Message>

/** Whether the Model's overlay is open. */
export const isOverlayOpen = (model: Model): boolean =>
  !Overlay.guards.Closed(model.overlay)

/** The command list of the screen shown, with its overlay's. */
export const modelCommands = (model: Model) =>
  commandsFor({ screen: model.screen, overlayOpen: isOverlayOpen(model) })

const sameScreen = Schema.toEquivalence(Screen)

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
      model: modifyFields(model, {
        scope: () => project,
        runView: () => Option.none(),
        attention: () => Option.none(),
        backlog: () => Option.none(),
      }),
    }),

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
        attention: () => Option.none(),
        backlog: () => Option.none(),
        load: () => Option.none(),
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
  })
