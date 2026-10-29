import { Option } from 'effect'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from '@effect/vitest'

import {
  type Earlier,
  type Git,
  Plan,
  type Sources,
  earlierPass,
  keepPass,
  lastPass,
  specifiers,
  standOn,
  testsFor,
  typeChecks,
  workingTree,
  workspacePackage,
} from './check-own'

/** A repository's sources from its files' texts; a file with no text isn't a module. */
const sourcesOf = (files: Record<string, string | null>): Sources => {
  const packages = Object.entries(files).flatMap(([file, text]) =>
    file.endsWith('/package.json') && text !== null
      ? Option.toArray(
          workspacePackage(file.slice(0, -'/package.json'.length), text),
        )
      : [],
  )
  const modules = new Map(
    Object.entries(files).flatMap(([file, text]) =>
      /\.tsx?$/.test(file) && text !== null ? [[file, text] as const] : [],
    ),
  )
  return { modules, files: new Set(Object.keys(files)), packages }
}

const manifest = (name: string, exports: Record<string, string>) =>
  JSON.stringify({ name, exports })

const project = (name: string, setup = '') =>
  `import { defineProject } from 'vitest/config'\n` +
  `export default defineProject({ test: { name: '${name}'${setup} } })\n`

/**
 * Three packages: contracts, the engine importing it through the workspace, and the UI, whose
 * Vitest project has a setup file.
 */
const fixture = sourcesOf({
  'packages/contracts/package.json': manifest('@fabrica/contracts', {
    '.': './src/index.ts',
  }),
  'packages/contracts/vitest.config.ts': project('contracts'),
  'packages/contracts/src/index.ts':
    "export * from './ids'\nexport * from './events'\n",
  'packages/contracts/src/ids.ts': 'export const TicketId = 1\n',
  'packages/contracts/src/events.ts':
    "import type { TicketId } from './ids'\nexport const Event = 1\n",
  'packages/contracts/src/ids.test.ts': "import { TicketId } from './ids'\n",
  'packages/contracts/src/events.test.ts':
    "import type { TicketId } from './ids'\nimport { Event } from './events'\n",
  'packages/contracts/src/inline-type.test.ts':
    "import { type TicketId } from './ids'\n",
  'packages/contracts/src/json-schema.test.ts':
    "import { Event } from './events'\n",
  'packages/contracts/src/__snapshots__/json-schema.test.ts.snap': null,
  'packages/engine/package.json': manifest('@fabrica/engine', {
    '.': './src/index.ts',
  }),
  'packages/engine/vitest.config.ts': project('engine'),
  'packages/engine/src/store.ts':
    "import { TicketId } from '@fabrica/contracts'\nexport const store = TicketId\n",
  'packages/engine/src/shapes.ts':
    "import type { TicketId } from '@fabrica/contracts'\nexport type Shape = TicketId\n",
  'packages/engine/src/reexports.ts':
    "export type { TicketId } from '@fabrica/contracts'\nexport type * as All from '@fabrica/contracts'\n",
  'packages/engine/test/store.test.ts':
    "import { store } from '../src/store'\n",
  'packages/engine/test/shapes.test.ts':
    "import { type Shape } from '../src/shapes'\nimport '../src/reexports'\n",
  'packages/engine/test/fixture.test.ts':
    "const file = new URL('./fixtures/ticket.json', import.meta.url)\n",
  'packages/engine/test/fixtures/ticket.json': null,
  'packages/engine/test/gone.test.ts': "import { gone } from '../src/gone'\n",
  'packages/ui/package.json': manifest('@fabrica/ui', { '.': './src/main.ts' }),
  'packages/ui/vitest.config.ts': project(
    'ui',
    ", setupFiles: ['./src/vitest-setup.ts']",
  ),
  'packages/ui/src/vitest-setup.ts': "import './dom'\n",
  'packages/ui/src/dom.ts': 'export const dom = 1\n',
  'packages/ui/src/main.ts': 'export const main = 1\n',
  'packages/ui/src/story.test.ts': "import { main } from './main'\n",
  'packages/ui/src/scene.test.ts': 'export {}\n',
})

describe('specifiers', () => {
  it('leaves out type-only imports and re-exports, keeping inline type imports', () => {
    expect(
      specifiers(
        [
          "import type { A } from './a'",
          "import type * as B from './b'",
          "import type C from './c'",
          "export type { D } from './d'",
          "export type * from './e'",
          "import { type F } from './f'",
          "import type from './g'",
          "export * from './h'",
          "const i = await import('./i')",
          "import './j.css'",
        ].join('\n'),
      ),
    ).toEqual(['./f', './g', './h', './i', './j.css'])
  })
})

describe('testsFor', () => {
  it('follows imports at any depth, through the workspace packages', () => {
    expect(testsFor(['packages/contracts/src/ids.ts'], fixture)).toEqual([
      'packages/contracts/src/ids.test.ts',
      'packages/contracts/src/inline-type.test.ts',
      'packages/engine/test/store.test.ts',
    ])
  })

  it('leaves out the tests that import the change only for its types', () => {
    const selected = testsFor(['packages/contracts/src/ids.ts'], fixture)
    expect(selected).not.toContain('packages/contracts/src/events.test.ts')
    expect(selected).not.toContain('packages/engine/test/shapes.test.ts')
  })

  it('selects a changed test, and the test a snapshot belongs to', () => {
    expect(
      testsFor(
        [
          'packages/ui/src/scene.test.ts',
          'packages/contracts/src/__snapshots__/json-schema.test.ts.snap',
        ],
        fixture,
      ),
    ).toEqual([
      'packages/contracts/src/json-schema.test.ts',
      'packages/ui/src/scene.test.ts',
    ])
  })

  it('selects the tests that name a changed file by its path', () => {
    expect(
      testsFor(['packages/engine/test/fixtures/ticket.json'], fixture),
    ).toEqual(['packages/engine/test/fixture.test.ts'])
  })

  it('selects the importers of a deleted module', () => {
    expect(testsFor(['packages/engine/src/gone.ts'], fixture)).toEqual([
      'packages/engine/test/gone.test.ts',
    ])
  })

  it('selects every test of a project whose setup file the change reaches', () => {
    expect(testsFor(['packages/ui/src/dom.ts'], fixture)).toEqual([
      'packages/ui/src/scene.test.ts',
      'packages/ui/src/story.test.ts',
    ])
    expect(testsFor(['packages/engine/vitest.config.ts'], fixture)).toEqual([
      'packages/engine/test/fixture.test.ts',
      'packages/engine/test/gone.test.ts',
      'packages/engine/test/shapes.test.ts',
      'packages/engine/test/store.test.ts',
    ])
  })

  it('selects nothing for a change no test reads', () => {
    expect(testsFor(['docs/spec/fabrica-spec.md'], fixture)).toEqual([])
  })
})

describe('typeChecks', () => {
  it("checks the packages a change's TypeScript is in, and scripts/", () => {
    expect(
      typeChecks(
        [
          'packages/ui/src/dom.ts',
          'packages/contracts/src/ids.ts',
          'packages/engine/README.md',
          'scripts/check-own.ts',
        ],
        fixture.packages,
      ),
    ).toEqual({
      packages: ['@fabrica/contracts', '@fabrica/ui'],
      scripts: true,
    })
  })
})

const treeA = 'a'.repeat(40)
const treeB = 'b'.repeat(40)

const earlier = (
  tests: ReadonlyArray<string>,
  since: ReadonlyArray<string>,
): Option.Option<Earlier> =>
  Option.some({ pass: { tree: treeA, tests }, since })

describe('standOn', () => {
  it('reuses a pass on the same tree, running nothing', () => {
    const pass = { tree: treeA, tests: ['packages/ui/src/story.test.ts'] }
    expect(
      standOn({
        tree: treeA,
        sinceBase: ['packages/ui/src/main.ts'],
        earlier: Option.some({ pass, since: [] }),
        sources: fixture,
      }),
    ).toEqual(Plan.Reused({ pass }))
  })

  it('runs the whole check when the setup changed since main', () => {
    expect(
      standOn({
        tree: treeB,
        sinceBase: ['package.json', 'packages/ui/src/main.ts'],
        earlier: Option.none(),
        sources: fixture,
      }),
    ).toEqual(Plan.Whole({ reason: 'package.json changed' }))
  })

  it('runs the selected tests, with no earlier pass', () => {
    expect(
      standOn({
        tree: treeB,
        sinceBase: ['packages/contracts/src/ids.ts'],
        earlier: Option.none(),
        sources: fixture,
      }),
    ).toEqual(
      Plan.Steps({
        from: Option.none(),
        changed: ['packages/contracts/src/ids.ts'],
        tests: [
          'packages/contracts/src/ids.test.ts',
          'packages/contracts/src/inline-type.test.ts',
          'packages/engine/test/store.test.ts',
        ],
        standing: [],
        passed: [
          'packages/contracts/src/ids.test.ts',
          'packages/contracts/src/inline-type.test.ts',
          'packages/engine/test/store.test.ts',
        ],
      }),
    )
  })

  it('leaves out the tests that passed and that nothing since touches', () => {
    expect(
      standOn({
        tree: treeB,
        sinceBase: [
          'package.json',
          'packages/contracts/src/ids.ts',
          'packages/ui/src/main.ts',
        ],
        earlier: earlier(
          [
            'packages/contracts/src/ids.test.ts',
            'packages/contracts/src/inline-type.test.ts',
            'packages/engine/test/store.test.ts',
            'packages/engine/test/deleted.test.ts',
          ],
          ['packages/ui/src/main.ts', 'packages/engine/test/store.test.ts'],
        ),
        sources: fixture,
      }),
    ).toEqual(
      Plan.Steps({
        from: Option.some(treeA),
        changed: [
          'packages/ui/src/main.ts',
          'packages/engine/test/store.test.ts',
        ],
        tests: [
          'packages/engine/test/store.test.ts',
          'packages/ui/src/story.test.ts',
        ],
        standing: [
          'packages/contracts/src/ids.test.ts',
          'packages/contracts/src/inline-type.test.ts',
        ],
        passed: [
          'packages/contracts/src/ids.test.ts',
          'packages/contracts/src/inline-type.test.ts',
          'packages/engine/test/store.test.ts',
          'packages/ui/src/story.test.ts',
        ],
      }),
    )
  })

  it('runs the whole check when the setup changed since the pass', () => {
    expect(
      standOn({
        tree: treeB,
        sinceBase: ['pnpm-lock.yaml'],
        earlier: earlier([], ['pnpm-lock.yaml']),
        sources: fixture,
      }),
    ).toEqual(Plan.Whole({ reason: 'pnpm-lock.yaml changed' }))
  })
})

describe('passes kept by tree', () => {
  const folders: Array<string> = []
  afterEach(() => {
    for (const folder of folders.splice(0)) {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  /** A repository in a temp folder, with git run by its path in an environment of its own. */
  const repository = (): { readonly runner: Git; readonly gitDir: string } => {
    const cwd = mkdtempSync(join(tmpdir(), 'fabrica-check-own-'))
    folders.push(cwd)
    const runner: Git = {
      command: '/usr/bin/git',
      cwd,
      env: {
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(cwd, '.gitconfig'),
        GIT_AUTHOR_NAME: 'Fabrica',
        GIT_AUTHOR_EMAIL: 'fabrica@example.com',
        GIT_COMMITTER_NAME: 'Fabrica',
        GIT_COMMITTER_EMAIL: 'fabrica@example.com',
      },
    }
    const run = (...args: Array<string>) =>
      execFileSync(runner.command, args, { cwd, env: runner.env })
    run('init', '--quiet', '--initial-branch=main')
    writeFileSync(join(cwd, 'a.ts'), 'export const a = 1\n')
    run('add', 'a.ts')
    run('commit', '--quiet', '-m', 'a')
    const gitDir = join(cwd, '.git')
    return { runner, gitDir }
  }

  const commitAll = (runner: Git, message: string) => {
    execFileSync(runner.command, ['add', '--all'], runner)
    execFileSync(runner.command, ['commit', '--quiet', '-m', message], runner)
  }

  const tree = (runner: Git, gitDir: string): string =>
    Option.getOrThrow(workingTree(runner, gitDir))

  it('names the tree with the uncommitted and untracked files, so committing them keeps it', () => {
    const { runner, gitDir } = repository()
    const committed = tree(runner, gitDir)
    mkdirSync(join(runner.cwd, 'src'))
    writeFileSync(join(runner.cwd, 'src/b.ts'), 'export const b = 2\n')
    writeFileSync(join(runner.cwd, 'a.ts'), 'export const a = 3\n')
    const working = tree(runner, gitDir)
    expect(working).not.toEqual(committed)
    commitAll(runner, 'b')
    expect(tree(runner, gitDir)).toEqual(working)
  })

  it('reuses the pass on the same tree, after a commit of what was checked', () => {
    const { runner, gitDir } = repository()
    writeFileSync(join(runner.cwd, 'b.ts'), 'export const b = 2\n')
    const checked = tree(runner, gitDir)
    keepPass(gitDir, { tree: checked, tests: ['b.test.ts'] })
    commitAll(runner, 'b')
    const now = tree(runner, gitDir)
    const pass = earlierPass({
      runner,
      gitDir,
      tree: now,
      passedAt: Option.none(),
    })
    expect(
      standOn({
        tree: now,
        sinceBase: ['b.ts'],
        earlier: pass,
        sources: fixture,
      }),
    ).toEqual(Plan.Reused({ pass: { tree: checked, tests: ['b.test.ts'] } }))
  })

  it("stands on the engine's pass (FABRICA_CHECK_OWN_PASSED_AT) over the last one kept", () => {
    const { runner, gitDir } = repository()
    const first = tree(runner, gitDir)
    keepPass(gitDir, { tree: first, tests: ['first.test.ts'] })
    writeFileSync(join(runner.cwd, 'b.ts'), 'export const b = 2\n')
    const second = tree(runner, gitDir)
    keepPass(gitDir, { tree: second, tests: ['second.test.ts'] })
    writeFileSync(join(runner.cwd, 'c.ts'), 'export const c = 3\n')
    const now = tree(runner, gitDir)
    expect(Option.map(lastPass(gitDir), ({ tree }) => tree)).toEqual(
      Option.some(second),
    )
    expect(
      earlierPass({ runner, gitDir, tree: now, passedAt: Option.none() }),
    ).toEqual(
      Option.some({
        pass: { tree: second, tests: ['second.test.ts'] },
        since: ['c.ts'],
      }),
    )
    expect(
      earlierPass({ runner, gitDir, tree: now, passedAt: Option.some(first) }),
    ).toEqual(
      Option.some({
        pass: { tree: first, tests: ['first.test.ts'] },
        since: ['b.ts', 'c.ts'],
      }),
    )
    expect(
      earlierPass({
        runner,
        gitDir,
        tree: now,
        passedAt: Option.some('c'.repeat(40)),
      }),
    ).toEqual(Option.none())
  })
})
