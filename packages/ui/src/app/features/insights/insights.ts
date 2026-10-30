import { Option } from 'effect'
import { Command, Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import * as Sidebar from '../../../console/sidebar'
import * as Insights from '../../../screens/insights'
import type { Handlers, Return } from '../../feature'
import { Message } from '../../message'
import type { Model } from '../../model'
import type { messages } from './message'

// The Insights screen (spec §18.4, §21): the scope's telemetry.

const foldInsights = Update.foldChild({
  update: Insights.update,
  read: (model: Model) => Option.some(model.screens.insights),
  write: (model: Model, insights: Insights.Model) =>
    modifyFields(model, {
      screens: screens => modifyFields(screens, { insights: () => insights }),
    }),
  toParentMessage: (message: Insights.Message) =>
    Message.GotInsightsMessage({ message }),
})

/** The Insights screen asks again for the scope's telemetry (§18.4, §21). */
export const opened = (model: Model): Return => {
  const stepped = Insights.opened(model.screens.insights, model.scope)
  return {
    model: modifyFields(model, {
      screens: screens =>
        modifyFields(screens, { insights: () => stepped.model }),
    }),
    commands: Command.mapMessages(stepped.commands, message =>
      Message.GotInsightsMessage({ message }),
    ),
  }
}

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  GotInsightsMessage: ({ message }) => foldInsights(model, message),
})

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    slotId: 'insights',
    view: Insights.view,
    model: model.screens.insights,
    viewInputs: {
      projectName: Option.flatMap(model.scope, project =>
        Sidebar.projectName(model.console.sidebar, project),
      ),
      today: model.today,
    },
    toParentMessage: message => Message.GotInsightsMessage({ message }),
  })
