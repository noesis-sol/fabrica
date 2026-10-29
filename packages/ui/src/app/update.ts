import { Array, Duration, Effect, Option, Schema } from 'effect'
import { Command, Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import {
  type AttentionRef,
  type NoRun,
  ProjectId,
  RunId,
  type Ticket,
  type TicketId,
  type TicketRow,
} from '@fabrica/contracts'

import * as Attention from '../console/attention'
import * as History from '../console/history'
import * as Sidebar from '../console/sidebar'
import * as Stats from '../console/stats'
import * as TalkPanel from '../console/talk-panel'
import * as Backlog from '../screens/backlog'
import * as Engines from '../screens/engines'
import * as Insights from '../screens/insights'
import * as Palette from '../screens/palette'
import * as Review from '../screens/review'
import * as Settings from '../screens/settings'
import * as Talks from '../screens/talks'
import { themeTitle, themes } from '../theme/theme'
import { dayOf, sameDay } from './clock'
import {
  Connection,
  type EngineConnectionService,
  isLive,
  retryAfter,
} from './connection'
import { commandFor, commandsFor, keyLabel, paletteCommands } from './keys'
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
  | Engines.Requires
  | Settings.Requires
  | Insights.Requires
  | Review.Requires
  | EngineConnectionService
  | Notifier
  | ThemeHost
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

const writeTalkPanel = (model: Model, talkPanel: TalkPanel.Model): Model =>
  modifyFields(model, {
    console: parts => modifyFields(parts, { talkPanel: () => talkPanel }),
  })

/** The talk panel's own Model changed, and its Commands lifted, by `step`. */
const stepTalkPanel = (
  model: Model,
  step: (
    talkPanel: TalkPanel.Model,
  ) => Update.Return<
    TalkPanel.Model,
    TalkPanel.Message,
    EngineConnectionService
  >,
): Return => {
  const stepped = step(model.console.talkPanel)
  return {
    model: writeTalkPanel(model, stepped.model),
    commands: Command.mapMessages(stepped.commands, message =>
      Message.GotTalkPanelMessage({ message }),
    ),
  }
}

const writeTalks = (model: Model, talks: Talks.Model): Model =>
  modifyFields(model, {
    screens: screens => modifyFields(screens, { talks: () => talks }),
  })

/** The Talks screen's own Model changed, and its Commands lifted, by `step`. */
const stepTalks = (
  model: Model,
  step: (
    talks: Talks.Model,
  ) => Update.Return<Talks.Model, Talks.Message, EngineConnectionService>,
): Return => {
  const stepped = step(model.screens.talks)
  return {
    model: writeTalks(model, stepped.model),
    commands: Command.mapMessages(stepped.commands, message =>
      Message.GotTalksMessage({ message }),
    ),
  }
}

/** `first`, then `next` on its model, their commands together. */
const andThen = (first: Return, next: (model: Model) => Return): Return => {
  const second = next(first.model)
  return {
    model: second.model,
    commands: [...(first.commands ?? []), ...(second.commands ?? [])],
  }
}

/** The talk panel for the scope: its run talk, and an answer talk only for a project in scope. */
const scopeTalkPanel = (model: Model): Return =>
  stepTalkPanel(model, talkPanel => TalkPanel.scoped(talkPanel, model.scope))

/** The answer talk opened by the maintainer, on `project` or the first with questions. */
const requestAnswerTalk = (
  model: Model,
  project: Option.Option<ProjectId>,
): Return =>
  stepTalkPanel(model, talkPanel =>
    TalkPanel.requestedAnswerTalk(talkPanel, project),
  )

/** The attention column's Messages, folded into its submodel; a card's buttons open their screens. */
const foldAttention = Update.foldChild({
  update: Attention.update,
  read: (model: Model) => Option.some(model.console.attention),
  write: writeAttention,
  toParentMessage: toAttentionMessage,
  foldOutMessage: (outMessage: Attention.OutMessage) => (model: Model) =>
    Attention.OutMessage.match<Return>(outMessage, {
      // "Talk it through": the answer talk opened on the question's project, shown on the Talks screen.
      OpenedAnswerTalk: ({ project }) =>
        requestAnswerTalk(
          writeTalks(
            showScreen(model, Screen.Talks()),
            Talks.showConsoleTalk(model.screens.talks, 'answer'),
          ),
          Option.some(project),
        ),
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

/** The run controls the stats row offers now, for the scoped project. */
export const runOffers = (model: Model): ReadonlyArray<Stats.Offer> =>
  Stats.offers(model.console.stats, {
    project: model.scope,
    live: isLive(model.connection),
    run: model.runView,
  })

/** The command list of the screen shown, with its overlay's. */
export const modelCommands = (model: Model) =>
  commandsFor({
    screen: model.screen,
    overlayOpen: isOverlayOpen(model),
    paletteOpen: Overlay.guards.Palette(model.overlay),
    options: Attention.keyedOptions(model.console.attention),
    offers: runOffers(model),
  })

/** Opens a ticket's worker view: made once, so the In progress column's memo holds across renders. */
export const openWorker = (ticket: TicketId): Message =>
  Message.RequestedScreen({ screen: Screen.Worker({ ticket }) })

/**
 * The palette's entries (§18.5): the screen's own command list as it is with no overlay open, but the
 * palette's own command; then every project, the scoped run's tickets (and the Backlog's, while it
 * shows them) and its workers, each opening its worker view; then the themes.
 */
export const paletteEntries = (
  model: Model,
): ReadonlyArray<Palette.Entry<Message>> => {
  const commands = paletteCommands(
    commandsFor({
      screen: model.screen,
      overlayOpen: false,
      options: Attention.keyedOptions(model.console.attention),
      offers: runOffers(model),
    }),
  ).map((command): Palette.Entry<Message> => ({
    id: command.id,
    group: 'command',
    title: command.title,
    key: keyLabel(command, model.platform),
    run: command.message,
  }))
  const enginesKnown = model.console.sidebar.engines.length
  const projects: ReadonlyArray<Palette.Entry<Message>> = [
    {
      id: 'project.all',
      group: 'project',
      title: 'All projects',
      key: Option.none(),
      run: Message.SelectedScope({ project: Option.none() }),
    },
    ...Sidebar.rows(model.console.sidebar).map(
      (row): Palette.Entry<Message> => ({
        id: `project.${row.status.project}`,
        group: 'project',
        title:
          enginesKnown > 1
            ? `${row.status.name} · ${row.engine.name}`
            : row.status.name,
        key: Option.none(),
        run: Message.SelectedScope({
          project: Option.some(row.status.project),
        }),
      }),
    ),
  ]
  const runTickets: ReadonlyArray<TicketRow> = Option.match(model.runView, {
    onNone: () => [],
    onSome: run => run.tickets,
  })
  const known: ReadonlyArray<{
    readonly ticket: TicketId
    readonly title: string
  }> = [
    ...runTickets.map(row => ({ ticket: row.ticket, title: row.title })),
    ...Option.match(model.backlog, {
      onNone: () => [],
      onSome: backlog =>
        backlog.map(ticket => ({ ticket: ticket.id, title: ticket.title })),
    }),
  ]
  const tickets = Array.dedupeWith(
    known,
    (first, second) => first.ticket === second.ticket,
  ).map(({ ticket, title }): Palette.Entry<Message> => ({
    id: `ticket.${ticket}`,
    group: 'ticket',
    title: `${ticket} ${title}`,
    key: Option.none(),
    run: openWorker(ticket),
  }))
  const workers = Option.match(model.runView, {
    onNone: () => [],
    onSome: run => run.workers,
  }).map((worker): Palette.Entry<Message> => ({
    id: `worker.${worker.ticket}`,
    group: 'worker',
    title: Option.match(
      Array.findFirst(runTickets, row => row.ticket === worker.ticket),
      {
        onNone: () => `${worker.ticket} · ${worker.model}`,
        onSome: row => `${worker.ticket} ${row.title} · ${worker.model}`,
      },
    ),
    key: Option.none(),
    run: openWorker(worker.ticket),
  }))
  const themeEntries = themes.map((theme): Palette.Entry<Message> => ({
    id: `theme.${theme}`,
    group: 'theme',
    title: themeTitle(theme),
    key: Option.none(),
    run: Message.ChoseTheme({ theme }),
  }))
  return [...commands, ...projects, ...tickets, ...workers, ...themeEntries]
}

const writePalette = (model: Model, palette: Palette.Model): Model =>
  modifyFields(model, {
    screens: screens => modifyFields(screens, { palette: () => palette }),
  })

/**
 * Runs a palette entry where there is one, while the palette is open: it closes, then the entry's
 * Message is sent. An entry asked for once it has closed runs nothing.
 */
const runPaletteEntry = (
  model: Model,
  entry: Option.Option<Palette.Entry<Message>>,
): Return =>
  Option.match(
    Option.filter(entry, () => Overlay.guards.Palette(model.overlay)),
    {
      onNone: () => ({ model }),
      onSome: ({ run }) =>
        update(modifyFields(model, { overlay: () => Overlay.Closed() }), run),
    },
  )

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
const openInsights = (model: Model): Return => {
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
const openBacklog = (model: Model): Model =>
  modifyFields(model, {
    screens: screens => modifyFields(screens, { backlog: Backlog.opened }),
  })

/** The Backlog screen told of its project's tickets, and what it asks of them lifted. */
const tellBacklog = (
  model: Model,
  project: ProjectId,
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

/**
 * Shows `screen`; a screen that wasn't shown already asks what it shows as it opens: the Engines
 * screen, its engine's status and credentials; the Settings screen, its settings; the Insights screen,
 * the scope's telemetry; the Review screen, the scope's report, log and diff (§18.4); the Backlog
 * screen starts afresh.
 */
const enterScreen = (model: Model, screen: Screen): Return => {
  const shown = showScreen(model, screen)
  return Screen.guards.Engines(screen) && !Screen.guards.Engines(model.screen)
    ? stepEngines(shown, Engines.opened)
    : Screen.guards.Settings(screen) && !Screen.guards.Settings(model.screen)
      ? openSettings(shown)
      : Screen.guards.Insights(screen) && !Screen.guards.Insights(model.screen)
        ? openInsights(shown)
        : Screen.guards.Review(screen) && !Screen.guards.Review(model.screen)
          ? reviewScope(shown)
          : Screen.guards.Backlog(screen) &&
              !Screen.guards.Backlog(model.screen)
            ? { model: openBacklog(shown) }
            : { model: shown }
}

/** What the screen shown asks again of the engine just reached, or of the scope just chosen. */
const reopenScreen = (model: Model): Return =>
  Screen.guards.Engines(model.screen)
    ? stepEngines(model, Engines.opened)
    : Screen.guards.Settings(model.screen)
      ? openSettings(model)
      : Screen.guards.Insights(model.screen)
        ? openInsights(model)
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
      model: writePalette(
        modifyFields(model, { overlay: () => Overlay.Palette() }),
        Palette.init(),
      ),
    }),
    GotPaletteMessage: ({ message }) => ({
      model: writePalette(
        model,
        Palette.update(model.screens.palette, message),
      ),
    }),
    MovedPaletteSelection: ({ by }) => {
      const entries = paletteEntries(model)
      const palette = Palette.moved(
        model.screens.palette,
        by,
        Palette.matching(entries, model.screens.palette.query).length,
      )
      // The list scrolls to keep the selection in view.
      return {
        model: writePalette(model, palette),
        commands: Option.match(Palette.selected(palette, entries), {
          onNone: () => [],
          onSome: ({ id }) => [
            Command.mapMessage(Palette.ScrollToEntry({ id }), message =>
              Message.GotPaletteMessage({ message }),
            ),
          ],
        }),
      }
    },
    RanPaletteSelection: () =>
      runPaletteEntry(
        model,
        Palette.selected(model.screens.palette, paletteEntries(model)),
      ),
    RanPaletteEntry: ({ id }) =>
      runPaletteEntry(
        model,
        Array.findFirst(paletteEntries(model), entry => entry.id === id),
      ),
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
        modifyFields(openBacklog(model), {
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
      // The Settings and Insights screens show the new scope's settings and telemetry; the Review screen
      // follows the scope to its project.
      const reopened = Screen.guards.Settings(scoped.model.screen)
        ? Option.some(openSettings(scoped.model))
        : Screen.guards.Insights(scoped.model.screen)
          ? Option.some(openInsights(scoped.model))
          : Screen.guards.Review(scoped.model.screen)
            ? Option.some(reviewScope(scoped.model))
            : Option.none()
      return andThen(
        Option.match(reopened, {
          onNone: () => scoped,
          onSome: again => ({
            model: again.model,
            commands: [...(scoped.commands ?? []), ...(again.commands ?? [])],
          }),
        }),
        scopeTalkPanel,
      )
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
    GotEnginesMessage: ({ message }) => {
      const folded = foldEngines(model, message)
      // This machine's engine updated: a connection it refused is tried again.
      return Engines.reconnectsAfter(message) &&
        Connection.guards.Refused(folded.model.connection)
        ? {
            ...folded,
            model: modifyFields(folded.model, {
              attempt: attempt => attempt + 1,
              connection: () => Connection.Connecting(),
            }),
          }
        : folded
    },
    GotSettingsMessage: ({ message }) => foldSettings(model, message),
    GotInsightsMessage: ({ message }) => foldInsights(model, message),
    ChoseTheme: ({ theme }) => ({
      model: modifyFields(model, { theme: () => Option.some(theme) }),
      commands: [ShowTheme({ theme })],
    }),
    CompletedShowTheme: () => ({ model }),
    GotReviewMessage: ({ message }) => foldReview(model, message),
    PressedReviewTab: ({ tab }) => ({
      model: writeReview(model, Review.selectTab(model.screens.review, tab)),
    }),
    GotBacklogMessage: ({ message }) => foldBacklog(model, message),

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
        modifyFields(openBacklog(model), {
          runView: () => Option.none(),
          events: () => [],
          attention: () => Option.none(),
          backlog: () => Option.none(),
          load: () => Option.none(),
          usage: () => Option.none(),
          console: parts =>
            modifyFields(parts, {
              sidebar: () => Sidebar.init(),
              talkPanel: () => TalkPanel.init(),
            }),
          screens: screens => modifyFields(screens, { talks: Talks.init }),
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
    // The connection is acquired again over the new port; one refused waits for an update still.
    ReplacedEnginePort: () => ({
      model: Connection.guards.Refused(model.connection)
        ? model
        : modifyFields(model, {
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
      return andThen(foldRequests(received, received.attention), requested =>
        Option.match(requested.attention, {
          onNone: () => ({ model: requested }),
          onSome: requests =>
            stepTalkPanel(requested, talkPanel =>
              TalkPanel.receivedQuestions(
                talkPanel,
                TalkPanel.openQuestions(requests),
              ),
            ),
        }),
      )
    },
    ReceivedBacklog: ({ project, items }) => {
      if (!Option.contains(model.scope, project)) return { model }
      const received = modifyFields(model, {
        backlog: backlog => applyBacklog(backlog, items),
      })
      return tellBacklog(received, project, received.backlog)
    },
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
    GotTalkPanelMessage: ({ message }) =>
      stepTalkPanel(model, talkPanel =>
        TalkPanel.update(talkPanel, message, {
          scope: model.scope,
          projects: TalkPanel.projectNames(model.console.sidebar),
        }),
      ),
    GotTalksMessage: ({ message }) =>
      stepTalks(model, talks => Talks.update(talks, message)),
    RequestedAnswerTalk: () => requestAnswerTalk(model, Option.none()),
    ReceivedTranscript: ({ talk, items }) => ({
      model: writeTalks(
        writeTalkPanel(
          model,
          TalkPanel.receivedTranscript(model.console.talkPanel, talk, items),
        ),
        Talks.receivedTranscript(model.screens.talks, talk, items),
      ),
    }),
    EndedTranscript: ({ talk }) => ({
      model: writeTalks(
        writeTalkPanel(
          model,
          TalkPanel.endedTranscript(model.console.talkPanel, talk),
        ),
        Talks.endedTranscript(model.screens.talks, talk),
      ),
    }),

    CompletedShowNotification: () => ({ model }),
    ClickedNotification: ({ target }) =>
      Notify.NotificationTarget.match(target, {
        Request: ({ ref }) =>
          focusOn(model, { project: ref.project, request: Option.some(ref) }),
        Project: ({ project }) =>
          focusOn(model, { project, request: Option.none() }),
      }),
  })
