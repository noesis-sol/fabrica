import { Option } from 'effect'
import {
  type Document,
  type Html,
  type HtmlBuilder,
  createLazy,
} from 'foldkit/html'

import type { Platform, ProjectId } from '@fabrica/contracts'

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
import { Connection, isLive } from './connection'
import {
  type KeyCommand,
  hints,
  keyHelp,
  keyLabel,
  openPalette,
  paletteCommands,
} from './keys'
import { Message } from './message'
import { type Model, Overlay } from './model'
import { Screen, screenTitle } from './screen'
import { modelCommands } from './update'

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

/** The stats row, a Submodel: given the scope, the connection, the scoped run and the time. */
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
  h: HtmlBuilder<Message>,
): Html => statsPart(stats, { project, live, run, now }, h)
const lazyTalkPanel = createLazy()
const lazyHistory = createLazy()
const lazyInProgress = createLazy()
const lazyAttention = createLazy()
const lazyUpNext = createLazy()

const panel =
  'flex flex-col overflow-hidden rounded-card border border-line bg-panel'
const column = 'flex min-h-0 flex-col gap-8 overflow-auto'

/** Whether the attention column has something to show: otherwise Up next takes its place (§18.3). */
const needsYou = (model: Model): boolean =>
  Option.exists(model.attention, requests => requests.length > 0)

const toHistoryMessage = (message: History.Message): Message =>
  Message.GotHistoryMessage({ message })

const historyView = (
  history: History.Model,
  events: Model['events'],
  today: Model['today'],
  h: HtmlBuilder<Message>,
): Html =>
  History.view(history, { events, today, toParentMessage: toHistoryMessage }, h)

const consoleView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const parts = model.console
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
            [lazyTalkPanel(TalkPanel.view<Message>, [parts.talkPanel, h])],
          ),
          h.section(
            [h.AriaLabel('History'), h.Class(panel)],
            [
              lazyHistory(historyView, [
                parts.history,
                model.events,
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
            [lazyInProgress(InProgress.view<Message>, [parts.inProgress, h])],
          ),
          needsYou(model)
            ? h.section(
                [h.AriaLabel('Needs your attention'), h.Class(column)],
                [lazyAttention(Attention.view<Message>, [parts.attention, h])],
              )
            : h.section(
                [h.AriaLabel('Up next'), h.Class(column)],
                [lazyUpNext(UpNext.view<Message>, [parts.upNext, h])],
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

const screenView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Screen.match(model.screen, {
    Console: () => consoleView(model, h),
    Worker: ({ ticket }) => Worker.view(model.screens.worker, ticket, h),
    Talks: () => Talks.view(model.screens.talks, h),
    Backlog: () => Backlog.view(model.screens.backlog, h),
    Review: () => Review.view(model.screens.review, h),
    Insights: () => Insights.view(model.screens.insights, h),
    Engines: () => Engines.view(model.screens.engines, h),
    Settings: () => Settings.view(model.screens.settings, h),
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
    Refused: ({ update }) =>
      Option.some(
        update === 'client'
          ? 'This app is too old for the engine: update the app.'
          : 'The engine is too old for this app: update the engine.',
      ),
  })

const noticeView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(connectionNotice(model), {
    onNone: () => h.empty,
    onSome: text =>
      h.p(
        [
          h.Role('status'),
          h.Class('rounded-card border border-line px-12 py-6 text-xs'),
        ],
        [text],
      ),
  })

const dialog = (
  label: string,
  body: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Class('fixed inset-0 flex items-start justify-center'),
      h.Style({ paddingTop: '96px' }),
    ],
    [
      h.div(
        [
          h.Role('dialog'),
          h.AriaModal(true),
          h.AriaLabel(label),
          h.Class(
            'flex w-full flex-col gap-8 rounded-window border border-line bg-panel py-12 shadow-glow1',
          ),
          h.Style({ maxWidth: '520px' }),
        ],
        body,
      ),
    ],
  )

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

const paletteView = (model: Model, h: HtmlBuilder<Message>): Html =>
  dialog(
    'Command palette',
    [
      Palette.view(
        model.screens.palette,
        paletteCommands(modelCommands(model)).map(command => ({
          id: command.id,
          title: command.title,
          key: Option.getOrUndefined(keyLabel(command, model.platform)),
          run: command.message,
        })),
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
    ],
  ),
})
