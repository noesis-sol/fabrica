import { Option, Schema, Stream } from 'effect'
import { Command, Subscription, Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import type { EngineClientShape } from '@fabrica/client'
import type { BacklogPatch, Ticket } from '@fabrica/contracts'

import * as Backlog from '../../../screens/backlog'
import { EngineProject } from '../../engine-project'
import { withEngineClient } from '../../engine-route'
import type { Handlers, Return, SubscriptionServices } from '../../feature'
import { perFrame } from '../../frame'
import { Message } from '../../message'
import type { Model } from '../../model'
import { liveScope } from '../../remote-engines'
import { Screen } from '../../screen'
import { applyBacklog, watchOf } from '../../streams'
import type { SubscriptionEnvironment } from '../../subscriptions'
import type { messages } from './message'

// The Backlog screen (spec §18.4): the scoped project's tickets, watched while the screen is shown.

const foldBacklog = Update.foldChild({
  update: Backlog.update,
  read: (model: Model) => Option.some(model.screens.backlog),
  write: (model: Model, backlog: Backlog.Model) =>
    modifyFields(model, {
      screens: screens => modifyFields(screens, { backlog: () => backlog }),
    }),
  toParentMessage: (message: Backlog.Message) =>
    Message.GotBacklogMessage({ message }),
})

/** The Backlog screen as it opens or its project changes: nothing of another backlog kept. */
export const opened = (model: Model): Model =>
  modifyFields(model, {
    screens: screens => modifyFields(screens, { backlog: Backlog.opened }),
  })

/** The Backlog screen told of its project's tickets, and what it asks of them lifted. */
const tellBacklog = (
  model: Model,
  project: EngineProject,
  tickets: Option.Option<ReadonlyArray<Ticket>>,
): Return =>
  Option.match(tickets, {
    onNone: () => ({ model }),
    onSome: tickets => {
      const told = Backlog.receivedBacklog(model.screens.backlog, {
        project,
        tickets,
      })
      return {
        model: modifyFields(model, {
          screens: screens =>
            modifyFields(screens, { backlog: () => told.model }),
        }),
        commands: Command.mapMessages(told.commands, message =>
          Message.GotBacklogMessage({ message }),
        ),
      }
    },
  })

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  GotBacklogMessage: ({ message }) => foldBacklog(model, message),
  ReceivedBacklog: ({ project, items }) => {
    if (!Option.contains(model.scope, project)) return { model }
    const received = modifyFields(model, {
      backlog: backlog => applyBacklog(backlog, items),
    })
    return tellBacklog(received, project, received.backlog)
  },
})

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    slotId: 'backlog',
    view: Backlog.view,
    model: model.screens.backlog,
    viewInputs: {
      project: model.scope,
      tickets: model.backlog,
      runView: model.runView,
      today: model.today,
    },
    toParentMessage: message => Message.GotBacklogMessage({ message }),
  })

/** The project's tickets. */
export const backlogMessages = (
  client: EngineClientShape,
  project: EngineProject,
  nextFrame: SubscriptionEnvironment['nextFrame'],
): Stream.Stream<Message> =>
  watchOf<ReadonlyArray<Ticket>, typeof BacklogPatch.Type>(client)(resume =>
    client.rpc['tickets.watch']({ project: project.project, resume }),
  ).pipe(
    perFrame(nextFrame),
    Stream.map(items => Message.ReceivedBacklog({ project, items })),
    Stream.catch(() => Stream.empty),
  )

export const subscriptions = ({ nextFrame }: SubscriptionEnvironment) =>
  Subscription.make<Model, Message, SubscriptionServices>()(entry => ({
    backlog: entry(
      { project: Schema.Option(EngineProject) },
      {
        modelToDependencies: model => ({
          project: Screen.guards.Backlog(model.screen)
            ? liveScope(model)
            : Option.none(),
        }),
        dependenciesToStream: ({ project }) =>
          Option.match(project, {
            onNone: () => Stream.empty,
            onSome: project =>
              withEngineClient(project.engine, client =>
                backlogMessages(client, project, nextFrame),
              ),
          }),
      },
    ),
  }))
