import { Schema } from 'effect'

import { TicketId } from './ids'
import { QuestionAnswer } from './rpc/attention'
import { Note, QuestionChoices, Text, TicketStatus } from './ticket'
import { type AnyTool, CheckOwnParameters } from './tools'

// The answer talk's question tools (spec §15.3): the open questions in its scope, with their options,
// the tickets they block and the ticket they were asked from; options drafted for a question filed
// without, and marked so; and the maintainer's answer, recorded one question at a time. A talk has no
// tool that closes, defers or releases a ticket: an answer does what an answer does (§15.2).

/** A ticket linked to a question, as the talk is given it. */
export class TicketInTalk extends Schema.Class<TicketInTalk>('TicketInTalk')({
  id: TicketId,
  title: Text,
  status: TicketStatus,
  description: Schema.OptionFromNullOr(Schema.String),
  notes: Schema.Array(Note),
}) {}

/** An open question, as the talk is given it. */
export class QuestionInTalk extends Schema.Class<QuestionInTalk>(
  'QuestionInTalk',
)({
  id: TicketId,
  title: Text,
  description: Schema.OptionFromNullOr(Schema.String),
  /** None: filed without options, which the talk is to draft. */
  choices: Schema.OptionFromNullOr(QuestionChoices),
  /** Its options were drafted by a talk, not given by who asked it. */
  drafted: Schema.Boolean,
  consequential: Schema.Boolean,
  maintainerOnly: Schema.Boolean,
  blocks: Schema.Array(TicketInTalk),
  askedFrom: Schema.OptionFromNullOr(TicketInTalk),
}) {}

/** A deferred ticket, mentioned to the maintainer: nothing in the talk releases it. */
export class DeferredInTalk extends Schema.Class<DeferredInTalk>(
  'DeferredInTalk',
)({ id: TicketId, title: Text }) {}

/** What the talk has to answer. */
export class QuestionsInTalk extends Schema.Class<QuestionsInTalk>(
  'QuestionsInTalk',
)({
  questions: Schema.Array(QuestionInTalk),
  deferred: Schema.Array(DeferredInTalk),
}) {}

/** An answer recorded: its words, and the questions still open in the talk's scope. */
export class AnswerRecorded extends Schema.Class<AnswerRecorded>(
  'AnswerRecorded',
)({
  question: TicketId,
  answer: Text,
  left: Schema.Array(TicketId),
}) {}

export const ListQuestionsTool = {
  name: 'list_questions',
  description:
    'Lists the open questions in this talk, those that arrived since it opened among them, each with ' +
    'its options, the tickets it blocks and the ticket it was asked from, and the deferred tickets, ' +
    'which you mention and never release.',
  parameters: CheckOwnParameters,
  success: QuestionsInTalk,
} satisfies AnyTool

export const DraftOptionsParameters = Schema.Struct({
  question: TicketId.annotate({ description: 'The question.' }),
  choices: QuestionChoices,
})

export const DraftOptionsTool = {
  name: 'draft_options',
  description:
    'Records options you drafted for a question filed without any: 2 to 4, one recommended. They are ' +
    'marked as drafted wherever they are shown, so say so when you show them. A question whose drafted ' +
    'options would close, cancel, defer or freeze work becomes consequential. Refused for a question ' +
    'filed with options.',
  parameters: DraftOptionsParameters,
  success: QuestionInTalk,
} satisfies AnyTool

export const AnswerQuestionParameters = Schema.Struct({
  question: TicketId.annotate({ description: 'The question.' }),
  answer: QuestionAnswer.annotate({
    description:
      "One of its options by its index, from 0, or the maintainer's own words.",
  }),
})

export const AnswerQuestionTool = {
  name: 'answer_question',
  description:
    "Records the maintainer's answer to one question: it closes the question, writes the answer into " +
    'the tickets it blocks and frees them. Only ever what the maintainer said. A consequential or ' +
    "maintainer-only question is refused unless the maintainer's latest message answers it and nothing " +
    'else, so it is never answered in a batch: ask them about it alone.',
  parameters: AnswerQuestionParameters,
  success: AnswerRecorded,
} satisfies AnyTool

/** The answer talk's question tools, in the order they are given. */
export const AnswerTalkTools = [
  ListQuestionsTool,
  DraftOptionsTool,
  AnswerQuestionTool,
] as const
