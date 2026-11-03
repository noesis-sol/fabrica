import {
  Console,
  DateTime,
  Effect,
  Option,
  Queue,
  Schema,
  Stream,
} from 'effect'
import { Argument, Command, Flag } from 'effect/cli'

import type { EngineClientShape } from '@fabrica/client'
import {
  Answered,
  AttentionAnswer,
  AttentionRequest,
  PermissionDecision,
  PermissionId,
  type ProjectId,
  QuestionAnswer,
  Revised,
  TalkContext,
  TicketId,
} from '@fabrica/contracts'

import { Json } from './flags'
import { printAnswer } from './output'
import { sanitiseLine } from './sanitise'
import { answerTalkOn, modelFlag, stdinLines, talkIn } from './talk'
import { projectFlag, refused, withProject } from './tickets-project'

// `fabrica answer [<id>]` (spec §19, §15.1, §15.2): questions and permission requests, asked on the
// terminal with their options, oldest first, the list read again after each so that what arrives is
// asked too and what another client answered isn't. Options are numbered from 1 in the order they
// were filed, the recommended one marked, and nothing is chosen for the maintainer: Enter passes a
// request by. `t` talks a question through in the answer talk, which then has the terminal until
// stdin ends; `--talk` opens the talk straight away. An agent answers with flags (`--option`, `--text`,
// `--allow`, `--refuse`), which ask nothing, and reads the requests with `--json`; `--revise` changes
// an answer already given (H53).

const fromTerminal = (text: string) => text.split('\n').map(sanitiseLine)

/** Why a command line asks for something it doesn't hold together. */
const notTogether = (reason: string) => Effect.fail(refused(reason))

const Asked = Schema.Array(AttentionRequest)

type Question = Extract<AttentionRequest, { readonly _tag: 'question' }>
type Permission = Extract<AttentionRequest, { readonly _tag: 'permission' }>
type Asking = Question | Permission

const isAsking = (request: AttentionRequest): request is Asking =>
  request._tag === 'question' || request._tag === 'permission'

/** The ID a request is named by on the command line. */
const idOf = (request: Asking): string =>
  request._tag === 'question' ? request.ticket : request.id

/** The lines that show a question, with its options. */
const questionLines = (question: Question): ReadonlyArray<string> => [
  `Question ${sanitiseLine(question.ticket)}: ${sanitiseLine(question.title)}`,
  ...(question.consequential
    ? ['  Consequential: nothing is chosen for you. Pick one deliberately.']
    : []),
  ...(question.maintainerOnly ? ['  Only you can answer this one.'] : []),
  ...Option.match(question.description, {
    onNone: () => [],
    onSome: text => fromTerminal(text).map(line => `  ${line}`),
  }),
  ...(question.blocks.length === 0
    ? []
    : [`  Blocks: ${question.blocks.map(sanitiseLine).join(', ')}`]),
  ...Option.match(question.askedFrom, {
    onNone: () => [],
    onSome: from => [`  Asked from: ${sanitiseLine(from)}`],
  }),
  ...Option.match(question.choices, {
    onNone: () => ['  Filed without options: the answer talk can draft them.'],
    onSome: ({ options, recommended }) => [
      ...(question.drafted
        ? ['  Options drafted by the answer talk, not by who asked:']
        : []),
      ...options.map(
        (option, index) =>
          `  ${index + 1}. ${sanitiseLine(option.label)}: ${sanitiseLine(option.tradeOff)}${index === recommended ? ' (recommended)' : ''}`,
      ),
    ],
  }),
  `Answer with ${Option.isSome(question.choices) ? 'its number or ' : ''}your own words, t to talk it through, Enter to pass:`,
]

/** The lines that show a permission request's call, whole (§15.1, H62). */
const permissionLines = (request: Permission): ReadonlyArray<string> => [
  `Permission ${sanitiseLine(request.id)} for ${sanitiseLine(request.ticket)}: ${sanitiseLine(request.tool)}`,
  `  Why it asks: ${sanitiseLine(request.why)}`,
  ...(request.shown._tag === 'command'
    ? request.shown.lines.flatMap(fromTerminal).map(line => `  $ ${line}`)
    : request.shown._tag === 'edit'
      ? [
          `  Edit ${sanitiseLine(request.shown.path)}:`,
          ...fromTerminal(request.shown.diff).map(line => `  ${line}`),
        ]
      : request.shown._tag === 'write'
        ? [
            `  Write ${sanitiseLine(request.shown.path)}:`,
            ...fromTerminal(request.shown.content).map(line => `  ${line}`),
          ]
        : fromTerminal(JSON.stringify(request.shown.input, null, 2)).map(
            line => `  ${line}`,
          )),
  '  1. Allow once',
  '  2. Allow for this run',
  '  3. Refuse (3 and a note, to say why)',
  'Answer with its number, Enter to pass:',
]

/** What a line typed for a question comes to. */
type QuestionLine =
  | { readonly _tag: 'pass' }
  | { readonly _tag: 'talk' }
  | { readonly _tag: 'again'; readonly why: string }
  | { readonly _tag: 'answer'; readonly answer: QuestionAnswer }

const readQuestionLine = (question: Question, typed: string): QuestionLine => {
  const line = typed.trim()
  if (line === '') return { _tag: 'pass' }
  if (line === 't') return { _tag: 'talk' }
  if (Option.isSome(question.choices) && /^\d+$/u.test(line)) {
    const index = Number(line) - 1
    return index >= 0 && index < question.choices.value.options.length
      ? {
          _tag: 'answer',
          answer: QuestionAnswer.cases.option.make({ index }),
        }
      : { _tag: 'again', why: `It has no option ${line}.` }
  }
  return {
    _tag: 'answer',
    answer: QuestionAnswer.cases.text.make({ text: line }),
  }
}

/** The decision a line typed for a permission request gives, or none where it gives none. */
const readPermissionLine = (
  typed: string,
): Option.Option<PermissionDecision> => {
  const line = typed.trim()
  if (line === '1')
    return Option.some(PermissionDecision.cases.allow_once.make({}))
  if (line === '2')
    return Option.some(PermissionDecision.cases.allow_run.make({}))
  if (line === '3' || line.startsWith('3 ')) {
    const note = line.slice(1).trim()
    return Option.some(
      PermissionDecision.cases.refuse.make({
        note: note === '' ? Option.none() : Option.some(note),
      }),
    )
  }
  return Option.none()
}

const say = (lines: ReadonlyArray<string>) =>
  Effect.forEach(lines, line => Console.log(line), { discard: true })

/** The requests the command asks: every open one, or the one `only` names. */
const requestsOf = (
  client: EngineClientShape,
  project: ProjectId,
  only: Option.Option<string>,
) =>
  Effect.map(
    client.rpc['attention.list']({ project: Option.some(project) }),
    requests =>
      requests.filter(isAsking).filter(request =>
        Option.match(only, {
          onNone: () => true,
          onSome: id => idOf(request) === id,
        }),
      ),
  )

/** Asks each request on the terminal, until none is left to ask or stdin ends. */
const askAll = (options: {
  readonly client: EngineClientShape
  readonly project: ProjectId
  readonly only: Option.Option<string>
  readonly model: Option.Option<string>
}) =>
  Effect.gen(function* () {
    const { client, project, only, model } = options
    const first = yield* requestsOf(client, project, only)
    if (first.length === 0)
      return yield* Option.match(only, {
        onNone: () => Console.log('Nothing waits on you.'),
        onSome: id =>
          notTogether(
            `${sanitiseLine(id)} isn't an open question or permission request in ${sanitiseLine(project)}: an answered question is changed with --revise`,
          ),
      })
    const input = yield* Stream.toQueue(yield* stdinLines, {
      capacity: 'unbounded',
    })
    const nextLine = Queue.take(input).pipe(
      Effect.map(Option.some),
      Effect.catch(() => Effect.succeedNone),
    )
    const asked = new Set<string>()

    /** Gives the answer, saying what became of it; whether the request is done with. */
    const give = (answer: AttentionAnswer) =>
      client.rpc['attention.answer']({ answer }).pipe(
        Effect.as(true),
        Effect.catchTags({
          AlreadyAnswered: ({ by, at }) =>
            Effect.as(
              Console.log(
                `${sanitiseLine(by)} answered it first, at ${DateTime.formatIso(at)}.`,
              ),
              true,
            ),
          AttentionNotFound: () =>
            Effect.as(Console.log("It isn't open any more."), true),
          InvalidAnswer: ({ reason }) =>
            Effect.as(Console.log(sanitiseLine(reason)), false),
        }),
      )

    const askQuestion = (question: Question) =>
      Effect.gen(function* () {
        yield* say(questionLines(question))
        while (true) {
          const line = yield* nextLine
          if (Option.isNone(line)) return false
          const read = readQuestionLine(question, line.value)
          if (read._tag === 'pass') return true
          if (read._tag === 'again') {
            yield* Console.log(read.why)
            continue
          }
          if (read._tag === 'talk') {
            yield* talkIn({
              client,
              project,
              context: TalkContext.cases.answer.make({
                questions: [question.ticket],
              }),
              model,
              lines: Stream.fromQueue(input),
            }).pipe(Effect.scoped)
            return false
          }
          const done = yield* give(
            AttentionAnswer.cases.question.make({
              project,
              ticket: question.ticket,
              answer: read.answer,
            }),
          )
          if (done) return true
        }
      })

    const askPermission = (request: Permission) =>
      Effect.gen(function* () {
        yield* say(permissionLines(request))
        while (true) {
          const line = yield* nextLine
          if (Option.isNone(line)) return false
          if (line.value.trim() === '') return true
          const decision = readPermissionLine(line.value)
          if (Option.isNone(decision)) {
            yield* Console.log('Answer with 1, 2 or 3, or Enter to pass.')
            continue
          }
          const done = yield* give(
            AttentionAnswer.cases.permission.make({
              project,
              id: request.id,
              decision: decision.value,
            }),
          )
          if (done) return true
        }
      })

    let requests = first
    while (true) {
      const next = requests.find(request => !asked.has(idOf(request)))
      if (next === undefined) return
      asked.add(idOf(next))
      const goesOn = yield* next._tag === 'question'
        ? askQuestion(next)
        : askPermission(next)
      if (!goesOn) return
      requests = yield* requestsOf(client, project, only)
    }
  }).pipe(Effect.scoped)

/** What the command line answers, where it answers. */
type Given =
  | { readonly _tag: 'question'; readonly answer: QuestionAnswer }
  | { readonly _tag: 'permission'; readonly decision: PermissionDecision }

const givenOf = (flags: {
  readonly option: Option.Option<number>
  readonly text: Option.Option<string>
  readonly allow: Option.Option<'once' | 'run'>
  readonly refuse: boolean
  readonly note: Option.Option<string>
  readonly revise: boolean
}): Effect.Effect<Option.Option<Given>, ReturnType<typeof refused>> => {
  const { option, text, allow, refuse, note, revise } = flags
  const answers =
    Number(Option.isSome(option)) +
    Number(Option.isSome(text)) +
    Number(Option.isSome(allow)) +
    Number(refuse)
  if (answers > 1)
    return notTogether('give one answer: --option, --text, --allow or --refuse')
  if (Option.isSome(note) && !refuse)
    return notTogether('--note goes with --refuse')
  if (revise && Option.isNone(option) && Option.isNone(text))
    return notTogether('--revise takes the new answer: --option or --text')
  if (Option.isSome(option))
    return option.value < 1
      ? notTogether('--option takes the number shown, from 1')
      : Effect.succeedSome<Given>({
          _tag: 'question',
          answer: QuestionAnswer.cases.option.make({
            index: option.value - 1,
          }),
        })
  if (Option.isSome(text))
    return Effect.succeedSome<Given>({
      _tag: 'question',
      answer: QuestionAnswer.cases.text.make({ text: text.value }),
    })
  if (Option.isSome(allow))
    return Effect.succeedSome<Given>({
      _tag: 'permission',
      decision:
        allow.value === 'once'
          ? PermissionDecision.cases.allow_once.make({})
          : PermissionDecision.cases.allow_run.make({}),
    })
  if (refuse)
    return Effect.succeedSome<Given>({
      _tag: 'permission',
      decision: PermissionDecision.cases.refuse.make({ note }),
    })
  return Effect.succeedNone
}

/** The refusal of an answer the command line gave, in words. */
const answerRefused = {
  AlreadyAnswered: ({
    by,
    at,
  }: {
    readonly by: string
    readonly at: DateTime.Utc
  }) =>
    Effect.fail(
      refused(
        `${sanitiseLine(by)} answered it first, at ${DateTime.formatIso(at)}: change it with --revise`,
      ),
    ),
  AttentionNotFound: () =>
    Effect.fail(refused("it isn't an open request of this project")),
  InvalidAnswer: ({ reason }: { readonly reason: string }) =>
    Effect.fail(refused(sanitiseLine(reason))),
}

/** The answer the command line gave to the request `id`. */
const answerGiven = (options: {
  readonly client: EngineClientShape
  readonly project: ProjectId
  readonly id: string
  readonly given: Given
  readonly revise: boolean
}) =>
  Effect.gen(function* () {
    const { client, project, id, given, revise } = options
    if (given._tag === 'permission') {
      const permission = yield* Option.match(PermissionId.makeOption(id), {
        onNone: () =>
          Effect.fail(
            refused(`${sanitiseLine(id)} isn't a permission request's ID`),
          ),
        onSome: Effect.succeed,
      })
      return yield* client.rpc['attention.answer']({
        answer: AttentionAnswer.cases.permission.make({
          project,
          id: permission,
          decision: given.decision,
        }),
      }).pipe(
        Effect.catchTags(answerRefused),
        Effect.flatMap(answered => printAnswered(id, answered)),
      )
    }
    const ticket = yield* Option.match(TicketId.makeOption(id), {
      onNone: () =>
        Effect.fail(refused(`${sanitiseLine(id)} isn't a ticket's ID`)),
      onSome: Effect.succeed,
    })
    if (!revise)
      return yield* client.rpc['attention.answer']({
        answer: AttentionAnswer.cases.question.make({
          project,
          ticket,
          answer: given.answer,
        }),
      }).pipe(
        Effect.catchTags(answerRefused),
        Effect.flatMap(answered => printAnswered(id, answered)),
      )
    return yield* client.rpc['attention.revise']({
      project,
      ticket,
      answer: given.answer,
    }).pipe(
      Effect.catchTags({
        AttentionNotFound: answerRefused.AttentionNotFound,
        InvalidAnswer: answerRefused.InvalidAnswer,
      }),
      Effect.flatMap(revised =>
        printAnswer({
          schema: Revised,
          value: revised,
          text: ({ undone, kept }) =>
            [
              `revised ${sanitiseLine(id)}`,
              ...undone.map(line => `  undone: ${sanitiseLine(line)}`),
              ...kept.map(line => `  couldn't undo: ${sanitiseLine(line)}`),
            ].join('\n'),
        }),
      ),
    )
  })

const printAnswered = (id: string, answered: Answered) =>
  printAnswer({
    schema: Answered,
    value: answered,
    text: () => `answered ${sanitiseLine(id)}`,
  })

export const answer = Command.make(
  'answer',
  {
    project: projectFlag,
    model: modelFlag,
    id: Argument.String('id').pipe(
      Argument.withDescription(
        'The question or permission request to answer, by ID; every open one where none is named',
      ),
      Argument.optional,
    ),
    talk: Flag.Boolean('talk').pipe(
      Flag.withDescription('Opens the answer talk on the terminal'),
      Flag.withDefault(false),
    ),
    option: Flag.Int('option').pipe(
      Flag.withDescription(
        "Answers the question with this option's number, from 1",
      ),
      Flag.optional,
    ),
    text: Flag.String('text').pipe(
      Flag.withDescription('Answers the question in these words'),
      Flag.optional,
    ),
    allow: Flag.ChoiceWithValue('allow', [
      ['once', 'once'],
      ['run', 'run'],
    ] as const).pipe(
      Flag.withDescription(
        'Allows the permission request once, or for this run',
      ),
      Flag.optional,
    ),
    refuse: Flag.Boolean('refuse').pipe(
      Flag.withDescription('Refuses the permission request'),
      Flag.withDefault(false),
    ),
    note: Flag.String('note').pipe(
      Flag.withDescription('Says why, with --refuse'),
      Flag.optional,
    ),
    revise: Flag.Boolean('revise').pipe(
      Flag.withDescription(
        "Changes a question's answer, undoing what the old one did where it can",
      ),
      Flag.withDefault(false),
    ),
  },
  flags =>
    Effect.gen(function* () {
      const given = yield* givenOf(flags)
      const json = yield* Json
      if (flags.talk) {
        if (Option.isSome(given))
          return yield* notTogether(
            '--talk asks in the talk: give it no answer',
          )
        return yield* answerTalkOn({
          questions: Option.toArray(flags.id),
          project: flags.project,
          model: flags.model,
        })
      }
      return yield* withProject(flags.project, (client, project) =>
        Option.match(given, {
          onSome: answered =>
            Option.match(flags.id, {
              onNone: () => notTogether('name the request an answer is for'),
              onSome: id =>
                answerGiven({
                  client,
                  project,
                  id,
                  given: answered,
                  revise: flags.revise,
                }),
            }),
          onNone: () =>
            json
              ? Effect.flatMap(
                  requestsOf(client, project, flags.id),
                  requests =>
                    printAnswer({
                      schema: Asked,
                      value: requests,
                      text: () => '',
                    }),
                )
              : askAll({
                  client,
                  project,
                  only: flags.id,
                  model: flags.model,
                }),
        }),
      )
    }),
).pipe(
  Command.withDescription(
    'Answers questions and permission requests on the terminal, or in the answer talk',
  ),
)
