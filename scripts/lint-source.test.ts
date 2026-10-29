import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RuleTester } from 'oxlint/plugins-dev'

import { describe, expect, it } from '@effect/vitest'

import plugin, { isRefusedControl, rules } from './lint-source'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: { sourceType: 'module', parserOptions: { lang: 'ts' } },
})

/** The character at `point`, made here so this file holds none raw. */
const raw = (point: number): string => String.fromCodePoint(point)

tester.run('no-raw-controls', rules['no-raw-controls'], {
  valid: [
    "const rlo = '\\u202e'",
    "const separator = '\\u2028' // an escape, not the character",
    "const text = 'é, ü and \\t: none refused'\n",
    `const tab = '${raw(0x09)}'`,
  ],
  invalid: [
    {
      code: `const label = 'admin${raw(0x202e)}txt.exe'`,
      errors: [{ message: /U\+202E/, line: 1, column: 20 }],
    },
    {
      code: `// a comment${raw(0x2066)} with an isolate${raw(0x2069)}\nconst x = 1`,
      errors: 2,
    },
    {
      code: `const a = 1\nconst b = '${raw(0x2028)}'`,
      errors: [{ message: /U\+2028/, line: 2 }],
    },
    { code: `const c1 = '${raw(0x85)}'`, errors: [{ message: /U\+0085/ }] },
    { code: `const mark = '${raw(0x200f)}'`, errors: 1 },
    { code: `const mark = '${raw(0x061c)}'`, errors: 1 },
  ],
})

tester.run('no-env-in-tests', rules['no-env-in-tests'], {
  valid: [
    "const env = { PATH: '/bin' }",
    'const run = (env: Record<string, string>) => env.PATH',
    "const script = 'process.stdout.write(process.env.HOME)'",
    "import { argv } from 'node:process'",
    'const { pid } = process',
  ],
  invalid: [
    { code: 'const home = process.env.HOME', errors: 1 },
    { code: "const home = process.env['HOME']", errors: 1 },
    { code: "const env = process['env']", errors: 1 },
    { code: 'const { env } = process', errors: 1 },
    { code: "import { env } from 'node:process'", errors: 1 },
    { code: "import { env as vars } from 'process'", errors: 1 },
  ],
})

tester.run('no-built-replacement', rules['no-built-replacement'], {
  valid: [
    "'a-b'.replace('-', '_')",
    "'a-b'.replaceAll(/-/g, '\\\\$&')",
    "'a-b'.replace('-', `_`)",
    "const fill = (template: string, value: string) => template.replaceAll('{{v}}', () => value)",
    "'a'.replace(/a/, function () { return 'b' })",
    "const names = list.filter(x => x).map(x => x.replace(/\\s/g, ''))",
    'map.replace(key)',
  ],
  invalid: [
    {
      code: "const fill = (template: string, value: string) => template.replaceAll('{{v}}', value)",
      errors: [{ message: /replaceAll interprets \$/ }],
    },
    {
      code: "const line = (text: string, indent: string) => text.replace('\\n', `\\n${indent}`)",
      errors: [{ message: /replace interprets \$/ }],
    },
    {
      code: "const join = (text: string, a: string) => text.replace('x', 'y' + a)",
      errors: 1,
    },
    {
      code: "const escape = (m: string) => m; 'a'.replace(/a/, escape)",
      errors: 1,
    },
  ],
})

describe('isRefusedControl', () => {
  it('refuses C1 controls, separators and bidi controls, and nothing near them', () => {
    expect(
      [0x80, 0x9f, 0x061c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e]
        .concat([0x2066, 0x2069])
        .every(isRefusedControl),
    ).toBe(true)
    expect(
      [0x09, 0x0a, 0x7e, 0xa0, 0xe9, 0x200d, 0x2027, 0x202f, 0x2065, 0x206a]
        .map(isRefusedControl)
        .some(Boolean),
    ).toBe(false)
  })
})

describe('the lint step', () => {
  const config: unknown = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../.oxlintrc.json', import.meta.url)),
      'utf8',
    ),
  )

  it('loads this plugin as fabrica', () => {
    expect(plugin.meta.name).toBe('fabrica')
    expect(config).toMatchObject({
      jsPlugins: expect.arrayContaining([
        { name: 'fabrica', specifier: './scripts/lint-source.ts' },
      ]),
    })
  })

  it('refuses controls and built replacements everywhere, the environment in tests', () => {
    expect(config).toMatchObject({
      rules: {
        'fabrica/no-raw-controls': 'error',
        'fabrica/no-built-replacement': 'error',
      },
      overrides: expect.arrayContaining([
        {
          files: ['**/*.test.ts', '**/*.test.tsx'],
          rules: { 'fabrica/no-env-in-tests': 'error' },
        },
      ]),
    })
  })
})
