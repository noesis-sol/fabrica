import {
  type Document,
  type Html,
  type HtmlBuilder,
  createLazy,
} from 'foldkit/html'

import type * as Titlebar from '../console/titlebar'
import * as Backlog from './features/backlog/backlog'
import * as Connection from './features/connection/connection'
import * as Console from './features/console/console'
import * as Engines from './features/engines/engines'
import * as Insights from './features/insights/insights'
import * as Keys from './features/keys/keys'
import * as Palette from './features/palette/palette'
import * as Review from './features/review/review'
import * as ScreenFeature from './features/screen/screen'
import * as Settings from './features/settings/settings'
import * as Sidebar from './features/sidebar/sidebar'
import * as SshPrompts from './features/ssh-prompts/ssh-prompts'
import * as Talks from './features/talks/talks'
import * as TitlebarFeature from './features/titlebar/titlebar'
import * as Worker from './features/worker/worker'
import { layout } from './layout'
import type { Message } from './message'
import { type Model, Overlay } from './model'
import { Screen } from './screen'

// The app's frame (spec §18.3, Appendix A.1), at the handoff's 1280 × 800 reference window: the title
// bar over a grid of the sidebar and the main column, which holds the connection's notice, the screen's
// header and the screen; the overlay and what ssh asks over it all. Each screen, overlay and part is its
// feature's view, listed here a line each in the order of their names (feature.ts).

const lazySidebar = createLazy()

const screenView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Screen.match(model.screen, {
    Backlog: () => Backlog.view(model, h),
    Console: () => Console.view(model, h),
    Engines: () => Engines.view(model, h),
    Insights: () => Insights.view(model, h),
    Review: () => Review.view(model, h),
    Settings: () => Settings.view(model, h),
    Talks: () => Talks.view(model, h),
    Worker: worker => Worker.view(model, worker, h),
  })

const overlayView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Overlay.match(model.overlay, {
    Closed: () => h.empty,
    KeyHelp: () => Keys.keyHelpView(model, h),
    Palette: () => Palette.view(model, h),
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
        [TitlebarFeature.view(model, h)],
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
            [
              lazySidebar(Sidebar.view, [
                model.console.sidebar,
                model.scope,
                h,
              ]),
            ],
          ),
          h.main(
            [
              h.Class('flex min-h-0 flex-col gap-16'),
              h.Style({ padding: layout.mainPadding }),
            ],
            [
              Connection.notice(model, h),
              ScreenFeature.header(model, h),
              screenView(model, h),
            ],
          ),
        ],
      ),
      overlayView(model, h),
      SshPrompts.view(model, h),
    ],
  ),
})
