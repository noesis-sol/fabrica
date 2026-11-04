import { Cause, Data, Duration, Effect, Option, Result } from 'effect'

import type {
  CommitHash,
  ModelChoice,
  Requirement,
  RunId,
} from '@fabrica/contracts'

import { Git, GitVersion } from '../git'
import { refusedWhy } from '../holds'
import { BaseSynced, syncBase, syncedNote } from '../projects/base-sync'
import { ModelProxy, ProbeOutcome, Refusal } from '../proxy'
import {
  RequirementsList,
  foundWords,
  missingItems,
  requirementsAt,
} from '../requirements'
import type { RunLog } from '../runlog'
import {
  type ResolvedSettings,
  SettingSource,
  describeProblem,
  describeSource,
  loadSettings,
  sourceOf,
} from '../settings'
import type { Steps } from '../view/steps'
import type { RunConfig } from './config'
import { record, recordBaseNote } from './records'
import { type RequirementsInput, checkInRun } from './requirements-step'

// The run's start checks (spec §13.1, H80): git 2.38 or later, the project's checkout clean and on a
// branch (Base then fetched and fast-forwarded from its upstream, §10.3), the settings valid, Base's
// requirements met (§17), and each model's credential tried with the proxy's probe (H60), a subscription's token refreshed first where it expires within the hour (H69). Every
// problem is listed together, and the run ends `SETUP`, exit 2; `REQUIREMENTS_MISSING`, exit 2, where
// missing requirements are all it found. Each check's end is streamed as an
// `info` record as it comes, so a client shows what the start is doing; a defect inside a check is a
// problem line of its own (`Internal error in <check>: …`), never an end with nothing said (tutti-kq5).

/** What the start found, for the run to go on with. */
export interface Started {
  /** Base: the branch checked out in the project's checkout. */
  readonly base: string
  /** Base's commit as the run started. */
  readonly baseCommit: CommitHash
  readonly settings: ResolvedSettings
  /** The requires list on Base's commit as the run started, found met (§17). */
  readonly requirements: ReadonlyArray<Requirement>
}

export type StartChecked = Data.TaggedEnum<{
  Ready: { readonly started: Started }
  /** Every problem the checks found, in the checks' order, and the kind of stop they come to. */
  Problems: {
    readonly kind: 'SETUP' | 'REQUIREMENTS_MISSING'
    readonly problems: ReadonlyArray<string>
  }
}>
export const StartChecked = Data.taggedEnum<StartChecked>()

/** A check's finding: what it read and what it says of it, or its problems. */
type Finding<A> = Result.Result<
  { readonly value: A; readonly said: string },
  ReadonlyArray<string>
>

const found = <A>(value: A, said: string): Finding<A> =>
  Result.succeed({ value, said })

const problems = <A>(...lines: ReadonlyArray<string>): Finding<A> =>
  Result.fail(lines)

/** The check's finding, its defects and failures among its problems, its end said as it comes. */
const guarded = <A, R>(
  log: RunLog['Service'],
  name: string,
  check: Effect.Effect<Finding<A>, unknown, R>,
): Effect.Effect<Finding<A>, never, R> =>
  check.pipe(
    Effect.catchCause(cause =>
      Effect.succeed(
        problems<A>(
          `Internal error in ${name}: ${Cause.pretty(cause).split('\n')[0] ?? ''}`,
        ),
      ),
    ),
    Effect.tap(finding =>
      record(log, {
        kind: 'info',
        text: Result.match(finding, {
          onSuccess: ({ said }) => `start: ${name}: ${said}`,
          onFailure: lines =>
            `start: ${name}: ${lines.length === 1 ? 'a problem' : `${lines.length} problems`}`,
        }),
      }),
    ),
  )

const gitCheck = Effect.gen(function* () {
  const version = yield* (yield* Git).version
  return GitVersion.$match(version, {
    Supported: ({ version }) => found(undefined, `git ${version}`),
    TooOld: ({ version, minimum }) =>
      problems<undefined>(
        `git ${version} is older than ${minimum}: Fabrica needs \`merge-tree --write-tree\` and \`worktree list -z\``,
      ),
    Missing: ({ path }) =>
      problems<undefined>(`git isn't on the PATH commands run with (${path})`),
    Unreadable: ({ reason }) =>
      problems<undefined>(`\`git version\` couldn't be read: ${reason}`),
  })
})

const checkoutCheck = (checkout: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const [branch, status] = yield* Effect.all(
      [
        git.currentBranch({ repo: checkout }),
        git.status({ worktree: checkout }),
      ],
      { concurrency: 2 },
    )
    const dirty =
      status.uncommitted.length === 0
        ? []
        : [
            `the checkout ${checkout} has uncommitted changes: ${status.uncommitted.join(', ')}`,
          ]
    if (Option.isNone(branch))
      return problems<{ base: string; commit: CommitHash }>(
        `the checkout ${checkout} isn't on a branch: its HEAD is detached`,
        ...dirty,
      )
    const commit = yield* git.commitHash({
      repo: checkout,
      revision: `refs/heads/${branch.value}`,
    })
    if (Option.isNone(commit))
      return problems<{ base: string; commit: CommitHash }>(
        `the branch ${branch.value} has no commit yet`,
        ...dirty,
      )
    if (dirty.length > 0)
      return problems<{ base: string; commit: CommitHash }>(...dirty)
    return found(
      { base: branch.value, commit: commit.value },
      `on ${branch.value}, clean`,
    )
  })

const settingsCheck = (config: RunConfig) =>
  loadSettings({
    checkout: config.checkout,
    flags: Option.match(config.options.concurrent, {
      onNone: () => config.settings.flags,
      onSome: concurrent => ({
        ...config.settings.flags,
        concurrent: String(concurrent),
      }),
    }),
    environment: config.settings.environment,
    engineSettings: config.settings.engineSettings,
  }).pipe(
    Effect.map(settings => found(settings, 'valid')),
    Effect.catchTag('SettingsProblems', error =>
      Effect.succeed(
        problems<ResolvedSettings>(...error.problems.map(describeProblem)),
      ),
    ),
  )

/**
 * Base's requires list on `commit` checked: the list, and what is still missing of it (§17). A stop cuts
 * it short, its command's tree ended and no further install started: nothing is missing, as the run ends
 * `INTERRUPTED` at its first look, before any ticket (§13.10).
 */
const requirementsCheck = (
  settings: ResolvedSettings,
  commit: CommitHash,
  input: RequirementsInput,
  stopped: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    type Checked = {
      readonly list: ReadonlyArray<Requirement>
      readonly missing: ReadonlyArray<string>
    }
    // Only Base's list's commands run: a flag or a variable naming others is refused.
    const given = Option.filter(
      sourceOf(settings, 'requires'),
      source =>
        SettingSource.$is('Flag')(source) ||
        SettingSource.$is('Environment')(source),
    )
    if (Option.isSome(given))
      return problems<Checked>(
        `requires is read from the settings on Base alone: ${describeSource(given.value)} gives it`,
      )
    const read = yield* requirementsAt({
      repo: input.checkout,
      revision: commit,
    })
    if (RequirementsList.$is('Unreadable')(read))
      return problems<Checked>(read.reason)
    const { list } = read
    const finished = yield* Effect.raceFirst(
      Effect.map(checkInRun(list, input), Option.some),
      Effect.as(stopped, Option.none()),
    )
    if (Option.isNone(finished))
      return found<Checked>({ list, missing: [] }, 'cut short by a stop')
    return found<Checked>(
      { list, missing: missingItems(finished.value) },
      list.length === 0 ? 'none listed' : foundWords(finished.value),
    )
  })

/** A model as the settings write it: `anthropic/claude-opus-5-5`. */
export const modelName = (choice: ModelChoice): string =>
  `${choice.provider}/${choice.model}`

/** A refusal in words, for a start problem. */
const refusalWords: (refusal: Refusal) => string = Refusal.$match({
  UsageLimited: () => 'its usage limit is reached',
  RateLimited: () => 'it is rate limited',
  StartFailed: ({ reason }) => reason,
  CredentialRefused: ({ reason }) => reason,
})

/** The models a run's workers may use, each once: the project's, its fallbacks, the verifier's. */
const modelsOf = (settings: ResolvedSettings): ReadonlyArray<ModelChoice> => {
  const all = [
    ...Option.toArray(settings.project.model),
    ...settings.project.model_fallbacks,
    ...Option.toArray(settings.project.verifier.model),
  ]
  const seen = new Set<string>()
  return all.filter(choice => {
    const name = modelName(choice)
    if (seen.has(name)) return false
    seen.add(name)
    return true
  })
}

/** How long a subscription's token is to have left as a run starts, or it is refreshed first (H69). */
const TOKEN_VALID_FOR = Duration.hours(1)

const credentialsCheck = (settings: ResolvedSettings, run: RunId) =>
  Effect.gen(function* () {
    const proxy = yield* ModelProxy
    const models = modelsOf(settings)
    if (models.length === 0)
      return problems<undefined>(
        'no model is set: set `model` in .fabrica/settings.json (`anthropic/claude-…`)',
      )
    // Each provider once, however many of its models the run uses: a token is the account's.
    const refreshed = yield* Effect.forEach(
      [...new Set(models.map(({ provider }) => provider))],
      provider =>
        Effect.map(
          Effect.result(proxy.refresh({ provider, validFor: TOKEN_VALID_FOR })),
          result => ({ provider, result }),
        ),
      { concurrency: 'unbounded' },
    )
    const unrefreshed = refreshed.flatMap(({ provider, result }) =>
      Result.isFailure(result)
        ? [{ provider, reason: result.failure.reason }]
        : [],
    )
    const outcomes = yield* Effect.forEach(
      models.filter(({ provider }) =>
        unrefreshed.every(failed => failed.provider !== provider),
      ),
      choice =>
        Effect.map(
          proxy.probe({ provider: choice.provider, model: choice.model, run }),
          outcome => ({ name: modelName(choice), outcome }),
        ),
      { concurrency: 'unbounded' },
    )
    const refused = [
      ...unrefreshed.map(({ provider, reason }) =>
        refusedWhy({ provider, account: Option.none(), reason }),
      ),
      ...outcomes.flatMap(({ name, outcome }) =>
        ProbeOutcome.$match(outcome, {
          Passed: () => [],
          Refused: ({ refusal }) => [
            `${name}: the credential was refused: ${refusalWords(refusal)}`,
          ],
          Failed: ({ reason }) => [`${name}: ${reason}`],
        }),
      ),
    ]
    return refused.length > 0
      ? problems<undefined>(...refused)
      : found(undefined, `${models.map(modelName).join(', ')} answered`)
  })

/**
 * The checkout's finding once Base is synced with its upstream (§10.3), the sync said: Base's commit
 * the one it was fast-forwarded to, where it was.
 */
const syncedCheckout = Effect.fnUntraced(function* (
  log: RunLog['Service'],
  checkout: string,
  found: {
    readonly value: { base: string; commit: CommitHash }
    readonly said: string
  },
) {
  const synced = yield* syncBase({ checkout, base: found.value.base })
  yield* Option.match(syncedNote(synced, found.value.base), {
    onNone: () => Effect.void,
    onSome: note => recordBaseNote(log, note),
  })
  return BaseSynced.$is('FastForwarded')(synced)
    ? Result.succeed({
        value: { ...found.value, commit: synced.to },
        said: found.said,
      })
    : Result.succeed(found)
})

/** Where a start isn't shown in a run view. */
const noSteps: Pick<Steps, 'during'> = { during: () => effect => effect }

/** Runs the start checks, side by side where one doesn't need another's finding. */
export const runStartChecks = Effect.fn('Run.startChecks')(function* (input: {
  readonly config: RunConfig
  readonly run: RunId
  readonly log: RunLog['Service']
  /** The run view's steps, which show an install under way; none, it isn't shown. */
  readonly steps?: Pick<Steps, 'during'>
  /** Waits for the run to be asked to stop; none, it never is. */
  readonly stopped?: Effect.Effect<void>
}) {
  const { config, run, log } = input
  const [git, checked] = yield* Effect.all(
    [
      guarded(log, 'the git check', gitCheck),
      guarded(log, 'the checkout check', checkoutCheck(config.checkout)),
    ],
    { concurrency: 'unbounded' },
  )
  // A clean checkout on Base has Base fetched from its upstream and fast-forwarded where it moved
  // before its settings are read, so the run is set up as the Base it starts on says (§10.3).
  const checkout = Result.isSuccess(checked)
    ? yield* syncedCheckout(log, config.checkout, checked.success)
    : checked
  const settings = yield* guarded(
    log,
    'the settings check',
    settingsCheck(config),
  )
  const [credentials, requirements] = yield* Effect.all(
    [
      guarded(
        log,
        'the credentials check',
        Result.isSuccess(settings)
          ? credentialsCheck(settings.success.value, run)
          : Effect.succeed(
              found(undefined, 'not checked: the settings have problems'),
            ),
      ),
      // Its commands run in the checkout: only one clean and on Base, or a branch's scripts would run.
      guarded(
        log,
        'the requirements check',
        Result.isSuccess(git) &&
          Result.isSuccess(checkout) &&
          Result.isSuccess(settings)
          ? requirementsCheck(
              settings.success.value,
              checkout.success.value.commit,
              {
                checkout: config.checkout,
                installLimit: settings.success.value.project.check_timeout,
                log,
                steps: input.steps ?? noSteps,
                saidAs: 'start: the requirements check',
              },
              input.stopped ?? Effect.never,
            )
          : Effect.succeed(
              found(
                { list: [], missing: [] },
                'not checked: the checkout or the settings have problems',
              ),
            ),
      ),
    ],
    { concurrency: 'unbounded' },
  )
  const others = [
    Result.isFailure(git) ? git.failure : [],
    Result.isFailure(checkout) ? checkout.failure : [],
    Result.isFailure(settings) ? settings.failure : [],
    Result.isFailure(requirements) ? requirements.failure : [],
    Result.isFailure(credentials) ? credentials.failure : [],
  ].flat()
  const missing = Result.isSuccess(requirements)
    ? requirements.success.value.missing
    : []
  if (others.length === 0 && missing.length > 0)
    return StartChecked.Problems({
      kind: 'REQUIREMENTS_MISSING',
      problems: missing,
    })
  if (
    others.length > 0 ||
    Result.isFailure(checkout) ||
    Result.isFailure(settings) ||
    Result.isFailure(requirements)
  )
    return StartChecked.Problems({
      kind: 'SETUP',
      problems: [
        ...others,
        ...missing.map(item => `a requirement is missing: ${item}`),
      ],
    })
  return StartChecked.Ready({
    started: {
      base: checkout.success.value.base,
      baseCommit: checkout.success.value.commit,
      settings: settings.success.value,
      requirements: requirements.success.value.list,
    },
  })
})
