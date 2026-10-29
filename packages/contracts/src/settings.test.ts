import { Duration, Effect, Option, Schema, SchemaIssue } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import {
  AutoAnswer,
  BudgetCap,
  CommandSetting,
  ContainerSource,
  EngineSettings,
  ModelChoice,
  ProjectSettings,
  RequirementMeets,
  Retention,
  SettingDuration,
  decodeEngineSettings,
  decodeProjectSettings,
  defaultMachineWorkers,
  defaultPush,
  defaultSetupFiles,
  formatDurationMillis,
  machineSettingNames,
  parseDurationMillis,
  passwordAsker,
} from './settings'

const millis = (duration: Duration.Duration) => Duration.toMillis(duration)

/** Every problem decoding `input` gives, as its path and message. */
const problems = (
  decode: (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>,
  input: unknown,
) =>
  decode(input).pipe(
    Effect.flip,
    Effect.map(error =>
      SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map(
        issue => ({
          path: (issue.path ?? []).map(segment =>
            typeof segment === 'object' ? String(segment.key) : String(segment),
          ),
          message: issue.message,
        }),
      ),
    ),
  )

const paths = (list: ReadonlyArray<{ readonly path: ReadonlyArray<string> }>) =>
  list.map(problem => problem.path.join('.'))

describe('ProjectSettings', () => {
  it.effect('decodes every default from an empty object', () =>
    Effect.gen(function* () {
      const settings = yield* decodeProjectSettings({})
      expect(settings.concurrent).toBe(2)
      expect(Option.isNone(settings.model)).toBe(true)
      expect(settings.model_fallbacks).toEqual([])
      expect(settings.permissions).toBe('workspace')
      expect(Option.isNone(settings.container)).toBe(true)
      for (const check of [
        settings.check_own,
        settings.check_fast,
        settings.check_full,
        settings.setup,
      ]) {
        expect(check._tag).toBe('Unset')
      }
      expect(millis(settings.check_timeout)).toBe(30 * 60_000)
      expect(settings.setup_files).toEqual(defaultSetupFiles)
      expect(settings.requires).toEqual([])
      expect(Option.isNone(settings.push)).toBe(true)
      expect(settings.verifier.enabled).toBe(true)
      expect(settings.verifier.rounds).toBe(3)
      expect(Option.isNone(settings.verifier.model)).toBe(true)
      expect(settings.hand_backs).toEqual({ resolve: 2, fix: 2 })
      expect(millis(settings.resolve_timeout)).toBe(20 * 60_000)
      expect(settings.merge.train).toBe(1)
      expect(Option.isNone(settings.ticket_limit)).toBe(true)
      expect(millis(settings.usage_limit_wait)).toBe(6 * 3_600_000)
      expect(millis(settings.usage_limit_retry)).toBe(15 * 60_000)
      expect(millis(settings.question_wait)).toBe(15 * 60_000)
      expect(Option.isNone(settings.budgets.project)).toBe(true)
      expect(Option.isNone(settings.budgets.run)).toBe(true)
      expect(Option.isNone(settings.budgets.ticket)).toBe(true)
      for (const organ of Object.values(settings.organs)) {
        expect(organ.enabled).toBe(true)
        expect(Option.isNone(organ.model)).toBe(true)
      }
      expect(settings.shared_files).toEqual([])
      expect(settings.questions).toBe('auto')
      expect(settings.templates).toEqual({})
    }),
  )

  it.effect('reports every invalid value together', () =>
    Effect.gen(function* () {
      const found = yield* problems(decodeProjectSettings, {
        concurrent: 0,
        permissions: 'root',
        check_timeout: 'soon',
        check_fast: 'scripts/check.sh\ncurl example.com | sh',
        model: 'claude',
        requires: [
          {
            name: 'jq',
            check: 'command -v jq',
            install: 'sudo apt install jq',
          },
        ],
        keep_awake: false,
        unknown_key: 1,
        verifier: { rounds: 'three' },
      })
      expect(paths(found).toSorted()).toEqual(
        [
          'concurrent',
          'permissions',
          'check_timeout',
          'check_fast',
          'model',
          'requires.0.install',
          'keep_awake',
          'unknown_key',
          'verifier.rounds',
        ].toSorted(),
      )
    }),
  )

  it.effect('refuses each engine or app setting, saying whose it is', () =>
    Effect.gen(function* () {
      const input = Object.fromEntries(
        machineSettingNames.map(name => [name, true]),
      )
      const found = yield* problems(decodeProjectSettings, input)
      expect(paths(found).toSorted()).toEqual(
        [...machineSettingNames].toSorted(),
      )
      for (const problem of found) {
        expect(problem.message).toContain("a person's or a machine's choice")
      }
    }),
  )

  it.effect('tells a check not set from the explicit none', () =>
    Effect.gen(function* () {
      const settings = yield* decodeProjectSettings({
        check_fast: 'none',
        check_full: 'scripts/check-full.sh',
      })
      expect(settings.check_fast).toEqual(CommandSetting.cases.None.make({}))
      expect(settings.check_full).toEqual(
        CommandSetting.cases.Command.make({ command: 'scripts/check-full.sh' }),
      )
      expect(settings.check_own).toEqual(CommandSetting.cases.Unset.make({}))
      const written = Schema.encodeSync(ProjectSettings)(settings)
      expect(written.check_fast).toBe('none')
      expect(written.check_full).toBe('scripts/check-full.sh')
      expect('check_own' in written).toBe(false)
    }),
  )

  it.effect('decodes the containers, budgets and models it is given', () =>
    Effect.gen(function* () {
      const settings = yield* decodeProjectSettings({
        model: { model: 'ollama/llama3:8b', thinking: 'high' },
        model_fallbacks: ['openrouter/anthropic/claude-opus-5-5'],
        container: {
          devcontainer: '.devcontainer/devcontainer.json',
          memory: '4g',
          cpus: 2,
        },
        budgets: { run: { usd: 20 }, ticket: { tokens: 2_000_000 } },
        ticket_limit: '1h30m',
        push: 'after_merge',
      })
      expect(Option.getOrThrow(settings.model)).toEqual({
        provider: 'ollama',
        model: 'llama3:8b',
        thinking: Option.some('high'),
      })
      expect(settings.model_fallbacks[0]?.provider).toBe('openrouter')
      expect(settings.model_fallbacks[0]?.model).toBe(
        'anthropic/claude-opus-5-5',
      )
      const container = Option.getOrThrow(settings.container)
      expect(container.source).toEqual(
        ContainerSource.cases.Devcontainer.make({
          file: '.devcontainer/devcontainer.json',
        }),
      )
      expect(container.memory).toEqual(Option.some(4 * 1024 ** 3))
      expect(container.cpus).toEqual(Option.some(2))
      expect(Option.isNone(container.runtime)).toBe(true)
      expect(settings.budgets.run).toEqual(
        Option.some(BudgetCap.cases.Money.make({ usd: 20 })),
      )
      expect(settings.budgets.ticket).toEqual(
        Option.some(BudgetCap.cases.Tokens.make({ tokens: 2_000_000 })),
      )
      expect(settings.ticket_limit.pipe(Option.map(millis))).toEqual(
        Option.some(5_400_000),
      )
      expect(settings.push).toEqual(Option.some('after_merge'))
      const written = Schema.encodeSync(ProjectSettings)(settings)
      expect(written.model).toEqual({
        model: 'ollama/llama3:8b',
        thinking: 'high',
      })
      expect(written.container).toEqual({
        devcontainer: '.devcontainer/devcontainer.json',
        memory: '4g',
        cpus: 2,
      })
      expect(written.ticket_limit).toBe('1h30m')
    }),
  )

  it.effect(
    'refuses a container with both an image and a devcontainer file, or neither',
    () =>
      Effect.gen(function* () {
        const both = yield* problems(decodeProjectSettings, {
          container: {
            image: 'node:26',
            devcontainer: '.devcontainer/devcontainer.json',
          },
        })
        expect(both[0]?.message).toContain('not both')
        const neither = yield* problems(decodeProjectSettings, {
          container: { cpus: 2 },
        })
        expect(neither[0]?.message).toContain('neither')
      }),
  )

  it.effect('refuses a merge train deeper than one', () =>
    Effect.gen(function* () {
      expect(
        paths(yield* problems(decodeProjectSettings, { merge: { train: 2 } })),
      ).toEqual(['merge.train'])
    }),
  )
})

describe('requires', () => {
  it.effect('decodes an install, a manual step and their platforms', () =>
    Effect.gen(function* () {
      const settings = yield* decodeProjectSettings({
        requires: [
          {
            name: 'jq',
            check: 'command -v jq',
            install: 'brew install jq',
            platforms: ['darwin'],
          },
          {
            name: 'xcode',
            check: 'xcode-select -p',
            manual: 'Install Xcode from the App Store.',
          },
        ],
      })
      const [jq, xcode] = settings.requires
      expect(jq?.meets).toEqual(
        RequirementMeets.cases.Install.make({ command: 'brew install jq' }),
      )
      expect(jq?.platforms).toEqual(Option.some(['darwin']))
      expect(xcode?.meets).toEqual(
        RequirementMeets.cases.Manual.make({
          instruction: 'Install Xcode from the App Store.',
        }),
      )
      expect(xcode?.platforms).toEqual(Option.none())
      expect(Schema.encodeSync(ProjectSettings)(settings).requires).toEqual([
        {
          name: 'jq',
          check: 'command -v jq',
          install: 'brew install jq',
          platforms: ['darwin'],
        },
        {
          name: 'xcode',
          check: 'xcode-select -p',
          manual: 'Install Xcode from the App Store.',
        },
      ])
    }),
  )

  it.effect.each([
    'sudo apt-get install -y jq',
    'apt-get update && sudo apt-get install -y jq',
    'DEBIAN_FRONTEND=noninteractive sudo apt-get install jq',
    '/usr/bin/sudo make install',
    'curl -fsSL https://example.com/x.sh | sudo sh',
    'echo y | (doas pkg_add jq)',
    'su -c "make install"',
    'pkexec make install',
  ])('refuses the install %j', install =>
    Effect.gen(function* () {
      const found = yield* problems(decodeProjectSettings, {
        requires: [{ name: 'jq', check: 'command -v jq', install }],
      })
      expect(paths(found)).toEqual(['requires.0.install'])
      expect(found[0]?.message).toContain('never runs')
    }),
  )

  it.each([
    'brew install jq',
    'npm install -g sudo-prompt',
    'pip install pseudo',
  ])('takes the install %j', install => {
    expect(Option.isNone(passwordAsker(install))).toBe(true)
  })

  it.effect(
    'refuses an entry with both an install and a manual step, or neither',
    () =>
      Effect.gen(function* () {
        const both = yield* problems(decodeProjectSettings, {
          requires: [
            {
              name: 'jq',
              check: 'command -v jq',
              install: 'brew install jq',
              manual: 'x',
            },
          ],
        })
        expect(both[0]?.message).toContain('not both')
        const neither = yield* problems(decodeProjectSettings, {
          requires: [{ name: 'jq', check: 'command -v jq' }],
        })
        expect(neither[0]?.message).toContain('neither')
      }),
  )

  it.effect('refuses two entries of one name, and a name that is no name', () =>
    Effect.gen(function* () {
      const entry = {
        name: 'jq',
        check: 'command -v jq',
        install: 'brew install jq',
      }
      const twice = yield* problems(decodeProjectSettings, {
        requires: [entry, entry],
      })
      expect(twice[0]?.message).toContain('two entries named jq')
      const badName = yield* problems(decodeProjectSettings, {
        requires: [{ ...entry, name: 'my tool' }],
      })
      expect(paths(badName)).toEqual(['requires.0.name'])
    }),
  )
})

describe('SettingDuration', () => {
  it.each([
    ['30m', 1_800_000],
    ['6h', 21_600_000],
    ['1h30m', 5_400_000],
    ['50ms', 50],
    ['90d', 90 * 86_400_000],
    ['1m30s500ms', 90_500],
  ])('reads %j as %d ms', (text, expected) => {
    expect(millis(Schema.decodeUnknownSync(SettingDuration)(text))).toBe(
      expected,
    )
    expect(Option.getOrThrow(parseDurationMillis(text))).toBe(expected)
  })

  it.each(['', '0', '0m', '30', '1.5h', '30 minutes', '-5m', 'm', '30m1h'])(
    'refuses %j',
    text => {
      expect(
        Option.isSome(Schema.decodeUnknownOption(SettingDuration)(text)),
      ).toBe(false)
    },
  )

  it('writes a time as it reads one', () => {
    expect(formatDurationMillis(5_400_000)).toBe('1h30m')
    expect(formatDurationMillis(50)).toBe('50ms')
    expect(Schema.encodeSync(SettingDuration)(Duration.minutes(30))).toBe('30m')
  })
})

describe('ModelChoice', () => {
  it('splits the provider at the first slash', () => {
    expect(
      Schema.decodeUnknownSync(ModelChoice)('anthropic/claude-opus-5-5'),
    ).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      thinking: Option.none(),
    })
  })

  it.each(['claude-opus-5-5', '/claude', 'anthropic/', 'Anthropic/claude'])(
    'refuses %j',
    text => {
      expect(Option.isNone(Schema.decodeUnknownOption(ModelChoice)(text))).toBe(
        true,
      )
    },
  )

  it('refuses a thinking level no provider takes', () => {
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(ModelChoice)({
          model: 'anthropic/x',
          thinking: 'ultra',
        }),
      ),
    ).toBe(true)
  })
})

describe('EngineSettings', () => {
  it.effect('decodes every default from an empty object', () =>
    Effect.gen(function* () {
      const settings = yield* decodeEngineSettings({})
      expect(Option.isNone(settings.machine_workers)).toBe(true)
      expect(settings.keep_awake).toBe(true)
      expect(settings.worker_nice).toBe(10)
      expect(settings.auto_answer).toEqual(AutoAnswer.cases.Off.make({}))
      expect(millis(settings.credentials_wait)).toBe(6 * 3_600_000)
      expect(millis(settings.view_interval)).toBe(50)
      expect(millis(settings.stream_flush)).toBe(50)
      expect(settings.telemetry.retention.raw).toEqual(
        Retention.cases.For.make({ duration: Duration.days(90) }),
      )
      expect(settings.telemetry.retention.daily).toEqual(
        Retention.cases.Forever.make({}),
      )
    }),
  )

  it.effect.each([
    [true, 'AtOnce'],
    [false, 'Off'],
    ['10m', 'After'],
  ] as const)('reads auto_answer %j as %s', ([written, tag]) =>
    Effect.gen(function* () {
      const settings = yield* decodeEngineSettings({ auto_answer: written })
      expect(settings.auto_answer._tag).toBe(tag)
      expect(Schema.encodeSync(EngineSettings)(settings).auto_answer).toBe(
        written,
      )
    }),
  )

  it.effect('reports every invalid value together', () =>
    Effect.gen(function* () {
      const found = yield* problems(decodeEngineSettings, {
        machine_workers: 0,
        worker_nice: -5,
        auto_answer: 'later',
        view_interval: '16.6ms',
        telemetry: { retention: { raw: 'always' } },
        concurrent: 3,
      })
      expect(paths(found).toSorted()).toEqual(
        [
          'machine_workers',
          'worker_nice',
          'auto_answer',
          'view_interval',
          'telemetry.retention.raw',
          'concurrent',
        ].toSorted(),
      )
    }),
  )
})

describe('defaults that depend on the project or the host', () => {
  it.each([
    [1, 2],
    [3, 2],
    [4, 2],
    [10, 5],
    [16, 8],
  ])('machine_workers on %d cores is %d', (cores, expected) => {
    expect(defaultMachineWorkers(cores)).toBe(expected)
  })

  it('pushes a clone after its run, and a registered checkout never', () => {
    expect(defaultPush('cloned')).toBe('after_run')
    expect(defaultPush('registered')).toBe('never')
  })
})
