import {
  Data,
  Deferred,
  Effect,
  Option,
  Redacted,
  Schema,
  Stream,
} from 'effect'

import {
  AgentRoleVariable,
  type FileDiff,
  ModelName,
  SessionId,
  type ModelChoice as SettingsModel,
  type Ticket,
  type TicketId,
  type TreeHash,
  type Verdict,
  VerdictTool,
} from '@fabrica/contracts'

import { type ModelChoice, PiAgent } from '../agent'
import { CheckOwnPassedAtVariable } from '../checks'
import {
  CheckOwnPasses,
  ControlRole,
  ControlServer,
  Outcome,
  OwnCheck,
} from '../control'
import { Git, type Worktree } from '../git'
import { ModelProxy } from '../proxy'
import { WorkGraph } from '../workgraph'
import { drawBase36 } from '../workgraph/ids'
import { recordTurns } from './turns'
import { type WorkerContext, modelOf, runVariables, standingOf } from './worker'

// The verifier after `finish` (spec §13.6, H19, H89): a separate Pi session in the ticket's worktree,
// read-only (Pi's read, grep, find, ls and bash, and its one tool of the extension's, `verdict`),
// given the ticket and the diff but none of the worker's reasoning, on `verifier.model`, else a
// configured model of another provider than the worker's, else the worker's. The worker's `check_own`
// pass on the finished tree stands for it: its prompt says so, and its environment names the last
// pass's tree (`FABRICA_CHECK_OWN_PASSED_AT`) for a check that selects tests. Its verdict comes back
// through its control channel; the run loop hands a FAIL back to the worker with the rounds' findings
// (`handBackPrompt`), at most `verifier.rounds` times, and a round that disagrees with an earlier one
// to the worker to ask the maintainer.

/** A round the verifier gave its verdict in, counted from 1. */
export interface VerifierRound {
  readonly round: number
  readonly verdict: Verdict
}

/** What a verifier round came to. */
export type Verified = Data.TaggedEnum<{
  /** PASS on `tree`: the change goes to the merge queue. */
  Passed: { readonly verdict: Verdict; readonly tree: TreeHash }
  /** FAIL: back to the worker with its findings. */
  Failed: { readonly verdict: Verdict }
  /** A finding disagrees with an earlier round (`DISAGREES WITH ROUND <n>`): the worker asks the maintainer. */
  Disagrees: {
    readonly verdict: Verdict
    readonly rounds: ReadonlyArray<number>
  }
  /** The verifier settled twice without a verdict. */
  Unanswered: {}
  /** The verifier couldn't be started or run: its session, its control channel, git, the work graph. */
  NotRun: { readonly reason: string }
}>
export const Verified = Data.taggedEnum<Verified>()

/** Pi's tools the verifier has: its built-in readers and bash, for reading and running tests, and `verdict`. */
export const verifierTools: ReadonlyArray<string> = [
  'read',
  'grep',
  'find',
  'ls',
  'bash',
  VerdictTool.name,
]

/** The most of the diff the verifier's prompt holds; past it, the files changed and the command. */
const diffLimit = 200_000

/** The rounds an earlier round's findings say a verdict disagrees with, each once, in order. */
const disagreedWith = (verdict: Verdict): ReadonlyArray<number> =>
  [
    ...new Set(
      verdict.findings.flatMap(finding =>
        Option.toArray(finding.disagreesWithRound),
      ),
    ),
  ].sort((one, other) => one - other)

/** What a verdict comes to for the run: a disagreement first, then PASS or FAIL. */
export const judged = (verdict: Verdict, tree: TreeHash): Verified => {
  const rounds = disagreedWith(verdict)
  if (rounds.length > 0) return Verified.Disagrees({ verdict, rounds })
  return verdict._tag === 'PASS'
    ? Verified.Passed({ verdict, tree })
    : Verified.Failed({ verdict })
}

const agentModel = (choice: SettingsModel): ModelChoice => ({
  provider: choice.provider,
  modelId: choice.model,
})

/**
 * The verifier's model (§13.6): `verifier.model` where it is set; else the first of the project's
 * configured models (its `model`, then its fallbacks) whose provider isn't the worker's; else the
 * worker's own.
 */
export const verifierModel = (input: {
  readonly verifier: Option.Option<SettingsModel>
  readonly configured: ReadonlyArray<SettingsModel>
  readonly worker: Option.Option<ModelChoice>
}): Option.Option<ModelChoice> =>
  Option.match(input.verifier, {
    onSome: choice => Option.some(agentModel(choice)),
    onNone: () =>
      Option.orElse(
        Option.map(
          Option.fromUndefinedOr(
            input.configured.find(
              choice =>
                !Option.exists(
                  input.worker,
                  worker => worker.provider === choice.provider,
                ),
            ),
          ),
          agentModel,
        ),
        () => input.worker,
      ),
  })

/** A verdict's findings in words, one a line, `DISAGREES WITH ROUND <n>` where one says so. */
const findingLines = (verdict: Verdict): ReadonlyArray<string> =>
  verdict.findings.map(finding => {
    const kind = finding.blocking ? 'blocking' : 'optional'
    const disagrees = Option.match(finding.disagreesWithRound, {
      onNone: () => '',
      onSome: round => `DISAGREES WITH ROUND ${round}: `,
    })
    return `- [${kind}] ${disagrees}${finding.gap}`
  })

/** A round's verdict in words: its round, PASS or FAIL, its summary and its findings. */
export const roundText = ({ round, verdict }: VerifierRound): string =>
  [
    `Round ${round}: ${verdict._tag}. ${verdict.summary}`,
    ...findingLines(verdict),
  ].join('\n')

const earlierText = (earlier: ReadonlyArray<VerifierRound>): string =>
  earlier.map(roundText).join('\n\n')

/** The diff as the verifier's prompt holds it: whole, or past `diffLimit` the files it changes. */
const diffText = (input: {
  readonly from: string
  readonly to: string
  readonly files: ReadonlyArray<FileDiff>
}): string => {
  const patch = input.files.map(file => file.patch).join('\n')
  const command = `git diff ${input.from} ${input.to}`
  if (patch.length <= diffLimit)
    return `The change, as \`${command}\` shows it:\n\n\`\`\`diff\n${patch}\n\`\`\``
  return [
    `The change is too long to give here: read it with \`${command}\`. The files it changes:`,
    ...input.files.map(file => `- ${file.path} (${file.change})`),
  ].join('\n')
}

/** The verifier's prompt: the ticket, the change, what its check stands on, and the earlier rounds. */
export const verifierPrompt = (input: {
  readonly ticket: Ticket
  readonly round: number
  readonly rounds: number
  readonly diff: string
  readonly checkOwn: OwnCheck
  readonly passedAt: Option.Option<TreeHash>
  readonly earlier: ReadonlyArray<VerifierRound>
}): string => {
  const { ticket } = input
  const parts: Array<string> = [
    `You verify a change you did not write, made for the ticket ${ticket.id}, before it merges: round ${input.round} of at most ${input.rounds}. You see the ticket and the change, not the reasoning that produced them: judge the result on its own terms, and try to show that it is not done. Change nothing. Give your verdict once, through verdict.`,
    [
      `The ticket, ${ticket.id}: ${ticket.title}`,
      ...Option.toArray(ticket.description),
      ...Option.toArray(Option.map(ticket.design, text => `Design:\n${text}`)),
      ...Option.toArray(
        Option.map(ticket.acceptance, text => `Acceptance criteria:\n${text}`),
      ),
    ].join('\n\n'),
    input.diff,
    OwnCheck.$match(input.checkOwn, {
      Passed: ({ pass }) =>
        `The project's check_own passed on this tree, ${pass.tree}, at ${pass.commit}; its whole output is in ${pass.output}. Its results stand: quote them rather than run check_own again, and run only a suite it leaves out that covers what the change touches.`,
      Unchecked: () =>
        'The project\'s check_own is "none": the change finished unchecked. Run the suites on what it touches, and lint and type checks on the files it changed.',
    }),
  ]
  Option.match(input.passedAt, {
    onNone: () => undefined,
    onSome: tree =>
      parts.push(
        `${CheckOwnPassedAtVariable} in your environment names the tree the last pass ran on, ${tree}, so a check that selects tests can leave out those that passed there and that nothing since touches.`,
      ),
  })
  if (input.earlier.length > 0)
    parts.push(
      [
        "The earlier rounds' findings. Check each again on its own terms rather than take or drop it unseen; one the change has since fixed is simply fixed. Where you judge otherwise than an earlier round, as over what a requirement means, give that finding disagreesWithRound with the round's number, saying why and your evidence: the worker then takes it to the maintainer rather than go round again.",
        earlierText(input.earlier),
      ].join('\n\n'),
    )
  parts.push(
    "For each requirement and acceptance criterion: is it implemented, and is there a test that would fail without the change? Did anything change that the ticket doesn't ask for? A finding is blocking only where it affects correctness or the ticket's requirements; leave out style preferences. Give each gap with its file and line and its evidence. PASS when the change meets its ticket; FAIL with at least one blocking finding.",
  )
  return parts.join('\n\n')
}

/**
 * The worker's prompt when a round hands its change back (§13.6): FAIL with rounds left, fix and
 * finish again; FAIL in the last round, finish only where it judges the findings outside the ticket's
 * requirements, else defer; a disagreement, ask the maintainer which round holds.
 */
export const handBackPrompt = (input: {
  readonly ticket: TicketId
  readonly round: VerifierRound
  readonly rounds: number
  readonly earlier: ReadonlyArray<VerifierRound>
}): string => {
  const { round, verdict } = input.round
  const earlier =
    input.earlier.length > 0
      ? [`The earlier rounds' findings:\n\n${earlierText(input.earlier)}`]
      : []
  const disagrees = disagreedWith(verdict)
  if (disagrees.length > 0)
    return [
      `The verifier's round ${round} on ${input.ticket} disagrees with round ${disagrees.join(', ')}:`,
      roundText(input.round),
      ...earlier,
      `Don't go round again to settle it: ask the maintainer which holds with ask_question, blocking ${input.ticket}, both rounds' findings in its description, with your options and your recommendation.`,
    ].join('\n\n')
  const last = round >= input.rounds
  return [
    `The verifier's round ${round} of at most ${input.rounds} found your change of ${input.ticket} not done:`,
    roundText(input.round),
    ...earlier,
    last
      ? "That was the last round, and its findings are noted on the ticket. Finish only where you judge its blocking findings outside the ticket's requirements, saying why with add_note: your finish goes to the merge queue with no further round. Otherwise fix them and finish, or defer where you cannot."
      : 'Fix each blocking finding, commit, run check_own after your last change, and finish again: the verifier then checks the change once more.',
  ].join('\n\n')
}

/** A verifier's session, as its claim on the proxy and its control channel name it. */
const drawSession = Effect.map(drawBase36(16), random =>
  SessionId.make(`verifier-${random}`),
)

/** The diff from the branch's merge base with Base to its HEAD, in words. */
const changeOf = Effect.fn('Verifier.change')(function* (
  context: WorkerContext,
  worktree: Worktree,
) {
  const git = yield* Git
  const [base, head] = yield* Effect.all(
    [
      git.mergeBase({
        repo: worktree.path,
        branch: 'HEAD',
        base: context.started.base,
      }),
      git.commitHash({ repo: worktree.path, revision: 'HEAD' }),
    ],
    { concurrency: 2 },
  )
  if (Option.isNone(base) || Option.isNone(head))
    return `Read the change with \`git diff ${context.started.base}...HEAD\`.`
  const files = yield* git.diff({
    repo: worktree.path,
    from: base.value,
    to: head.value,
  })
  return diffText({ from: base.value, to: head.value, files })
})

/** One round of the verifier on what the ticket's worker finished in `worktree`. */
const verifyRound = Effect.fn('Verifier.round')(function* (input: {
  readonly context: WorkerContext
  readonly ticket: TicketId
  readonly worktree: Worktree
  readonly checkOwn: OwnCheck
  readonly round: number
  readonly earlier: ReadonlyArray<VerifierRound>
}) {
  const graph = yield* WorkGraph
  const git = yield* Git
  const passes = yield* CheckOwnPasses
  const control = yield* ControlServer
  const proxy = yield* ModelProxy
  const agents = yield* PiAgent
  const { context, ticket, worktree } = input
  const { config, started } = context
  const project = started.settings.project

  const [detail, diff, passedAt, tree] = yield* Effect.all(
    [
      graph.show(ticket),
      changeOf(context, worktree),
      passes.last(ticket),
      git.worktreeTree({ worktree: worktree.path }),
    ],
    { concurrency: 'unbounded' },
  )
  const model = verifierModel({
    verifier: project.verifier.model,
    configured: [...Option.toArray(project.model), ...project.model_fallbacks],
    worker: modelOf(detail.ticket, started),
  })
  const session = yield* drawSession
  const channel = yield* control.open({
    project: config.project,
    ticket,
    session,
    role: ControlRole.Verifier({ round: input.round }),
    worktree: worktree.path,
    folder: config.sockets,
    questionWait: project.question_wait,
    checkOwn: {
      command: project.check_own,
      checkout: config.checkout,
      timeLimit: project.check_timeout,
      cores: config.cores,
      nice: config.nice,
    },
    mergeStanding: standingOf(context.merges, ticket),
  })
  const modelText = Option.match(model, {
    onNone: () => 'none',
    onSome: ({ provider, modelId }) => `${provider}/${modelId}`,
  })
  const granted = yield* proxy.grant({
    run: context.run,
    ticket: Option.some(ticket),
    session: Option.some(session),
    model: modelText,
  })

  // The verdict, read from before the agent starts; a session that settled without one says so.
  const answered = yield* Deferred.make<Verified>()
  yield* channel.outcomes.pipe(
    Stream.runForEach(outcome =>
      Outcome.$match(outcome, {
        Verdict: ({ verdict }) =>
          Deferred.succeed(answered, judged(verdict, tree)),
        Unfinished: () => Deferred.succeed(answered, Verified.Unanswered()),
        ToolFailed: ({ tool, reason }) =>
          Deferred.succeed(
            answered,
            Verified.NotRun({
              reason: `${tool} failed in the engine: ${reason}`,
            }),
          ),
        Finished: () => Effect.void,
        Deferred: () => Effect.void,
        WaitsFor: () => Effect.void,
        Asked: () => Effect.void,
        Checked: () => Effect.void,
      }).pipe(Effect.asVoid),
    ),
    Effect.forkScoped,
  )

  const agent = yield* agents.start({
    ticket,
    project: config.project,
    worktree: worktree.path,
    providers: Object.entries(granted.baseUrls).map(([provider, baseUrl]) => ({
      provider,
      baseUrl,
    })),
    token: Redacted.value(granted.token),
    model,
    tools: Option.some(verifierTools),
    resume: Option.none(),
    env: {
      ...channel.environment,
      ...runVariables(started),
      [AgentRoleVariable]: 'verifier',
      ...Option.match(passedAt, {
        onNone: () => ({}),
        onSome: passed => ({ [CheckOwnPassedAtVariable]: passed }),
      }),
    },
    projectTrusted: config.projectTrusted,
    nice: config.nice,
  })
  yield* recordTurns({
    log: context.log,
    cost: context.cost,
    ticket: Option.some(ticket),
    session,
    model: Schema.is(ModelName)(modelText) ? modelText : 'none',
    events: yield* agent.events,
  })
  yield* agent.prompt(
    verifierPrompt({
      ticket: detail.ticket,
      round: input.round,
      rounds: project.verifier.rounds,
      diff,
      checkOwn: input.checkOwn,
      passedAt,
      earlier: input.earlier,
    }),
  )
  // The verdict is published before its tool answers, and the turn settles after: it is here.
  const verified = yield* Deferred.poll(answered)
  return Option.isSome(verified) ? yield* verified.value : Verified.Unanswered()
})

/**
 * Verifies what the ticket's worker finished in `worktree`, in round `round`, the earlier rounds'
 * verdicts given; what keeps the verifier from a verdict is its outcome, in its own scope.
 */
export const verifyFinished = (input: {
  readonly context: WorkerContext
  readonly ticket: TicketId
  readonly worktree: Worktree
  readonly checkOwn: OwnCheck
  readonly round: number
  readonly earlier: ReadonlyArray<VerifierRound>
}) =>
  verifyRound(input).pipe(
    Effect.scoped,
    Effect.catch(error =>
      Effect.succeed(Verified.NotRun({ reason: error.message })),
    ),
  )
