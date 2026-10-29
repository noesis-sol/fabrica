// scripts/lint-source.ts: the repository's own lint rules (spec §23, §24), an oxlint JS plugin that
// .oxlintrc.json loads as `fabrica`, so `pnpm lint` runs them with the rest:
//   fabrica/no-raw-controls:      a raw bidi control, C1 control or line separator in the source,
//                                 which shows one text and runs another (an agent's write tools turn
//                                 a `\u` escape of one into the raw character; tutti-hgdi). Write
//                                 such characters as escapes, by a script.
//   fabrica/no-env-in-tests:      a test reading the process environment (process.env, or `env` from
//                                 node:process): a test's environment is airtight, its facts
//                                 injected (orchestra-nqbn). .oxlintrc.json turns it on for tests.
//   fabrica/no-built-replacement: String.replace or replaceAll given a replacement that isn't a
//                                 literal or a function. A replacement string's `$&`, `$1` and `$$`
//                                 are interpreted, so a value a model, worker or project wrote is
//                                 corrupted when it holds one (tutti's init and `$$`); the lint
//                                 can't tell where a value came from, so it refuses every built one.
//                                 Pass a function returning the value: its result is taken as is.
//   fabrica/no-colour-literals:   a colour written in a string of the renderer's source: a hex colour,
//                                 a CSS colour function (rgb(), oklch() and the rest), or a class of
//                                 Tailwind's own palette. Colours come from themes.css's variables
//                                 through Tailwind's theme (spec §18.2). .oxlintrc.json turns it on
//                                 for the renderer; the colour-literals test checks its CSS files.
// Each rule reads only the file it lints; the plugin imports nothing at run time.
import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

/** The code points refused raw in the source: C1 controls, the line and paragraph separators, and
 *  the bidi marks, embeddings, overrides and isolates. Numbers, so this file holds none of them. */
const refusedRanges: ReadonlyArray<readonly [number, number]> = [
  [0x80, 0x9f],
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
]

/** Whether the source may not hold the code point `point` raw. */
export const isRefusedControl = (point: number): boolean =>
  refusedRanges.some(([low, high]) => point >= low && point <= high)

const hex = (point: number): string =>
  `U+${point.toString(16).toUpperCase().padStart(4, '0')}`

const noRawControls: Rule = {
  meta: { type: 'problem' },
  create: context => ({
    Program: () => {
      const { text } = context.sourceCode
      for (let index = 0; index < text.length; index++) {
        const point = text.charCodeAt(index)
        if (isRefusedControl(point)) {
          context.report({
            message: `raw ${hex(point)} in the source: write it as an escape, by a script`,
            loc: {
              start: context.sourceCode.getLocFromIndex(index),
              end: context.sourceCode.getLocFromIndex(index + 1),
            },
          })
        }
      }
    },
  }),
}

const envMessage =
  "a test reads the process environment: inject what it needs, and give the code under test an environment of the test's own"

const noEnvInTests: Rule = {
  meta: { type: 'problem' },
  create: context => ({
    MemberExpression: node => {
      const property =
        node.property.type === 'Identifier' && !node.computed
          ? node.property.name
          : node.property.type === 'Literal'
            ? node.property.value
            : null
      if (
        node.object.type === 'Identifier' &&
        node.object.name === 'process' &&
        property === 'env'
      ) {
        context.report({ message: envMessage, node })
      }
    },
    VariableDeclarator: node => {
      if (
        node.init?.type === 'Identifier' &&
        node.init.name === 'process' &&
        node.id.type === 'ObjectPattern' &&
        node.id.properties.some(
          entry =>
            entry.type === 'Property' &&
            ((entry.key.type === 'Identifier' &&
              !entry.computed &&
              entry.key.name === 'env') ||
              (entry.key.type === 'Literal' && entry.key.value === 'env')),
        )
      ) {
        context.report({ message: envMessage, node })
      }
    },
    ImportDeclaration: node => {
      if (
        (node.source.value === 'process' ||
          node.source.value === 'node:process') &&
        node.specifiers.some(
          specifier =>
            specifier.type === 'ImportSpecifier' &&
            (specifier.imported.type === 'Identifier'
              ? specifier.imported.name
              : specifier.imported.value) === 'env',
        )
      ) {
        context.report({ message: envMessage, node })
      }
    },
  }),
}

const noBuiltReplacement: Rule = {
  meta: { type: 'problem' },
  create: context => ({
    CallExpression: node => {
      const { callee } = node
      const replacement = node.arguments[1]
      if (
        callee.type !== 'MemberExpression' ||
        callee.computed ||
        callee.property.type !== 'Identifier' ||
        (callee.property.name !== 'replace' &&
          callee.property.name !== 'replaceAll') ||
        replacement === undefined
      ) {
        return
      }
      const fixed =
        (replacement.type === 'Literal' &&
          typeof replacement.value === 'string') ||
        (replacement.type === 'TemplateLiteral' &&
          replacement.expressions.length === 0) ||
        replacement.type === 'ArrowFunctionExpression' ||
        replacement.type === 'FunctionExpression'
      if (!fixed) {
        context.report({
          message: `${callee.property.name} interprets $ in a replacement string: pass a literal, or a function returning the value`,
          node: replacement,
        })
      }
    },
  }),
}

/** Colours written as text: hex colours, CSS colour functions (color-mix() mixes the theme's
 *  variables, so it isn't one), and the utilities of Tailwind's own palette, with any variant. */
const colourPatterns: ReadonlyArray<RegExp> = [
  /(?<![\w&#])#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![\w-])/i,
  /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i,
  /(?<![\w-])(?:bg|text|border(?:-[xytrblse])?|outline|ring|ring-offset|divide|fill|stroke|from|via|to|decoration|placeholder|caret|accent|shadow|inset-shadow|inset-ring|drop-shadow|text-shadow)-(?:(?:slate|gray|zinc|neutral|stone|mauve|olive|mist|taupe|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)|white|black)(?![\w-])/,
]

/** The first colour literal in `text`, if it holds one. */
export const colourLiteralIn = (text: string): string | undefined => {
  for (const pattern of colourPatterns) {
    const found = pattern.exec(text)
    if (found !== null) {
      return found[0]
    }
  }
  return undefined
}

const colourMessage = (colour: string): string =>
  `colour literal ${colour}: use the theme's colours (themes.css's variables, through Tailwind's theme)`

const noColourLiterals: Rule = {
  meta: { type: 'problem' },
  create: context => ({
    Literal: node => {
      const colour =
        typeof node.value === 'string' ? colourLiteralIn(node.value) : undefined
      if (colour !== undefined) {
        context.report({ message: colourMessage(colour), node })
      }
    },
    TemplateElement: node => {
      const colour = colourLiteralIn(node.value.cooked ?? node.value.raw)
      if (colour !== undefined) {
        context.report({ message: colourMessage(colour), node })
      }
    },
  }),
}

export const rules = {
  'no-raw-controls': noRawControls,
  'no-env-in-tests': noEnvInTests,
  'no-built-replacement': noBuiltReplacement,
  'no-colour-literals': noColourLiterals,
}

export default { meta: { name: 'fabrica' }, rules }
