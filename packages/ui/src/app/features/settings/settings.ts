import { Option } from 'effect'
import { Command, Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import * as Sidebar from '../../../console/sidebar'
import * as Settings from '../../../screens/settings'
import type { Theme } from '../../../theme/theme'
import type { Handlers, Return } from '../../feature'
import { Message } from '../../message'
import type { Model } from '../../model'
import type { messages } from './message'

// The Settings screen (spec §18.4): the scoped project's settings and its engine's, and the theme.

const foldSettings = Update.foldChild({
  update: Settings.update,
  read: (model: Model) => Option.some(model.screens.settings),
  write: (model: Model, settings: Settings.Model) =>
    modifyFields(model, {
      screens: screens => modifyFields(screens, { settings: () => settings }),
    }),
  toParentMessage: (message: Settings.Message) =>
    Message.GotSettingsMessage({ message }),
})

/** The Settings screen asks again for the settings it shows: the scope's and its engine's (§18.4). */
export const opened = (model: Model): Return => {
  const stepped = Settings.opened(model.screens.settings, model.scope)
  return {
    model: modifyFields(model, {
      screens: screens =>
        modifyFields(screens, { settings: () => stepped.model }),
    }),
    commands: Command.mapMessages(stepped.commands, message =>
      Message.GotSettingsMessage({ message }),
    ),
  }
}

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  GotSettingsMessage: ({ message }) => foldSettings(model, message),
})

/** Chooses a theme: made once, as the palette's theme commands do too. */
const chooseTheme = (theme: Theme): Message => Message.ChoseTheme({ theme })

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  Settings.view(
    model.screens.settings,
    {
      projectName: Option.flatMap(model.scope, project =>
        Sidebar.projectName(model.console.sidebar, project),
      ),
      theme: model.theme,
      chooseTheme,
    },
    h,
  )
