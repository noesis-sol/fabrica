import { Option } from 'effect'

import type { FileDiff } from '@fabrica/contracts'

import { hexOfColour, parseColour, themeVariables } from '../theme/contrast'
import type { Theme } from '../theme/theme'
import themesCss from '../theme/themes.css?raw'

// What Monaco's diff view is given (spec §18.1, §18.4): a file's two sides, rebuilt from the unified
// patch the Review group sends, and the colours it draws them in, from themes.css's tokens. A patch
// carries its hunks only, so each side holds the hunks' lines, every hunk opened by its header line
// on both sides: unchanged, so Monaco aligns the hunks on it, and saying where in the file each is.

/** A file's two sides, as its patch has them. */
export interface DiffSides {
  readonly original: string
  readonly modified: string
}

const hunkHeader = /^@@ .* @@/u

/** `file`'s two sides from its patch's hunks; none where it has no hunk (a binary file, a bare rename). */
export const sidesOf = (file: FileDiff): Option.Option<DiffSides> => {
  const original: Array<string> = []
  const modified: Array<string> = []
  let inHunk = false
  for (const line of file.patch.split('\n')) {
    if (hunkHeader.test(line)) {
      inHunk = true
      original.push(line)
      modified.push(line)
    } else if (inHunk) {
      const body = line.slice(1)
      if (line.startsWith('+')) modified.push(body)
      else if (line.startsWith('-')) original.push(body)
      else if (line.startsWith(' ')) {
        original.push(body)
        modified.push(body)
      }
      // `\ No newline at end of file`, and the empty line a patch ends with, are neither side's.
    }
  }
  return inHunk
    ? Option.some({
        original: original.join('\n'),
        modified: modified.join('\n'),
      })
    : Option.none()
}

/** The diff view's colours, as hex, Monaco's colour IDs taking them. */
export type DiffColours = Readonly<Record<string, string>>

/** How opaque a changed line's background is over --panel: enough to read, faint enough to read through. */
const lineAlpha = '26'
const textAlpha = '4d'

/**
 * `theme`'s colours for Monaco, from themes.css's variables: the editor on --panel in --fg, line
 * numbers in --muted, inserted lines tinted with --c4 (merged or done) and removed ones with --c3
 * (failed). Each variable themes.css writes as an opaque colour; none where one isn't.
 */
export const diffColoursOf = (
  css: string,
  theme: Theme,
): Option.Option<DiffColours> => {
  const variables = themeVariables(css).get(theme)
  const hexOf = (variable: string): Option.Option<string> =>
    Option.fromUndefinedOr(variables?.get(variable)).pipe(
      Option.flatMap(parseColour),
      Option.map(hexOfColour),
    )
  return Option.map(
    Option.all({
      panel: hexOf('panel'),
      fg: hexOf('fg'),
      muted: hexOf('muted'),
      inserted: hexOf('c4'),
      removed: hexOf('c3'),
      focus: hexOf('c1'),
    }),
    ({ panel, fg, muted, inserted, removed, focus }) => ({
      'editor.background': panel,
      'editor.foreground': fg,
      'editorGutter.background': panel,
      'editorLineNumber.foreground': muted,
      'editorLineNumber.activeForeground': fg,
      focusBorder: focus,
      'diffEditor.insertedLineBackground': `${inserted}${lineAlpha}`,
      'diffEditor.insertedTextBackground': `${inserted}${textAlpha}`,
      'diffEditor.removedLineBackground': `${removed}${lineAlpha}`,
      'diffEditor.removedTextBackground': `${removed}${textAlpha}`,
      'diffEditorGutter.insertedLineBackground': `${inserted}${lineAlpha}`,
      'diffEditorGutter.removedLineBackground': `${removed}${lineAlpha}`,
    }),
  )
}

/** `theme`'s colours for Monaco in the bundled themes.css. */
export const diffColours = (theme: Theme): Option.Option<DiffColours> =>
  diffColoursOf(themesCss, theme)
