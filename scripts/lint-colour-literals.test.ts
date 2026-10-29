import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuleTester } from 'oxlint/plugins-dev'

import { describe, expect, it } from '@effect/vitest'

import { colourLiteralIn, rules } from './lint-source'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: { sourceType: 'module', parserOptions: { lang: 'ts' } },
})

const inRepository = (path: string): string =>
  fileURLToPath(new URL(`../${path}`, import.meta.url))

const fixture = readFileSync(
  inRepository('scripts/fixtures/colour-literals.ts'),
  'utf8',
)

tester.run('no-colour-literals', rules['no-colour-literals'], {
  valid: [
    "const style = 'bg-panel text-fg border-line rounded-card shadow-glow1'",
    "const tag = 'bg-c2 text-ink hover:bg-c1 focus-visible:outline-c1'",
    "const mix = 'color-mix(in oklch, var(--c1) 20%, transparent)'",
    "const root = document.querySelector('#root')",
    "const entity = '&#123;'",
    "const commit = 'a1b2c3d'",
    "const words = 'to the white house, from gray-ish text'",
    'const css = `background: var(--bg); color: currentColor`',
    '// a comment naming #fff and rgb(0 0 0)\nconst x = 1',
    'const pattern = /#[0-9a-f]{6}/',
  ],
  invalid: [
    {
      code: fixture,
      errors: Array.from({ length: 10 }, () => ({
        message: /^colour literal /,
      })),
    },
    {
      code: "const button = 'bg-black text-white'",
      errors: [{ message: /colour literal bg-black: use the theme's colours/ }],
    },
    {
      code: 'const glow = `0 0 18px rgba(0,229,255,0.5)`',
      errors: [{ message: /colour literal rgba\(/ }],
    },
  ],
})

describe('colourLiteralIn', () => {
  it('names the colour a text writes', () => {
    expect(colourLiteralIn('border: 1px solid #FF2E9B')).toBe('#FF2E9B')
    expect(colourLiteralIn('dark:ring-offset-zinc-950')).toBe(
      'ring-offset-zinc-950',
    )
    expect(colourLiteralIn('text-fg bg-bg')).toBeUndefined()
  })
})

describe('the lint step', () => {
  const config: unknown = JSON.parse(
    readFileSync(inRepository('.oxlintrc.json'), 'utf8'),
  )

  it("refuses colour literals in the renderer, but in the contrast test's own colours", () => {
    expect(config).toMatchObject({
      overrides: expect.arrayContaining([
        {
          files: ['packages/ui/**', 'apps/desktop/src/renderer/**'],
          rules: { 'fabrica/no-colour-literals': 'error' },
        },
        {
          files: ['packages/ui/test/contrast.test.ts'],
          rules: { 'fabrica/no-colour-literals': 'off' },
        },
      ]),
    })
  })

  it("finds none in the renderer's stylesheets but themes.css", () => {
    const stylesheets = (folder: string): Array<string> =>
      readdirSync(inRepository(folder), { recursive: true, encoding: 'utf8' })
        .filter(file => file.endsWith('.css') && !file.includes('node_modules'))
        .map(file => join(folder, file))
    const found = ['packages/ui/src', 'apps/desktop/src/renderer']
      .flatMap(stylesheets)
      .filter(file => !file.endsWith('/theme/themes.css'))
      .flatMap(file => {
        const colour = colourLiteralIn(readFileSync(inRepository(file), 'utf8'))
        return colour === undefined ? [] : [`${file}: ${colour}`]
      })
    expect(found).toEqual([])
  })
})
