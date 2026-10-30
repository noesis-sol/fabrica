import {
  Console,
  Data,
  DateTime,
  Effect,
  Option,
  Runtime,
  Schema,
} from 'effect'
import { Command, Flag } from 'effect/cli'

import {
  type ExitCode,
  ProjectId,
  RunFlags,
  RunId,
  RunMode,
  RunStatus,
  StopKind,
  TicketId,
  exitCodeOf,
} from '@fabrica/contracts'

import { Json, optionalValueFlag } from './flags'
import { Followed, followRun } from './follow'
import { printAnswer } from './output'
import { sanitiseLine } from './sanitise'
import { projectFlag, refused, withProject } from './tickets-project'

// `fabrica run [--tickets|--ticket <id>|--spec <file|url> [--refine]|--feature "<text>"|--overnight]
// [--limit N] [--concurrent N] [--model …] [--auto-answer[=<duration>]] [--offline] [--wait]` and
// `fabrica run status|drain|undrain|stop` (spec §19, §13.1, §13.10, §13.11): a run of the project
// (`--project`, or the one whose checkout holds this folder). Without `--wait` the command returns once
// the run starts; with it, it prints the run's lines as `fabrica follow` does and exits with the code
// its end gives (§13.11). A start the engine refuses prints every problem and exits with its end's
// code, 2 for a start check's. `--concurrent`, `--model` and `--auto-answer` are settings flags: the
// engine resolves them with the project's and its own settings (§13.13).

/** The run ended, or didn't start, with a non-zero exit code (§13.11): the command exits with it. */
export class RunExited extends Data.TaggedError('RunExited')<{
  readonly code: ExitCode
  readonly said: string
}> {
  override get [Runtime.errorExitCode](): number {
    return this.code
  }

  override get message() {
    return this.said
  }
}

/** What a start came to, as the engine answered it. */
type Start = Data.TaggedEnum<{
  Started: { readonly run: RunId }
  /** Started, then followed to its end (`--wait`). */
  Followed: { readonly run: RunId; readonly followed: Followed }
  Going: { readonly project: ProjectId; readonly run: RunId }
  Refused: {
    readonly end: StopKind
    readonly problems: ReadonlyArray<string>
  }
}>
const Start = Data.taggedEnum<Start>()

/** The mode flags, as given. */
interface ModeFlags {
  readonly tickets: boolean
  readonly ticket: Option.Option<string>
  readonly spec: Option.Option<string>
  readonly refine: boolean
  readonly feature: Option.Option<string>
  readonly overnight: boolean
}

const modes =
  '--tickets, --ticket <id>, --spec <file|url>, --feature "<text>" or --overnight'

/** The run's mode, from its flags: the current tickets where none is given. */
const modeOf = (flags: ModeFlags) =>
  Effect.gen(function* () {
    if (flags.refine && Option.isNone(flags.spec))
      return yield* refused('--refine refines a spec: give it with --spec')
    const given: ReadonlyArray<
      Effect.Effect<RunMode, ReturnType<typeof refused>>
    > = [
      ...(flags.tickets
        ? [Effect.succeed(RunMode.cases.tickets.make({}))]
        : []),
      ...Option.toArray(
        Option.map(flags.ticket, text =>
          Option.match(TicketId.makeOption(text), {
            onNone: () =>
              Effect.fail(refused(`${sanitiseLine(text)} isn't a ticket's ID`)),
            onSome: ticket =>
              Effect.succeed(RunMode.cases.ticket.make({ ticket })),
          }),
        ),
      ),
      ...Option.toArray(
        Option.map(flags.spec, source =>
          Effect.succeed(
            RunMode.cases.spec.make({ source, refine: flags.refine }),
          ),
        ),
      ),
      ...Option.toArray(
        Option.map(flags.feature, text =>
          Effect.succeed(RunMode.cases.feature.make({ text })),
        ),
      ),
      ...(flags.overnight
        ? [Effect.succeed(RunMode.cases.overnight.make({}))]
        : []),
    ]
    const [only, ...more] = given
    if (more.length > 0)
      return yield* refused(`give one mode at most: ${modes}`)
    return yield* only ?? Effect.succeed(RunMode.cases.tickets.make({}))
  })

/** The run's flags: its limit, `--offline`, and the settings flags by setting path, as their text. */
const flagsOf = (given: {
  readonly limit: Option.Option<number>
  readonly concurrent: Option.Option<number>
  readonly model: Option.Option<string>
  readonly autoAnswer: Option.Option<string>
  readonly offline: boolean
}) =>
  Effect.gen(function* () {
    if (Option.exists(given.limit, limit => limit < 1))
      return yield* refused('--limit takes a whole number, 1 or more')
    const settings: Record<string, string> = {}
    if (Option.isSome(given.concurrent))
      settings['concurrent'] = String(given.concurrent.value)
    if (Option.isSome(given.model)) settings['model'] = given.model.value
    if (Option.isSome(given.autoAnswer))
      settings['auto_answer'] = given.autoAnswer.value
    return RunFlags.make({
      limit: given.limit,
      offline: given.offline,
      settings,
      preflight: Option.none(),
    })
  })

const switchFlag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(
    Flag.withDescription(description),
    Flag.withDefault(false),
  )

const valueFlag = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional)

const countFlag = (name: string, description: string) =>
  Flag.Int(name).pipe(Flag.withDescription(description), Flag.optional)

const startAnswer = Schema.Struct({ run: RunId })
const refusedAnswer = Schema.Struct({
  end: StopKind,
  problems: Schema.Array(Schema.String),
})

/** Prints what a start came to, failing with the exit code a refusal or the run's end gives. */
const answerStart = Start.$match({
  Started: ({ run }) =>
    printAnswer({
      schema: startAnswer,
      value: { run },
      text: () =>
        `started the run ${sanitiseLine(run)}: follow it with \`fabrica follow\``,
    }),
  Followed: ({ run, followed }) =>
    Followed.$match(followed, {
      Ended: ({ code }) =>
        code === 0
          ? Effect.void
          : Effect.fail(
              new RunExited({
                code,
                said: `the run ${sanitiseLine(run)} ended with exit code ${code}`,
              }),
            ),
      Unended: () =>
        Effect.fail(
          refused(
            `the run ${sanitiseLine(run)} ended, its end record lost: \`fabrica run status\` says how`,
          ),
        ),
      NoRun: () =>
        Effect.fail(refused(`the run ${sanitiseLine(run)} isn't going`)),
    }),
  Going: ({ project, run }) =>
    Effect.fail(
      refused(
        `${sanitiseLine(project)} has a run going already, ${sanitiseLine(run)}: stop it with \`fabrica run stop\`, or follow it with \`fabrica follow\``,
      ),
    ),
  Refused: ({ end, problems }) =>
    Effect.gen(function* () {
      if (yield* Json)
        yield* printAnswer({
          schema: refusedAnswer,
          value: { end, problems },
          text: () => '',
        })
      else
        yield* Effect.forEach(
          problems,
          problem => Console.error(`  ${sanitiseLine(problem)}`),
          { discard: true },
        )
      return yield* new RunExited({
        code: exitCodeOf(end),
        said: `the run didn't start (${end})`,
      })
    }),
})

const start = Command.make(
  'run',
  {
    project: projectFlag,
    tickets: switchFlag('tickets', 'Runs the current tickets (the default)'),
    ticket: valueFlag('ticket', 'Runs one ticket and its descendants'),
    spec: valueFlag(
      'spec',
      'Runs a spec: a file in the project, or an https URL',
    ),
    refine: switchFlag('refine', 'Refines the spec in a talk first'),
    feature: valueFlag('feature', 'Runs a feature, talked through first'),
    overnight: switchFlag(
      'overnight',
      'Runs overnight, after its pre-flight checklist',
    ),
    limit: countFlag('limit', 'Dispatches at most this many tickets'),
    concurrent: countFlag(
      'concurrent',
      "Runs at most this many workers at once; the project's concurrent setting where it isn't given",
    ),
    model: valueFlag(
      'model',
      "The workers' model, as provider/model; the project's where it isn't given",
    ),
    autoAnswer: optionalValueFlag('auto-answer').pipe(
      Flag.withDescription(
        "Answers the run's ordinary questions with their recommended option, at once or after the duration given",
      ),
      Flag.optional,
    ),
    offline: switchFlag(
      'offline',
      'Starts without the remote: the run lease unchecked',
    ),
    wait: switchFlag(
      'wait',
      "Waits for the run's end, printing its lines, and exits with its code",
    ),
  },
  given =>
    Effect.gen(function* () {
      const mode = yield* modeOf(given)
      const flags = yield* flagsOf(given)
      const json = yield* Json
      const started = yield* withProject(given.project, (client, project) =>
        client.rpc['run.start']({ project, mode, flags }).pipe(
          Effect.flatMap(({ run }) =>
            given.wait
              ? Effect.map(
                  followRun({ client, project, run: Option.some(run), json }),
                  (followed): Start => Start.Followed({ run, followed }),
                )
              : Effect.succeed<Start>(Start.Started({ run })),
          ),
          Effect.catchTags({
            RunGoing: ({ run }) =>
              Effect.succeed(Start.Going({ project, run })),
            RunRefused: ({ end, problems }) =>
              Effect.succeed(Start.Refused({ end, problems })),
          }),
        ),
      )
      yield* answerStart(started)
    }),
)

/** A run's mode in words. */
const modeWords = RunMode.match({
  tickets: () => 'the current tickets',
  ticket: ({ ticket }) => `${sanitiseLine(ticket)} and its descendants`,
  spec: ({ source }) => `the spec ${sanitiseLine(source)}`,
  feature: () => 'a feature',
  overnight: () => 'overnight',
})

const statusText = RunStatus.match({
  going: ({ header }) =>
    [
      `run      ${sanitiseLine(header.run)}`,
      `state    ${header.state}`,
      `mode     ${modeWords(header.mode)}`,
      `started  ${DateTime.formatIso(header.startedAt)}`,
    ].join('\n'),
  idle: ({ last }) =>
    Option.match(last, {
      onNone: () => 'no run is going, and none has ended yet',
      onSome: ({ run, end, endedAt }) =>
        `no run is going; the last, ${sanitiseLine(run)}, ended ${end} at ${DateTime.formatIso(endedAt)}`,
    }),
})

const status = Command.make('status', { project: projectFlag }, ({ project }) =>
  withProject(project, (client, id) =>
    client.rpc['run.status']({ project: id }),
  ).pipe(
    Effect.flatMap(value =>
      printAnswer({ schema: RunStatus, value, text: statusText }),
    ),
  ),
).pipe(Command.withDescription("The run's state"))

/** What `drain`, `undrain` and `stop` asked of the run. */
const Asked = Schema.Literals(['drain', 'undrain', 'stop'])
type Asked = typeof Asked.Type

const askedAnswer = Schema.Struct({ project: ProjectId, asked: Asked })

const askedWords: { readonly [K in Asked]: string } = {
  drain: 'drains: no new tickets; the running ones finish and merge',
  undrain: 'starts tickets again',
  stop: 'stops: its workers are interrupted, their sessions saved',
}

/** `fabrica run drain`, `undrain` or `stop`: asks the project's run so. */
const ask = (asked: Asked, description: string) =>
  Command.make(asked, { project: projectFlag }, ({ project }) =>
    Effect.gen(function* () {
      const going = yield* withProject(project, (client, id) =>
        client.rpc[`run.${asked}`]({ project: id }).pipe(
          Effect.as(Option.some(id)),
          Effect.catchTag('NoRun', () => Effect.succeedNone),
        ),
      )
      if (Option.isNone(going))
        return yield* refused(
          'no run is going in the project: start one with `fabrica run`',
        )
      yield* printAnswer({
        schema: askedAnswer,
        value: { project: going.value, asked },
        text: () =>
          `the run of ${sanitiseLine(going.value)} ${askedWords[asked]}`,
      })
    }),
  ).pipe(Command.withDescription(description))

export const run = start.pipe(
  Command.withDescription('Starts a run'),
  Command.withSubcommands([
    status,
    ask('drain', 'Starts no more tickets; the ones running finish'),
    ask('undrain', 'Starts tickets again'),
    ask('stop', 'Stops the run'),
  ]),
)
