import {
  Duration,
  Effect,
  Option,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from 'effect'

// The project's settings, `.fabrica/settings.json` (spec §13.13), and the engine's (spec §7, §8.3,
// §15.2, §14.6, §21). Every key has a default, so `{}` decodes to a whole value. The project file is
// committed, so it holds only what everyone running the project shares; a person's or a machine's
// choice is the engine's setting, and given in the project file it is a problem (H68).
//
// A value's own problem is checked on its text, before it is decoded, so it is reported beside every
// other key's: a struct stops before its decoding step once one of its keys fails.

// --- Durations -------------------------------------------------------------------------------

const durationPattern =
  /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/

const durationUnits = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1_000],
  ['ms', 1],
] as const

/** The whole milliseconds a time such as "30m", "1h30m" or "50ms" names; none for other text. */
export const parseDurationMillis = (text: string): Option.Option<number> => {
  const match = durationPattern.exec(text)
  if (match === null || text === '') return Option.none()
  const millis = durationUnits.reduce(
    (total, [, size], index) => total + Number(match[index + 1] ?? '0') * size,
    0,
  )
  return Number.isSafeInteger(millis) ? Option.some(millis) : Option.none()
}

/** Writes whole milliseconds as parseDurationMillis reads them: "30m", "1h30m", "50ms". */
export const formatDurationMillis = (millis: number): string => {
  let rest = millis
  let text = ''
  for (const [name, size] of durationUnits) {
    const amount = Math.floor(rest / size)
    if (amount > 0) text += `${amount}${name}`
    rest -= amount * size
  }
  return text === '' ? '0ms' : text
}

const DurationText = Schema.String.check(
  Schema.makeFilter(
    text =>
      Option.match(parseDurationMillis(text), {
        onNone: () =>
          `Expected a time such as "30m", "6h" or "1h30m", got ${JSON.stringify(text)}`,
        onSome: millis =>
          millis > 0 ||
          `Expected a time longer than 0, such as "30m", got ${JSON.stringify(text)}`,
      }),
    { expected: 'a time such as "30m", "6h", "1h30m" or "50ms"' },
  ),
)

/**
 * A time longer than zero, written "30m" (units d, h, m, s, ms), decoded to a Duration of whole
 * milliseconds (H55).
 */
export const SettingDuration = DurationText.pipe(
  Schema.decodeTo(
    Schema.Duration,
    SchemaTransformation.transform({
      decode: text =>
        Duration.millis(Option.getOrElse(parseDurationMillis(text), () => 0)),
      encode: duration => formatDurationMillis(Duration.toMillis(duration)),
    }),
  ),
)

// --- Commands --------------------------------------------------------------------------------

/**
 * A shell command line: some text, on one line, without control characters. A newline in a
 * command hides what runs after it from one who reads it as one line (spec §16, init's checks).
 */
export const CommandLine = Schema.String.check(
  Schema.isPattern(/^[^\p{Cc}]*[^\p{Cc}\s][^\p{Cc}]*$/u, {
    expected: 'a command on one line, without control characters',
  }),
)

/**
 * A check's or the setup's command: not set (as init left it), the explicit `"none"`, or a command.
 * A project whose `check_fast` isn't set doesn't merge; `"none"` merges unchecked (H62).
 */
export const CommandSetting = Schema.TaggedUnion({
  Unset: {},
  None: {},
  Command: { command: CommandLine },
})
export type CommandSetting = typeof CommandSetting.Type

const commandSetting = Schema.optionalKey(CommandLine).pipe(
  Schema.decodeTo(
    CommandSetting,
    SchemaTransformation.transformOptional({
      decode: text =>
        Option.some(
          Option.match(text, {
            onNone: () => CommandSetting.cases.Unset.make({}),
            onSome: command =>
              command === 'none'
                ? CommandSetting.cases.None.make({})
                : CommandSetting.cases.Command.make({ command }),
          }),
        ),
      encode: setting =>
        Option.flatMap(
          setting,
          CommandSetting.match({
            Unset: () => Option.none(),
            None: () => Option.some('none'),
            Command: ({ command }) => Option.some(command),
          }),
        ),
    }),
  ),
)

// --- Models ----------------------------------------------------------------------------------

/** The thinking or effort levels a model may be given, where its provider takes one (spec §12.5). */
export const ThinkingLevel = Schema.Literals([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
])
export type ThinkingLevel = typeof ThinkingLevel.Type

const ModelName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*\/\S+$/, {
    expected: 'a provider and model, such as "anthropic/claude-opus-5-5"',
  }),
)

const ModelChoiceType = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  thinking: Schema.Option(ThinkingLevel),
})

/**
 * A provider and model, written `"anthropic/claude-opus-5-5"`, or with a thinking level as
 * `{ "model": "anthropic/claude-opus-5-5", "thinking": "high" }`. The provider is the text before
 * the first slash: a model's own ID may hold slashes (`openrouter/…`) and colons (`ollama/…`).
 */
export const ModelChoice = Schema.Union([
  ModelName,
  Schema.Struct({
    model: ModelName,
    thinking: Schema.optionalKey(ThinkingLevel),
  }),
]).pipe(
  Schema.decodeTo(
    ModelChoiceType,
    SchemaTransformation.transform({
      decode: written => {
        const { name, thinking } =
          typeof written === 'string'
            ? { name: written, thinking: Option.none<ThinkingLevel>() }
            : {
                name: written.model,
                thinking: Option.fromUndefinedOr(written.thinking),
              }
        const slash = name.indexOf('/')
        return {
          provider: name.slice(0, slash),
          model: name.slice(slash + 1),
          thinking,
        }
      },
      encode: ({ provider, model, thinking }) =>
        Option.match(thinking, {
          onNone: () => `${provider}/${model}`,
          onSome: level => ({ model: `${provider}/${model}`, thinking: level }),
        }),
    }),
  ),
)
export type ModelChoice = typeof ModelChoice.Type

// --- Requirements (spec §17) -----------------------------------------------------------------

/** The platforms a requirement can be limited to, as Node's `process.platform` names them. */
export const Platform = Schema.Literals(['darwin', 'linux', 'win32'])
export type Platform = typeof Platform.Type

/** The commands that ask for a password on a terminal, which an install runs without. */
const asksForPassword = new Set(['sudo', 'su', 'doas', 'pkexec'])

/** The words of a command line, split at blanks, quotes and the shell's operators. */
const commandWords = (line: string): ReadonlyArray<string> =>
  line.split(/[\s;&|()<>`$"'{}]+/u).filter(word => word !== '')

/** The command among asksForPassword that `install` names, as a word or a path's last part. */
export const passwordAsker = (install: string): Option.Option<string> =>
  Option.fromUndefinedOr(
    commandWords(install)
      .map(word => word.slice(word.lastIndexOf('/') + 1))
      .find(word => asksForPassword.has(word)),
  )

const InstallCommand = CommandLine.check(
  Schema.makeFilter(install =>
    Option.match(passwordAsker(install), {
      onNone: () => true,
      onSome: asker =>
        `An install never runs ${asker}, which asks for a password: give it as manual instead, or install without ${asker} (got ${JSON.stringify(install)})`,
    }),
  ),
)

/** What meets a requirement: a command the engine runs, or a step a person takes. */
export const RequirementMeets = Schema.TaggedUnion({
  Install: { command: CommandLine },
  Manual: { instruction: Schema.String },
})
export type RequirementMeets = typeof RequirementMeets.Type

const RequirementType = Schema.Struct({
  name: Schema.String,
  check: CommandLine,
  meets: RequirementMeets,
  platforms: Schema.Option(Schema.NonEmptyArray(Platform)),
})

const RequirementFields = Schema.Struct({
  name: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, {
      expected: 'a name of letters, digits and . _ + -, such as "jq"',
    }),
  ),
  check: CommandLine,
  install: Schema.optionalKey(InstallCommand),
  manual: Schema.optionalKey(Schema.String.check(Schema.isPattern(/\S/))),
  platforms: Schema.optionalKey(Schema.NonEmptyArray(Platform)),
})
type RequirementFields = typeof RequirementFields.Type

/**
 * One entry of the requires list: a name, a `check` command that exits 0 when it is met, and either
 * an `install` command (never `sudo`) or a `manual` instruction; `platforms` limits it to some.
 */
export const Requirement = RequirementFields.pipe(
  Schema.decodeTo(
    RequirementType,
    SchemaTransformation.transformEffect({
      decode: ({ name, check, install, manual, platforms }) => {
        const meets: Option.Option<RequirementMeets> =
          install !== undefined && manual === undefined
            ? Option.some(
                RequirementMeets.cases.Install.make({ command: install }),
              )
            : manual !== undefined && install === undefined
              ? Option.some(
                  RequirementMeets.cases.Manual.make({ instruction: manual }),
                )
              : Option.none()
        return Option.match(meets, {
          onNone: () =>
            Effect.fail(
              new SchemaIssue.InvalidValue({
                message: `The requirement ${name} needs an install (a command that meets it) or manual (what a person must do): ${install === undefined ? 'it has neither' : 'give one, not both'}`,
              }),
            ),
          onSome: meets =>
            Effect.succeed({
              name,
              check,
              meets,
              platforms: Option.fromUndefinedOr(platforms),
            }),
        })
      },
      encode: ({ name, check, meets, platforms }) => {
        const written = RequirementMeets.match(meets, {
          Install: ({ command }): RequirementFields => ({
            name,
            check,
            install: command,
          }),
          Manual: ({ instruction }): RequirementFields => ({
            name,
            check,
            manual: instruction,
          }),
        })
        return Effect.succeed(
          Option.match(platforms, {
            onNone: () => written,
            onSome: (list): RequirementFields => ({
              ...written,
              platforms: list,
            }),
          }),
        )
      },
    }),
  ),
)
export type Requirement = typeof Requirement.Type

/** The requires list, each name once. */
export const Requires = Schema.Array(Requirement).check(
  Schema.makeFilter(list => {
    const names = list.map(entry => entry.name)
    const twice = names.find((name, index) => names.indexOf(name) !== index)
    return (
      twice === undefined || `The requires list has two entries named ${twice}`
    )
  }),
)

// --- The project's settings ------------------------------------------------------------------

/** Text that isn't blank: a path, a glob, a name. */
const Text = Schema.String.check(
  Schema.isPattern(/\S/, { expected: 'some text' }),
)

/** A whole number at least `minimum`. */
const Count = (minimum: number) =>
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(minimum))

const withDefault =
  <S extends Schema.Top>(value: S['Encoded']) =>
  (schema: S) =>
    schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)))

/**
 * The dependency manifests and lockfiles whose change in a rebase runs the setup again, where the
 * settings name none: orchestra's list (spec §13.8).
 */
export const defaultSetupFiles: ReadonlyArray<string> = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'pyproject.toml',
  'poetry.lock',
  'uv.lock',
  'Pipfile',
  'Pipfile.lock',
  'requirements*.txt',
  'Gemfile',
  'Gemfile.lock',
  'composer.json',
  'composer.lock',
  'mix.exs',
  'mix.lock',
  'pubspec.yaml',
  'pubspec.lock',
]

/** The worker gate's levels (spec §12.6). */
export const Permissions = Schema.Literals(['workspace', 'ask', 'full'])
export type Permissions = typeof Permissions.Type

/** When Base is pushed (spec §10.3). */
export const Push = Schema.Literals(['never', 'after_run', 'after_merge'])
export type Push = typeof Push.Type

/** How a project came to the engine, which sets its default `push`. */
export type ProjectOrigin = 'registered' | 'cloned'

/** `push` where the settings give none: `never` for a registered checkout, `after_run` for a clone. */
export const defaultPush = (origin: ProjectOrigin): Push =>
  origin === 'cloned' ? 'after_run' : 'never'

/** The container runtimes the engine drives through their Docker-compatible CLI (spec §12.7). */
export const ContainerRuntime = Schema.Literals(['docker', 'podman'])
export type ContainerRuntime = typeof ContainerRuntime.Type

const memoryUnits = [
  ['g', 1024 ** 3],
  ['m', 1024 ** 2],
  ['k', 1024],
  ['b', 1],
] as const

const memoryPattern = /^([1-9]\d*)([bkmg])?$/

const MemoryText = Schema.String.check(
  Schema.isPattern(memoryPattern, {
    expected: 'a memory size such as "4g" or "512m"',
  }),
)

/** A container's memory limit, written as Docker takes it ("4g", "512m"), decoded to bytes. */
export const ContainerMemory = MemoryText.pipe(
  Schema.decodeTo(
    Schema.Int,
    SchemaTransformation.transform({
      decode: text => {
        const match = memoryPattern.exec(text)
        const unit = memoryUnits.find(([name]) => name === (match?.[2] ?? 'b'))
        return Number(match?.[1] ?? '0') * (unit?.[1] ?? 1)
      },
      encode: bytes => {
        const unit =
          memoryUnits.find(([, size]) => bytes % size === 0) ?? memoryUnits[3]
        return `${bytes / unit[1]}${unit[0]}`
      },
    }),
  ),
)

/** Where a worker's container comes from: an image, or a devcontainer file. */
export const ContainerSource = Schema.TaggedUnion({
  Image: { image: Text },
  Devcontainer: { file: Text },
})
export type ContainerSource = typeof ContainerSource.Type

const ContainerType = Schema.Struct({
  source: ContainerSource,
  runtime: Schema.Option(ContainerRuntime),
  memory: Schema.Option(Schema.Int),
  cpus: Schema.Option(Schema.Number),
})

const ContainerFields = Schema.Struct({
  image: Schema.optionalKey(Text),
  devcontainer: Schema.optionalKey(Text),
  runtime: Schema.optionalKey(ContainerRuntime),
  memory: Schema.optionalKey(ContainerMemory),
  cpus: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThan(0))),
})
type ContainerFields = typeof ContainerFields.Type

/**
 * A worker's container (spec §12.7): an `image` or a `devcontainer` file, and the `runtime`,
 * `memory` and `cpus` where the settings choose them; otherwise whichever runtime is present, and
 * the worker's share of the machine.
 */
export const Container = ContainerFields.pipe(
  Schema.decodeTo(
    ContainerType,
    SchemaTransformation.transformEffect({
      decode: ({ image, devcontainer, runtime, memory, cpus }) => {
        const source: Option.Option<ContainerSource> =
          image !== undefined && devcontainer === undefined
            ? Option.some(ContainerSource.cases.Image.make({ image }))
            : devcontainer !== undefined && image === undefined
              ? Option.some(
                  ContainerSource.cases.Devcontainer.make({
                    file: devcontainer,
                  }),
                )
              : Option.none()
        return Option.match(source, {
          onNone: () =>
            Effect.fail(
              new SchemaIssue.InvalidValue({
                message: `A container needs an image or a devcontainer file: ${image === undefined ? 'it has neither' : 'give one, not both'}`,
              }),
            ),
          onSome: source =>
            Effect.succeed({
              source,
              runtime: Option.fromUndefinedOr(runtime),
              memory: Option.fromUndefinedOr(memory),
              cpus: Option.fromUndefinedOr(cpus),
            }),
        })
      },
      encode: ({ source, runtime, memory, cpus }) => {
        const written: ContainerFields = {
          ...ContainerSource.match(source, {
            Image: ({ image }): ContainerFields => ({ image }),
            Devcontainer: ({ file }): ContainerFields => ({
              devcontainer: file,
            }),
          }),
          ...Option.match(runtime, {
            onNone: () => ({}),
            onSome: runtime => ({ runtime }),
          }),
          ...Option.match(memory, {
            onNone: () => ({}),
            onSome: memory => ({ memory }),
          }),
          ...Option.match(cpus, {
            onNone: () => ({}),
            onSome: cpus => ({ cpus }),
          }),
        }
        return Effect.succeed(written)
      },
    }),
  ),
)
export type Container = typeof Container.Type

/** A budget's cap: tokens, or money in US dollars (spec §14.4). */
export const BudgetCap = Schema.TaggedUnion({
  Tokens: { tokens: Schema.Int },
  Money: { usd: Schema.Number },
})
export type BudgetCap = typeof BudgetCap.Type

/** A budget, written `{ "tokens": 2000000 }` or `{ "usd": 20 }`. */
export const Budget = Schema.Union([
  Schema.Struct({ tokens: Count(1) }),
  Schema.Struct({ usd: Schema.Number.check(Schema.isGreaterThan(0)) }),
]).pipe(
  Schema.decodeTo(
    BudgetCap,
    SchemaTransformation.transform<
      BudgetCap,
      { readonly tokens: number } | { readonly usd: number }
    >({
      decode: written =>
        'tokens' in written
          ? BudgetCap.cases.Tokens.make({ tokens: written.tokens })
          : BudgetCap.cases.Money.make({ usd: written.usd }),
      encode: BudgetCap.match<
        { readonly tokens: number } | { readonly usd: number }
      >({
        Tokens: ({ tokens }) => ({ tokens }),
        Money: ({ usd }) => ({ usd }),
      }),
    }),
  ),
)

/** An organ's settings: on by default, on the project's model unless it names one (spec §16). */
const Organ = Schema.Struct({
  enabled: Schema.Boolean.pipe(withDefault(true)),
  model: Schema.OptionFromOptionalKey(ModelChoice),
}).pipe(withDefault({}))

/**
 * The engine's settings and the app's, which `.fabrica/settings.json` never holds: each is a
 * person's or a machine's choice (H68).
 */
export const machineSettingNames = [
  'machine_workers',
  'keep_awake',
  'worker_nice',
  'auto_answer',
  'credentials_wait',
  'view_interval',
  'stream_flush',
  'listen',
  'listen_certificate',
  'listen_key',
  'telemetry',
  'notifications',
  'theme',
] as const

const notInProjectSettings = (name: string) =>
  Schema.optionalKey(
    Schema.Never.annotate({
      message: `${name} is a person's or a machine's choice, the engine's or the app's setting: the project's settings are committed, so they hold only what everyone running the project shares`,
    }),
  )

/** `.fabrica/settings.json`: what everyone running the project shares (spec §13.13). */
export const ProjectSettings = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  /** Workers for this project's runs. */
  concurrent: Count(1).pipe(withDefault(2)),
  /** The workers' model; none: the run asks for one (spec §12.5). */
  model: Schema.OptionFromOptionalKey(ModelChoice),
  /** Models tried in order when the chosen one fails to start. */
  model_fallbacks: Schema.Array(ModelChoice).pipe(withDefault([])),
  permissions: Permissions.pipe(withDefault('workspace')),
  /** A container per worker; none: a worktree per worker on the host (spec §12.7). */
  container: Schema.OptionFromOptionalKey(Container),
  /** A worker's check of its own change (spec §13.6). */
  check_own: commandSetting,
  /** The merge check, on every merge (spec §13.7). */
  check_fast: commandSetting,
  /** Every suite, once on Base at a run's end (spec §13.9). */
  check_full: commandSetting,
  /** How long a check or setup may run. */
  check_timeout: SettingDuration.pipe(withDefault('30m')),
  /** Run in each new worktree, and again where a rebase changed a setup file (spec §13.8). */
  setup: commandSetting,
  setup_files: Schema.Array(Text).pipe(withDefault(defaultSetupFiles)),
  requires: Requires.pipe(withDefault([])),
  /** None: the project's origin decides it (defaultPush). */
  push: Schema.OptionFromOptionalKey(Push),
  verifier: Schema.Struct({
    enabled: Schema.Boolean.pipe(withDefault(true)),
    rounds: Count(1).pipe(withDefault(3)),
    /** None: a different provider's model from the worker's where one is configured (spec §13.6). */
    model: Schema.OptionFromOptionalKey(ModelChoice),
  }).pipe(withDefault({})),
  hand_backs: Schema.Struct({
    resolve: Count(0).pipe(withDefault(2)),
    fix: Count(0).pipe(withDefault(2)),
  }).pipe(withDefault({})),
  resolve_timeout: SettingDuration.pipe(withDefault('20m')),
  merge: Schema.Struct({
    /** The merge train's depth: one at most, never deeper (spec §13.7). */
    train: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(
      withDefault(1),
    ),
  }).pipe(withDefault({})),
  /** How long a ticket's worker may go on; none: no limit (spec §14.5). */
  ticket_limit: Schema.OptionFromOptionalKey(SettingDuration),
  usage_limit_wait: SettingDuration.pipe(withDefault('6h')),
  usage_limit_retry: SettingDuration.pipe(withDefault('15m')),
  question_wait: SettingDuration.pipe(withDefault('15m')),
  /** Caps per project, run or ticket; none by default (spec §14.4). */
  budgets: Schema.Struct({
    project: Schema.OptionFromOptionalKey(Budget),
    run: Schema.OptionFromOptionalKey(Budget),
    ticket: Schema.OptionFromOptionalKey(Budget),
  }).pipe(withDefault({})),
  organs: Schema.Struct({
    triage: Organ,
    predictor: Organ,
    reviewer: Organ,
    scout: Organ,
    breakdown: Organ,
  }).pipe(withDefault({})),
  /** Paths and globs that stay in footprints but hold no tickets apart (spec §13.4). */
  shared_files: Schema.Array(Text).pipe(withDefault([])),
  /** Whether the app opens the answer talk by itself (spec §15.3). */
  questions: Schema.Literals(['auto', 'key']).pipe(withDefault('auto')),
  /** The versions of the templates init wrote, by template (spec §12.4). */
  templates: Schema.Record(Schema.String, Count(0)).pipe(withDefault({})),
  machine_workers: notInProjectSettings('machine_workers'),
  keep_awake: notInProjectSettings('keep_awake'),
  worker_nice: notInProjectSettings('worker_nice'),
  auto_answer: notInProjectSettings('auto_answer'),
  credentials_wait: notInProjectSettings('credentials_wait'),
  view_interval: notInProjectSettings('view_interval'),
  stream_flush: notInProjectSettings('stream_flush'),
  listen: notInProjectSettings('listen'),
  listen_certificate: notInProjectSettings('listen_certificate'),
  listen_key: notInProjectSettings('listen_key'),
  telemetry: notInProjectSettings('telemetry'),
  notifications: notInProjectSettings('notifications'),
  theme: notInProjectSettings('theme'),
})
export type ProjectSettings = typeof ProjectSettings.Type

// --- The engine's settings -------------------------------------------------------------------

/**
 * Whether the engine answers questions for the maintainer (spec §15.2): `false` (off), `true` (at
 * once), or a time they wait first ("10m").
 */
export const AutoAnswer = Schema.TaggedUnion({
  Off: {},
  AtOnce: {},
  After: { wait: Schema.Duration },
})
export type AutoAnswer = typeof AutoAnswer.Type

const autoAnswer = Schema.Union([Schema.Boolean, SettingDuration]).pipe(
  Schema.decodeTo(
    AutoAnswer,
    SchemaTransformation.transform<AutoAnswer, boolean | Duration.Duration>({
      decode: written =>
        written === true
          ? AutoAnswer.cases.AtOnce.make({})
          : written === false
            ? AutoAnswer.cases.Off.make({})
            : AutoAnswer.cases.After.make({ wait: written }),
      encode: AutoAnswer.match<boolean | Duration.Duration>({
        Off: () => false,
        AtOnce: () => true,
        After: ({ wait }) => wait,
      }),
    }),
  ),
)

/** How long telemetry keeps rows: `"forever"`, or a time ("90d"). */
export const Retention = Schema.TaggedUnion({
  Forever: {},
  For: { duration: Schema.Duration },
})
export type Retention = typeof Retention.Type

const retention = Schema.Union([
  Schema.Literal('forever'),
  SettingDuration,
]).pipe(
  Schema.decodeTo(
    Retention,
    SchemaTransformation.transform<Retention, 'forever' | Duration.Duration>({
      decode: written =>
        written === 'forever'
          ? Retention.cases.Forever.make({})
          : Retention.cases.For.make({ duration: written }),
      encode: Retention.match<'forever' | Duration.Duration>({
        Forever: () => 'forever',
        For: ({ duration }) => duration,
      }),
    }),
  ),
)

/** Where the engine's TLS listener listens (spec §9.3): a host, or every interface, and a port (0: any free one). */
export const ListenAddress = Schema.Struct({
  host: Schema.Option(Schema.String),
  port: Schema.Int,
})
export type ListenAddress = typeof ListenAddress.Type

const listenPattern = /^(?:\[([0-9A-Fa-f:.]+)\]|([^\s:[\]]*)):(\d{1,5})$/u

/** The address `host:port`, `[v6]:port` or `:port` (every interface) names; none for other text. */
export const parseListenAddress = (
  text: string,
): Option.Option<ListenAddress> => {
  const match = listenPattern.exec(text)
  const port = Number(match?.[3])
  if (match === null || port > 65_535) return Option.none()
  const host = match[1] ?? match[2] ?? ''
  return Option.some({
    host: host === '' ? Option.none() : Option.some(host),
    port,
  })
}

/** Writes an address as parseListenAddress reads it. */
export const formatListenAddress = (address: ListenAddress): string =>
  `${Option.match(address.host, {
    onNone: () => '',
    onSome: host => (host.includes(':') ? `[${host}]` : host),
  })}:${address.port}`

/** An address written `host:port`, `[v6]:port` or `:port`, decoded to its host and port. */
export const ListenAddressText = Schema.String.check(
  Schema.makeFilter(
    text =>
      Option.isSome(parseListenAddress(text)) ||
      `Expected an address such as "0.0.0.0:8443", "[::1]:8443" or ":8443", got ${JSON.stringify(text)}`,
    { expected: 'an address such as "0.0.0.0:8443" or ":8443"' },
  ),
).pipe(
  Schema.decodeTo(
    ListenAddress,
    SchemaTransformation.transform({
      decode: text =>
        Option.getOrElse(parseListenAddress(text), () => ({
          host: Option.none(),
          port: 0,
        })),
      encode: formatListenAddress,
    }),
  ),
)

/** `machine_workers` where the engine's settings give none: half the cores, at least 2 (H35). */
export const defaultMachineWorkers = (cores: number): number =>
  Math.max(2, Math.floor(cores / 2))

/** The engine's settings: one person's or one machine's choices, across its projects. */
export const EngineSettings = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  /** Workers live across every run; none: defaultMachineWorkers of the host's cores (spec §7.3). */
  machine_workers: Schema.OptionFromOptionalKey(Count(1)),
  /** Whether a run keeps its host from idle sleep (spec §7.7, H67). */
  keep_awake: Schema.Boolean.pipe(withDefault(true)),
  /** The nice value workers' agent processes start at (spec §7.4, H73). */
  worker_nice: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: 19 }),
  ).pipe(withDefault(10)),
  auto_answer: autoAnswer.pipe(withDefault(false)),
  /** How long a run holds for a refused credential before it ends (spec §14.6). */
  credentials_wait: SettingDuration.pipe(withDefault('6h')),
  /** The least time between two writes of a run's view (spec §8.3). */
  view_interval: SettingDuration.pipe(withDefault('50ms')),
  /** How often batched tokens and tool output are flushed to clients (spec §8.3). */
  stream_flush: SettingDuration.pipe(withDefault('50ms')),
  /** Where the engine listens for clients over TLS; none: only on its local socket (spec §9.3). */
  listen: Schema.OptionFromOptionalKey(ListenAddressText),
  /** The TLS listener's certificate, a PEM file; none: one the engine makes and keeps (spec §9.3). */
  listen_certificate: Schema.OptionFromOptionalKey(Text),
  /** The private key of `listen_certificate`, a PEM file. */
  listen_key: Schema.OptionFromOptionalKey(Text),
  telemetry: Schema.Struct({
    retention: Schema.Struct({
      raw: retention.pipe(withDefault('90d')),
      daily: retention.pipe(withDefault('forever')),
    }).pipe(withDefault({})),
  }).pipe(withDefault({})),
})
export type EngineSettings = typeof EngineSettings.Type

// --- Decoding --------------------------------------------------------------------------------

/** How settings files are decoded: every problem at once, and an unknown key is one. */
export const settingsParseOptions = {
  errors: 'all',
  onExcessProperty: 'error',
} as const

/** Decodes a project's parsed settings file, or fails with every problem in it. */
export const decodeProjectSettings = Schema.decodeUnknownEffect(
  ProjectSettings,
  settingsParseOptions,
)

/** Decodes the engine's parsed settings file, or fails with every problem in it. */
export const decodeEngineSettings = Schema.decodeUnknownEffect(
  EngineSettings,
  settingsParseOptions,
)
