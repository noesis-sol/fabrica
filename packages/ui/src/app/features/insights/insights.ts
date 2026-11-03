import { Option } from 'effect'
import { Command, Update } from 'foldkit'
import { type Html, type HtmlBuilder, createLazy } from 'foldkit/html'
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

const lazyInsights = createLazy()

const insightsPart = (
  insights: Insights.Model,
  scope: Model['scope'],
  sidebar: Sidebar.Model,
  today: Model['today'],
  h: HtmlBuilder<Message>,
): Html =>
  h.submodel({
    slotId: 'insights',
    view: Insights.view,
    model: insights,
    viewInputs: {
      projectName: Option.flatMap(scope, project =>
        Sidebar.projectName(sidebar, project),
      ),
      today,
    },
    toParentMessage: message => Message.GotInsightsMessage({ message }),
  })

/** The Insights screen, memoised on its own Model, the scope, the projects and the day (§18.5). */
export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  lazyInsights(insightsPart, [
    model.screens.insights,
    model.scope,
    model.console.sidebar,
    model.today,
    h,
  ])
