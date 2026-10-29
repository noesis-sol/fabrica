import { Effect, Exit, Option } from 'effect'
import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, layer } from '@effect/vitest'
import { Host, HostFacts } from '@fabrica/contracts'

import {
  type ModuleReport,
  Outcome,
  Plan,
  Rerun,
  type RunReport,
  ToolNotFound,
  Toolbox,
  airtightEnv,
  findTool,
  hostFacts,
  isCi,
  judgeRerun,
  layerHost,
  layerToolbox,
  makeGitRepo,
  makeToolbox,
  namePattern,
  outcomeLine,
  parseCores,
  planReruns,
  rerunRequest,
  runCommand,
  runCommandExit,
  shStub,
  tempFolder,
  testWorkers,
} from '../src'

// The shared test kit (spec §24, H55, H88): the worker count, an airtight environment and PATH, temp
// git repositories with a bare remote, injected host facts, and the reruns of failed tests, the last
// both as rules and through scripts/test-rerun.ts on the fixtures in `fixtures/`.

const exists = (path: string) =>
  Effect.promise(() =>
    access(path).then(
      () => true,
      () => false,
    ),
  )

describe('testWorkers', () => {
  const facts = (fabricaCores: string | undefined, ci: string | undefined) => ({
    fabricaCores: Option.fromNullishOr(fabricaCores),
    ci: Option.fromNullishOr(ci),
    machineCores: 10,
  })

  it('follows FABRICA_CORES, on CI too', () => {
    expect(testWorkers(facts('3', undefined))).toBe(3)
    expect(testWorkers(facts('1', 'true'))).toBe(1)
    expect(testWorkers(facts('16', undefined))).toBe(16)
  })

  it('takes half the cores without FABRICA_CORES, and every core on CI', () => {
    expect(testWorkers(facts(undefined, undefined))).toBe(5)
    expect(testWorkers(facts(undefined, 'true'))).toBe(10)
    expect(testWorkers(facts(undefined, 'false'))).toBe(5)
    expect(
      testWorkers({ ...facts(undefined, undefined), machineCores: 1 }),
    ).toBe(1)
  })

  it('ignores a FABRICA_CORES that names no cores', () => {
    for (const text of ['', '0', '-2', '2.5', 'four'])
      expect(testWorkers(facts(text, undefined))).toBe(5)
    expect(parseCores(' 4 ')).toEqual(Option.some(4))
  })

  it('takes any CI value but empty, 0 and false for CI', () => {
    expect(['true', '1', 'yes'].map(isCi)).toEqual([true, true, true])
    expect(['', '0', 'false', 'FALSE'].map(isCi)).toEqual([
      false,
      false,
      false,
      false,
    ])
  })
})

describe('airtightEnv', () => {
  it('holds only the PATH, the home, a fixed locale and zone, and the named variables', () => {
    expect(
      airtightEnv({
        path: '/kit/bin',
        home: '/kit/home',
        vars: { FOO: 'bar' },
      }),
    ).toEqual({
      PATH: '/kit/bin',
      HOME: '/kit/home',
      LANG: 'C',
      LC_ALL: 'C',
      TZ: 'UTC',
      FOO: 'bar',
    })
  })
})

describe('tempFolder', () => {
  it.effect('is removed with its contents as its scope closes', () =>
    Effect.gen(function* () {
      const folder = yield* Effect.scoped(
        Effect.gen(function* () {
          const path = yield* tempFolder('kit')
          yield* Effect.promise(() => writeFile(NodePath.join(path, 'a'), 'a'))
          expect(yield* exists(path)).toBe(true)
          return path
        }),
      )
      expect(yield* exists(folder)).toBe(false)
    }),
  )
})

describe('findTool', () => {
  it.effect('finds the first executable file by the name on the PATH', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* tempFolder('find')
        const [plain, runnable, later] = ['plain', 'runnable', 'later'].map(
          name => NodePath.join(root, name),
        )
        yield* Effect.promise(async () => {
          for (const folder of [plain, runnable, later])
            await mkdir(folder ?? '')
          await writeFile(NodePath.join(plain ?? '', 'tool'), '')
          for (const folder of [runnable, later]) {
            await writeFile(NodePath.join(folder ?? '', 'tool'), shStub('true'))
            await chmod(NodePath.join(folder ?? '', 'tool'), 0o755)
          }
        })
        const path = [plain, '', runnable, later].join(NodePath.delimiter)
        expect(yield* findTool('tool', path)).toEqual(
          Option.some(NodePath.join(runnable ?? '', 'tool')),
        )
        expect(yield* findTool('other', path)).toEqual(Option.none())
      }),
    ),
  )
})

// One toolbox for the file's tests: stubs are written once per file (tutti-6ns2).
layer(
  layerToolbox({
    tools: ['git'],
    stubs: {
      greet: shStub('echo "stubbed $*"'),
      'show-env': shStub('/usr/bin/env'),
    },
  }),
)('a toolbox', it => {
  it.effect('runs its stubs, found on its PATH', () =>
    Effect.gen(function* () {
      const tools = yield* Toolbox
      const output = yield* runCommand({
        command: 'greet',
        args: ['a', 'b'],
        cwd: tools.home,
        env: tools.env(),
      })
      expect(output).toBe('stubbed a b\n')
    }),
  )

  it.effect('holds nothing it doesn’t name', () =>
    Effect.gen(function* () {
      const tools = yield* Toolbox
      const exit = yield* Effect.exit(
        runCommand({
          command: 'ls',
          args: [],
          cwd: tools.home,
          env: tools.env(),
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.findErrorOption(exit).pipe(Option.map(e => e._tag))).toEqual(
        Option.some('CommandFailed'),
      )
    }),
  )

  it.effect('gives a command no variable it wasn’t given', () =>
    Effect.gen(function* () {
      const tools = yield* Toolbox
      const output = yield* runCommand({
        command: 'show-env',
        args: [],
        cwd: tools.home,
        env: tools.env({ NAMED: 'yes' }),
      })
      const names = output
        .split('\n')
        .filter(line => line !== '')
        .map(line => line.slice(0, line.indexOf('=')))
      // The shell sets PWD, SHLVL and `_` itself.
      expect(
        names
          .filter(name => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(name))
          .sort(),
      ).toEqual(['HOME', 'LANG', 'LC_ALL', 'NAMED', 'PATH', 'TZ'])
      expect(output).toContain(`PATH=${tools.bin}\n`)
    }),
  )

  it.effect('reports the exit code of a command that fails', () =>
    Effect.gen(function* () {
      const tools = yield* Toolbox
      const exit = yield* runCommandExit({
        command: 'git',
        args: ['no-such-command'],
        cwd: tools.home,
        env: tools.env(),
      })
      expect(exit.code).not.toBe(0)
      expect(exit.stderr).toContain('no-such-command')
    }),
  )

  it.effect('makes a checkout on main tracking a bare remote', () =>
    Effect.gen(function* () {
      const tools = yield* Toolbox
      const repo = yield* Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* makeGitRepo(tools)
          expect(yield* repo.git(['branch', '--show-current'])).toBe('main')
          expect(
            yield* repo.git(['rev-parse', '--abbrev-ref', 'main@{upstream}']),
          ).toBe('origin/main')
          expect(
            yield* repo.git(['rev-parse', '--is-bare-repository'], repo.remote),
          ).toBe('true')
          const commit = yield* repo.commit({
            files: { 'src/a.txt': 'a\n' },
            message: 'Add a',
          })
          expect(yield* repo.git(['rev-parse', 'HEAD'])).toBe(commit)
          expect(yield* repo.git(['log', '-1', '--format=%an <%ae>'])).toBe(
            'Fabrica Test <test@fabrica.invalid>',
          )
          yield* repo.git(['push', '--quiet'])
          expect(yield* repo.git(['rev-parse', 'main'], repo.remote)).toBe(
            commit,
          )
          // No configuration but the repository's: a global setting can't be read.
          const global = yield* Effect.exit(
            repo.git(['config', '--global', 'user.name']),
          )
          expect(Exit.isFailure(global)).toBe(true)
          return repo
        }),
      )
      expect(yield* exists(repo.root)).toBe(false)
    }),
  )
})

describe('makeToolbox', () => {
  it.effect('fails for a tool its PATH lacks', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const empty = yield* tempFolder('empty')
        const exit = yield* Effect.exit(
          makeToolbox({ tools: ['git'], hostPath: empty }),
        )
        expect(Exit.findErrorOption(exit)).toEqual(
          Option.some(new ToolNotFound({ tool: 'git', path: empty })),
        )
      }),
    ),
  )
})

describe('layerHost', () => {
  it.effect('gives the facts it was made with', () =>
    Effect.gen(function* () {
      const host = yield* Host
      const facts = yield* host.facts
      expect(facts).toEqual(
        new HostFacts({
          cores: 4,
          memoryBytes: 8 * 1024 ** 3,
          load: 3.5,
          home: '/nonexistent/fabrica-test-home',
        }),
      )
    }).pipe(Effect.provide(layerHost(hostFacts({ cores: 4, load: 3.5 })))),
  )

  it('defaults to a 2-core host, and refuses facts that can’t be', () => {
    expect(hostFacts().cores).toBe(2)
    expect(() => hostFacts({ cores: 0 })).toThrow()
    expect(() => hostFacts({ load: -1 })).toThrow()
  })
})

const moduleReport = (
  file: string,
  fields: Partial<Omit<ModuleReport, 'file'>> = {},
): ModuleReport => ({
  file,
  project: 'engine',
  failed: [],
  passed: [],
  errors: [],
  ...fields,
})

const stackIn = (file: string) => `Error: boom\n    at ${file}:3:9`

describe('planReruns', () => {
  it('reruns nothing when nothing failed', () => {
    expect(
      planReruns({
        modules: [moduleReport('/a.test.ts', { passed: ['t'] })],
        unhandled: [],
      }),
    ).toEqual(Plan.Passed())
  })

  it('reruns a file’s failed tests together, and a file with an error outside its tests whole', () => {
    const report: RunReport = {
      modules: [
        moduleReport('/a.test.ts', {
          failed: ['s > t1', 's > t2'],
          passed: ['u'],
        }),
        moduleReport('/b.test.ts', { passed: ['v'] }),
        moduleReport('/c.test.ts', { errors: ['SyntaxError'] }),
      ],
      unhandled: [],
    }
    expect(planReruns(report)).toEqual(
      Plan.Rerun({
        reruns: [
          Rerun.Tests({
            file: '/a.test.ts',
            project: 'engine',
            names: ['s > t1', 's > t2'],
          }),
          Rerun.File({
            file: '/c.test.ts',
            project: 'engine',
            why: 'an error outside its tests',
          }),
        ],
      }),
    )
  })

  it('sends an error between tests with its file’s rerun', () => {
    const report: RunReport = {
      modules: [
        moduleReport('/a.test.ts', { failed: ['timed out'] }),
        moduleReport('/b.test.ts', { passed: ['v'] }),
      ],
      unhandled: [
        { message: 'boom', stack: stackIn('/a.test.ts') },
        { message: 'bang', stack: stackIn('/b.test.ts') },
      ],
    }
    expect(planReruns(report)).toEqual(
      Plan.Rerun({
        reruns: [
          Rerun.Tests({
            file: '/a.test.ts',
            project: 'engine',
            names: ['timed out'],
          }),
          Rerun.File({
            file: '/b.test.ts',
            project: 'engine',
            why: 'an error between tests',
          }),
        ],
      }),
    )
  })

  it('reruns nothing for an error no test file can be blamed for', () => {
    const error = {
      message: 'boom',
      stack: 'Error: boom\n    at /elsewhere.ts:1:1',
    }
    expect(
      planReruns({
        modules: [moduleReport('/a.test.ts', { failed: ['t'] })],
        unhandled: [error],
      }),
    ).toEqual(Plan.Broken({ errors: [error] }))
  })
})

describe('judgeRerun', () => {
  const rerun = Rerun.Tests({
    file: '/a.test.ts',
    project: 'engine',
    names: ['t1', 't2'],
  })

  it('reports a test passing on its rerun flaky, and one failing again failed', () => {
    const report: RunReport = {
      modules: [moduleReport('/a.test.ts', { passed: ['t1'], failed: ['t2'] })],
      unhandled: [],
    }
    expect(judgeRerun(rerun, Option.some(report))).toEqual([
      Outcome.Flaky({ file: '/a.test.ts', name: 't1' }),
      Outcome.Failed({ file: '/a.test.ts', name: 't2' }),
    ])
  })

  it('fails every test of a rerun that wrote no report, or threw between tests', () => {
    expect(judgeRerun(rerun, Option.none())).toEqual([
      Outcome.Failed({ file: '/a.test.ts', name: 't1' }),
      Outcome.Failed({ file: '/a.test.ts', name: 't2' }),
    ])
    const report: RunReport = {
      modules: [moduleReport('/a.test.ts', { passed: ['t1', 't2'] })],
      unhandled: [{ message: 'boom', stack: stackIn('/a.test.ts') }],
    }
    expect(judgeRerun(rerun, Option.some(report)).map(o => o._tag)).toEqual([
      'Failed',
      'Failed',
    ])
  })

  it('reports a file rerun whole flaky once it passes', () => {
    const whole = Rerun.File({
      file: '/b.test.ts',
      project: 'engine',
      why: 'an error between tests',
    })
    const report: RunReport = {
      modules: [moduleReport('/b.test.ts', { passed: ['v'] })],
      unhandled: [],
    }
    expect(judgeRerun(whole, Option.some(report))).toEqual([
      Outcome.Flaky({ file: '/b.test.ts', name: '(an error between tests)' }),
    ])
    expect(
      outcomeLine(
        Outcome.Flaky({ file: '/repo/b.test.ts', name: 's > t' }),
        '/repo',
      ),
    ).toBe('FLAKY: b.test.ts > s > t')
  })
})

describe('namePattern', () => {
  it('matches exactly the names it was given', () => {
    const pattern = new RegExp(namePattern(['a > b (c) [d]', 'e.f*']))
    expect(pattern.test('a > b (c) [d]')).toBe(true)
    expect(pattern.test('e.f*')).toBe(true)
    expect(pattern.test('a > b (c) [d] more')).toBe(false)
    expect(pattern.test('eXf')).toBe(false)
  })

  it('goes into a rerun’s request only where tests are named', () => {
    expect(
      rerunRequest(Rerun.File({ file: '/b.test.ts', project: '', why: 'w' }), [
        '--bail',
      ]),
    ).toEqual({ args: ['--bail'], file: '/b.test.ts', project: '' })
  })
})

// scripts/test-rerun.ts on the fixtures: Vitest in a process of its own, in an airtight environment.
const script = fileURLToPath(
  new URL('../../../scripts/test-rerun.ts', import.meta.url),
)
const fixtures = fileURLToPath(new URL('fixtures', import.meta.url))

const runScript = (filters: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const tools = yield* makeToolbox({ hostPath: '' })
      const marks = yield* tempFolder('marks')
      return yield* runCommandExit({
        command: process.execPath,
        args: [script, ...filters],
        cwd: fixtures,
        env: tools.env({ FABRICA_FIXTURE_MARKS: marks, FABRICA_CORES: '2' }),
      })
    }),
  )

describe('scripts/test-rerun.ts', () => {
  it.effect(
    'reports a deliberately flaky test flaky after its rerun, and passes',
    () =>
      Effect.gen(function* () {
        const ran = yield* runScript(['flaky', 'stray'])
        const lines = ran.stdout.split('\n')
        expect(
          lines.filter(line => /^(?:FLAKY|FAILED): /u.test(line)).sort(),
        ).toEqual([
          'FLAKY: flaky.fixture.ts > a suite (with parens) > fails once [then passes]',
          'FLAKY: stray.fixture.ts > (an error between tests)',
        ])
        expect(ran.code).toBe(0)
      }),
    60_000,
  )

  it.effect(
    'fails for a test that fails on its rerun too',
    () =>
      Effect.gen(function* () {
        const ran = yield* runScript(['broken'])
        expect(ran.stdout).toContain(
          'FAILED: broken.fixture.ts > fails every time\n',
        )
        expect(ran.stdout).not.toContain('passes beside it\nFAILED')
        expect(ran.code).toBe(1)
      }),
    60_000,
  )
})
