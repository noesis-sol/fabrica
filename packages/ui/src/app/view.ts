import { Option } from 'effect'
import {
  type Document,
  type Html,
  type HtmlBuilder,
  createLazy,
} from 'foldkit/html'

import {
  type AttentionRequest,
  MergeQueue,
  type Platform,
  type ProjectId,
  type TicketRow,
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
import type { Theme } from '../theme/theme'
import { Connection, isLive } from './connection'
import { dialog } from './dialog'
import {
  type KeyCommand,
  hints,
  keyHelp,
  keyLabel,
  openPalette,
  paletteOverlayKeys,
} from './keys'
import { Message } from './message'
import { type Model, Overlay } from './model'
import { Screen, screenTitle } from './screen'
import * as SshPrompts from './ssh-prompts'
import { modelCommands, openWorker, paletteEntries } from './update'

// The app's frame (spec §18.3, Appendix A.1), at the handoff's 1280 × 800 reference window: a 38px
// title bar over a grid of the 260px sidebar and the main column (padded 20 × 24 px, its parts 16px
// apart). On the console the main column holds the stats row, the run talk beside the 320px History
// in a row 156px high, and the two ticket columns, which take the remaining height and scroll each on
// its own. Each part is its submodel's view, memoised on its own slice of the Model, so a change
// elsewhere doesn't redraw it (§18.5). The key help and the palette are drawn from the screen's
// command list (keys.ts).

/** The handoff's measurements (Appendix A.1, A.2). */
export const layout = {
  titleBarHeight: '38px',
  sidebarWidth: '260px',
  mainPadding: '20px 24px',
  talkRowHeight: '156px',
  historyWidth: '320px',
}

const lazySidebar = createLazy()

/** The sidebar's Messages, made once, so its memo holds across renders. */
const sidebarMessages: Sidebar.Messages<Message> = {
  select: project => Message.SelectedScope({ project }),
  addProject: Message.RequestedAddProject(),
}

const sidebarView = (
  sidebar: Sidebar.Model,
  scope: Option.Option<ProjectId>,
  h: HtmlBuilder<Message>,
): Html => Sidebar.view(sidebar, { scope, messages: sidebarMessages }, h)
const lazyStats = createLazy()

/** The stats row, a Submodel: given the scope, the connection, the scoped run, the time and the requests. */
const statsPart = (
  stats: Stats.Model,
  inputs: Stats.ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.submodel({
    slotId: 'stats',
    model: stats,
    view: Stats.view,
    viewInputs: inputs,
    toParentMessage: message => Message.GotStatsMessage({ message }),
  })

const lazyStatsPart = (
  stats: Stats.Model,
  project: Model['scope'],
  live: boolean,
  run: Model['runView'],
  now: Model['now'],
  attention: Model['attention'],
  h: HtmlBuilder<Message>,
): Html => statsPart(stats, { project, live, run, now, attention }, h)
const lazyTalkPanel = createLazy()

/** The talk panel, a Submodel: given the scope, the connection and the projects by name. */
const talkPanelPart = (
  talkPanel: TalkPanel.Model,
  scope: Model['scope'],
  live: boolean,
  sidebar: Sidebar.Model,
  h: HtmlBuilder<Message>,
): Html =>
  h.submodel({
    slotId: 'talk-panel',
    model: talkPanel,
    view: TalkPanel.view,
    viewInputs: { scope, live, projects: TalkPanel.projectNames(sidebar) },
    toParentMessage: message => Message.GotTalkPanelMessage({ message }),
  })

const lazyHistory = createLazy()
const lazyInProgress = createLazy()

/** The In progress column's slices of the scoped run, the same values while no run is shown. */
const noRun: InProgress.Slices = {
  tickets: [],
  workers: [],
  queue: new MergeQueue({
    merging: Option.none(),
    train: Option.none(),
    waiting: [],
  }),
  steps: [],
}

/** The In progress column, from the scoped run's tickets, workers, queue and steps, in its project's colour. */
const inProgressView = (
  inProgress: InProgress.Model,
  tickets: InProgress.Slices['tickets'],
  workers: InProgress.Slices['workers'],
  queue: InProgress.Slices['queue'],
  steps: InProgress.Slices['steps'],
  role: Sidebar.Role,
  now: Model['now'],
  h: HtmlBuilder<Message>,
): Html =>
  InProgress.view(
    inProgress,
    { tickets, workers, queue, steps, now, role, open: openWorker },
    h,
  )

/** The scoped run's project's colour, its sidebar chip's; `c1`, running, until the sidebar knows it. */
const runRole = (model: Model): Sidebar.Role =>
  Option.match(
    Option.flatMap(model.runView, run =>
      Sidebar.projectChip(model.console.sidebar, run.header.project),
    ),
    { onNone: () => 'c1', onSome: chip => chip.role },
  )
const lazyAttention = createLazy()

/**
 * The attention column, a Submodel: given the scope's requests, the time, the connection and, under All
 * projects, each card's project's chip (§18.3).
 */
const attentionPart = (
  attention: Attention.Model,
  requests: Model['attention'],
  now: Model['now'],
  live: boolean,
  scope: Model['scope'],
  sidebar: Sidebar.Model,
  h: HtmlBuilder<Message>,
): Html =>
  h.submodel({
    slotId: 'attention',
    model: attention,
    view: Attention.view,
    viewInputs: {
      requests,
      now,
      live,
      chip: project =>
        Option.isNone(scope)
          ? Sidebar.projectChip(sidebar, project)
          : Option.none(),
    },
    toParentMessage: message => Message.GotAttentionMessage({ message }),
  })
const lazyUpNext = createLazy()

const noRequests: ReadonlyArray<AttentionRequest> = []

/** Up next, memoised on the run view's ticket rows and attention requests, each the same value while unchanged. */
const upNextView = (
  upNext: UpNext.Model,
  tickets: ReadonlyArray<TicketRow>,
  attention: ReadonlyArray<AttentionRequest>,
  h: HtmlBuilder<Message>,
): Html => UpNext.view(upNext, { tickets, attention }, h)

const panel =
  'flex flex-col overflow-hidden rounded-card border border-line bg-panel'
const column = 'flex min-h-0 flex-col gap-8 overflow-auto'

/** Whether the attention column has something to show: otherwise Up next takes its place (§18.3). */
const needsYou = (model: Model): boolean =>
  Option.exists(model.attention, requests => requests.length > 0)

const toHistoryMessage = (message: History.Message): Message =>
  Message.GotHistoryMessage({ message })

/** History, given the scope's events: under All projects each row carries its project's chip (§18.3). */
const historyView = (
  history: History.Model,
  events: Model['events'],
  scope: Model['scope'],
  sidebar: Sidebar.Model,
  today: Model['today'],
  h: HtmlBuilder<Message>,
): Html =>
  History.view(
    history,
    {
      events: events.map(({ project, events }) => ({
        project,
        events,
        chip: Option.isNone(scope)
          ? Sidebar.projectChip(sidebar, project)
          : Option.none(),
      })),
      today,
      toParentMessage: toHistoryMessage,
    },
    h,
  )

const consoleView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const parts = model.console
  const run = Option.getOrElse(model.runView, () => noRun)
  return h.div(
    [h.Class('flex min-h-0 flex-1 flex-col gap-16')],
    [
      h.section(
        [h.AriaLabel('Ticket stats')],
        [
          lazyStats(lazyStatsPart, [
            parts.stats,
            model.scope,
            isLive(model.connection),
            model.runView,
            model.now,
            model.attention,
            h,
          ]),
        ],
      ),
      h.div(
        [
          h.DataAttribute('layout', 'talk-row'),
          h.Class('grid gap-16'),
          h.Style({
            gridTemplateColumns: `minmax(0,1fr) ${layout.historyWidth}`,
            height: layout.talkRowHeight,
          }),
        ],
        [
          h.section(
            [h.AriaLabel('Run talk'), h.Class(panel)],
            [
              lazyTalkPanel(talkPanelPart, [
                parts.talkPanel,
                model.scope,
                isLive(model.connection),
                parts.sidebar,
                h,
              ]),
            ],
          ),
          h.section(
            [h.AriaLabel('History'), h.Class(panel)],
            [
              lazyHistory(historyView, [
                parts.history,
                model.events,
                model.scope,
                parts.sidebar,
                model.today,
                h,
              ]),
            ],
          ),
        ],
      ),
      h.div(
        [
          h.DataAttribute('layout', 'ticket-columns'),
          h.Class('grid min-h-0 flex-1 gap-16'),
          h.Style({ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }),
        ],
        [
          h.section(
            [h.AriaLabel('In progress'), h.Class(column)],
            [
              lazyInProgress(inProgressView, [
                parts.inProgress,
                run.tickets,
                run.workers,
                run.queue,
                run.steps,
                runRole(model),
                model.now,
                h,
              ]),
            ],
          ),
          needsYou(model)
            ? h.section(
                [h.AriaLabel('Needs your attention'), h.Class(column)],
                [
                  lazyAttention(attentionPart, [
                    parts.attention,
                    model.attention,
                    model.now,
                    isLive(model.connection),
                    model.scope,
                    parts.sidebar,
                    h,
                  ]),
                ],
              )
            : h.section(
                [h.AriaLabel('Up next'), h.Class(column)],
                [
                  lazyUpNext(upNextView, [
                    parts.upNext,
                    run.tickets,
                    Option.match(model.runView, {
                      onNone: () => noRequests,
                      onSome: runView => runView.attention,
                    }),
                    h,
                  ]),
                ],
              ),
        ],
      ),
    ],
  )
}

/** Whether the scoped run holds on a usage limit: its banner then takes the usage windows' place (§18.3). */
const usageHeld = (model: Model): boolean =>
  Option.exists(model.runView, runView =>
    runView.holds.some(hold => hold.kind === 'USAGE_LIMIT'),
  )

const keyCap = (label: string, h: HtmlBuilder<Message>): Html =>
  h.kbd(
    [h.Class('rounded-button border border-line px-4 font-mono text-xs')],
    [label],
  )

/** A hint: the command's control with its key beside it. */
const hintButton = (
  command: KeyCommand,
  platform: Platform,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('button')(
    command.id,
    [
      h.Type('button'),
      h.OnClick(command.message),
      h.Class('flex items-center gap-6 text-xs text-muted'),
      ...Option.match(keyLabel(command, platform), {
        onNone: () => [],
        onSome: label => [h.AriaKeyshortcuts(label)],
      }),
    ],
    [
      command.title,
      ...Option.match(keyLabel(command, platform), {
        onNone: () => [],
        onSome: label => [keyCap(label, h)],
      }),
    ],
  )

/** Chooses a theme: made once, as the palette's theme commands do too. */
const chooseTheme = (theme: Theme): Message => Message.ChoseTheme({ theme })

const screenView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Screen.match(model.screen, {
    Console: () => consoleView(model, h),
    Worker: ({ ticket }) => Worker.view(model.screens.worker, ticket, h),
    Talks: () =>
      h.submodel({
        slotId: 'talks',
        view: Talks.view,
        model: model.screens.talks,
        viewInputs: {
          scope: model.scope,
          live: isLive(model.connection),
          run: TalkPanel.runTalk(model.console.talkPanel),
          answer: TalkPanel.answerTalk(model.console.talkPanel),
          projectName: project =>
            Option.getOrElse(
              Sidebar.projectName(model.console.sidebar, project),
              () => project,
            ),
        },
        toParentMessage: message => Message.GotTalksMessage({ message }),
      }),
    Backlog: () =>
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
      }),
    Review: () =>
      h.submodel({
        slotId: 'review',
        view: Review.view,
        model: model.screens.review,
        toParentMessage: message => Message.GotReviewMessage({ message }),
      }),
    Insights: () =>
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
      }),
    Engines: () =>
      h.submodel({
        slotId: 'engines',
        view: Engines.view,
        model: model.screens.engines,
        viewInputs: {
          connection: model.connection,
          engines: model.console.sidebar.engines,
          platform: model.platform,
        },
        toParentMessage: message => Message.GotEnginesMessage({ message }),
      }),
    Settings: () =>
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
      ),
  })

/** Above any screen but the console: its name and its hints, drawn from its command list. */
const screenHeader = (model: Model, h: HtmlBuilder<Message>): Html =>
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

/** The connection's state, said while it isn't up. */
const connectionNotice = (model: Model): Option.Option<string> =>
  Connection.match(model.connection, {
    Connecting: () => Option.some('Connecting to the engine…'),
    Up: () => Option.none(),
    Down: () => Option.some('Lost the engine; reconnecting…'),
    Failed: ({ reason }) =>
      Option.some(`Couldn't reach the engine (${reason}); trying again.`),
    Stopped: ({ reason }) =>
      Option.some(`Couldn't reach the engine: ${reason}.`),
    Refused: ({ update }) =>
      Option.some(
        update === 'client'
          ? 'This app is too old for the engine: update the app.'
          : 'The engine is too old for this app: update the engine.',
      ),
  })

/** The connection's notice; one stopped offers to try again. */
const noticeView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(connectionNotice(model), {
    onNone: () => h.empty,
    onSome: text =>
      h.p(
        [
          h.Role('status'),
          h.Class('rounded-card border border-line px-12 py-6 text-xs'),
        ],
        [
          text,
          ...(Connection.guards.Stopped(model.connection)
            ? [
                ' ',
                h.button(
                  [
                    h.Type('button'),
                    h.OnClick(Message.RequestedReconnect()),
                    h.Class(
                      'rounded-button border border-line px-8 py-2 text-xs text-fg',
                    ),
                  ],
                  ['Try again'],
                ),
              ]
            : []),
        ],
      ),
  })

const keyHelpView = (model: Model, h: HtmlBuilder<Message>): Html =>
  dialog(
    'Keys',
    [
      h.h2([h.Class('px-12 text-sm font-extrabold')], ['Keys']),
      h.ul(
        [h.Class('flex flex-col')],
        keyHelp(modelCommands(model)).map(command =>
          h.keyed('li')(
            command.id,
            [h.Class('flex items-center gap-12 px-12 py-4 text-sm')],
            [
              keyCap(
                Option.getOrElse(keyLabel(command, model.platform), () => ''),
                h,
              ),
              h.span([], [command.title]),
            ],
          ),
        ),
      ),
    ],
    h,
  )

const toPaletteMessage = (message: Palette.Message): Message =>
  Message.GotPaletteMessage({ message })

const runPaletteEntry = (id: string): Message => Message.RanPaletteEntry({ id })

const paletteView = (model: Model, h: HtmlBuilder<Message>): Html =>
  dialog(
    'Command palette',
    [
      Palette.view(
        model.screens.palette,
        {
          entries: paletteEntries(model),
          keys: paletteOverlayKeys.flatMap(command =>
            Option.match(keyLabel(command, model.platform), {
              onNone: () => [],
              onSome: key => [{ id: command.id, title: command.title, key }],
            }),
          ),
          toParentMessage: toPaletteMessage,
          run: runPaletteEntry,
        },
        h,
      ),
    ],
    h,
  )

const overlayView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Overlay.match(model.overlay, {
    Closed: () => h.empty,
    KeyHelp: () => keyHelpView(model, h),
    Palette: () => paletteView(model, h),
  })

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'Fabrica',
  body: h.div(
    [
      h.Class(
        'flex h-screen w-screen flex-col overflow-hidden bg-bg font-sans text-fg',
      ),
    ],
    [
      h.header(
        [
          h.AriaLabel('Title bar'),
          h.DataAttribute('app-region', 'drag' satisfies Titlebar.AppRegion),
          h.Class('flex items-center gap-8 border-b border-line bg-side'),
          h.Style({ height: layout.titleBarHeight, padding: '0 14px' }),
        ],
        [
          Titlebar.view(
            model.console.titlebar,
            {
              platform: model.platform,
              load: model.load,
              usage: model.usage,
              usageHeld: usageHeld(model),
              search: {
                hint: Option.getOrElse(
                  keyLabel(openPalette, model.platform),
                  () => '',
                ),
                open: openPalette.message,
              },
            },
            h,
          ),
        ],
      ),
      h.div(
        [
          h.DataAttribute('layout', 'body'),
          h.Class('grid min-h-0 flex-1'),
          h.Style({
            gridTemplateColumns: `${layout.sidebarWidth} minmax(0,1fr)`,
          }),
        ],
        [
          h.nav(
            [
              h.AriaLabel('Projects'),
              h.Class('flex min-h-0 flex-col border-r border-line bg-side'),
            ],
            [lazySidebar(sidebarView, [model.console.sidebar, model.scope, h])],
          ),
          h.main(
            [
              h.Class('flex min-h-0 flex-col gap-16'),
              h.Style({ padding: layout.mainPadding }),
            ],
            [
              noticeView(model, h),
              screenHeader(model, h),
              screenView(model, h),
            ],
          ),
        ],
      ),
      overlayView(model, h),
      SshPrompts.view(model.sshPrompts, h),
    ],
  ),
})
