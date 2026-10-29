import { Option, Schema } from 'effect'

/** The three themes of themes.css, all dark (spec §18.2): one applies at a time, chosen by
 *  data-theme on the root element. */
export const Theme = Schema.Literals(['lichen-bright', 'classic', 'neon-grid'])
export type Theme = typeof Theme.Type

/** Every theme, in the order Settings and the palette offer them. */
export const themes: ReadonlyArray<Theme> = Theme.literals

/** The theme an install starts with. */
export const defaultTheme: Theme = 'lichen-bright'

/** A theme's name, as the handoff names it. */
export const themeTitle = (theme: Theme): string =>
  ({
    'lichen-bright': 'Lichen Bright',
    classic: 'Classic',
    'neon-grid': 'Neon Grid',
  })[theme]

/** The root's attribute themes.css's selectors read. */
export const themeAttribute = 'data-theme'

/** Applies `theme` to the document whose root is `root`, at once. */
export const applyTheme = (root: Element, theme: Theme): void => {
  root.setAttribute(themeAttribute, theme)
}

/** Where an install keeps the theme it chose: a setting of each app install, not the engine's. */
export const themeStorageKey = 'fabrica.theme'

const decodeTheme = Schema.decodeUnknownOption(Theme)

/** The theme `storage` keeps; none where it keeps none, or something that isn't a theme. */
export const keptTheme = (
  storage: Pick<Storage, 'getItem'>,
): Option.Option<Theme> =>
  Option.flatMap(
    Option.fromNullishOr(storage.getItem(themeStorageKey)),
    decodeTheme,
  )

/** Keeps `theme` in `storage`, for the install's next start. */
export const keepTheme = (
  storage: Pick<Storage, 'setItem'>,
  theme: Theme,
): void => {
  storage.setItem(themeStorageKey, theme)
}
