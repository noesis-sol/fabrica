import { Effect, Option, Result, Schema } from 'effect'

import { type OrganName, Platform, Requirement } from '@fabrica/contracts'

import { runnable } from '../checks'
import { type Spend, tokensOf } from '../cost'
import {
  OrganOutcome,
  type OrganRuntime,
  type OrganSessionQuestion,
} from './runtime'

// The scout (spec §16, H57): at `init`, a short read-only session on the repository answers the project's
// check suites, setup, stack and requirements, and `proposalsOf` makes them `init`'s proposals. No test
// runs twice: a full-tier suite that already runs everything the fast tier does is `check_full` alone,
// without the fast tier first, one that runs some of it goes with only the rest, and a project's own full
// runner is kept as it is. Build and packaging
// steps found only in CI are offered unticked, with what they cost. A command the settings wouldn't take
// is left out, saying why, and whatever is shown has its control characters written out, so that nothing
// reads as one line while running as two (tutti-spz). `scoutCost` says what the scout cost (tutti-ktn).

const organ: OrganName = 'scout'

const FastSuite = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
})

const FullSuite = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  /** The names of the fast suites whose tests it already runs, as a slow mode of the same runner does. */
  runs_fast_suites: Schema.Array(Schema.String),
  /** Whether it is the project's own runner of every suite: a script or a target of its own. */
  own_runner: Schema.Boolean,
})

const CiStep = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  /** What it costs each run, in time and size. */
  cost: Schema.String,
})

// Its fields are plain strings, as the contract's list decodes them: one it refuses is left out by itself.
const ProposedRequirement = Schema.Struct({
  name: Schema.String,
  check: Schema.String,
  install: Schema.optionalKey(Schema.String),
  manual: Schema.optionalKey(Schema.String),
  platforms: Schema.optionalKey(Schema.NonEmptyArray(Platform)),
})

/**
 * The organ's answer. Its text is plain strings, so that a command refused loses itself, not the answer,
 * and the JSON Schema a provider is shown holds no pattern it might not take.
 */
export const ScoutAnswer = Schema.Struct({
  fast: Schema.Array(FastSuite),
  full: Schema.Array(FullSuite),
  own: Schema.NullOr(Schema.String),
  setup: Schema.NullOr(Schema.String),
  stack: Schema.Array(Schema.String),
  requirements: Schema.Array(ProposedRequirement),
  ci_only: Schema.Array(CiStep),
})
export type ScoutAnswer = typeof ScoutAnswer.Type

const instructions = `You are the scout of a project being set up. With read-only tools you read its repository: manifests, task runners, scripts, test configuration, CI workflows, the README. You run nothing and change nothing. You propose how its work is checked and set up, for its maintainer to tick, and end by calling answer. Propose only what the repository shows.

- fast: the suites that check a change quickly enough to run on every merge (type checks, lint, unit tests), each its own entry, none repeated.
- full: the suites that run only once at the end of a run. In runs_fast_suites name each fast suite whose tests it already runs, some or all of them, as a slow mode of the same runner runs the quick tests but no linter; else leave it empty. Set own_runner where it is the project's own runner of every suite, a script or a target of its own. Never write a command that runs a fast suite and then a full one: no test runs twice.
- own: the project's command for checking one change alone, where it has one; else null.
- setup: the command that makes a fresh checkout ready to work in, as a lockfile's exact install; else null.
- stack: the languages, runners and frameworks it uses, a short name each.
- requirements: what the machine needs that setup doesn't install. A name of letters, digits and . _ + -, a check that exits 0 where it is met, and either install, a command that never uses sudo, or manual, what a person does. platforms only where it is limited to some.
- ci_only: build and packaging steps found only in CI, with cost, what each costs a run in time and size as far as the repository shows it.

Every command is one shell line: no newline, no control character, no comment.`

const description =
  "Gives the project's check suites, setup, stack and requirements, as proposals for its maintainer to tick."

const prompt =
  "Read this repository, then call answer with how its work is checked and set up. Don't run or change anything."

/** The session's question; `cores` is its share of the machine's cores. */
export const scoutQuestion = (
  cores: number,
): OrganSessionQuestion<ScoutAnswer> => ({
  organ,
  ticket: Option.none(),
  answer: ScoutAnswer,
  description,
  instructions,
  prompt: Effect.succeed(prompt),
  cores,
})

/** A build or packaging step found only in CI: offered, for the maintainer to tick. */
export interface OfferedStep {
  readonly name: string
  readonly command: string
  /** What it costs a run, as the scout read it, or `not known`. */
  readonly cost: string
  /** Everything else proposed comes ticked. */
  readonly ticked: false
}

/** Something the scout proposed and `proposalsOf` didn't keep, and why. */
export interface LeftOut {
  /** What it was, in words. */
  readonly what: string
  /** Why, on one line, a command's control characters written out. */
  readonly reason: string
}

/** `init`'s proposals (spec §16): each command as the settings take it. */
export interface ScoutProposals {
  readonly checkOwn: Option.Option<string>
  readonly checkFast: Option.Option<string>
  readonly checkFull: Option.Option<string>
  readonly setup: Option.Option<string>
  readonly stack: ReadonlyArray<string>
  readonly requirements: ReadonlyArray<Requirement>
  readonly ciSteps: ReadonlyArray<OfferedStep>
  readonly leftOut: ReadonlyArray<LeftOut>
}

/** `text` on one line: each control character written out, as JSON writes those it escapes. */
const writtenOut = (text: string): string =>
  text.replace(
    /\p{Cc}/gu,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )

/** Why a proposed command can't be kept, if so: the settings' own rule, and `none` isn't a command. */
const refused = (command: string): Option.Option<string> =>
  runnable(command)
    ? command === 'none'
      ? Option.some(
          `"none" isn't a command: it says to go unchecked, which is the maintainer's to say`,
        )
      : Option.none()
    : Option.some(
        /\S/u.test(command)
          ? `its command "${writtenOut(command)}" holds a newline or a control character, which would hide what runs after it`
          : 'its command is empty',
      )

/**
 * `commands` as one line, each once, in order, stopping at the first that fails. One holding a shell
 * operator is grouped, so that `a; b` can't hide a failure before it, and one with a comment fails loudly
 * rather than swallow what follows.
 */
export const chainedCommands = (commands: ReadonlyArray<string>): string => {
  const each = [...new Set(commands)]
  return each.length === 1
    ? each.join('')
    : each
        .map(command => (/[;&|#]/u.test(command) ? `(${command})` : command))
        .join(' && ')
}

/** The chain of a list that may be empty. */
const chainOf = (commands: ReadonlyArray<string>): Option.Option<string> =>
  commands.length === 0 ? Option.none() : Option.some(chainedCommands(commands))

const decodeRequirement = Schema.decodeUnknownResult(Requirement)

/**
 * The answer as `init`'s proposals. Refused commands go first, so each rule weighs only what can run:
 * a project's own full runner that can't is no reason to drop the suites it would have stood for.
 */
export const proposalsOf = (answer: ScoutAnswer): ScoutProposals => {
  const leftOut: Array<LeftOut> = []
  const leave = (what: string, reason: string) => {
    leftOut.push({ what, reason })
  }
  /** Whether `command` can be kept; where it can't, `what` is left out, saying why. */
  const keeps = (command: string, what: string): boolean =>
    Option.match(refused(command), {
      onNone: () => true,
      onSome: reason => {
        leave(what, reason)
        return false
      },
    })
  /** The entries of `list` whose commands can be kept, their names on one line. */
  const kept = <S extends { readonly name: string; readonly command: string }>(
    list: ReadonlyArray<S>,
    kind: string,
  ): ReadonlyArray<S> =>
    list
      .map(entry => ({ ...entry, name: writtenOut(entry.name) }))
      .filter(entry => keeps(entry.command, `the ${kind} ${entry.name}`))
  /** The command, if there is one and it can be kept. */
  const single = (
    command: string | null,
    what: string,
  ): Option.Option<string> =>
    Option.filter(Option.fromNullOr(command), given => keeps(given, what))

  const fast = kept(answer.fast, 'fast suite')
  const full = kept(answer.full, 'full suite')
  const fastCommands = fast.map(suite => suite.command)

  // No test runs twice: the first own runner stands for the tier; otherwise a full suite goes without the
  // fast suites it names, and with none that an earlier full suite already runs. Each suite runs once.
  const runner = full.find(suite => suite.own_runner)
  const runBy = new Map<string, string>()
  const tier =
    runner === undefined
      ? full.filter(suite => {
          const names = suite.runs_fast_suites.map(writtenOut)
          const earlier = names.flatMap(name => {
            const by = runBy.get(name)
            return by === undefined ? [] : [{ name, by }]
          })[0]
          if (earlier !== undefined) {
            leave(
              `the full suite ${suite.name}`,
              `${earlier.by} already runs the fast suite ${earlier.name}, and no test runs twice`,
            )
            return false
          }
          for (const name of names) runBy.set(name, suite.name)
          return true
        })
      : [runner]
  if (runner !== undefined)
    for (const suite of full.filter(other => other !== runner))
      leave(
        `the full suite ${suite.name}`,
        `the project's own full runner, ${runner.name}, stands for the full tier`,
      )
  const fullCommands =
    runner !== undefined || tier.length === 0
      ? tier.map(suite => suite.command)
      : [
          ...fast
            .filter(suite => !runBy.has(suite.name))
            .map(suite => suite.command),
          ...tier.map(suite => suite.command),
        ]

  const checkOwn = single(answer.own, 'the own check')
  const setup = single(answer.setup, 'the setup')

  const inChecks = new Set([
    ...fastCommands,
    ...fullCommands,
    ...Option.toArray(checkOwn),
    ...Option.toArray(setup),
  ])
  const ciSteps = kept(answer.ci_only, 'CI step').flatMap(
    ({ name, command, cost }): ReadonlyArray<OfferedStep> => {
      if (!inChecks.has(command))
        return [
          {
            name,
            command,
            cost: /\S/u.test(cost) ? writtenOut(cost) : 'not known',
            ticked: false,
          },
        ]
      leave(`the CI step ${name}`, 'the checks already run it')
      return []
    },
  )

  const named = new Set<string>()
  const requirements = answer.requirements.flatMap(
    (proposed): ReadonlyArray<Requirement> => {
      const what = `the requirement "${writtenOut(proposed.name)}"`
      const commands = [
        proposed.check,
        ...(proposed.install === undefined ? [] : [proposed.install]),
      ]
      if (!commands.every(command => keeps(command, what))) return []
      const decoded = decodeRequirement(proposed)
      if (Result.isFailure(decoded)) {
        leave(what, writtenOut(decoded.failure.message))
        return []
      }
      if (named.has(decoded.success.name)) {
        leave(what, 'an earlier requirement has its name')
        return []
      }
      named.add(decoded.success.name)
      return [decoded.success]
    },
  )

  return {
    checkOwn,
    checkFast: chainOf(fastCommands),
    checkFull: chainOf(fullCommands),
    setup,
    stack: answer.stack.map(writtenOut),
    requirements,
    ciSteps,
    leftOut,
  }
}

/**
 * Runs the scout: a read-only session asking `scoutQuestion`, its answer made `init`'s proposals. Each
 * outcome carries what it spent, as an organ's does; `scoutCost` says it.
 */
export const scout = Effect.fn('Organs.scout')(function* (input: {
  readonly organs: Pick<OrganRuntime, 'session'>
  readonly cores: number
}) {
  const outcome = yield* input.organs.session(scoutQuestion(input.cores))
  return OrganOutcome.$match(outcome, {
    Answered: ({ answer, spend }): OrganOutcome<ScoutProposals> =>
      OrganOutcome.Answered({ answer: proposalsOf(answer), spend }),
    Disabled: (): OrganOutcome<ScoutProposals> => OrganOutcome.Disabled(),
    NoResult: ({ reason, spend }): OrganOutcome<ScoutProposals> =>
      OrganOutcome.NoResult({ reason, spend }),
  })
})

const dollars = (usd: number) => `$${usd.toFixed(2)}`

/** `spend` in words: its money, a subscription's equivalent apart; its tokens where neither is priced. */
const spentWords = (spend: Spend): string => {
  const priced = [
    ...Option.toArray(Option.map(spend.costUsd, dollars)),
    ...Option.toArray(
      Option.map(
        spend.equivalentUsd,
        usd => `${dollars(usd)} at API prices, on a subscription`,
      ),
    ),
  ]
  if (priced.length > 0) return priced.join(' and ')
  const { input, output, cache_write, cache_read } = tokensOf(spend)
  const tokens = input + output + cache_write + cache_read
  return tokens === 0 ? 'nothing' : `${tokens} tokens, at no known price`
}

/** What the scout cost, as `init` says it (spec §16). */
export const scoutCost: (outcome: OrganOutcome<ScoutProposals>) => string =
  OrganOutcome.$match({
    Answered: ({ spend }) => `The scout cost ${spentWords(spend)}.`,
    Disabled: () => 'The scout is turned off, and cost nothing.',
    NoResult: ({ reason, spend }) =>
      `The scout lost its answer (${writtenOut(reason)}), and cost ${spentWords(spend)}.`,
  })
