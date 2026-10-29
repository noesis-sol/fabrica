import { Schema } from 'effect'

/** The three themes of themes.css, all dark (spec §18.2): one applies at a time, chosen by
 *  data-theme on the root element. */
export const Theme = Schema.Literals(['lichen-bright', 'classic', 'neon-grid'])
export type Theme = typeof Theme.Type

/** The theme an install starts with. */
export const defaultTheme: Theme = 'lichen-bright'

/** The root's attribute themes.css's selectors read. */
export const themeAttribute = 'data-theme'

/** Applies `theme` to the document whose root is `root`, at once. */
export const applyTheme = (root: Element, theme: Theme): void => {
  root.setAttribute(themeAttribute, theme)
}
