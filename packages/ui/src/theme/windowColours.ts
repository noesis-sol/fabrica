import { Option } from 'effect'

import { hexOfColour, parseColour, themeVariables } from './contrast'
import type { Theme } from './theme'
import themesCss from './themes.css?raw'

// The colours the native window draws around the page (spec §18.3, H46): its background before the
// page paints (--bg) and, on Windows and Linux, the title bar overlay's buttons, drawn on --side in
// --fg. They come from themes.css's own text, the only source of colours; Electron takes them as hex,
// and themes.css writes some as oklch().

/** A theme's colours for the native window, as hex. */
export interface WindowColours {
  readonly background: string
  readonly titleBar: string
  readonly symbols: string
}

/** `theme`'s window colours in `css` (themes.css's text), when it writes all three as opaque colours. */
export const windowColoursOf = (
  css: string,
  theme: Theme,
): Option.Option<WindowColours> => {
  const variables = themeVariables(css).get(theme)
  const hexOf = (variable: string): Option.Option<string> =>
    Option.fromUndefinedOr(variables?.get(variable)).pipe(
      Option.flatMap(parseColour),
      Option.map(hexOfColour),
    )
  return Option.all({
    background: hexOf('bg'),
    titleBar: hexOf('side'),
    symbols: hexOf('fg'),
  })
}

/** `theme`'s window colours in the bundled themes.css. */
export const windowColours = (theme: Theme): Option.Option<WindowColours> =>
  windowColoursOf(themesCss, theme)
