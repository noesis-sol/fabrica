import { Effect, Option, Schema } from 'effect'

import { failureText } from '../app/connection'
import { Theme, defaultTheme, themeAttribute } from '../theme/theme'
import { type DiffSides, diffColours } from './diff'

// Monaco's diff view, mounted on an element (spec §18.1): loaded the first time a diff is shown, so
// the app starts without it; read-only; in the theme the root names, its colours from themes.css's
// tokens (diff.ts). Only the editor worker runs: the languages are their syntax colours alone, no
// language service, since a diff's hunks aren't a program to check. A file's language is told from
// its path, as Monaco tells it.

const decodeTheme = Schema.decodeUnknownOption(Theme)

/** The theme the document's root names, or the default where it names none. */
const documentTheme = (element: Element): Theme =>
  decodeTheme(
    element.ownerDocument.documentElement.getAttribute(themeAttribute),
  ).pipe(Option.getOrElse(() => defaultTheme))

const loadMonaco = Effect.tryPromise({
  try: async () => {
    const [monaco, { default: EditorWorker }] = await Promise.all([
      import('monaco-editor/editor/editor.api'),
      import('monaco-editor/editor/editor.worker?worker'),
      import('monaco-editor/basic-languages/monaco.contribution'),
    ])
    globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() }
    return monaco
  },
  catch: error => failureText(error, "Monaco's diff view could not be loaded"),
})

/** Monaco's theme for `theme`, defined from its tokens; Monaco's own dark theme where they can't be read. */
const defineTheme = (
  monaco: Effect.Success<typeof loadMonaco>,
  theme: Theme,
): string =>
  Option.match(diffColours(theme), {
    onNone: () => 'vs-dark',
    onSome: colors => {
      const name = `fabrica-${theme}`
      monaco.editor.defineTheme(name, {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors,
      })
      return name
    },
  })

/**
 * Shows `sides` of the file at `path` in Monaco's diff view, side by side, inside `element`, until the
 * scope closes, when the view and its models are disposed. Each side's model is named by its side,
 * the file's path, so its language is the path's, and `key` with the view's own random name, so no
 * two views' models share a name, even while one is being disposed as the next is drawn.
 */
export const showDiff = Effect.fn('Monaco.showDiff')(function* ({
  element,
  path,
  key,
  sides,
}: {
  readonly element: Element
  readonly path: string
  readonly key: string
  readonly sides: DiffSides
}) {
  if (!(element instanceof HTMLElement)) {
    return yield* Effect.fail('the diff view has no element to draw in')
  }
  const monaco = yield* loadMonaco
  const theme = defineTheme(monaco, documentTheme(element))
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const view = crypto.randomUUID()
      const uri = (side: string) =>
        monaco.Uri.from({
          scheme: `fabrica-${side}`,
          path: `/${path}`,
          query: `${key}/${view}`,
        })
      const original = monaco.editor.createModel(
        sides.original,
        undefined,
        uri('original'),
      )
      const modified = monaco.editor.createModel(
        sides.modified,
        undefined,
        uri('modified'),
      )
      const editor = monaco.editor.createDiffEditor(element, {
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        theme,
        fontFamily: getComputedStyle(element).getPropertyValue('--mono'),
      })
      editor.setModel({ original, modified })
      return { editor, original, modified }
    }),
    ({ editor, original, modified }) =>
      Effect.sync(() => {
        editor.dispose()
        original.dispose()
        modified.dispose()
      }),
  )
})
