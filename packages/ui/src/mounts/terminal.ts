import { Data, Effect, Option, Schema } from 'effect'

import { failureText } from '../app/connection'
import { hexOfColour, parseColour, themeVariables } from '../theme/contrast'
import { Theme, defaultTheme, themeAttribute } from '../theme/theme'
import themesCss from '../theme/themes.css?raw'

// xterm.js for a tool call's output (spec §18.1, §18.4): read-only, loaded the first time output is
// shown, in the theme the root names, its colours from themes.css's tokens. The output so far is the
// element's `data-output`, which the view rewrites as more arrives: the terminal is made once, as the
// element mounts, and writes what each rewrite added, so streamed output costs no new terminal.

/** The attribute the view writes a tool call's output so far to. */
export const outputAttribute = 'data-output'

/** What the terminal does with the output now, after `written`: write what was added, or start over. */
export type OutputStep = Data.TaggedEnum<{
  Append: { readonly text: string }
  Restart: { readonly text: string }
}>
export const OutputStep = Data.taggedEnum<OutputStep>()

/**
 * The step from the output `written` to `output`: what was added, where `output` goes on from it; the
 * whole output afresh where it doesn't (a snapshot that took the transcript's place).
 */
export const outputStep = (written: string, output: string): OutputStep =>
  output.startsWith(written)
    ? OutputStep.Append({ text: output.slice(written.length) })
    : OutputStep.Restart({ text: output })

/** The terminal's colours, as hex, xterm's theme keys taking them. */
export interface TerminalColours {
  readonly background: string
  readonly foreground: string
  readonly cursor: string
  readonly selectionBackground: string
}

/** How opaque the selection is over --panel. */
const selectionAlpha = '4d'

/**
 * `theme`'s colours for xterm, from themes.css's variables: the output on --panel in --fg, selected in
 * --c1 (working) at a third. Each variable themes.css writes as an opaque colour; none where one isn't.
 */
export const terminalColoursOf = (
  css: string,
  theme: Theme,
): Option.Option<TerminalColours> => {
  const variables = themeVariables(css).get(theme)
  const hexOf = (variable: string): Option.Option<string> =>
    Option.fromUndefinedOr(variables?.get(variable)).pipe(
      Option.flatMap(parseColour),
      Option.map(hexOfColour),
    )
  return Option.map(
    Option.all({ panel: hexOf('panel'), fg: hexOf('fg'), c1: hexOf('c1') }),
    ({ panel, fg, c1 }) => ({
      background: panel,
      foreground: fg,
      cursor: panel,
      selectionBackground: `${c1}${selectionAlpha}`,
    }),
  )
}

const decodeTheme = Schema.decodeUnknownOption(Theme)

/** The theme the document's root names, or the default where it names none. */
const documentTheme = (element: Element): Theme =>
  decodeTheme(
    element.ownerDocument.documentElement.getAttribute(themeAttribute),
  ).pipe(Option.getOrElse(() => defaultTheme))

const loadXterm = Effect.tryPromise({
  try: async () => {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css'),
    ])
    return { Terminal, FitAddon }
  },
  catch: error => failureText(error, 'The terminal could not be loaded'),
})

/** The rows a tool call's output shows before it scrolls. */
export const terminalRows = 12

/**
 * Shows the output written to `element`'s `data-output` in a read-only terminal inside it, fitted to its
 * width, until the scope closes, when the terminal is disposed. Each rewrite of the attribute writes
 * what it added (`outputStep`).
 */
export const showOutput = Effect.fn('Terminal.showOutput')(function* ({
  element,
}: {
  readonly element: Element
}) {
  if (!(element instanceof HTMLElement)) {
    return yield* Effect.fail('the terminal has no element to draw in')
  }
  const { Terminal, FitAddon } = yield* loadXterm
  const colours = terminalColoursOf(themesCss, documentTheme(element))
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const terminal = new Terminal({
        disableStdin: true,
        convertEol: true,
        cursorInactiveStyle: 'none',
        rows: terminalRows,
        scrollback: 5_000,
        fontSize: 12,
        fontFamily: getComputedStyle(element).getPropertyValue('--mono'),
        ...Option.match(colours, {
          onNone: () => ({}),
          onSome: theme => ({ theme }),
        }),
      })
      const fit = new FitAddon()
      terminal.loadAddon(fit)
      terminal.open(element)
      fit.fit()
      const written = { output: '' }
      const write = () => {
        const output = element.getAttribute(outputAttribute) ?? ''
        OutputStep.$match(outputStep(written.output, output), {
          Append: ({ text }) => terminal.write(text),
          Restart: ({ text }) => {
            terminal.reset()
            terminal.write(text)
          },
        })
        written.output = output
      }
      const observer = new MutationObserver(write)
      observer.observe(element, {
        attributes: true,
        attributeFilter: [outputAttribute],
      })
      write()
      return { terminal, observer }
    }),
    ({ terminal, observer }) =>
      Effect.sync(() => {
        observer.disconnect()
        terminal.dispose()
      }),
  )
})
