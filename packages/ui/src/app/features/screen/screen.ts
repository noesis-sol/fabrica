import { Option, Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import type { TicketId } from '@fabrica/contracts'

import * as Engines from '../../../screens/engines'
import type { EngineProject } from '../../engine-project'
import { scopeEngine } from '../../engine-route'
import type { Handlers, Return } from '../../feature'
import { hints, openPalette } from '../../keys'
import { Message } from '../../message'
import { type Model, Overlay } from '../../model'
import { Screen, screenTitle } from '../../screen'
import * as BacklogFeature from '../backlog/backlog'
import * as EnginesFeature from '../engines/engines'
import * as InsightsFeature from '../insights/insights'
import { hintButton, isOverlayOpen, modelCommands } from '../keys/keys'
import * as ReviewFeature from '../review/review'
import * as SettingsFeature from '../settings/settings'
import * as WorkerFeature from '../worker/worker'
import type { messages } from './message'

// The screens (spec §18.3, §18.4): showing one, and what each asks as it opens, as the engine it shows
// is reached again or as the scope changes under it; and the header above any screen but the console.

const sameScreen = Schema.toEquivalence(Screen)

/** Shows `screen`, closing any overlay; the same screen again keeps the Model as it is. */
export const showScreen = (model: Model, screen: Screen): Model =>
  sameScreen(model.screen, screen) && !isOverlayOpen(model)
    ? model
    : modifyFields(model, {
        screen: () => screen,
        overlay: () => Overlay.Closed(),
        backlog: backlog =>
          Screen.guards.Backlog(screen) ? backlog : Option.none(),
      })

/**
 * Shows `screen`; a screen that wasn't shown already asks what it shows as it opens: the Engines
 * screen, its engines' status and credentials; the Settings screen, its settings; the Insights screen,
 * the scope's telemetry; the Review screen, the scope's report, log and diff (§18.4); the Backlog
 * screen starts afresh; a worker's view, its ticket.
 */
export const enterScreen = (model: Model, screen: Screen): Return => {
  const shown = showScreen(model, screen)
  const opens = model.screen._tag !== screen._tag
  return Screen.match<Return>(screen, {
    Backlog: () =>
      opens ? { model: BacklogFeature.opened(shown) } : { model: shown },
    Console: () => ({ model: shown }),
    Engines: () => (opens ? EnginesFeature.opened(shown) : { model: shown }),
    Insights: () => (opens ? InsightsFeature.opened(shown) : { model: shown }),
    Review: () => (opens ? ReviewFeature.opened(shown) : { model: shown }),
    Settings: () => (opens ? SettingsFeature.opened(shown) : { model: shown }),
    Talks: () => ({ model: shown }),
    Worker: ({ project, ticket }) =>
      shown !== model
        ? WorkerFeature.opened(shown, { project, ticket })
        : { model: shown },
  })
}

/** What the screen shown asks again of the engine just reached, or of the scope just chosen. */
export const reopenScreen = (model: Model): Return =>
  Screen.match<Return>(model.screen, {
    Backlog: () => ({ model }),
    Console: () => ({ model }),
    Engines: () => EnginesFeature.opened(model),
    Insights: () => InsightsFeature.opened(model),
    Review: () => ReviewFeature.opened(model),
    Settings: () => SettingsFeature.opened(model),
    Talks: () => ({ model }),
    Worker: ({ project, ticket }) =>
      WorkerFeature.opened(model, { project, ticket }),
  })

/**
 * What the screen shown asks of a scope just chosen: the Settings and Insights screens show the new
 * scope's settings and telemetry; the Review screen follows the scope to its project.
 */
export const rescopeScreen = (model: Model): Return =>
  Screen.match<Return>(model.screen, {
    Backlog: () => ({ model }),
    Console: () => ({ model }),
    Engines: () => ({ model }),
    Insights: () => InsightsFeature.opened(model),
    Review: () => ReviewFeature.opened(model),
    Settings: () => SettingsFeature.opened(model),
    Talks: () => ({ model }),
    Worker: () => ({ model }),
  })

/**
 * Opens the worker view of a ticket of a run in the scope, on its project: made once, so the In
 * progress column's memo holds across renders.
 */
export const openWorker = (project: EngineProject, ticket: TicketId): Message =>
  Message.RequestedWorker({ project, ticket })

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  RequestedScreen: ({ screen }) => enterScreen(model, screen),
  RequestedWorker: ({ project, ticket }) =>
    enterScreen(model, Screen.Worker({ project, ticket })),
  RequestedAddProject: () => {
    const entered = enterScreen(model, Screen.Engines())
    return {
      ...entered,
      model: modifyFields(entered.model, {
        screens: screens =>
          modifyFields(screens, {
            engines: engines =>
              Engines.openAddProject(engines, scopeEngine(model.scope)),
          }),
      }),
    }
  },
})

/** Above any screen but the console: its name and its hints, drawn from its command list. */
export const header = (model: Model, h: HtmlBuilder<Message>): Html =>
  Screen.guards.Console(model.screen)
    ? h.empty
    : h.div(
        [h.Class('flex items-center gap-16')],
        [
          h.h1(
            [h.Class('text-sm font-extrabold')],
            [screenTitle(model.screen)],
          ),
          h.div(
            [h.Class('ml-auto flex gap-12')],
            hints(modelCommands(model))
              .filter(command => command.id !== openPalette.id)
              .map(command => hintButton(command, model.platform, h)),
          ),
        ],
      )
