import { Effect, Option } from 'effect'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, layer } from '@effect/vitest'

import {
  Toolbox,
  layerToolbox,
  tempFolder,
} from '../packages/testkit/src/index.ts'
import {
  type Checked,
  Ran,
  type Run,
  Step,
  checkWrite,
  checkWritten,
  claudeWritten,
  inRepository,
  lintDiagnostics,
  readPackages,
  report,
  repositoryRoot,
  spawnRun,
  stepOf,
  tsconfigsFor,
  tsconfigsOf,
  typeDiagnostics,
  typedPackage,
} from './check-write'
import { type ToolResultEvent, afterWrite, piWritten } from './pi-checks/index'

// The checks after every agent write (spec §23): which files and type checks a write reaches, how
// effect-tsgo's and oxlint's output is read and narrowed to the written files, the report, the Claude Code
// hook's input, the Pi package's tool_result handler, and the real tools on a repository of a test's.

const root = '/repo'

const packages = [
  typedPackage(
    '',
    JSON.stringify({
      scripts: {
        typecheck:
          'pnpm --recursive run typecheck && effect-tsgo tsc --noEmit -p scripts/tsconfig.json',
      },
    }),
  ),
  typedPackage(
    'apps/desktop',
    JSON.stringify({
      scripts: {
        typecheck:
          'effect-tsgo tsc --noEmit -p tsconfig.node.json && effect-tsgo tsc --noEmit -p tsconfig.web.json',
      },
    }),
  ),
  typedPackage(
    'packages/contracts',
    JSON.stringify({
      scripts: { typecheck: 'effect-tsgo tsc --noEmit -p tsconfig.json' },
    }),
  ),
  typedPackage('packages/bare', JSON.stringify({ name: 'bare' })),
]

/** A run answering each command with `answer`, keeping what it was asked. */
const fakeRun = (
  answer: (command: string, args: ReadonlyArray<string>) => Ran,
) => {
  const asked: Array<ReadonlyArray<string>> = []
  const run: Run = (command, args) => {
    asked.push([command, ...args])
    return Promise.resolve(answer(command, args))
  }
  return { asked, run }
}

const passed = () => Ran.Exited({ code: 0, output: '' })

describe('which files and type checks a write reaches', () => {
  it('takes the files in the repository, from the folder the tool ran in', () => {
    expect(inRepository(root, root, 'packages/a.ts')).toEqual(
      Option.some('packages/a.ts'),
    )
    expect(inRepository(root, '/repo/packages', './a.ts')).toEqual(
      Option.some('packages/a.ts'),
    )
    expect(inRepository(root, root, '/repo/scripts/b.ts')).toEqual(
      Option.some('scripts/b.ts'),
    )
    expect(inRepository(root, root, '/elsewhere/a.ts')).toEqual(Option.none())
    expect(inRepository(root, root, '../repo-other/a.ts')).toEqual(
      Option.none(),
    )
    expect(inRepository(root, root, '.')).toEqual(Option.none())
  })

  it("reads a package's tsconfigs from its typecheck script", () => {
    expect(
      tsconfigsOf(
        'apps/desktop',
        'effect-tsgo tsc --noEmit -p tsconfig.node.json && effect-tsgo tsc --noEmit --project=tsconfig.web.json',
      ),
    ).toEqual([
      'apps/desktop/tsconfig.node.json',
      'apps/desktop/tsconfig.web.json',
    ])
    expect(packages[0]?.tsconfigs).toEqual(['scripts/tsconfig.json'])
    expect(packages[3]?.tsconfigs).toEqual([])
  })

  it("type checks a file with its package's tsconfigs, else the root's", () => {
    expect(tsconfigsFor('apps/desktop/src/main/index.ts', packages)).toEqual([
      'apps/desktop/tsconfig.node.json',
      'apps/desktop/tsconfig.web.json',
    ])
    expect(tsconfigsFor('packages/contracts/src/ids.ts', packages)).toEqual([
      'packages/contracts/tsconfig.json',
    ])
    expect(tsconfigsFor('scripts/check-own.ts', packages)).toEqual([
      'scripts/tsconfig.json',
    ])
    expect(tsconfigsFor('packages/contracts-two/a.ts', packages)).toEqual([
      'scripts/tsconfig.json',
    ])
    expect(tsconfigsFor('packages/bare/a.ts', packages)).toEqual([])
  })

  it("reads this repository's packages, each with the type checks it runs", () => {
    const own = readPackages(repositoryRoot())
    expect(own.find(({ dir }) => dir === '')?.tsconfigs).toEqual([
      'scripts/tsconfig.json',
    ])
    expect(own.find(({ dir }) => dir === 'apps/desktop')?.tsconfigs).toEqual([
      'apps/desktop/tsconfig.node.json',
      'apps/desktop/tsconfig.connection.json',
      'apps/desktop/tsconfig.web.json',
    ])
  })
})

describe("reading the checks' output", () => {
  it("reads effect-tsgo's diagnostics, their indented lines and those about no file", () => {
    const output = [
      "a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "b.ts(3,1): error TS2345: Argument of type '{ a: string; }' is not assignable.",
      "  Types of property 'a' are incompatible.",
      'error TS5083: Cannot read file tsconfig.base.json.',
      '',
    ].join('\n')
    expect(typeDiagnostics(output)).toEqual([
      {
        file: Option.some('a.ts'),
        text: "a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      },
      {
        file: Option.some('b.ts'),
        text:
          "b.ts(3,1): error TS2345: Argument of type '{ a: string; }' is not assignable.\n" +
          "  Types of property 'a' are incompatible.",
      },
      {
        file: Option.none(),
        text: 'error TS5083: Cannot read file tsconfig.base.json.',
      },
    ])
  })

  it("reads oxlint's unix lines, leaving out its count", () => {
    const output =
      "a.ts:2:7: Variable 'x' is declared but never used. [Error/eslint(no-unused-vars)]\n\n1 problem\n"
    expect(lintDiagnostics(output)).toEqual([
      {
        file: Option.some('a.ts'),
        text: "a.ts:2:7: Variable 'x' is declared but never used. [Error/eslint(no-unused-vars)]",
      },
    ])
  })

  it('keeps the problems in the written files and those about no file', () => {
    const output = [
      'packages/a/x.ts(1,1): error TS1: in the written file',
      'packages/a/y.ts(1,1): error TS2: in another',
      'error TS3: about no file',
    ].join('\n')
    const step = stepOf({
      ran: Ran.Exited({ code: 2, output }),
      root,
      files: ['packages/a/x.ts'],
      diagnostics: typeDiagnostics,
    })
    expect(step).toEqual(
      Step.Found({
        problems: [
          'packages/a/x.ts(1,1): error TS1: in the written file',
          'error TS3: about no file',
        ],
      }),
    )
  })

  it('passes a check whose problems are all in other files', () => {
    const step = stepOf({
      ran: Ran.Exited({
        code: 2,
        output: 'packages/a/y.ts(1,1): error TS2: in another\n',
      }),
      root,
      files: ['packages/a/x.ts'],
      diagnostics: typeDiagnostics,
    })
    expect(step).toEqual(Step.Passed())
  })

  it('gives the whole output of a failed check it could not read, and says when a check could not run', () => {
    const unread = (output: string) =>
      stepOf({
        ran: Ran.Exited({ code: 1, output }),
        root,
        files: ['a.ts'],
        diagnostics: lintDiagnostics,
      })
    expect(unread('Failed to parse the config\n')).toEqual(
      Step.Found({ problems: ['Failed to parse the config'] }),
    )
    expect(unread('')).toEqual(Step.Found({ problems: ['exited with 1'] }))
    expect(
      stepOf({
        ran: Ran.Failed({ reason: 'effect-tsgo: spawn ENOENT' }),
        root,
        files: ['a.ts'],
        diagnostics: typeDiagnostics,
      }),
    ).toEqual(Step.NotRun({ reason: 'effect-tsgo: spawn ENOENT' }))
  })
})

describe('the checks after a write', () => {
  const bin = (tool: string) => `/bin/${tool}`

  it.effect(
    'runs each type check the written files reach and oxlint on them',
    () =>
      Effect.promise(async () => {
        const { asked, run } = fakeRun(passed)
        const checks = await checkWrite({
          root,
          files: [
            'packages/contracts/src/ids.ts',
            'apps/desktop/src/main/a.ts',
          ],
          packages,
          run,
          bin,
        })
        expect(checks.map(({ name }) => name)).toEqual([
          'type check (apps/desktop/tsconfig.node.json)',
          'type check (apps/desktop/tsconfig.web.json)',
          'type check (packages/contracts/tsconfig.json)',
          'oxlint',
        ])
        expect(checks.every(({ step }) => Step.$is('Passed')(step))).toBe(true)
        expect(asked).toContainEqual([
          '/bin/effect-tsgo',
          'tsc',
          '--noEmit',
          '--pretty',
          'false',
          '-p',
          'packages/contracts/tsconfig.json',
        ])
        expect(asked).toContainEqual([
          '/bin/oxlint',
          '--deny-warnings',
          '--no-error-on-unmatched-pattern',
          '--format',
          'unix',
          'apps/desktop/src/main/a.ts',
          'packages/contracts/src/ids.ts',
        ])
      }),
  )

  it.effect('runs nothing for a file that is no module', () =>
    Effect.promise(async () => {
      const { asked, run } = fakeRun(passed)
      const checks = await checkWrite({
        root,
        files: ['README.md', 'packages/contracts/package.json'],
        packages,
        run,
        bin,
      })
      expect(checks).toEqual([])
      expect(asked).toEqual([])
    }),
  )

  it('reports nothing where every check passed, else each problem under its check', () => {
    const files = ['packages/a/x.ts']
    const clean: ReadonlyArray<Checked> = [
      { name: 'oxlint', step: Step.Passed() },
    ]
    expect(report(files, clean)).toEqual(Option.none())
    const text = Option.getOrThrow(
      report(files, [
        {
          name: 'type check (packages/a/tsconfig.json)',
          step: Step.Found({ problems: ['x.ts(1,1): error TS1: wrong'] }),
        },
        {
          name: 'oxlint',
          step: Step.NotRun({ reason: 'oxlint: spawn ENOENT' }),
        },
      ]),
    )
    expect(text).toContain('found problems in packages/a/x.ts')
    expect(text).toContain(
      'type check (packages/a/tsconfig.json):\nx.ts(1,1): error TS1: wrong',
    )
    expect(text).toContain('oxlint could not run: oxlint: spawn ENOENT')
  })

  it("reads the written file from a Claude Code hook's input", () => {
    expect(
      claudeWritten({
        cwd: '/repo',
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: '/repo/a.ts',
          old_string: 'a',
          new_string: 'b',
        },
      }),
    ).toEqual(Option.some({ cwd: '/repo', path: '/repo/a.ts' }))
    expect(
      claudeWritten({ cwd: '/repo', tool_input: { notebook_path: 'a.ipynb' } }),
    ).toEqual(Option.none())
    expect(claudeWritten(null)).toEqual(Option.none())
  })
})

describe("the Pi package's tool_result handler", () => {
  const event = (fields: Partial<ToolResultEvent>): ToolResultEvent => ({
    toolName: 'write',
    input: { path: 'packages/contracts/src/a.ts', content: '' },
    content: [{ type: 'text', text: 'Wrote 1 line' }],
    isError: false,
    ...fields,
  })

  it('takes the file of a write or edit that succeeded, and of nothing else', () => {
    expect(piWritten(event({}))).toEqual(
      Option.some('packages/contracts/src/a.ts'),
    )
    expect(
      piWritten(
        event({ toolName: 'edit', input: { path: 'b.ts', edits: [] } }),
      ),
    ).toEqual(Option.some('b.ts'))
    expect(piWritten(event({ isError: true }))).toEqual(Option.none())
    expect(piWritten(event({ toolName: 'read' }))).toEqual(Option.none())
  })

  it.effect("adds the checks' report to the tool's result", () =>
    Effect.promise(async () => {
      const { run } = fakeRun((command, args) =>
        command.endsWith('oxlint')
          ? Ran.Exited({
              code: 1,
              output: `${args.at(-1) ?? ''}:1:1: debugger [Error/eslint(no-debugger)]\n`,
            })
          : passed(),
      )
      const patch = await afterWrite({
        event: event({}),
        cwd: repositoryRoot(),
        root: repositoryRoot(),
        run,
        bin: tool => tool,
      })
      expect(patch?.content[0]).toEqual({ type: 'text', text: 'Wrote 1 line' })
      expect(patch?.content[1]).toEqual({
        type: 'text',
        text: expect.stringContaining(
          'packages/contracts/src/a.ts:1:1: debugger [Error/eslint(no-debugger)]',
        ),
      })
    }),
  )

  it.effect(
    'leaves the result as it is where the checks passed or nothing was written',
    () =>
      Effect.promise(async () => {
        const { asked, run } = fakeRun(passed)
        const after = (fields: Partial<ToolResultEvent>) =>
          afterWrite({
            event: event(fields),
            cwd: repositoryRoot(),
            root: repositoryRoot(),
            run,
            bin: tool => tool,
          })
        expect(await after({})).toBeUndefined()
        const ran = asked.length
        expect(
          await after({ toolName: 'bash', input: { command: 'ls' } }),
        ).toBe(undefined)
        expect(asked.length).toBe(ran)
      }),
  )
})

// The real effect-tsgo and oxlint, the repository's own, on a repository of the test's: a package whose
// typecheck script names its tsconfig, and an oxlint config of its own.
layer(layerToolbox({ tools: ['node'] }))('the real checks', it => {
  it.effect(
    'find the type error and the lint error in the written file, and nothing in a clean one',
    () =>
      Effect.gen(function* () {
        const tools = yield* Toolbox
        const repo = yield* tempFolder('check-write')
        const write = (file: string, text: string) =>
          Effect.promise(async () => {
            await mkdir(join(repo, file, '..'), { recursive: true })
            await writeFile(join(repo, file), text)
          })
        yield* write(
          'packages/a/package.json',
          JSON.stringify({
            scripts: { typecheck: 'effect-tsgo tsc --noEmit -p tsconfig.json' },
          }),
        )
        yield* write(
          'packages/a/tsconfig.json',
          JSON.stringify({
            compilerOptions: { strict: true, noEmit: true, types: [] },
            include: ['src/*.ts'],
          }),
        )
        yield* write(
          '.oxlintrc.json',
          JSON.stringify({ rules: { 'no-debugger': 'error' } }),
        )
        yield* write(
          'packages/a/src/bad.ts',
          'export const n: number = "one"\nexport const f = () => {\n  debugger\n}\n',
        )
        yield* write('packages/a/src/good.ts', 'export const m: number = 1\n')
        const own = repositoryRoot()
        const check = (path: string) =>
          Effect.promise(() =>
            checkWritten({
              root: repo,
              cwd: repo,
              paths: [path],
              run: spawnRun(repo, tools.env()),
              bin: tool => join(own, 'node_modules', '.bin', tool),
            }),
          )
        const found = Option.getOrThrow(yield* check('packages/a/src/bad.ts'))
        expect(found).toContain('packages/a/src/bad.ts(1,14): error TS2322')
        expect(found).toMatch(/packages\/a\/src\/bad\.ts:3:3: .*no-debugger/)
        expect(yield* check(join(repo, 'packages/a/src/good.ts'))).toEqual(
          Option.none(),
        )
        // The checkout reached through a link, as macOS's /var links to /private/var.
        const linked = join(yield* tempFolder('check-write-link'), 'repo')
        yield* Effect.promise(() => symlink(repo, linked))
        const throughLink = (input: { root: string; path: string }) =>
          Effect.promise(() =>
            checkWritten({
              root: input.root,
              cwd: linked,
              paths: [input.path],
              run: spawnRun(repo, tools.env()),
              bin: tool => join(own, 'node_modules', '.bin', tool),
            }),
          )
        for (const root of [linked, repo]) {
          const report = Option.getOrThrow(
            yield* throughLink({ root, path: 'packages/a/src/bad.ts' }),
          )
          expect(report).toContain('packages/a/src/bad.ts(1,14): error TS2322')
        }
      }),
    60_000,
  )
})
