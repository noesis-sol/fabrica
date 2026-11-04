import { Effect, Match, Option, Ref, Semaphore, Stream } from 'effect'

import {
  AnswerQuestionTool,
  AnswerRecorded,
  AttentionAnswer,
  type AttentionRequest,
  DeferredInTalk,
  DraftOptionsTool,
  ListQuestionsTool,
  type ProjectId,
  QuestionInTalk,
  QuestionsInTalk,
  type TalkId,
  TalkNotOpened,
  type TicketId,
  TicketInTalk,
  ToolRefusal,
} from '@fabrica/contracts'

import { AttentionRequests } from '../attention/service'
import type { WorkGraphShape } from '../workgraph'
import {
  type TalkContextOf,
  type TalkModeOf,
  type TalkTool,
  talkTool,
} from './core'

// The answer talk (spec §15.3): the open questions in its scope (the ones it was opened on, or every
// open one in the project, new ones queueing into the talk as they arrive), each given with its options,
// the tickets it blocks, the ticket it was asked from and their notes. Its tools read and answer
// questions, and nothing else: it can't release a deferred ticket, which it only mentions. The answers
// go through the attention requests as any client's do, the first answer winning. A maintainer's message
// that answers a consequential or maintainer-only question answers it alone (H53): that rule is the
// engine's, so a model that takes "all the recommended ones" literally is refused, not trusted.

export const answerInstructions = [
  "You are going through the maintainer's open questions with them, in the project's checkout, which you read but never change.",
  "Take the questions one at a time. Show a question's options first: each label and its trade-off, the recommended one first and marked, and its number as answer_question takes it. Say that options you drafted are drafted. Talk a question through only when the maintainer asks to, reading the code and the tickets it names. Record what the maintainer decides with answer_question, then go on to the next.",
  'A question filed without options: draft 2 to 4 with draft_options, one recommended, then show them as drafted.',
  "A question marked consequential would close, cancel, defer or freeze work, or change a recorded decision: choose nothing for the maintainer and never take it with others. Ask about it alone and have them pick one deliberately; a general yes is no pick. A question marked maintainer-only asks them to approve something done in their name: the same goes. answer_question refuses an answer to either that isn't their latest message's only answer. An answer you cannot trace to what the maintainer said is not an answer.",
  "Deferred tickets are the maintainer's to release: mention the ones that bear on a question, and never release one; you have no tool for it. Maintainer tasks are not questions, and not for this talk.",
  'The engine tells you when another question arrives: finish the one in hand, then take it up. Call list_questions before you say that none is left. Once none is left, say so in a line and wait.',
].join('\n\n')

/** Who the talk answers as, to a later client: an answer it records is the maintainer's, given in the talk. */
const answeredBy = 'the answer talk'

type QuestionRequest = Extract<AttentionRequest, { readonly _tag: 'question' }>

const inScope =
  ({ questions }: TalkContextOf<'answer'>) =>
  ({ ticket }: QuestionRequest): boolean =>
    questions.length === 0 || questions.includes(ticket)

const ticketInTalk = (graph: WorkGraphShape, id: TicketId) =>
  graph.show(id).pipe(
    Effect.map(
      ({ ticket, notes }) =>
        new TicketInTalk({
          id: ticket.id,
          title: ticket.title,
          status: ticket.status,
          description: ticket.description,
          notes,
        }),
    ),
    // A request names tickets its work graph has, and the store failing is a defect, as for the tool calls.
    Effect.orDie,
  )

const questionInTalk = (graph: WorkGraphShape, request: QuestionRequest) =>
  Effect.gen(function* () {
    const [blocks, askedFrom] = yield* Effect.all(
      [
        Effect.forEach(request.blocks, id => ticketInTalk(graph, id), {
          concurrency: 'unbounded',
        }),
        Effect.transposeOption(
          Option.map(request.askedFrom, id => ticketInTalk(graph, id)),
        ),
      ],
      { concurrency: 'unbounded' },
    )
    return new QuestionInTalk({
      id: request.ticket,
      title: request.title,
      description: request.description,
      choices: request.choices,
      drafted: request.drafted,
      consequential: request.consequential,
      maintainerOnly: request.maintainerOnly,
      blocks,
      askedFrom,
    })
  })

/** A question, as the talk is told of it. */
const said = (question: QuestionInTalk): string => {
  const { choices } = question
  const options = Option.match(choices, {
    onNone: () => [
      'Options: none were filed. Draft them with draft_options, then show them as drafted.',
    ],
    onSome: ({ options, recommended }) => [
      question.drafted
        ? 'Options (DRAFTED by a talk, not given by who asked):'
        : 'Options:',
      ...options
        .map((option, index) => ({ option, index }))
        .toSorted(
          (a, b) =>
            Number(b.index === recommended) - Number(a.index === recommended),
        )
        .map(
          ({ option, index }) =>
            `  ${index}. ${option.label}: ${option.tradeOff}${index === recommended ? ' (recommended)' : ''}`,
        ),
    ],
  })
  const ticket = ({ id, title, status, notes }: TicketInTalk) => [
    `  ${id} (${status}): ${title}`,
    ...notes.map(({ body }) => `    note: ${body}`),
  ]
  return [
    `Question ${question.id}: ${question.title}`,
    ...(question.consequential
      ? [
          'CONSEQUENTIAL: nothing is chosen for the maintainer, and it is never answered with others.',
        ]
      : []),
    ...(question.maintainerOnly
      ? ['MAINTAINER ONLY: only the maintainer can give this answer.']
      : []),
    ...Option.toArray(question.description),
    ...options,
    ...(question.blocks.length === 0
      ? []
      : ['It blocks:', ...question.blocks.flatMap(ticket)]),
    ...Option.match(question.askedFrom, {
      onNone: () => [],
      onSome: from => ['Asked from:', ...ticket(from)],
    }),
  ].join('\n')
}

/** What the talk is opened on, or told as it opens. */
const opening = ({ questions, deferred }: QuestionsInTalk): string =>
  [
    questions.length === 0
      ? 'No question is open now: wait for one to arrive.'
      : "Let's go through my open questions, one at a time.",
    ...questions.map(said),
    ...(deferred.length === 0
      ? []
      : [
          [
            'Deferred tickets (mention those that bear on a question; none is yours to release):',
            ...deferred.map(({ id, title }) => `  ${id}: ${title}`),
          ].join('\n'),
        ]),
  ].join('\n\n')

/** The answers a maintainer's message has given in a talk. */
interface Given {
  readonly message: number
  /** Whether it gave a consequential or maintainer-only question's. */
  readonly alone: boolean
}

/** Why the message can't answer `question` now; none where it can. */
const refusal = (options: {
  readonly question: QuestionRequest
  readonly message: number
  readonly given: Option.Option<Given>
}): Option.Option<string> => {
  const { question, message, given } = options
  if (message === 0)
    return Option.some(
      'the maintainer has said nothing yet: an answer is theirs, so show them the question and wait',
    )
  const alone = question.consequential || question.maintainerOnly
  const same = Option.filter(given, each => each.message === message)
  if (Option.isSome(same) && alone)
    return Option.some(
      `${question.ticket} is ${question.consequential ? 'consequential' : 'maintainer-only'}: it is never answered in a batch, and their last message has answered another. Ask about it alone, and have them pick one`,
    )
  if (Option.exists(same, each => each.alone))
    return Option.some(
      `their last message answered a consequential or maintainer-only question, which goes alone: ask them about ${question.ticket} now`,
    )
  return Option.none()
}

const invalid = (issue: string) =>
  Effect.fail(ToolRefusal.cases.invalid.make({ issue }))

/** The answer talk, on the attention requests; its talks' ledgers of answers given live as long as it does. */
export const makeAnswerMode: Effect.Effect<
  TalkModeOf<'answer'>,
  never,
  AttentionRequests
> = Effect.gen(function* () {
  const attention = yield* AttentionRequests
  const ledger = yield* Ref.make<ReadonlyMap<TalkId, Given>>(new Map())
  // A turn's calls may come side by side: an answer and the ledger move together.
  const answers = yield* Semaphore.make(1)

  /** The open questions the talk's context takes, oldest first. */
  const open = (project: ProjectId, context: TalkContextOf<'answer'>) =>
    attention.list(Option.some(project)).pipe(
      // The project is the talk's own, which the engine knows.
      Effect.orDie,
      Effect.map(requests =>
        requests
          .filter(
            (request): request is QuestionRequest =>
              request._tag === 'question',
          )
          .filter(inScope(context)),
      ),
    )

  const inTalk = (
    project: ProjectId,
    context: TalkContextOf<'answer'>,
    graph: WorkGraphShape,
  ) =>
    Effect.gen(function* () {
      const [requests, deferred] = yield* Effect.all(
        [
          open(project, context),
          Effect.orDie(graph.list({ statuses: ['deferred'] })),
        ],
        { concurrency: 'unbounded' },
      )
      return new QuestionsInTalk({
        questions: yield* Effect.forEach(requests, request =>
          questionInTalk(graph, request),
        ),
        deferred: deferred.map(
          ({ id, title }) => new DeferredInTalk({ id, title }),
        ),
      })
    })

  const listQuestions: TalkTool<'answer'> = talkTool(
    ListQuestionsTool,
    (_, { project, context, graph }) =>
      Effect.flatMap(graph, read => inTalk(project.id, context, read)),
  )

  const draftOptions: TalkTool<'answer'> = talkTool(
    DraftOptionsTool,
    ({ question, choices }, { project, context, graph, actor }) =>
      Effect.gen(function* () {
        const read = yield* graph
        const ask = (yield* open(project.id, context)).find(
          ({ ticket }) => ticket === question,
        )
        if (ask === undefined)
          return yield* invalid(
            `${question} isn't an open question in this talk`,
          )
        yield* read.draftOptions({ id: question, choices, actor }).pipe(
          Effect.catchTag(['NotAQuestion', 'TransitionRefused'], () =>
            invalid(
              `${question} was filed with options, which stand: answer it with one, or in the maintainer's words`,
            ),
          ),
          Effect.catchTag('InvalidTicket', ({ message }) => invalid(message)),
          Effect.catchTag(['StoreFailed', 'TicketNotFound'], Effect.die),
        )
        const now = (yield* open(project.id, context)).find(
          ({ ticket }) => ticket === question,
        )
        return yield* questionInTalk(read, now ?? ask)
      }),
  )

  const answerQuestion: TalkTool<'answer'> = talkTool(
    AnswerQuestionTool,
    (
      { question, answer },
      { talk, project, context, graph, maintainerMessages },
    ) =>
      answers.withPermit(
        Effect.gen(function* () {
          const requests = yield* open(project.id, context)
          const ask = requests.find(({ ticket }) => ticket === question)
          if (ask === undefined)
            return yield* invalid(
              `${question} isn't an open question in this talk: another answer may have come first`,
            )
          const message = yield* maintainerMessages
          const given = Option.fromUndefinedOr(
            (yield* Ref.get(ledger)).get(talk),
          )
          const refused = refusal({ question: ask, message, given })
          if (Option.isSome(refused)) return yield* invalid(refused.value)
          yield* attention
            .answer({
              answer: AttentionAnswer.cases.question.make({
                project: project.id,
                ticket: question,
                answer,
              }),
              by: answeredBy,
            })
            .pipe(
              Effect.catch(error =>
                invalid(
                  Match.value(error).pipe(
                    Match.tag(
                      'AlreadyAnswered',
                      ({ by }) => `${question} was answered first by ${by}`,
                    ),
                    Match.tag(
                      'AttentionNotFound',
                      () => `${question} isn't an open question`,
                    ),
                    Match.tag('InvalidAnswer', ({ reason }) => reason),
                    Match.exhaustive,
                  ),
                ),
              ),
            )
          const alone = ask.consequential || ask.maintainerOnly
          yield* Ref.update(ledger, current =>
            new Map(current).set(talk, {
              message,
              alone:
                alone ||
                Option.exists(
                  given,
                  each => each.message === message && each.alone,
                ),
            }),
          )
          // Read back in the words the attention requests recorded: an option's label, or the maintainer's.
          const { ticket: recorded } = yield* Effect.orDie(
            Effect.flatMap(graph, read => read.show(question)),
          )
          return new AnswerRecorded({
            question,
            answer: yield* Option.match(
              Option.flatMap(recorded.question, each => each.answer),
              {
                onNone: () =>
                  Effect.die(`${question} was answered with no answer kept`),
                onSome: Effect.succeed,
              },
            ),
            left: requests
              .map(({ ticket }) => ticket)
              .filter(ticket => ticket !== question),
          })
        }),
      ),
  )

  return {
    keep: false,
    instructions: answerInstructions,
    tools: [listQuestions, draftOptions, answerQuestion],
    opening: ({ context, project, graph }) =>
      Effect.gen(function* () {
        const read = yield* graph
        const questions = yield* inTalk(project.id, context, read)
        const closed = context.questions.filter(
          id => !questions.questions.some(question => question.id === id),
        )
        if (closed.length > 0)
          return yield* new TalkNotOpened({
            reason: `no open question has the ID ${closed.join(', ')}`,
          })
        return Option.some(opening(questions))
      }),
    // A talk opened on named questions has those alone; else, the project's new ones queue into it.
    arrivals: ({ context, project, graph }) =>
      context.questions.length > 0
        ? Effect.succeed(Stream.empty)
        : Effect.gen(function* () {
            const read = yield* graph
            const changes = yield* Effect.orDie(read.changes)
            return changes.pipe(
              Stream.filter(({ change }) => change._tag === 'created'),
              Stream.mapEffect(({ ticketId }) =>
                Effect.gen(function* () {
                  const request = (yield* open(project.id, context)).find(
                    each => Option.contains(ticketId, each.ticket),
                  )
                  return request === undefined
                    ? []
                    : [
                        `Another question arrived.\n\n${said(yield* questionInTalk(read, request))}`,
                      ]
                }),
              ),
              Stream.flatMap(Stream.fromIterable),
              // The work graph failing ends the queue; list_questions still reads what is open.
              Stream.catch(error =>
                Stream.unwrap(
                  Effect.as(
                    Effect.logWarning(
                      `the answer talk stopped following new questions: ${error.message}`,
                    ),
                    Stream.empty,
                  ),
                ),
              ),
            )
          }),
  }
})
