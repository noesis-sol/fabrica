import {
  Console,
  Effect,
  Fiber,
  Option,
  Ref,
  Schema,
  Stdio,
  Stream,
  SubscriptionRef,
} from 'effect'
import { Argument, Command, Flag } from 'effect/cli'

import {
  ModelChoice,
  type ProjectId,
  type TalkContext,
  type TalkId,
  TicketId,
  TranscriptEntry,
} from '@fabrica/contracts'

import { Json } from './flags'
import { sanitiseLine } from './sanitise'
import { projectFlag, refused, withProject } from './tickets-project'

// `fabrica talk refine|feature|answer|run` (spec §19, §15.4): a talk on the terminal. It opens the talk
// in the project (`--project`, or the one whose checkout holds this folder), on the project's model or
// `--model`, prints its transcript as it comes, and sends each line read from stdin as the
// maintainer's message. At the end of stdin (Ctrl-D) it waits for the talk's answer to the last
// message (the engine's opening prompt among them), then closes the talk; a kept talk (the run talk) keeps its session for the next open.
// The model's text is printed a line at a time, its tool calls as `→ <tool> <input>`, a tool that
// failed as `✗ <tool> failed`, the engine's messages (its opening prompt, its notices) as `fabrica: <text>`, and the maintainer's own
// messages, where stdin isn't a terminal that shows them already, as `> <text>`. With `--json`, each
// transcript entry is one line of JSON.

/** Where the talk stands, as the terminal reads it. */
interface Standing {
  /** The transcript's snapshot has been read, so what the talk was doing as it opened is known. */
  readonly read: boolean
  /** Messages this command sent. */
  readonly sent: number
  /** The maintainer's messages the transcript has shown. */
  readonly shown: number
  /** A message waits for its answer: one was sent, or the model is answering, since the last turn's end. */
  readonly waiting: boolean
}

/** Whether every message sent has been answered. */
const answered = ({ read, sent, shown, waiting }: Standing): boolean =>
  read && shown >= sent && !waiting

const modelFlag = Flag.String('model').pipe(
  Flag.withDescription(
    "The talk's model, as provider/model (anthropic/claude-opus-5-5); the project's where it isn't given",
  ),
  Flag.optional,
)

const decodeModel = Schema.decodeUnknownOption(ModelChoice)

/** The model `--model` names, or the refusal that it doesn't name one. */
const modelOf = (given: Option.Option<string>) =>
  Option.match(given, {
    onNone: () => Effect.succeedNone,
    onSome: text =>
      Option.match(decodeModel(text), {
        onNone: () =>
          Effect.fail(
            refused(
              `${sanitiseLine(text)} isn't a model: write it as provider/model, such as anthropic/claude-opus-5-5`,
            ),
          ),
        onSome: model => Effect.succeed(Option.some(model)),
      }),
  })

const encodeEntry = Schema.encodeSync(TranscriptEntry)

/** Prints transcript entries on the terminal, keeping where the talk stands. */
const makePrinter = Effect.fn('Cli.talkPrinter')(function* (
  standing: SubscriptionRef.SubscriptionRef<Standing>,
) {
  const json = yield* Json
  const stdio = yield* Stdio.Stdio
  const echo = !(yield* stdio.stdinIsTerminal)
  /** The model's text not yet printed: its last line, until it ends. */
  const partial = yield* Ref.make('')
  /** Each tool call's tool, for its end. */
  const tools = yield* Ref.make<ReadonlyMap<string, string>>(new Map())

  const flushPartial = Effect.flatMap(Ref.getAndSet(partial, ''), rest =>
    rest === '' ? Effect.void : Console.log(rest),
  )
  const lines = (prefix: string, text: string) =>
    Effect.forEach(text.split('\n'), each => Console.log(`${prefix}${each}`), {
      discard: true,
    })
  const stand = (change: (standing: Standing) => Standing) =>
    SubscriptionRef.update(standing, change)

  const text = TranscriptEntry.match<Effect.Effect<void>>({
    message: ({ role, text }) =>
      Effect.andThen(
        flushPartial,
        role === 'user'
          ? echo
            ? lines('> ', text)
            : Effect.void
          : role === 'engine'
            ? lines('fabrica: ', text)
            : Ref.set(partial, text),
      ),
    text: ({ delta }) =>
      Effect.gen(function* () {
        const pieces = `${yield* Ref.get(partial)}${delta}`.split('\n')
        const last = pieces.pop() ?? ''
        yield* Ref.set(partial, last)
        yield* Effect.forEach(pieces, piece => Console.log(piece), {
          discard: true,
        })
      }),
    thinking: () => Effect.void,
    tool_input: () => Effect.void,
    tool_call: ({ id, tool, input }) =>
      Effect.andThen(
        Effect.andThen(
          flushPartial,
          Ref.update(tools, current => new Map(current).set(id, tool)),
        ),
        Console.log(`→ ${sanitiseLine(tool)} ${JSON.stringify(input)}`),
      ),
    tool_output: () => Effect.void,
    tool_end: ({ id, ok }) =>
      ok
        ? Effect.void
        : Effect.flatMap(Ref.get(tools), current =>
            Console.log(`✗ ${sanitiseLine(current.get(id) ?? id)} failed`),
          ),
    turn_end: () => flushPartial,
  })

  /**
   * Keeps where the talk stands from an entry: every message (the maintainer's, the engine's opening
   * prompt or notice, the model's) waits for the turn's end.
   */
  const standOn = TranscriptEntry.match<Effect.Effect<void>>({
    message: ({ role }) =>
      stand(now => ({
        ...now,
        shown: role === 'user' ? now.shown + 1 : now.shown,
        waiting: true,
      })),
    text: () => Effect.void,
    thinking: () => Effect.void,
    tool_input: () => Effect.void,
    tool_call: () => Effect.void,
    tool_output: () => Effect.void,
    tool_end: () => Effect.void,
    turn_end: () => stand(now => ({ ...now, waiting: false })),
  })

  const print = (entry: TranscriptEntry) =>
    Effect.andThen(
      json ? Console.log(JSON.stringify(encodeEntry(entry))) : text(entry),
      standOn(entry),
    )

  return { print, flush: flushPartial }
})

/** The talk opened on `context`, on the terminal until stdin ends; closed as it ends. */
const talkOn = (options: {
  readonly context: (
    project: ProjectId,
  ) => Effect.Effect<TalkContext, ReturnType<typeof refused>>
  readonly project: Option.Option<string>
  readonly model: Option.Option<string>
}) =>
  Effect.gen(function* () {
    const model = yield* modelOf(options.model)
    const stdio = yield* Stdio.Stdio
    const json = yield* Json
    const standing = yield* SubscriptionRef.make<Standing>({
      read: false,
      sent: 0,
      shown: 0,
      waiting: false,
    })
    const printer = yield* makePrinter(standing)
    yield* withProject(options.project, (client, project) =>
      Effect.gen(function* () {
        const context = yield* options.context(project)
        const opened = yield* Effect.acquireRelease(
          client.rpc['talk.open']({ project, context, model }),
          ({ talk }) => Effect.ignore(client.rpc['talk.close']({ talk })),
        ).pipe(
          Effect.catchTag('TalkNotOpened', ({ reason }) =>
            Effect.fail(
              refused(`the talk couldn't be opened: ${sanitiseLine(reason)}`),
            ),
          ),
        )
        if (!json)
          yield* Console.log(
            `talk ${sanitiseLine(opened.talk)} · ${sanitiseLine(opened.model)}: type a message and Enter to send it, Ctrl-D to end`,
          )
        const watching = yield* client.rpc['talk.watchTranscript']({
          talk: opened.talk,
          resume: Option.none(),
        }).pipe(
          Stream.runForEach(item =>
            Effect.andThen(
              Effect.forEach(item.value, printer.print, { discard: true }),
              SubscriptionRef.update(standing, now => ({ ...now, read: true })),
            ),
          ),
          Effect.andThen(printer.flush),
          Effect.forkScoped,
        )
        // Stdin's own errors are the terminal's; a message the engine refuses fails the command.
        yield* stdio.stdin.pipe(
          Stream.orDie,
          Stream.decodeText(),
          Stream.splitLines,
          Stream.filter(line => line.trim() !== ''),
          Stream.runForEach(text =>
            Effect.andThen(
              SubscriptionRef.update(standing, now => ({
                ...now,
                sent: now.sent + 1,
              })),
              client.rpc['talk.send']({ talk: opened.talk, text }),
            ),
          ),
        )
        // Every message answered, or the talk ended.
        yield* Effect.raceFirst(
          SubscriptionRef.changes(standing).pipe(
            Stream.filter(answered),
            Stream.runHead,
          ),
          Fiber.join(watching),
        )
        yield* printer.flush
      }).pipe(
        // The talk closes before the client does.
        Effect.scoped,
        Effect.catchTag('TalkNotFound', ({ talk }) =>
          Effect.fail(talkEnded(talk)),
        ),
      ),
    )
  })

const talkEnded = (talk: TalkId) =>
  refused(`the talk ${sanitiseLine(talk)} has ended`)

const flags = { project: projectFlag, model: modelFlag }

const refine = Command.make(
  'refine',
  {
    ...flags,
    spec: Argument.String('spec').pipe(
      Argument.withDescription("The spec's path in the project"),
    ),
  },
  ({ spec, project, model }) =>
    talkOn({
      context: () => Effect.succeed({ _tag: 'refine', spec }),
      project,
      model,
    }),
).pipe(Command.withDescription('Refines a spec into tickets'))

const feature = Command.make(
  'feature',
  {
    ...flags,
    text: Argument.String('text').pipe(
      Argument.withDescription('The feature, in a few words'),
      Argument.variadic(),
    ),
  },
  ({ text, project, model }) =>
    talkOn({
      context: () =>
        Effect.succeed({
          _tag: 'feature',
          text: text.length === 0 ? Option.none() : Option.some(text.join(' ')),
        }),
      project,
      model,
    }),
).pipe(Command.withDescription('Shapes a feature into tickets'))

const answer = Command.make(
  'answer',
  {
    ...flags,
    questions: Argument.String('question').pipe(
      Argument.withDescription(
        'The questions to answer, by ID; every open one where none is named',
      ),
      Argument.variadic(),
    ),
  },
  ({ questions, project, model }) =>
    talkOn({
      context: () =>
        Effect.forEach(questions, text =>
          Option.match(TicketId.makeOption(text), {
            onNone: () =>
              Effect.fail(refused(`${sanitiseLine(text)} isn't a ticket's ID`)),
            onSome: Effect.succeed,
          }),
        ).pipe(Effect.map(ids => ({ _tag: 'answer', questions: ids }))),
      project,
      model,
    }),
).pipe(Command.withDescription('Answers questions in a talk'))

const run = Command.make('run', flags, ({ project, model }) =>
  talkOn({ context: () => Effect.succeed({ _tag: 'run' }), project, model }),
).pipe(Command.withDescription('Talks about a run'))

export const talk = Command.make('talk').pipe(
  Command.withDescription('A talk on the terminal'),
  Command.withSubcommands([refine, feature, answer, run]),
)
