import { Option } from 'effect'
import type { BrowserWindowConstructorOptions, TitleBarOverlay } from 'electron'

import type { WindowColours } from '@fabrica/ui/window-colours'

// The app's window (spec §18.2, §18.3, §20.1): one window at the handoff's 1280 × 800 reference, its
// title bar the design's 38px bar with the system's own controls in it, and the page sandboxed and
// isolated from the preload.

/** The handoff's reference window. */
export const referenceSize = { width: 1280, height: 800 } as const

/** The design's title bar height (Appendix A.1). */
export const titleBarHeight = 38

/** The height of macOS's window buttons (the traffic lights). */
const trafficLightHeight = 14

/** The traffic lights' top left, centred on the title bar, as far from the left edge as from the top. */
export const trafficLightPosition = {
  x: (titleBarHeight - trafficLightHeight) / 2,
  y: (titleBarHeight - trafficLightHeight) / 2,
} as const

/** The title bar overlay of Windows and Linux in `colours`: the system's buttons drawn on --side in --fg. */
export const titleBarOverlay = (
  colours: Option.Option<WindowColours>,
): TitleBarOverlay =>
  Option.match(colours, {
    onNone: () => ({ height: titleBarHeight }),
    onSome: ({ titleBar, symbols }) => ({
      color: titleBar,
      symbolColor: symbols,
      height: titleBarHeight,
    }),
  })

/** The window's title bar on `platform`. */
const titleBar = (
  platform: NodeJS.Platform,
  colours: Option.Option<WindowColours>,
): BrowserWindowConstructorOptions =>
  platform === 'darwin'
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition }
    : { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(colours) }

/** The window's options on `platform`, in a theme's `colours`, with the preload at `preload`. */
export const windowOptions = ({
  platform,
  colours,
  preload,
}: {
  readonly platform: NodeJS.Platform
  readonly colours: Option.Option<WindowColours>
  readonly preload: string
}): BrowserWindowConstructorOptions => ({
  ...referenceSize,
  title: 'Fabrica',
  // Shown once the page has painted, so the window never flashes another colour.
  show: false,
  ...Option.match(colours, {
    onNone: () => ({}),
    onSome: ({ background }) => ({ backgroundColor: background }),
  }),
  ...titleBar(platform, colours),
  webPreferences: {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    experimentalFeatures: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    spellcheck: false,
  },
})
