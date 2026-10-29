import { Duration, Effect, Option, Schema } from 'effect'
import { Command, Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import {
  type AttentionRef,
  type NoRun,
  ProjectId,
  RunId,
} from '@fabrica/contracts'

import * as Attention from '../console/attention'
import * as History from '../console/history'
import * as Sidebar from '../console/sidebar'
import * as Stats from '../console/stats'
import * as Engines from '../screens/engines'
import * as Review from '../screens/review'
import * as Settings from '../screens/settings'
import { dayOf, sameDay } from './clock'
import { Connection, retryAfter } from './connection'
import { commandFor, commandsFor } from './keys'
import { Message } from './message'
import { type Model, Overlay } from './model'
import { type Notifier, ShowNotification } from './notifier'
import * as Notify from './notify'
import { Screen } from './screen'
import {
  applyAttention,
  applyBacklog,
  applyLoad,
  applyProjectEvents,
  applyRunView,
} from './streams'
import { ShowTheme, type ThemeHost } from './theme-host'

// The root's update (spec §18.1): routing, the keys through the screen's command list, the
// connection's lifecycle, each stream's items applied to the part of the Model they change, and the
// app's notifications: those to show, and a click on one focusing its target (§18.5).

/** Waits before the next connection attempt. */
export const WaitToReconnect = Command.define('WaitToReconnect', {
  messages: [Message.WaitedToReconnect],
  execute: Effect.as(Effect.sleep(retryAfter), Message.WaitedToReconnect()),
})

/**
 * How long a run view watch that ended NoRun waits before watching again, while the project's row shows
 * a run going: the row can show a run before the engine has its view.
 */
export const rewatchAfter = Duration.seconds(1)

/** Waits before watching the project's run view again, for the run its row showed going. */
export const WaitToRewatchRunView = Command.define('WaitToRewatchRunView', {
  args: { project: ProjectId, run: RunId },
  messages: [Message.WaitedToRewatchRunView],
  execute: ({ project, run }) =>
    Effect.as(
      Effect.sleep(rewatchAfter),
      Message.WaitedToRewatchRunView({ project, run }),
    ),
})

type Return = Update.Return<
  Model,
  Message,
  Engines.Requires | Settings.Requires | Review.Requires | Notifier | ThemeHost
>

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

const writeAttention = (model: Model, attention: Attention.Model): Model =>
  modifyFields(model, {
    console: parts => modifyFields(parts, { attention: () => attention }),
  })

const toAttentionMessage = (message: Attention.Message): Message =>
  Message.GotAttentionMessage({ message })

const writeReview = (model: Model, review: Review.Model): Model =>
  modifyFields(model, {
    screens: screens => modifyFields(screens, { review: () => review }),
  })

const foldReview = Update.foldChild({
  update: Review.update,
  read: (model: Model) => Option.some(model.screens.review),
  write: writeReview,
  toParentMessage: (message: Review.Message) =>
    Message.GotReviewMessage({ message }),
})

/** The Review screen's own Model changed, and its Commands lifted, by `step`. */
const stepReview = (
  model: Model,
  step: (
    review: Review.Model,
  ) => Update.Return<Review.Model, Review.Message, Review.Requires>,
): Return => {
  const stepped = step(model.screens.review)
  return {
    model: writeReview(model, stepped.model),
    commands: Command.mapMessages(stepped.commands, message =>
      Message.GotReviewMessage({ message }),
    ),
  }
}

/** What the Review screen shows as it opens, or as the scope changes under it: the scope's project and its run going. */
const reviewScope = (model: Model): Return =>
  stepReview(model, review =>
    Review.opened(review, {
      project: model.scope,
      run: Option.map(model.runView, view => view.header.run),
    }),
  )

/** The attention column's Messages, folded into its submodel; a card's buttons open their screens. */
const foldAttention = Update.foldChild({
  update: Attention.update,
  read: (model: Model) => Option.some(model.console.attention),
  write: writeAttention,
  toParentMessage: toAttentionMessage,
  foldOutMessage: (outMessage: Attention.OutMessage) => (model: Model) =>
    Attention.OutMessage.match<Return>(outMessage, {
      OpenedAnswerTalk: () => ({ model: showScreen(model, Screen.Talks()) }),
      // A set-aside ticket's Review opens its branch diff (§18.3).
      OpenedReview: ({ project, ticket }) =>
        stepReview(showScreen(model, Screen.Review()), review =>
          Review.openTicket(review, { project, ticket }),
        ),
      OpenedSession: ({ ticket }) => ({
        model: showScreen(model, Screen.Worker({ ticket })),
      }),
    }),
})

/** The attention column kept in step with the Model's requests, after they change. */
const foldRequests = Update.foldChild({
  update: Attention.receivedRequests,
  read: (model: Model) => Option.some(model.console.attention),
  write: writeAttention,
  toParentMessage: toAttentionMessage,
})

/** A key 1–9, applied by the attention column to the request it names. */
const foldAnswerKey = Update.foldChild({
  update: Attention.pressedOptionKey,
  read: (model: Model) => Option.some(model.console.attention),
  write: writeAttention,
  toParentMessage: toAttentionMessage,
})

/** Whether the Model's overlay is open. */
export const isOverlayOpen = (model: Model): boolean =>
  !Overlay.guards.Closed(model.overlay)

/** The command list of the screen shown, with its overlay's. */
export const modelCommands = (model: Model) =>
  commandsFor({
    screen: model.screen,
    overlayOpen: isOverlayOpen(model),
    options: Attention.keyedOptions(model.console.attention),
  })

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

/** A project's name as the sidebar's rows have it; its ID while they don't. */
const projectName =
  (model: Model): Notify.ProjectName =>
  project =>
    Option.getOrElse(
      Sidebar.projectName(model.console.sidebar, project),
      () => project,
    )

/** `told`'s model as the Model's, and its notifications shown. */
const tell = (model: Model, told: Notify.Told): Return => ({
  model: modifyFields(model, { notify: () => told.model }),
  commands: told.notifications.map(notification =>
    ShowNotification({ notification }),
  ),
})

/**
 * The console, focused on a clicked notification's `project` and `request`: the scope stays where it
 * already shows the project (every project, or that one), and moves to the project otherwise.
 */
const focusOn = (
  model: Model,
  {
    project,
    request,
  }: {
    readonly project: ProjectId
    readonly request: Option.Option<AttentionRef>
  },
): Return => {
  const scoped = Option.match(model.scope, {
    onNone: () => model,
    onSome: scope =>
      scope === project
        ? model
        : update(
            model,
            Message.SelectedScope({ project: Option.some(project) }),
          ).model,
  })
  return {
    model: modifyFields(showScreen(scoped, Screen.Console()), {
      focusedRequest: () => request,
    }),
  }
}

const foldEngines = Update.foldChild({
  update: Engines.update,
  read: (model: Model) => Option.some(model.screens.engines),
  write: (model: Model, engines: Engines.Model) =>
    modifyFields(model, {
      screens: screens => modifyFields(screens, { engines: () => engines }),
    }),
  toParentMessage: (message: Engines.Message) =>
    Message.GotEnginesMessage({ message }),
})

/** The Engines screen's own Model changed, and its Commands lifted, by `step`. */
const stepEngines = (
  model: Model,
  step: (
    engines: Engines.Model,
  ) => Update.Return<Engines.Model, Engines.Message, Engines.Requires>,
): Return => {
  const stepped = step(model.screens.engines)
  return {
    model: modifyFields(model, {
      screens: screens =>
        modifyFields(screens, { engines: () => stepped.model }),
    }),
    commands: Command.mapMessages(stepped.commands, message =>
      Message.GotEnginesMessage({ message }),
    ),
  }
}

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

/** The Settings screen asks again for the settings it shows: the engine's and the scope's (§18.4). */
const openSettings = (model: Model): Return => {
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

/**
 * Shows `screen`; a screen that wasn't shown already asks what it shows as it opens: the Engines
 * screen, its engine's status and credentials; the Settings screen, its settings; the Review screen,
 * the scope's report, log and diff (§18.4).
 */
const enterScreen = (model: Model, screen: Screen): Return => {
  const shown = showScreen(model, screen)
  return Screen.guards.Engines(screen) && !Screen.guards.Engines(model.screen)
    ? stepEngines(shown, Engines.opened)
    : Screen.guards.Settings(screen) && !Screen.guards.Settings(model.screen)
      ? openSettings(shown)
      : Screen.guards.Review(screen) && !Screen.guards.Review(model.screen)
        ? reviewScope(shown)
        : { model: shown }
}

/** What the screen shown asks again of the engine just reached, or of the scope just chosen. */
const reopenScreen = (model: Model): Return =>
  Screen.guards.Engines(model.screen)
    ? stepEngines(model, Engines.opened)
    : Screen.guards.Settings(model.screen)
      ? openSettings(model)
      : Screen.guards.Review(model.screen)
        ? reviewScope(model)
        : { model }

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    PressedKey: pressed =>
      Option.match(commandFor(modelCommands(model), pressed), {
        onNone: () => ({ model }),
        onSome: command => update(model, command.message),
      }),
    RequestedScreen: ({ screen }) => enterScreen(model, screen),
    RequestedPalette: () => ({
      model: modifyFields(model, { overlay: () => Overlay.Palette() }),
    }),
    RequestedKeyHelp: () => ({
      model: modifyFields(model, { overlay: () => Overlay.KeyHelp() }),
    }),
    DismissedOverlay: () => ({
      model: modifyFields(model, { overlay: () => Overlay.Closed() }),
    }),
    SelectedScope: ({ project }) => {
      if (sameScope(model.scope, project)) {
        return { model }
      }
      const scoped = foldRequests(
        modifyFields(model, {
          scope: () => project,
          runView: () => Option.none(),
          events: () => [],
          attention: () => Option.none(),
          focusedRequest: () => Option.none(),
          backlog: () => Option.none(),
          usage: () => Option.none(),
        }),
        Option.none(),
      )
      // The Settings screen shows the new scope's settings; the Review screen follows the scope to its
      // project.
      const reopened = Screen.guards.Settings(scoped.model.screen)
        ? Option.some(openSettings(scoped.model))
        : Screen.guards.Review(scoped.model.screen)
          ? Option.some(reviewScope(scoped.model))
          : Option.none()
      return Option.match(reopened, {
        onNone: () => scoped,
        onSome: again => ({
          model: again.model,
          commands: [...(scoped.commands ?? []), ...(again.commands ?? [])],
        }),
      })
    },
    RequestedAddProject: () => {
      const entered = enterScreen(model, Screen.Engines())
      return {
        ...entered,
        model: modifyFields(entered.model, {
          screens: screens =>
            modifyFields(screens, {
              engines: Engines.openAddProject,
            }),
        }),
      }
    },
    GotHistoryMessage: ({ message }) => foldHistory(model, message),
    GotEnginesMessage: ({ message }) => foldEngines(model, message),
    GotSettingsMessage: ({ message }) => foldSettings(model, message),
    ChoseTheme: ({ theme }) => ({
      model: modifyFields(model, { theme: () => Option.some(theme) }),
      commands: [ShowTheme({ theme })],
    }),
    CompletedShowTheme: () => ({ model }),
    GotReviewMessage: ({ message }) => foldReview(model, message),
    PressedReviewTab: ({ tab }) => ({
      model: writeReview(model, Review.selectTab(model.screens.review, tab)),
    }),

    ConnectedToEngine: ({ engine, release, protocol }) => {
      const connected = modifyFields(model, {
        connection: () => Connection.Up({ engine, release, protocol }),
      })
      // The screen shown asks again what it shows of the engine just reached.
      return reopenScreen(connected)
    },
    LostEngine: () => ({
      model: modifyFields(model, { connection: () => Connection.Down() }),
    }),
    ReleasedEngine: () =>
      foldRequests(
        modifyFields(model, {
          runView: () => Option.none(),
          events: () => [],
          attention: () => Option.none(),
          backlog: () => Option.none(),
          load: () => Option.none(),
          usage: () => Option.none(),
          console: parts =>
            modifyFields(parts, { sidebar: () => Sidebar.init() }),
        }),
        Option.none(),
      ),
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
    EndedRunView: ({ project, reason }) => {
      if (!Option.contains(model.scope, project)) {
        return { model }
      }
      const ended = modifyFields(model, { runView: () => Option.none() })
      const going =
        reason === ('NoRun' satisfies NoRun['_tag'])
          ? Sidebar.goingRun(model.console.sidebar, project)
          : Option.none()
      return Option.match(going, {
        onNone: () => ({ model: ended }),
        onSome: run => ({
          model: ended,
          commands: [WaitToRewatchRunView({ project, run })],
        }),
      })
    },
    WaitedToRewatchRunView: ({ project, run }) => ({
      model:
        Option.contains(model.scope, project) &&
        Option.contains(
          Sidebar.goingRun(model.console.sidebar, project),
          run,
        ) &&
        Option.isNone(model.runView)
          ? modifyFields(model, { runWatch: watch => watch + 1 })
          : model,
    }),
    ReceivedEvents: ({ project, items }) =>
      Option.isNone(model.scope) || Option.contains(model.scope, project)
        ? {
            model: modifyFields(model, {
              events: events => applyProjectEvents(events, project, items),
            }),
          }
        : { model },
    ReceivedAttention: ({ items }) => {
      const received = modifyFields(model, {
        attention: attention => applyAttention(attention, items),
      })
      return foldRequests(received, received.attention)
    },
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
    ReceivedProjects: ({ engine, name, items }) => {
      const sidebar = Sidebar.receivedProjects(model.console.sidebar, {
        engine,
        name,
        items,
      })
      return {
        model: modifyFields(model, {
          console: parts => modifyFields(parts, { sidebar: () => sidebar }),
          notify: notify =>
            Notify.receivedRuns(
              notify,
              Notify.liveRuns(Sidebar.rows(sidebar).map(row => row.status)),
            ),
        }),
      }
    },

    ReceivedAttentionToNotify: ({ items }) =>
      tell(
        model,
        Notify.receivedAttention(model.notify, items, projectName(model)),
      ),
    ReceivedRunEvents: ({ project, run, items }) =>
      tell(
        model,
        Notify.receivedRunEvents(
          model.notify,
          { project, run, items },
          projectName(model),
        ),
      ),
    EndedRunEvents: ({ project, run }) => ({
      model: modifyFields(model, {
        notify: notify => Notify.endedRunEvents(notify, { project, run }),
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
    GotAttentionMessage: ({ message }) => foldAttention(model, message),
    PressedAnswerKey: ({ key, place }) => foldAnswerKey(model, { key, place }),

    CompletedShowNotification: () => ({ model }),
    ClickedNotification: ({ target }) =>
      Notify.NotificationTarget.match(target, {
        Request: ({ ref }) =>
          focusOn(model, { project: ref.project, request: Option.some(ref) }),
        Project: ({ project }) =>
          focusOn(model, { project, request: Option.none() }),
      }),
  })
