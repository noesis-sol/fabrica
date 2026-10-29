import { Option } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import { Plan, type Sources, isVendored, standOn } from './check-own'

const treeA = 'a'.repeat(40)
const treeB = 'b'.repeat(40)

/** One package with a module and its test, beside vendored Foldkit with a package and a test of its own. */
const sources: Sources = {
  modules: new Map([
    [
      'packages/contracts/vitest.config.ts',
      "export default { test: { name: 'contracts' } }\n",
    ],
    ['packages/contracts/src/ids.ts', 'export const TicketId = 1\n'],
    [
      'packages/contracts/src/ids.test.ts',
      "import { TicketId } from './ids'\n",
    ],
  ]),
  files: new Set([
    'packages/contracts/package.json',
    'packages/contracts/vitest.config.ts',
    'packages/contracts/src/ids.ts',
    'packages/contracts/src/ids.test.ts',
  ]),
  packages: [
    {
      name: '@fabrica/contracts',
      dir: 'packages/contracts',
      exports: new Map([['.', 'packages/contracts/src/ids.ts']]),
    },
  ],
}

/** What a refresh of the Foldkit subtree changes: its manifests, configs, modules and tests. */
const refresh = [
  'repos/foldkit/package.json',
  'repos/foldkit/tsconfig.json',
  'repos/foldkit/vitest.config.ts',
  'repos/foldkit/packages/foldkit/src/runtime.ts',
  'repos/foldkit/packages/foldkit/src/runtime.test.ts',
]

describe('isVendored', () => {
  it('holds for a file under repos/ only', () => {
    expect(isVendored('repos/foldkit/package.json')).toBe(true)
    expect(isVendored('repos/pi/packages/coding-agent/src/main.ts')).toBe(true)
    expect(isVendored('packages/repos/index.ts')).toBe(false)
    expect(isVendored('reposition.ts')).toBe(false)
    expect(isVendored('FOLDKIT.md')).toBe(false)
  })
})

describe('standOn with vendored source', () => {
  it('runs nothing for a change under repos/ alone, its setup files included', () => {
    expect(
      standOn({
        tree: treeB,
        sinceBase: refresh,
        earlier: Option.none(),
        sources,
      }),
    ).toEqual(
      Plan.Steps({
        from: Option.none(),
        changed: [],
        tests: [],
        standing: [],
        passed: [],
      }),
    )
  })

  it('checks the rest of a change that also refreshes a subtree', () => {
    expect(
      standOn({
        tree: treeB,
        sinceBase: [...refresh, 'FOLDKIT.md', 'packages/contracts/src/ids.ts'],
        earlier: Option.none(),
        sources,
      }),
    ).toEqual(
      Plan.Steps({
        from: Option.none(),
        changed: ['FOLDKIT.md', 'packages/contracts/src/ids.ts'],
        tests: ['packages/contracts/src/ids.test.ts'],
        standing: [],
        passed: ['packages/contracts/src/ids.test.ts'],
      }),
    )
  })

  it('leaves vendored files out of what changed since an earlier pass', () => {
    const pass = { tree: treeA, tests: ['packages/contracts/src/ids.test.ts'] }
    expect(
      standOn({
        tree: treeB,
        sinceBase: ['packages/contracts/src/ids.ts', ...refresh],
        earlier: Option.some({ pass, since: refresh }),
        sources,
      }),
    ).toEqual(
      Plan.Steps({
        from: Option.some(treeA),
        changed: [],
        tests: [],
        standing: ['packages/contracts/src/ids.test.ts'],
        passed: ['packages/contracts/src/ids.test.ts'],
      }),
    )
  })

  it('still runs the whole check for a setup file of the workspace', () => {
    expect(
      standOn({
        tree: treeB,
        sinceBase: [...refresh, 'packages/contracts/package.json'],
        earlier: Option.none(),
        sources,
      }),
    ).toEqual(
      Plan.Whole({ reason: 'packages/contracts/package.json changed' }),
    )
  })
})
