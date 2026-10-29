import { Duration, Effect, Option } from 'effect'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import {
  AutoAnswer,
  CommandSetting,
  EngineSettings,
  ProjectSettings,
  machineSettingNames,
} from '@fabrica/contracts'

import {
  ProjectSettingsFile,
  SettingSource,
  type SettingsInputs,
  type SettingsProblem,
  describeSource,
  editSettingsText,
  loadSettings,
  readProjectSettingsFile,
  resolveSettings,
  settingKeys,
  sourceOf,
  writeProjectSetting,
} from '../src/settings'

// Settings resolution (spec §13.13): flags, then FABRICA_ variables, then the project's settings,
// then the engine's, each value once with its source; every problem listed together; a machine's
// setting refused in the project's file (H68); a key written keeping the file's formatting (§16).

/** A temporary checkout for one test, removed when the test ends. */
const scratch = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(NodePath.join(tmpdir(), 'fabrica-settings-'))),
  folder => Effect.promise(() => rm(folder, { recursive: true, force: true })),
)

const writeSettings = (checkout: string, text: string) =>
  Effect.promise(async () => {
    await mkdir(NodePath.join(checkout, '.fabrica'), { recursive: true })
    await writeFile(NodePath.join(checkout, '.fabrica/settings.json'), text)
  })

const readSettings = (checkout: string) =>
  Effect.promise(() =>
    readFile(NodePath.join(checkout, '.fabrica/settings.json'), 'utf8'),
  )

const inputs = (given: Partial<SettingsInputs>): SettingsInputs => ({
  flags: {},
  environment: {},
  projectFile: ProjectSettingsFile.Missing(),
  engineSettings: {},
  ...given,
})

const projectFile = (value: unknown) =>
  ProjectSettingsFile.Read({ text: JSON.stringify(value), value })

/** The problems a resolution fails with, as source, path and message. */
const problemsOf = (given: SettingsInputs) =>
  resolveSettings(given).pipe(
    Effect.flip,
    Effect.map(error =>
      error.problems.map((problem: SettingsProblem) => ({
        source: describeSource(problem.source),
        path: problem.path,
        message: problem.message,
      })),
    ),
  )

const millis = (duration: Duration.Duration) => Duration.toMillis(duration)

describe('the settings keys', () => {
  it('name every setting of both files, each with a flag and a variable of its own', () => {
    const tops = (scope: 'project' | 'engine') =>
      new Set(
        settingKeys
          .filter(key => key.scope === scope)
          .map(key => key.segments[0]),
      )
    const machine: ReadonlySet<string> = new Set(machineSettingNames)
    expect(tops('project')).toEqual(
      new Set(
        Object.keys(ProjectSettings.fields).filter(
          name => name !== '$schema' && !machine.has(name),
        ),
      ),
    )
    expect(tops('engine')).toEqual(
      new Set(
        Object.keys(EngineSettings.fields).filter(name => name !== '$schema'),
      ),
    )
    const variables = settingKeys.map(key => key.variable)
    const flags = settingKeys.map(key => key.flag)
    expect(new Set(variables).size).toBe(settingKeys.length)
    expect(new Set(flags).size).toBe(settingKeys.length)
    expect(variables).toContain('FABRICA_VERIFIER_ROUNDS')
    expect(flags).toContain('--auto-answer')
  })
})

describe('resolveSettings', () => {
  it.effect(
    'takes a flag, then a variable, then the project, then the default',
    () =>
      Effect.gen(function* () {
        const file = projectFile({ concurrent: 3 })
        const all = yield* resolveSettings(
          inputs({
            flags: { concurrent: '5' },
            environment: { FABRICA_CONCURRENT: '4' },
            projectFile: file,
          }),
        )
        expect(all.project.concurrent).toBe(5)
        expect(sourceOf(all, 'concurrent')).toEqual(
          Option.some(SettingSource.Flag({ flag: '--concurrent' })),
        )

        const noFlag = yield* resolveSettings(
          inputs({
            environment: { FABRICA_CONCURRENT: '4' },
            projectFile: file,
          }),
        )
        expect(noFlag.project.concurrent).toBe(4)
        expect(sourceOf(noFlag, 'concurrent')).toEqual(
          Option.some(
            SettingSource.Environment({ variable: 'FABRICA_CONCURRENT' }),
          ),
        )

        const fileOnly = yield* resolveSettings(inputs({ projectFile: file }))
        expect(fileOnly.project.concurrent).toBe(3)
        expect(sourceOf(fileOnly, 'concurrent')).toEqual(
          Option.some(
            SettingSource.ProjectFile({ file: '.fabrica/settings.json' }),
          ),
        )

        const none = yield* resolveSettings(inputs({}))
        expect(none.project.concurrent).toBe(2)
        expect(sourceOf(none, 'concurrent')).toEqual(
          Option.some(SettingSource.Default()),
        )
      }),
  )

  it.effect(
    "takes a machine's key from a flag or a variable over the engine's settings",
    () =>
      Effect.gen(function* () {
        const resolved = yield* resolveSettings(
          inputs({
            environment: { FABRICA_KEEP_AWAKE: 'false' },
            flags: { credentials_wait: '2h' },
            engineSettings: {
              keep_awake: true,
              worker_nice: 5,
              credentials_wait: '1h',
            },
          }),
        )
        expect(resolved.engine.keep_awake).toBe(false)
        expect(resolved.engine.worker_nice).toBe(5)
        expect(millis(resolved.engine.credentials_wait)).toBe(7_200_000)
        expect(sourceOf(resolved, 'keep_awake')).toEqual(
          Option.some(
            SettingSource.Environment({ variable: 'FABRICA_KEEP_AWAKE' }),
          ),
        )
        expect(sourceOf(resolved, 'worker_nice')).toEqual(
          Option.some(SettingSource.EngineSettings()),
        )
        expect(sourceOf(resolved, 'credentials_wait')).toEqual(
          Option.some(SettingSource.Flag({ flag: '--credentials-wait' })),
        )
        expect(sourceOf(resolved, 'stream_flush')).toEqual(
          Option.some(SettingSource.Default()),
        )
      }),
  )

  it.effect("merges a group key by key, keeping the file's other keys", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveSettings(
        inputs({
          flags: { 'verifier.rounds': '4' },
          environment: { FABRICA_ORGANS_TRIAGE_ENABLED: 'false' },
          projectFile: projectFile({
            verifier: { enabled: false, rounds: 2 },
            organs: { triage: { model: 'anthropic/claude-haiku-5-5' } },
          }),
        }),
      )
      expect(resolved.project.verifier.enabled).toBe(false)
      expect(resolved.project.verifier.rounds).toBe(4)
      expect(resolved.project.organs.triage.enabled).toBe(false)
      expect(
        Option.map(
          resolved.project.organs.triage.model,
          choice => choice.model,
        ),
      ).toEqual(Option.some('claude-haiku-5-5'))
      expect(sourceOf(resolved, 'verifier.enabled')).toEqual(
        Option.some(
          SettingSource.ProjectFile({ file: '.fabrica/settings.json' }),
        ),
      )
      expect(sourceOf(resolved, 'verifier.rounds')).toEqual(
        Option.some(SettingSource.Flag({ flag: '--verifier-rounds' })),
      )
    }),
  )

  it.effect('reads text as the key takes it: a command, a time, or JSON', () =>
    Effect.gen(function* () {
      const resolved = yield* resolveSettings(
        inputs({
          environment: {
            FABRICA_CHECK_FAST: 'true',
            FABRICA_AUTO_ANSWER: 'true',
            FABRICA_QUESTION_WAIT: '20m',
            FABRICA_SHARED_FILES: '["CHANGELOG.md"]',
            FABRICA_MODEL: 'anthropic/claude-opus-5-5',
            FABRICA_CORES: '4',
          },
          flags: { 'budgets.run': '{"usd": 20}' },
        }),
      )
      expect(resolved.project.check_fast).toEqual(
        CommandSetting.cases.Command.make({ command: 'true' }),
      )
      expect(resolved.engine.auto_answer).toEqual(
        AutoAnswer.cases.AtOnce.make({}),
      )
      expect(millis(resolved.project.question_wait)).toBe(1_200_000)
      expect(resolved.project.shared_files).toEqual(['CHANGELOG.md'])
      expect(
        Option.map(resolved.project.model, choice => choice.provider),
      ).toEqual(Option.some('anthropic'))
      expect(Option.isSome(resolved.project.budgets.run)).toBe(true)
    }),
  )

  it.effect('lists every problem in every source at once', () =>
    Effect.gen(function* () {
      const found = yield* problemsOf(
        inputs({
          flags: { worker_nice: '99', limit: '3' },
          environment: { FABRICA_QUESTION_WAIT: 'soon' },
          projectFile: projectFile({
            concurrent: 0,
            colour: 'blue',
            requires: [{ name: 'jq', check: 'jq --version' }],
          }),
          engineSettings: { view_interval: 'often' },
        }),
      )
      const where = found.map(problem => `${problem.source} ${problem.path}`)
      expect(where).toEqual(
        expect.arrayContaining([
          '--limit limit',
          '--worker-nice worker_nice',
          'FABRICA_QUESTION_WAIT question_wait',
          '.fabrica/settings.json concurrent',
          '.fabrica/settings.json colour',
          '.fabrica/settings.json requires.0',
          "the engine's settings view_interval",
        ]),
      )
      expect(found).toHaveLength(7)
    }),
  )

  it.effect(
    "refuses a person's or a machine's setting in the project's settings",
    () =>
      Effect.gen(function* () {
        const found = yield* problemsOf(
          inputs({
            projectFile: projectFile({ keep_awake: false, auto_answer: '10m' }),
          }),
        )
        expect(found.map(problem => problem.path).sort()).toEqual([
          'auto_answer',
          'keep_awake',
        ])
        for (const problem of found) {
          expect(problem.source).toBe('.fabrica/settings.json')
          expect(problem.message).toContain("a person's or a machine's choice")
        }
        const engine = yield* resolveSettings(
          inputs({ engineSettings: { keep_awake: false, auto_answer: '10m' } }),
        )
        expect(engine.engine.keep_awake).toBe(false)
        expect(engine.engine.auto_answer).toEqual(
          AutoAnswer.cases.After.make({ wait: Duration.minutes(10) }),
        )
      }),
  )

  it.effect(
    "reports a project file that couldn't be read beside the rest",
    () =>
      Effect.gen(function* () {
        const found = yield* problemsOf(
          inputs({
            projectFile: ProjectSettingsFile.Unreadable({
              reason: "it isn't JSON",
            }),
            environment: { FABRICA_CONCURRENT: 'many' },
          }),
        )
        expect(found.map(problem => problem.source)).toEqual([
          '.fabrica/settings.json',
          'FABRICA_CONCURRENT',
        ])
        expect(found[0]?.message).toContain("it isn't JSON")
      }),
  )
})

describe('readProjectSettingsFile', () => {
  it.effect('reads a checkout without settings as every default', () =>
    Effect.gen(function* () {
      const checkout = yield* scratch
      const resolved = yield* loadSettings({
        checkout,
        flags: {},
        environment: {},
        engineSettings: {},
      })
      expect(resolved.project.concurrent).toBe(2)
      expect(
        resolved.sources.every(({ source }) => source._tag === 'Default'),
      ).toBe(true)
    }),
  )

  it.effect('reads the file, and refuses one that is a link or not JSON', () =>
    Effect.gen(function* () {
      const checkout = yield* scratch
      yield* writeSettings(checkout, '{ "concurrent": 6 }\n')
      const resolved = yield* loadSettings({
        checkout,
        flags: {},
        environment: {},
        engineSettings: {},
      })
      expect(resolved.project.concurrent).toBe(6)

      yield* writeSettings(checkout, '{ "concurrent": ')
      expect((yield* readProjectSettingsFile(checkout))._tag).toBe('Unreadable')

      const linked = yield* scratch
      yield* Effect.promise(() => mkdir(NodePath.join(linked, '.fabrica')))
      yield* Effect.promise(() =>
        symlink(
          NodePath.join(checkout, '.fabrica/settings.json'),
          NodePath.join(linked, '.fabrica/settings.json'),
        ),
      )
      const read = yield* readProjectSettingsFile(linked)
      expect(read._tag).toBe('Unreadable')
    }),
  )
})

describe('editSettingsText', () => {
  const edit = (text: string, path: string, value: Option.Option<unknown>) =>
    editSettingsText({ text, path, value })

  const file = [
    '{',
    '    "concurrent":   3,',
    '    "check_fast": "pnpm test",',
    '    "verifier": { "rounds": 2 },',
    '    "setup_files": ["package.json",',
    '                    "pnpm-lock.yaml"]',
    '}',
    '',
  ].join('\n')

  it.effect('replaces a key without reformatting the rest', () =>
    Effect.gen(function* () {
      expect(yield* edit(file, 'check_fast', Option.some('none'))).toBe(
        file.replace('"pnpm test"', '"none"'),
      )
      expect(yield* edit(file, 'verifier.rounds', Option.some(5))).toBe(
        file.replace('"rounds": 2', '"rounds": 5'),
      )
    }),
  )

  it.effect('adds a key beside its neighbours, with their indentation', () =>
    Effect.gen(function* () {
      expect(
        yield* edit(file, 'budgets', Option.some({ run: { usd: 20 } })),
      ).toBe(
        file.replace(
          '"pnpm-lock.yaml"]\n',
          [
            '"pnpm-lock.yaml"],',
            '    "budgets": {',
            '        "run": {',
            '            "usd": 20',
            '        }',
            '    }',
            '',
          ].join('\n'),
        ),
      )
      expect(yield* edit(file, 'verifier.enabled', Option.some(false))).toBe(
        file.replace('{ "rounds": 2 }', '{ "rounds": 2, "enabled": false }'),
      )
      expect(yield* edit(file, 'merge.train', Option.some(0))).toContain(
        '"merge": {\n        "train": 0\n    }\n}',
      )
    }),
  )

  it.effect('removes a key with its comma', () =>
    Effect.gen(function* () {
      expect(yield* edit(file, 'check_fast', Option.none())).toBe(
        file.replace('    "check_fast": "pnpm test",\n', ''),
      )
      expect(yield* edit(file, 'setup_files', Option.none())).toBe(
        file.replace(
          ',\n    "setup_files": ["package.json",\n                    "pnpm-lock.yaml"]',
          '',
        ),
      )
      expect(yield* edit(file, 'push', Option.none())).toBe(file)
    }),
  )

  it.effect('keeps line endings, one-line files, and starts an empty one', () =>
    Effect.gen(function* () {
      expect(
        yield* edit(
          '{\r\n  "concurrent": 3\r\n}\r\n',
          'push',
          Option.some('never'),
        ),
      ).toBe('{\r\n  "concurrent": 3,\r\n  "push": "never"\r\n}\r\n')
      expect(yield* edit('{"concurrent":3}', 'requires', Option.some([]))).toBe(
        '{"concurrent":3,"requires":[]}',
      )
      expect(yield* edit('{}\n', 'concurrent', Option.some(4))).toBe(
        '{\n  "concurrent": 4\n}\n',
      )
      expect(yield* edit('', 'verifier.rounds', Option.some(4))).toBe(
        '{\n  "verifier": {\n    "rounds": 4\n  }\n}\n',
      )
      const failed = yield* Effect.flip(
        edit('[1]', 'concurrent', Option.some(4)),
      )
      expect(failed._tag).toBe('SettingsFileNotJson')
    }),
  )
})

describe('writeProjectSetting', () => {
  it.effect("writes one key of the checkout's file, keeping the rest", () =>
    Effect.gen(function* () {
      const checkout = yield* scratch
      const text = '{\n\t"concurrent": 3,\n\t"check_fast":"pnpm test"\n}\n'
      yield* writeSettings(checkout, text)
      yield* writeProjectSetting({
        checkout,
        path: 'check_full',
        value: Option.some('pnpm test:all'),
      })
      expect(yield* readSettings(checkout)).toBe(
        '{\n\t"concurrent": 3,\n\t"check_fast":"pnpm test",\n\t"check_full":"pnpm test:all"\n}\n',
      )
    }),
  )

  it.effect("refuses a value that doesn't decode, or a machine's setting", () =>
    Effect.gen(function* () {
      const checkout = yield* scratch
      yield* writeSettings(checkout, '{}\n')
      const machine = yield* Effect.flip(
        writeProjectSetting({
          checkout,
          path: 'keep_awake',
          value: Option.some(false),
        }),
      )
      expect(machine._tag).toBe('SettingsProblems')
      expect(machine.message).toContain("a person's or a machine's choice")
      const bad = yield* Effect.flip(
        writeProjectSetting({
          checkout,
          path: 'check_timeout',
          value: Option.some('soon'),
        }),
      )
      expect(bad._tag).toBe('SettingsProblems')
      expect(yield* readSettings(checkout)).toBe('{}\n')

      yield* writeSettings(checkout, '{\n  "keep_awake": true\n}\n')
      yield* writeProjectSetting({
        checkout,
        path: 'keep_awake',
        value: Option.none(),
      })
      expect(yield* readSettings(checkout)).toBe('{}\n')
    }),
  )
})
