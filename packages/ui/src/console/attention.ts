import {
  Array,
  type DateTime,
  Duration,
  Effect,
  Match,
  Option,
  Schema,
} from 'effect'
import type { RpcClientError } from 'effect/rpc'
import { Command, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { defineView } from 'foldkit/submodel'

import { clientErrorWords } from '@fabrica/client'
import {
  type AlreadyAnswered,
  AttentionAnswer,
  type AttentionNotFound,
  AttentionRequest,
  type InvalidAnswer,
  PermissionDecision,
  PermissionId,
  type PermissionShown,
  type ProjectNotFound,
  QuestionAnswer,
  type QuestionChoices,
  type QuestionOption,
  type Refused,
  type SetAsideReason,
  Text,
  TicketId,
  type TicketNotFound,
  attentionKey,
} from '@fabrica/contracts'

import { sayElapsed } from '../app/clock'
import {
  type EngineAttentionRef,
  EngineProject,
  namesRequest,
} from '../app/engine-project'
import {
  type EngineNotConnected,
  type EngineServices,
  sessionFor,
} from '../app/engine-route'
import {
  type EngineAttention,
  type EngineRequest,
  engineRequests,
} from '../app/streams'
import { type Chip, chipView } from './sidebar'

// The console's Needs your attention column (spec §15.1, §18.3, H62, H92; Appendix A.2): what waits on
// the maintainer, as the handoff's card with its kind tag, the ID and how long it has waited (`c2`),
// and under All projects its project's chip before the tag.
// Approval (`c2`): a permission request, its input shown whole and rendered for its tool, why it asks;
// Approve allows it once, its menu allows it for this run or refuses it with a note. Question (`c5`):
// the question's own title, the tickets waiting on it, as much of its description as fits; Answer opens
// its options inline, the recommended one first and marked (and chosen, unless the question is
// consequential, H53), a free-text line and "Talk it through". Review (`c4`): a ticket set aside, with
// why. Your task (`c2`): a maintainer task, done when the maintainer closes it. "Open session" opens
// the worker view. Keys 1–9 answer the question whose options are drawn, only that one, and only 500 ms
// after they were first drawn: a guard that starts again whenever the request they would answer changes,
// counted on the injected clock (§15.1, H88; tutti-14o5). Every answer carries its request's ID, and
// goes to the engine the request is open on (engine-route.ts): under All projects the column holds
// every connected engine's requests, each card with its engine.
// A Submodel: the root folds its Messages, keeps its open request in step with the stream, and gives it
// the requests and the time.

/** How long a request's options are drawn before a key may answer it (§15.1). */
export const keyGuard = Duration.millis(500)

/** What a card has open: its answer's options, Approve's menu, or a refusal's note. */
export const Open = defineTaggedUnion({
  None: {},
  /** A question's options, the one chosen, if any, and the free-text line. */
  Answering: {
    key: Schema.String,
    chosen: Schema.Option(Schema.Int),
    text: Schema.String,
  },
  /** Approve's menu: allow for this run, or refuse. */
  ChoosingDecision: { key: Schema.String },
  /** Refusing, with a note. */
  Refusing: { key: Schema.String, note: Schema.String },
})
export type Open = typeof Open.Type

/**
 * The key guard: off while no options are drawn; waiting from when they are drawn, numbered so that a
 * guard started for an earlier drawing can't pass this one; passed once `keyGuard` has gone by with the
 * same request drawn. It keeps the request as drawn, so a change to it starts the guard again.
 */
export const Guard = defineTaggedUnion({
  Off: {},
  Waiting: {
    engine: Schema.String,
    request: AttentionRequest,
    drawing: Schema.Int,
  },
  Passed: { engine: Schema.String, request: AttentionRequest },
})
export type Guard = typeof Guard.Type

/** The last answer sent: none, one the engine hasn't answered, or one it refused, with why. */
export const Sending = defineTaggedUnion({
  None: {},
  Pending: { key: Schema.String },
  Failed: { key: Schema.String, reason: Schema.String },
})
export type Sending = typeof Sending.Type

export const Model = Schema.Struct({
  open: Open,
  guard: Guard,
  /** How many times options have been drawn: each drawing's guard is its own. */
  drawings: Schema.Int,
  sending: Sending,
})
export type Model = typeof Model.Type

export const init = (): Model => ({
  open: Open.None(),
  guard: Guard.Off(),
  drawings: 0,
  sending: Sending.None(),
})

export const Message = defineMessageUnion({
  /** Answer on a question's card, open on the engine named `engine`: its options open, or close again. */
  ClickedAnswer: { engine: Schema.String, request: AttentionRequest },
  ChoseOption: { key: Schema.String, index: Schema.Int },
  TypedAnswer: { key: Schema.String, text: Schema.String },
  SubmittedAnswer: { key: Schema.String },
  /** The guard's time has gone by for one drawing of a request's options. */
  PassedGuard: { drawing: Schema.Int },
  ClickedTalkItThrough: { project: EngineProject, ticket: TicketId },

  ClickedApprove: {
    key: Schema.String,
    engine: Schema.String,
    answer: AttentionAnswer,
  },
  ClickedDecisionMenu: { key: Schema.String },
  ClickedAllowForRun: {
    key: Schema.String,
    engine: Schema.String,
    answer: AttentionAnswer,
  },
  ClickedRefuse: { key: Schema.String },
  TypedRefusalNote: { key: Schema.String, note: Schema.String },
  SubmittedRefusal: {
    key: Schema.String,
    project: EngineProject,
    id: PermissionId,
  },
  CancelledOpen: {},

  ClickedTaskDone: {
    key: Schema.String,
    project: EngineProject,
    ticket: TicketId,
  },
  ClickedReview: { project: EngineProject, ticket: TicketId },
  ClickedOpenSession: { ticket: TicketId },

  SucceededAnswer: { key: Schema.String },
  FailedAnswer: { key: Schema.String, reason: Schema.String },
  DismissedFailure: {},
})
export type Message = typeof Message.Type

/** What the root does on the column's behalf: the screens a card opens. */
export const OutMessage = defineMessageUnion({
  /** The answer talk, for a question (§15.3). */
  OpenedAnswerTalk: { project: EngineProject, ticket: TicketId },
  /** The Review screen, for a set-aside ticket. */
  OpenedReview: { project: EngineProject, ticket: TicketId },
  /** The worker view of a ticket's session. */
  OpenedSession: { ticket: TicketId },
})
export type OutMessage = typeof OutMessage.Type

/** What an answer can fail with: the engine's refusals, its engine not connected, or the connection lost. */
export type AnswerError =
  | AlreadyAnswered
  | AttentionNotFound
  | InvalidAnswer
  | ProjectNotFound
  | TicketNotFound
  | Refused
  | EngineNotConnected
  | RpcClientError.RpcClientError

/** Why an answer didn't go through, in words. */
export const failureWords = (error: AnswerError): string =>
  Match.valueTags(error, {
    AlreadyAnswered: ({ by }) => `already answered by ${by}`,
    AttentionNotFound: () => 'it is no longer open',
    InvalidAnswer: ({ reason }) => reason,
    ProjectNotFound: () => "the engine doesn't know the project",
    TicketNotFound: () => "the engine doesn't know the ticket",
    Refused: ({ reason }) => reason,
    EngineNotConnected: () => 'not connected to the engine',
    RpcClientError: clientErrorWords,
  })

/** Waits out the key guard for one drawing of a request's options, on the injected clock. */
export const WaitGuard = Command.define('WaitGuard', {
  args: { drawing: Schema.Int },
  messages: [Message.PassedGuard],
  execute: ({ drawing }) =>
    Effect.as(Effect.sleep(keyGuard), Message.PassedGuard({ drawing })),
})

/** Sends an answer, carrying the ID of what it answers, to the engine named `engine`. */
export const Answer = Command.define('Answer', {
  args: { key: Schema.String, engine: Schema.String, answer: AttentionAnswer },
  messages: [Message.SucceededAnswer, Message.FailedAnswer],
  execute: ({ key, engine, answer }) =>
    sessionFor({ engine, project: answer.project }).pipe(
      Effect.flatMap(({ client }) =>
        client.rpc['attention.answer']({ answer }),
      ),
      Effect.as(Message.SucceededAnswer({ key })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedAnswer({ key, reason: failureWords(error) }),
        ),
      ),
    ),
})

/** Closes a maintainer task as done, which frees what it blocks (§15.1, H52). */
export const CloseTask = Command.define('CloseTask', {
  args: { key: Schema.String, project: EngineProject, ticket: TicketId },
  messages: [Message.SucceededAnswer, Message.FailedAnswer],
  execute: ({ key, project, ticket }) =>
    sessionFor(project).pipe(
      Effect.flatMap(({ client }) =>
        client.rpc['tickets.close']({
          project: project.project,
          ticket,
          resolution: 'done',
          reason: Option.none(),
        }),
      ),
      Effect.as(Message.SucceededAnswer({ key })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedAnswer({ key, reason: failureWords(error) }),
        ),
      ),
    ),
})

// The options.

/** An option as drawn: its place in the list, its index in the question's, and whether it is recommended. */
export interface ShownOption {
  readonly place: number
  readonly index: number
  readonly option: QuestionOption
  readonly recommended: boolean
}

/** A question's options as drawn: the recommended one first, then the rest in their order. */
export const shownOptions = (
  choices: QuestionChoices,
): ReadonlyArray<ShownOption> =>
  [
    choices.recommended,
    ...choices.options
      .map((_, index) => index)
      .filter(index => index !== choices.recommended),
  ].flatMap((index, place) =>
    Option.match(Array.get(choices.options, index), {
      onNone: () => [],
      onSome: option => [
        { place, index, option, recommended: index === choices.recommended },
      ],
    }),
  )

/** The option chosen when a question's options open: the recommended one, unless the question is consequential (H53). */
export const preselected = (request: AttentionRequest): Option.Option<number> =>
  AttentionRequest.guards.question(request) && !request.consequential
    ? Option.map(request.choices, choices => choices.recommended)
    : Option.none()

/** The request whose options are drawn, if any: what keys 1–9 would answer. */
export const drawnRequest = (model: Model): Option.Option<AttentionRequest> =>
  Open.guards.Answering(model.open)
    ? Guard.match(model.guard, {
        Off: () => Option.none(),
        Waiting: ({ request }) => Option.some(request),
        Passed: ({ request }) => Option.some(request),
      })
    : Option.none()

/** The options keys 1–9 answer, in the order drawn, with the request's key: none while no options are drawn. */
export const keyedOptions = (
  model: Model,
): Option.Option<{
  readonly key: string
  readonly options: ReadonlyArray<ShownOption>
}> =>
  Option.flatMap(drawnRequest(model), request =>
    AttentionRequest.guards.question(request)
      ? Option.map(request.choices, choices => ({
          key: attentionKey(request),
          options: shownOptions(choices).slice(0, 9),
        }))
      : Option.none(),
  )

// The update.

type Return = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  EngineServices
>

/** A return with no OutMessage. */
type Kept = Update.Return<Model, Message, EngineServices>

/** The guard started afresh for the options of `request`, open on the engine named `engine`, drawn now. */
const drawing = (model: Model, { engine, request }: EngineRequest): Kept => {
  const next = model.drawings + 1
  return {
    model: modifyFields(model, {
      guard: () => Guard.Waiting({ engine, request, drawing: next }),
      drawings: () => next,
    }),
    commands: [WaitGuard({ drawing: next })],
  }
}

const closed = (model: Model): Model =>
  modifyFields(model, {
    open: () => Open.None(),
    guard: () => Guard.Off(),
  })

const sending = (
  model: Model,
  { key, engine }: { readonly key: string; readonly engine: string },
  answer: AttentionAnswer,
): Kept => ({
  model: modifyFields(model, { sending: () => Sending.Pending({ key }) }),
  commands: [Answer({ key, engine, answer })],
})

const isPending = (model: Model): boolean =>
  Sending.guards.Pending(model.sending)

const decodeText = Schema.decodeUnknownOption(Text)

/** A question's answer: option `index` of the drawn request. */
const optionAnswer = (
  request: AttentionRequest,
  index: number,
): Option.Option<AttentionAnswer> =>
  AttentionRequest.guards.question(request)
    ? Option.some(
        AttentionAnswer.cases.question.make({
          project: request.project,
          ticket: request.ticket,
          answer: QuestionAnswer.cases.option.make({ index }),
        }),
      )
    : Option.none()

/** The drawn request with the engine it is open on, when its key is `key`. */
const drawnWithKey = (
  model: Model,
  key: string,
): Option.Option<EngineRequest> =>
  Open.guards.Answering(model.open)
    ? Option.filter(
        Guard.match(model.guard, {
          Off: (): Option.Option<EngineRequest> => Option.none(),
          Waiting: ({ engine, request }) => Option.some({ engine, request }),
          Passed: ({ engine, request }) => Option.some({ engine, request }),
        }),
        ({ request }) => attentionKey(request) === key,
      )
    : Option.none()

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ClickedAnswer: ({ engine, request }) =>
      Open.guards.Answering(model.open) &&
      model.open.key === attentionKey(request)
        ? { model: closed(model) }
        : drawing(
            modifyFields(model, {
              open: () =>
                Open.Answering({
                  key: attentionKey(request),
                  chosen: preselected(request),
                  text: '',
                }),
            }),
            { engine, request },
          ),
    ChoseOption: ({ key, index }) => ({
      model: modifyFields(model, {
        open: open =>
          Open.guards.Answering(open) && open.key === key
            ? Open.Answering({ ...open, chosen: Option.some(index), text: '' })
            : open,
      }),
    }),
    TypedAnswer: ({ key, text }) => ({
      model: modifyFields(model, {
        open: open =>
          Open.guards.Answering(open) && open.key === key
            ? Open.Answering({
                ...open,
                text,
                chosen: text.trim() === '' ? open.chosen : Option.none(),
              })
            : open,
      }),
    }),
    SubmittedAnswer: ({ key }) => {
      if (
        isPending(model) ||
        !Open.guards.Answering(model.open) ||
        model.open.key !== key
      ) {
        return { model }
      }
      const { chosen, text } = model.open
      return Option.match(drawnWithKey(model, key), {
        onNone: () => ({ model }),
        onSome: ({ engine, request }) =>
          Option.match(
            Option.isSome(chosen)
              ? optionAnswer(request, chosen.value)
              : Option.flatMap(decodeText(text.trim()), words =>
                  AttentionRequest.guards.question(request)
                    ? Option.some(
                        AttentionAnswer.cases.question.make({
                          project: request.project,
                          ticket: request.ticket,
                          answer: QuestionAnswer.cases.text.make({
                            text: words,
                          }),
                        }),
                      )
                    : Option.none(),
                ),
            {
              onNone: () => ({ model }),
              onSome: answer => sending(model, { key, engine }, answer),
            },
          ),
      })
    },
    PassedGuard: ({ drawing }) => {
      const { guard } = model
      return {
        model:
          Guard.guards.Waiting(guard) && guard.drawing === drawing
            ? modifyFields(model, {
                guard: () =>
                  Guard.Passed({
                    engine: guard.engine,
                    request: guard.request,
                  }),
              })
            : model,
      }
    },
    ClickedTalkItThrough: ({ project, ticket }) => ({
      model,
      outMessage: OutMessage.OpenedAnswerTalk({ project, ticket }),
    }),

    ClickedApprove: ({ key, engine, answer }) =>
      isPending(model)
        ? { model }
        : sending(closed(model), { key, engine }, answer),
    ClickedDecisionMenu: ({ key }) => ({
      model: modifyFields(closed(model), {
        open: () =>
          Open.guards.ChoosingDecision(model.open) && model.open.key === key
            ? Open.None()
            : Open.ChoosingDecision({ key }),
      }),
    }),
    ClickedAllowForRun: ({ key, engine, answer }) =>
      isPending(model)
        ? { model }
        : sending(closed(model), { key, engine }, answer),
    ClickedRefuse: ({ key }) => ({
      model: modifyFields(closed(model), {
        open: () => Open.Refusing({ key, note: '' }),
      }),
    }),
    TypedRefusalNote: ({ key, note }) => ({
      model: modifyFields(model, {
        open: open =>
          Open.guards.Refusing(open) && open.key === key
            ? Open.Refusing({ key, note })
            : open,
      }),
    }),
    SubmittedRefusal: ({ key, project, id }) =>
      isPending(model) ||
      !Open.guards.Refusing(model.open) ||
      model.open.key !== key
        ? { model }
        : sending(
            closed(model),
            { key, engine: project.engine },
            AttentionAnswer.cases.permission.make({
              project: project.project,
              id,
              decision: PermissionDecision.cases.refuse.make({
                note: decodeText(model.open.note.trim()),
              }),
            }),
          ),
    CancelledOpen: () => ({ model: closed(model) }),

    ClickedTaskDone: ({ key, project, ticket }) =>
      isPending(model)
        ? { model }
        : {
            model: modifyFields(model, {
              sending: () => Sending.Pending({ key }),
            }),
            commands: [CloseTask({ key, project, ticket })],
          },
    ClickedReview: ({ project, ticket }) => ({
      model,
      outMessage: OutMessage.OpenedReview({ project, ticket }),
    }),
    ClickedOpenSession: ({ ticket }) => ({
      model,
      outMessage: OutMessage.OpenedSession({ ticket }),
    }),

    SucceededAnswer: ({ key }) => ({
      model: modifyFields(
        Option.isSome(drawnWithKey(model, key)) ? closed(model) : model,
        { sending: () => Sending.None() },
      ),
    }),
    FailedAnswer: ({ key, reason }) => ({
      model: modifyFields(model, {
        sending: () => Sending.Failed({ key, reason }),
      }),
    }),
    DismissedFailure: () => ({
      model: modifyFields(model, { sending: () => Sending.None() }),
    }),
  })

/**
 * A key 1–9 pressed for the option at `place` (from 0) in the list drawn for the request `key`: it answers
 * only that request, only while its options are drawn, and only once the guard has passed (§15.1).
 */
export const pressedOptionKey = (
  model: Model,
  { key, place }: { readonly key: string; readonly place: number },
): Kept => {
  const { guard } = model
  return Guard.guards.Passed(guard) &&
    Open.guards.Answering(model.open) &&
    attentionKey(guard.request) === key &&
    !isPending(model)
    ? Option.match(
        Option.flatMap(keyedOptions(model), ({ options }) =>
          Option.flatMap(Array.get(options, place), shown =>
            optionAnswer(guard.request, shown.index),
          ),
        ),
        {
          onNone: () => ({ model }),
          onSome: answer =>
            sending(model, { key, engine: guard.engine }, answer),
        },
      )
    : { model }
}

const sameRequest = Schema.toEquivalence(AttentionRequest)

const openKey = (open: Open): Option.Option<string> =>
  Open.match(open, {
    None: () => Option.none(),
    Answering: ({ key }) => Option.some(key),
    ChoosingDecision: ({ key }) => Option.some(key),
    Refusing: ({ key }) => Option.some(key),
  })

/**
 * The column kept in step with every engine's requests, as their streams give them: what a card has
 * open closes when its request leaves the list (answered elsewhere, or the scope changed), and drawn
 * options whose request changed are drawn afresh, their guard started again and their choice made
 * again from the new request (none while the maintainer's own words are typed), so an option chosen
 * before can't stand for another (§15.1, tutti-14o5). A drawn request is the one of its key on its own
 * engine.
 */
export const receivedRequests = (
  model: Model,
  engines: ReadonlyArray<EngineAttention>,
): Kept => {
  const listed = engineRequests(engines)
  const open = openKey(model.open)
  if (
    Option.isSome(open) &&
    !listed.some(({ request }) => attentionKey(request) === open.value)
  ) {
    return { model: closed(model) }
  }
  return Option.match(
    Option.flatMap(openKey(model.open), key => drawnWithKey(model, key)),
    {
      onNone: () => ({ model }),
      onSome: drawn =>
        Option.match(
          Array.findFirst(
            listed,
            ({ engine, request }) =>
              engine === drawn.engine &&
              attentionKey(request) === attentionKey(drawn.request),
          ),
          {
            onNone: () => ({ model: closed(model) }),
            onSome: current =>
              sameRequest(current.request, drawn.request)
                ? { model }
                : drawing(
                    modifyFields(model, {
                      open: open =>
                        Open.guards.Answering(open)
                          ? Open.Answering({
                              ...open,
                              chosen:
                                open.text.trim() === ''
                                  ? preselected(current.request)
                                  : Option.none(),
                            })
                          : open,
                    }),
                    current,
                  ),
          },
        ),
    },
  )
}

// The view.

/** A card's kind: its tag's words and colour (Appendix A.2). */
type Kind = 'approval' | 'question' | 'review' | 'task'

const kindOf = (request: AttentionRequest): Kind =>
  AttentionRequest.match(request, {
    permission: () => 'approval',
    question: () => 'question',
    review: () => 'review',
    task: () => 'task',
  })

const kindWords: Record<Kind, string> = {
  approval: 'Approval',
  question: 'Question',
  review: 'Review',
  task: 'Your task',
}

const kindFill: Record<Kind, string> = {
  approval: 'bg-c2',
  question: 'bg-c5',
  review: 'bg-c4',
  task: 'bg-c2',
}

/** Why a ticket was set aside, in words. */
export const setAsideWords: Record<SetAsideReason, string> = {
  DEFERRED: 'Its worker deferred it',
  CHECKS_FAILED: 'Its merge check failed',
  MERGE_CONFLICT: 'Its merge conflicts outlasted the resolve hand-backs',
  CLOSED_UNCOMMITTED: 'It reached the queue with uncommitted files',
  DIRTY_WORKTREE: 'A setup or check left tracked files changed',
  GIT_FAILED: 'A git read that steers its merge kept failing',
  BASE_KEPT_MOVING: 'Base kept moving during every check',
  TICKET_LIMIT: 'Its worker ran past the ticket limit',
  UNFINISHED: 'Its worker settled twice with no outcome',
  AGENT_STUCK: 'Its worker went quiet twice',
  TOOL_DEFECT: 'A tool failed under its worker',
  BUDGET_EXCEEDED: 'It went over its budget',
  HAND_BACK_NOT_DONE: 'A hand-back waited all night on a request',
}

/** The ticket a card names: a permission request's and a question's are the asking ticket's and its own. */
const cardTicket = (request: AttentionRequest): TicketId => request.ticket

/** The ticket whose session "Open session" opens, where the request has one. */
export const sessionTicket = (
  request: AttentionRequest,
): Option.Option<TicketId> =>
  AttentionRequest.match(request, {
    permission: ({ ticket }) => Option.some(ticket),
    question: ({ askedFrom }) => askedFrom,
    review: ({ ticket }) => Option.some(ticket),
    task: () => Option.none(),
  })

/** What the frame gives the column. */
export interface ViewInputs {
  /** The scope's open requests, each engine's apart: under All projects every connected engine's. */
  readonly requests: ReadonlyArray<EngineAttention>
  /** The request a clicked notification focused, named with its engine: its card is drawn focused. */
  readonly focused: Option.Option<EngineAttentionRef>
  /** The time now, in the viewer's zone. */
  readonly now: Option.Option<DateTime.Zoned>
  /** Whether the engine's client is held, so answers can be sent. */
  readonly live: boolean
  /** The chip a request's card carries for its project: none in a project's own scope (§18.3). */
  readonly chip: (project: EngineProject) => Option.Option<Chip>
}

const primaryButton =
  'rounded-button bg-c2 px-12 py-6 text-sm font-bold text-ink shadow-glow2 hover:brightness-[1.08] disabled:opacity-60'
const ghostButton =
  'rounded-button border border-line px-12 py-6 text-sm text-fg hover:brightness-[1.08] disabled:opacity-60'
const block =
  'whitespace-pre-wrap break-all rounded-button border border-line bg-bg px-8 py-6 font-mono text-xs text-fg'

const kindTag = (kind: Kind, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.DataAttribute('kind', kind),
      h.Class(
        `rounded-button px-6 py-2 font-extrabold text-ink ${kindFill[kind]}`,
      ),
      h.Style({ fontSize: '11px' }),
    ],
    [kindWords[kind]],
  )

const firstRow = (
  { engine, request }: EngineRequest,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex items-center gap-8')],
    [
      Option.match(inputs.chip({ engine, project: request.project }), {
        onNone: () => h.empty,
        onSome: chip => chipView(chip, h),
      }),
      kindTag(kindOf(request), h),
      h.span(
        [
          h.DataAttribute('ticket', ''),
          h.Class('font-mono text-xs text-muted'),
        ],
        [cardTicket(request)],
      ),
      Option.match(inputs.now, {
        onNone: () => h.empty,
        onSome: now =>
          h.span(
            [
              h.DataAttribute('waiting', ''),
              h.Class('ml-auto text-xs text-c2'),
            ],
            [`waiting ${sayElapsed(request.openedAt, now)}`],
          ),
      }),
    ],
  )

const title = (text: string, h: HtmlBuilder<Message>): Html =>
  h.h3([h.Class('text-sm font-bold'), h.Style({ fontSize: '14px' })], [text])

const reason = (text: string, h: HtmlBuilder<Message>): Html =>
  h.p([h.DataAttribute('reason', ''), h.Class('text-sm text-muted')], [text])

/** A diff's line, marked by what it does: added, removed, or context. */
const diffLine = (line: string, h: HtmlBuilder<Message>): Html =>
  line.startsWith('+') && !line.startsWith('+++')
    ? h.span(
        [h.DataAttribute('diff', 'added'), h.Class('block text-c4')],
        [line],
      )
    : line.startsWith('-') && !line.startsWith('---')
      ? h.span(
          [h.DataAttribute('diff', 'removed'), h.Class('block text-c3')],
          [line],
        )
      : h.span([h.DataAttribute('diff', 'context'), h.Class('block')], [line])

const pathLine = (path: string, h: HtmlBuilder<Message>): Html =>
  h.p(
    [h.DataAttribute('path', ''), h.Class('font-mono text-xs text-fg')],
    [path],
  )

/** A permission request's input, rendered for its tool and shown whole: wrapped, never cut off (H62). */
export const shownInput = (
  shown: PermissionShown,
  h: HtmlBuilder<Message>,
): Html =>
  Match.valueTags(shown, {
    command: ({ lines }) =>
      h.pre(
        [
          h.DataAttribute('shown', 'command'),
          h.AriaLabel('Command'),
          h.Class(block),
        ],
        lines.map(line =>
          h.span([h.DataAttribute('line', ''), h.Class('block')], [line]),
        ),
      ),
    edit: ({ path, diff }) =>
      h.div(
        [h.DataAttribute('shown', 'edit'), h.Class('flex flex-col gap-4')],
        [
          pathLine(path, h),
          h.pre(
            [h.AriaLabel('Diff'), h.Class(block)],
            diff.split('\n').map(line => diffLine(line, h)),
          ),
        ],
      ),
    write: ({ path, content }) =>
      h.div(
        [h.DataAttribute('shown', 'write'), h.Class('flex flex-col gap-4')],
        [
          pathLine(path, h),
          h.pre([h.AriaLabel('Content'), h.Class(block)], [content]),
        ],
      ),
    call: ({ input }) =>
      h.pre(
        [
          h.DataAttribute('shown', 'call'),
          h.AriaLabel('Arguments'),
          h.Class(block),
        ],
        [JSON.stringify(input, null, 2)],
      ),
  })

const failure = (model: Model, key: string, h: HtmlBuilder<Message>): Html =>
  Sending.guards.Failed(model.sending) && model.sending.key === key
    ? h.p(
        [h.Role('alert'), h.Class('flex items-baseline gap-8 text-xs text-fg')],
        [
          h.span([h.Class('font-extrabold text-c3')], ['Not sent']),
          model.sending.reason,
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.DismissedFailure()),
              h.Class('ml-auto text-muted'),
            ],
            ['Dismiss'],
          ),
        ],
      )
    : h.empty

const openSession = (
  request: AttentionRequest,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(sessionTicket(request), {
    onNone: () => h.empty,
    onSome: ticket =>
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedOpenSession({ ticket })),
          h.Class(ghostButton),
        ],
        ['Open session'],
      ),
  })

const actions = (
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div([h.Class('relative flex flex-wrap items-center gap-8')], children)

type Permission = Extract<AttentionRequest, { readonly _tag: 'permission' }>
type Question = Extract<AttentionRequest, { readonly _tag: 'question' }>

const permissionAnswer = (
  request: Permission,
  decision: PermissionDecision,
): AttentionAnswer =>
  AttentionAnswer.cases.permission.make({
    project: request.project,
    id: request.id,
    decision,
  })

const decisionMenu = (
  { key, engine }: { readonly key: string; readonly engine: string },
  request: Permission,
  h: HtmlBuilder<Message>,
): Html =>
  h.ul(
    [
      h.Role('menu'),
      h.AriaLabel('More answers'),
      h.Class(
        'absolute left-0 top-full z-10 mt-4 flex flex-col rounded-card border border-line bg-panel py-4 shadow-glow2',
      ),
      h.Style({ minWidth: '200px' }),
    ],
    [
      h.li(
        [],
        [
          h.button(
            [
              h.Type('button'),
              h.Role('menuitem'),
              h.OnClick(
                Message.ClickedAllowForRun({
                  key,
                  engine,
                  answer: permissionAnswer(
                    request,
                    PermissionDecision.cases.allow_run.make({}),
                  ),
                }),
              ),
              h.Class('w-full px-12 py-4 text-left text-sm hover:bg-bg'),
            ],
            ['Allow for this run'],
          ),
        ],
      ),
      h.li(
        [],
        [
          h.button(
            [
              h.Type('button'),
              h.Role('menuitem'),
              h.OnClick(Message.ClickedRefuse({ key })),
              h.Class('w-full px-12 py-4 text-left text-sm hover:bg-bg'),
            ],
            ['Refuse…'],
          ),
        ],
      ),
    ],
  )

const refusalForm = (
  { key, engine }: { readonly key: string; readonly engine: string },
  request: Permission,
  note: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.form(
    [
      h.AriaLabel('Refuse'),
      h.OnSubmit(
        Message.SubmittedRefusal({
          key,
          project: { engine, project: request.project },
          id: request.id,
        }),
      ),
      h.Class('flex flex-wrap items-center gap-8'),
    ],
    [
      h.input([
        h.Type('text'),
        h.AriaLabel('Note'),
        h.Placeholder('Why, for the worker (optional)'),
        h.Value(note),
        h.OnInput(note => Message.TypedRefusalNote({ key, note })),
        h.Class(
          'min-w-0 flex-1 rounded-button border border-line bg-bg px-8 py-4 text-sm text-fg',
        ),
      ]),
      h.button(
        [
          h.Type('submit'),
          h.Class(
            'rounded-button bg-c3 px-12 py-6 text-sm font-bold text-ink hover:brightness-[1.08]',
          ),
        ],
        ['Refuse'],
      ),
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.CancelledOpen()),
          h.Class(ghostButton),
        ],
        ['Cancel'],
      ),
    ],
  )

const approvalBody = (
  model: Model,
  engine: string,
  request: Permission,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const key = attentionKey(request)
  const busy = !inputs.live || isPending(model)
  const menuOpen =
    Open.guards.ChoosingDecision(model.open) && model.open.key === key
  return [
    title(`Allow ${request.tool}?`, h),
    reason(request.why, h),
    shownInput(request.shown, h),
    Open.guards.Refusing(model.open) && model.open.key === key
      ? refusalForm({ key, engine }, request, model.open.note, h)
      : actions(
          [
            h.button(
              [
                h.Type('button'),
                h.Disabled(busy),
                h.OnClick(
                  Message.ClickedApprove({
                    key,
                    engine,
                    answer: permissionAnswer(
                      request,
                      PermissionDecision.cases.allow_once.make({}),
                    ),
                  }),
                ),
                h.Class(primaryButton),
              ],
              ['Approve'],
            ),
            h.button(
              [
                h.Type('button'),
                h.AriaLabel('More answers'),
                h.AriaHasPopup('menu'),
                h.AriaExpanded(menuOpen),
                h.Disabled(busy),
                h.OnClick(Message.ClickedDecisionMenu({ key })),
                h.Class(ghostButton),
              ],
              ['▾'],
            ),
            openSession(request, h),
            menuOpen ? decisionMenu({ key, engine }, request, h) : h.empty,
          ],
          h,
        ),
    failure(model, key, h),
  ]
}

const keyCap = (label: string, h: HtmlBuilder<Message>): Html =>
  h.kbd(
    [h.Class('rounded-button border border-line px-4 font-mono text-xs')],
    [label],
  )

const optionsPanel = (
  model: Model,
  engine: string,
  request: Question,
  answering: Extract<Open, { readonly _tag: 'Answering' }>,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const key = attentionKey(request)
  const options = Option.match(request.choices, {
    onNone: () => [],
    onSome: shownOptions,
  })
  const ready =
    Option.isSome(answering.chosen) ||
    Option.isSome(decodeText(answering.text.trim()))
  return h.form(
    [
      h.AriaLabel('Answer'),
      h.OnSubmit(Message.SubmittedAnswer({ key })),
      h.Class('flex flex-col gap-8'),
      h.DataAttribute(
        'guard',
        Guard.guards.Passed(model.guard) ? 'passed' : 'waiting',
      ),
    ],
    [
      request.consequential
        ? h.p(
            [h.DataAttribute('consequential', ''), h.Class('text-xs text-c2')],
            [
              'Consequential: nothing is chosen for you. Pick one deliberately.',
            ],
          )
        : h.empty,
      options.length === 0
        ? h.empty
        : h.div(
            [
              h.Role('radiogroup'),
              h.AriaLabel('Options'),
              h.Class('flex flex-col gap-4'),
            ],
            options.map(shown =>
              h.keyed('button')(
                `option-${shown.index}`,
                [
                  h.Type('button'),
                  h.Role('radio'),
                  h.AriaChecked(Option.contains(answering.chosen, shown.index)),
                  h.AriaKeyshortcuts(String(shown.place + 1)),
                  h.DataAttribute('option', String(shown.index)),
                  h.OnClick(Message.ChoseOption({ key, index: shown.index })),
                  h.Class(
                    `flex items-baseline gap-8 rounded-button border px-8 py-4 text-left text-sm hover:brightness-[1.08] ${Option.contains(answering.chosen, shown.index) ? 'border-c5 bg-bg font-bold' : 'border-line'}`,
                  ),
                ],
                [
                  shown.place < 9
                    ? keyCap(String(shown.place + 1), h)
                    : h.empty,
                  h.span([h.Class('text-fg')], [shown.option.label]),
                  shown.recommended
                    ? h.span(
                        [
                          h.DataAttribute('recommended', ''),
                          h.Class('text-xs font-extrabold text-c5'),
                        ],
                        ['Recommended'],
                      )
                    : h.empty,
                  h.span(
                    [h.Class('text-xs text-muted')],
                    [shown.option.tradeOff],
                  ),
                ],
              ),
            ),
          ),
      h.input([
        h.Type('text'),
        h.AriaLabel('Your own answer'),
        h.Placeholder('Or answer in your own words'),
        h.Value(answering.text),
        h.OnInput(text => Message.TypedAnswer({ key, text })),
        h.Class(
          'rounded-button border border-line bg-bg px-8 py-4 text-sm text-fg',
        ),
      ]),
      actions(
        [
          h.button(
            [
              h.Type('submit'),
              h.Disabled(!ready || !inputs.live || isPending(model)),
              h.Class(primaryButton),
            ],
            ['Send answer'],
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(
                Message.ClickedTalkItThrough({
                  project: { engine, project: request.project },
                  ticket: request.ticket,
                }),
              ),
              h.Class(ghostButton),
            ],
            ['Talk it through'],
          ),
        ],
        h,
      ),
    ],
  )
}

const questionBody = (
  model: Model,
  engine: string,
  request: Question,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const key = attentionKey(request)
  const answering =
    Open.guards.Answering(model.open) && model.open.key === key
      ? Option.some(model.open)
      : Option.none()
  return [
    title(request.title, h),
    request.blocks.length === 0
      ? h.empty
      : h.p(
          [h.DataAttribute('blocks', ''), h.Class('text-xs text-muted')],
          [
            `${request.blocks.join(', ')} ${request.blocks.length === 1 ? 'waits' : 'wait'} on it`,
          ],
        ),
    Option.match(request.description, {
      onNone: () => h.empty,
      onSome: description =>
        h.p(
          [
            h.DataAttribute('description', ''),
            h.Class('line-clamp-3 text-sm text-muted'),
            h.Title(description),
          ],
          [description],
        ),
    }),
    actions(
      [
        h.button(
          [
            h.Type('button'),
            h.AriaExpanded(Option.isSome(answering)),
            h.OnClick(Message.ClickedAnswer({ engine, request })),
            h.Class(primaryButton),
          ],
          ['Answer'],
        ),
        openSession(request, h),
      ],
      h,
    ),
    Option.match(answering, {
      onNone: () => h.empty,
      onSome: answering =>
        optionsPanel(model, engine, request, answering, inputs, h),
    }),
    failure(model, key, h),
  ]
}

const reviewBody = (
  engine: string,
  request: Extract<AttentionRequest, { readonly _tag: 'review' }>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  title(request.title, h),
  reason(setAsideWords[request.reason], h),
  actions(
    [
      h.button(
        [
          h.Type('button'),
          h.OnClick(
            Message.ClickedReview({
              project: { engine, project: request.project },
              ticket: request.ticket,
            }),
          ),
          h.Class(primaryButton),
        ],
        ['Review'],
      ),
      openSession(request, h),
    ],
    h,
  ),
]

const taskBody = (
  model: Model,
  engine: string,
  request: Extract<AttentionRequest, { readonly _tag: 'task' }>,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const key = attentionKey(request)
  return [
    title(request.title, h),
    reason('Yours to do: done when you close it', h),
    actions(
      [
        h.button(
          [
            h.Type('button'),
            h.Disabled(!inputs.live || isPending(model)),
            h.OnClick(
              Message.ClickedTaskDone({
                key,
                project: { engine, project: request.project },
                ticket: request.ticket,
              }),
            ),
            h.Class(primaryButton),
          ],
          ['Done'],
        ),
      ],
      h,
    ),
    failure(model, key, h),
  ]
}

/**
 * A request's card, keyed by its engine and its key: one key may be open on two engines. The focused
 * request's card, the one of its key on its own engine, carries the focus outline and is marked so,
 * not by colour alone (§18.2).
 */
const card = (
  model: Model,
  open: EngineRequest,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const { engine, request } = open
  const focused = Option.exists(inputs.focused, ref => namesRequest(ref, open))
  return h.keyed('li')(
    `${engine}/${attentionKey(request)}`,
    [
      h.DataAttribute('card', kindOf(request)),
      ...(focused ? [h.DataAttribute('focused', '')] : []),
      h.AriaLabel(`${kindWords[kindOf(request)]} ${cardTicket(request)}`),
      h.Class(
        `flex flex-col gap-8 rounded-card border border-line bg-panel hover:border-muted${focused ? ' outline-2 outline-offset-2 outline-c1' : ''}`,
      ),
      h.Style({ padding: '12px 14px' }),
    ],
    [
      firstRow(open, inputs, h),
      ...AttentionRequest.match(request, {
        permission: permission =>
          approvalBody(model, engine, permission, inputs, h),
        question: question => questionBody(model, engine, question, inputs, h),
        review: review => reviewBody(engine, review, h),
        task: task => taskBody(model, engine, task, inputs, h),
      }),
    ],
  )
}

export const view = defineView<Model, Message, ViewInputs>(
  (model, inputs, h) => {
    const requests = engineRequests(inputs.requests)
    return h.div(
      [h.Class('flex flex-col gap-8')],
      [
        h.div(
          [
            h.Class('flex items-baseline gap-8 border-b-2 border-c2'),
            h.Style({ paddingBottom: '8px' }),
          ],
          [
            h.h2(
              [h.Class('font-extrabold'), h.Style({ fontSize: '14px' })],
              ['Needs your attention'],
            ),
            h.span(
              [h.DataAttribute('count', ''), h.Class('text-xs text-c2')],
              [String(requests.length)],
            ),
          ],
        ),
        h.ul(
          [h.AriaLabel('Requests'), h.Class('flex flex-col gap-8')],
          requests.map(request => card(model, request, inputs, h)),
        ),
      ],
    )
  },
)
