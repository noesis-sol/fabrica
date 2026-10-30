import { Option } from 'effect'

// The settings a run resolves, each by its path in its settings file (spec §13.13). A key is a value
// set as a whole; a group (verifier, budgets, organs.triage) is an object of keys, merged key by key,
// so a flag giving verifier.rounds keeps the project's verifier.enabled. Each key is also a flag
// (`--verifier-rounds`) and an environment variable (`FABRICA_VERIFIER_ROUNDS`).

/** Whose settings hold a key: the project's committed file, or the engine's (a person's or a machine's choice, H68). */
export type SettingScope = 'project' | 'engine'

/** A setting a run resolves. */
export interface SettingKey {
  /** Its path in its settings file: `concurrent`, `verifier.rounds`. */
  readonly path: string
  readonly segments: ReadonlyArray<string>
  readonly scope: SettingScope
  /** The flag that sets it: `--verifier-rounds`. */
  readonly flag: string
  /** The environment variable that sets it: `FABRICA_VERIFIER_ROUNDS`. */
  readonly variable: string
}

const organNames = ['triage', 'predictor', 'reviewer', 'scout', 'breakdown']

const projectPaths = [
  'concurrent',
  'model',
  'model_fallbacks',
  'permissions',
  'container',
  'check_own',
  'check_fast',
  'check_full',
  'check_timeout',
  'setup',
  'setup_files',
  'requires',
  'push',
  'verifier.enabled',
  'verifier.rounds',
  'verifier.model',
  'hand_backs.resolve',
  'hand_backs.fix',
  'resolve_timeout',
  'merge.train',
  'ticket_limit',
  'usage_limit_wait',
  'usage_limit_retry',
  'question_wait',
  'budgets.project',
  'budgets.run',
  'budgets.ticket',
  ...organNames.flatMap(organ => [
    `organs.${organ}.enabled`,
    `organs.${organ}.model`,
  ]),
  'shared_files',
  'questions',
  'templates',
]

const enginePaths = [
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
  'telemetry.retention.raw',
  'telemetry.retention.daily',
  'telemetry.otlp_endpoint',
]

/** The flag that sets the setting at `path`: `--verifier-rounds`. */
export const flagOf = (path: string): string =>
  `--${path.replaceAll(/[._]/g, '-')}`

const makeKey =
  (scope: SettingScope) =>
  (path: string): SettingKey => ({
    path,
    segments: path.split('.'),
    scope,
    flag: flagOf(path),
    variable: `FABRICA_${path.replaceAll('.', '_').toUpperCase()}`,
  })

/** Every setting a run resolves, the project's first. */
export const settingKeys: ReadonlyArray<SettingKey> = [
  ...projectPaths.map(makeKey('project')),
  ...enginePaths.map(makeKey('engine')),
]

/** The setting at `path`, where there is one. */
export const findSettingKey = (path: string): Option.Option<SettingKey> =>
  Option.fromUndefinedOr(settingKeys.find(key => key.path === path))

/** Whether `segments` (a problem's path in a settings file) start with the key's own. */
export const keyHolds = (
  key: SettingKey,
  segments: ReadonlyArray<string>,
): boolean =>
  key.segments.every((segment, index) => segments[index] === segment)
