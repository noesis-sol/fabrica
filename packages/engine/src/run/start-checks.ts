import { Cause, Data, Effect, Option, Result } from 'effect'

import type { CommitHash, ModelChoice, RunId } from '@fabrica/contracts'

import { Git, GitVersion } from '../git'
import { ModelProxy, ProbeOutcome, Refusal } from '../proxy'
import type { RunLog } from '../runlog'
import {
  type ResolvedSettings,
  describeProblem,
  loadSettings,
} from '../settings'
import type { RunConfig } from './config'
import { record } from './records'

// The run's start checks (spec §13.1, H80): git 2.38 or later, the project's checkout clean and on a
// branch, the settings valid, and each model's credential tried with the proxy's probe (H60). Every
// problem is listed together, and the run ends `SETUP`, exit 2. Each check's end is streamed as an
// `info` record as it comes, so a client shows what the start is doing; a defect inside a check is a
// problem line of its own (`Internal error in <check>: …`), never an end with nothing said (tutti-kq5).

/** What the start found, for the run to go on with. */
export interface Started {
  /** Base: the branch checked out in the project's checkout. */
  readonly base: string
  /** Base's commit as the run started. */
  readonly baseCommit: CommitHash
  readonly settings: ResolvedSettings
}

export type StartChecked = Data.TaggedEnum<{
  Ready: { readonly started: Started }
  /** Every problem the checks found, in the checks' order. */
  Problems: { readonly problems: ReadonlyArray<string> }
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

const credentialsCheck = (settings: ResolvedSettings, run: RunId) =>
  Effect.gen(function* () {
    const proxy = yield* ModelProxy
    const models = modelsOf(settings)
    if (models.length === 0)
      return problems<undefined>(
        'no model is set: set `model` in .fabrica/settings.json (`anthropic/claude-…`)',
      )
    const outcomes = yield* Effect.forEach(
      models,
      choice =>
        Effect.map(
          proxy.probe({ provider: choice.provider, model: choice.model, run }),
          outcome => ({ name: modelName(choice), outcome }),
        ),
      { concurrency: 'unbounded' },
    )
    const refused = outcomes.flatMap(({ name, outcome }) =>
      ProbeOutcome.$match(outcome, {
        Passed: () => [],
        Refused: ({ refusal }) => [
          `${name}: the credential was refused: ${refusalWords(refusal)}`,
        ],
        Failed: ({ reason }) => [`${name}: ${reason}`],
      }),
    )
    return refused.length > 0
      ? problems<undefined>(...refused)
      : found(undefined, `${models.map(modelName).join(', ')} answered`)
  })

/** Runs the start checks, side by side where one doesn't need another's finding. */
export const runStartChecks = Effect.fn('Run.startChecks')(function* (input: {
  readonly config: RunConfig
  readonly run: RunId
  readonly log: RunLog['Service']
}) {
  const { config, run, log } = input
  const [git, checkout, settings] = yield* Effect.all(
    [
      guarded(log, 'the git check', gitCheck),
      guarded(log, 'the checkout check', checkoutCheck(config.checkout)),
      guarded(log, 'the settings check', settingsCheck(config)),
    ],
    { concurrency: 'unbounded' },
  )
  const credentials = yield* guarded(
    log,
    'the credentials check',
    Result.isSuccess(settings)
      ? credentialsCheck(settings.success.value, run)
      : Effect.succeed(
          found(undefined, 'not checked: the settings have problems'),
        ),
  )
  const all = [
    Result.isFailure(git) ? git.failure : [],
    Result.isFailure(checkout) ? checkout.failure : [],
    Result.isFailure(settings) ? settings.failure : [],
    Result.isFailure(credentials) ? credentials.failure : [],
  ].flat()
  if (
    all.length > 0 ||
    Result.isFailure(checkout) ||
    Result.isFailure(settings)
  )
    return StartChecked.Problems({ problems: all })
  return StartChecked.Ready({
    started: {
      base: checkout.success.value.base,
      baseCommit: checkout.success.value.commit,
      settings: settings.success.value,
    },
  })
})
