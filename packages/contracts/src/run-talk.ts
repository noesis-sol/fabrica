import { Schema } from 'effect'

import { ModelName } from './events'
import { PermissionId, TalkId, TicketId } from './ids'
import { AttentionRequest, PermissionDecision } from './rpc/attention'
import { TicketDetail, Why } from './rpc/backlog'
import { Ordinal } from './rpc/common'
import { RunView } from './rpc/run-view'
import { RunEnded, RunEvents } from './rpc/runs'
import { TranscriptEntry } from './rpc/transcript'
import { LabelName, Priority, Text, Ticket } from './ticket'
import { type AnyTool, Files, Title, opensWith } from './tools'

// The run talk's tools (spec §15.4, H44): what the console's conversation with the run reads, and the
// engine's commands it acts through. It has these and nothing else: no code edits, no git, no shell.
// A command answers with the line History shows for it; one that stops a run, closes or cancels a
// ticket or allows a permission request is refused with `confirm_first` until the maintainer has been
// asked, and has answered in a message of its own.

/** No arguments: an empty struct alone takes any value but null, so the check refuses every key. */
const NoArguments = Schema.Struct({}).check(
  Schema.makeFilter(input =>
    typeof input === 'object' && Object.keys(input).length === 0
      ? undefined
      : 'this tool takes no arguments',
  ),
)

/** How many of the latest items a read gives. */
const Last = (what: string, otherwise: number) =>
  Schema.OptionFromOptionalKey(
    Ordinal.annotate({
      description: `How many of the latest ${what} to read; ${otherwise} when left out.`,
    }),
  )

/** A ticket named by a tool. */
const NamedTicket = (description: string) => TicketId.annotate({ description })

// ---------------------------------------------------------------------------------------------------
// What it reads

/** The run going, whole, or how the project's last run ended. */
export const RunTalkView = Schema.TaggedUnion({
  idle: { last: Schema.OptionFromNullOr(RunEnded) },
  going: { view: RunView },
})
export type RunTalkView = typeof RunTalkView.Type

export const RunViewTool = {
  name: 'run_view',
  description:
    "Reads the project's run: its state, totals, ticket rows, workers, merge queue, holds and open " +
    'requests, or, with no run going, how the last one ended.',
  parameters: NoArguments,
  success: RunTalkView,
} satisfies AnyTool

export const RunEventsTool = {
  name: 'run_events',
  description:
    "Reads the latest records of the run's event stream: the run going, or the project's last.",
  parameters: Schema.Struct({ last: Last('records', 50) }),
  success: RunEvents,
} satisfies AnyTool

export const TicketShowTool = {
  name: 'ticket_show',
  description: 'Reads a ticket whole: its fields, labels, links and notes.',
  parameters: Schema.Struct({ id: NamedTicket('The ticket to read.') }),
  success: TicketDetail,
} satisfies AnyTool

export const TicketWhyTool = {
  name: 'ticket_why',
  description:
    'Says why a ticket is not ready, each reason in the log’s words.',
  parameters: Schema.Struct({ id: NamedTicket('The ticket to ask about.') }),
  success: Why,
} satisfies AnyTool

export const TicketsReadyTool = {
  name: 'tickets_ready',
  description: 'Lists the tickets ready to dispatch, most urgent first.',
  parameters: NoArguments,
  success: Schema.Array(Ticket),
} satisfies AnyTool

export const WorkerTranscriptTool = {
  name: 'worker_transcript',
  description: "Reads the latest of a worker's transcript, by its ticket.",
  parameters: Schema.Struct({
    ticket: NamedTicket("The worker's ticket."),
    last: Last('entries', 30),
  }),
  success: Schema.Array(TranscriptEntry),
} satisfies AnyTool

export const RunLogTool = {
  name: 'run_log',
  description: "Reads the latest lines of the project's log.",
  parameters: Schema.Struct({ last: Last('lines', 100) }),
  success: Schema.Array(Schema.String),
} satisfies AnyTool

export const OpenRequestsTool = {
  name: 'open_requests',
  description:
    'Lists what waits on the maintainer in this project: questions, permission requests (with the ID answer_permission takes), maintainer tasks and tickets set aside for review.',
  parameters: NoArguments,
  success: Schema.Array(AttentionRequest),
} satisfies AnyTool

// ---------------------------------------------------------------------------------------------------
// The engine's commands

/** What a command did, as History says it. */
export const Acted = Schema.Struct({
  text: Text,
  /** What else the maintainer should hear of it. */
  also: Schema.optionalKey(Text),
})
export type Acted = typeof Acted.Type

/** The answer talk a command opened: History's line, and the talk, for a client to take up (§15.3). */
export const AnswerTalkOpened = Schema.Struct({
  text: Text,
  talk: TalkId,
  model: ModelName,
})
export type AnswerTalkOpened = typeof AnswerTalkOpened.Type

export const MessageWorkerTool = {
  name: 'message_worker',
  description:
    "Sends a worker a message, steering it: the maintainer's instruction, by its ticket. The engine sends it nothing more until it is released; a ticket merging holds the message until it has.",
  parameters: Schema.Struct({
    ticket: NamedTicket("The worker's ticket."),
    text: Text,
  }),
  success: Acted,
} satisfies AnyTool

export const StartRunTool = {
  name: 'start_run',
  description:
    "Starts a run of the project's current tickets, or of one ticket and its descendants. Its start checks' problems come back, all together, where it can't start.",
  parameters: Schema.Struct({
    ticket: Schema.OptionFromOptionalKey(
      NamedTicket('The one ticket to run, with its descendants.'),
    ),
    limit: Schema.OptionFromOptionalKey(
      Ordinal.annotate({ description: 'Caps its dispatches.' }),
    ),
  }),
  success: Acted,
} satisfies AnyTool

export const DrainRunTool = {
  name: 'drain_run',
  description:
    'Drains the run: no new tickets; the running ones finish and merge, then it ends.',
  parameters: NoArguments,
  success: Acted,
} satisfies AnyTool

export const UndrainRunTool = {
  name: 'undrain_run',
  description: 'Takes a drain back: the run takes new tickets again.',
  parameters: NoArguments,
  success: Acted,
} satisfies AnyTool

export const StopRunTool = {
  name: 'stop_run',
  description:
    'Stops the run now. Confirm in one line first: refused with confirm_first, ask the maintainer that line and end your turn; call it again only once they have said yes.',
  parameters: NoArguments,
  success: Acted,
} satisfies AnyTool

export const HoldTicketTool = {
  name: 'hold_ticket',
  description:
    'Holds a ticket until another merges: a blocks link from the other to it.',
  parameters: Schema.Struct({
    ticket: NamedTicket('The ticket to hold.'),
    until: NamedTicket('The ticket that must merge first.'),
  }),
  success: Acted,
} satisfies AnyTool

export const TalkFileTicketParameters = Schema.Struct({
  title: Title,
  description: Text.annotate({
    description:
      'Opens with the detail, not a restatement of the title. Name a file only where the ticket will change it.',
  }),
  type: Schema.Literals(['task', 'bug', 'feature', 'chore', 'epic']),
  design: Schema.OptionFromOptionalKey(
    Text.annotate({
      description:
        'The decisions made with the maintainer that its worker must follow.',
    }),
  ),
  acceptance: Schema.OptionFromOptionalKey(
    Text.annotate({ description: 'How its worker knows it is done.' }),
  ),
  priority: Schema.OptionFromOptionalKey(
    Priority.annotate({
      description: '0 (most urgent) to 4 (backlog); 2 when left out.',
    }),
  ),
  files: Schema.OptionFromOptionalKey(
    Files.annotate({
      description:
        'The files it will change, its footprint; "unknown", or left out, when they cannot be named yet.',
    }),
  ),
  labels: Schema.OptionFromOptionalKey(Schema.Array(LabelName)),
  parent: Schema.OptionFromOptionalKey(NamedTicket('The epic it goes under.')),
}).check(
  Schema.makeFilter(({ title, description }) =>
    opensWith(description, title)
      ? {
          path: ['description'],
          issue:
            'the description opens with the detail, not a restatement of the title',
        }
      : undefined,
  ),
)

export const TalkFileTicketTool = {
  name: 'file_ticket',
  description:
    'Files a ticket on the maintainer’s instruction. Keep the title a plain summary of the change, at most 60 characters; the details go in the description.',
  parameters: TalkFileTicketParameters,
  success: Acted,
} satisfies AnyTool

export const UpdateTicketTool = {
  name: 'update_ticket',
  description:
    "Changes a ticket's fields on the maintainer's instruction: what is left out stays as it is.",
  parameters: Schema.Struct({
    id: NamedTicket('The ticket to change.'),
    title: Schema.OptionFromOptionalKey(Title),
    description: Schema.OptionFromOptionalKey(Text),
    design: Schema.OptionFromOptionalKey(Text),
    acceptance: Schema.OptionFromOptionalKey(Text),
    priority: Schema.OptionFromOptionalKey(Priority),
  }),
  success: Acted,
} satisfies AnyTool

export const DeferTicketTool = {
  name: 'defer_ticket',
  description:
    'Defers a ticket, sets it aside, until a time or until it is undeferred.',
  parameters: Schema.Struct({
    id: NamedTicket('The ticket to defer.'),
    until: Schema.OptionFromOptionalKey(
      Schema.DateTimeUtcFromString.annotate({
        description: 'An ISO 8601 time; left out, until it is undeferred.',
      }),
    ),
  }),
  success: Acted,
} satisfies AnyTool

export const LabelTicketTool = {
  name: 'label_ticket',
  description: "Changes a ticket's labels.",
  parameters: Schema.Struct({
    id: NamedTicket('The ticket to label.'),
    add: Schema.OptionFromOptionalKey(Schema.Array(LabelName)),
    remove: Schema.OptionFromOptionalKey(Schema.Array(LabelName)),
  }),
  success: Acted,
} satisfies AnyTool

const closing = {
  id: NamedTicket('The ticket.'),
  reason: Text.annotate({ description: "Why, in the maintainer's words." }),
}

export const CloseTicketTool = {
  name: 'close_ticket',
  description:
    'Closes a ticket as done. Confirm in one line first: refused with confirm_first, ask the maintainer that line and end your turn; call it again only once they have said yes.',
  parameters: Schema.Struct(closing),
  success: Acted,
} satisfies AnyTool

export const CancelTicketTool = {
  name: 'cancel_ticket',
  description:
    'Closes a ticket as cancelled. Confirm in one line first: refused with confirm_first, ask the maintainer that line and end your turn; call it again only once they have said yes.',
  parameters: Schema.Struct(closing),
  success: Acted,
} satisfies AnyTool

export const AnswerQuestionTool = {
  name: 'answer_question',
  description:
    "Answers a question in the maintainer's words: what they said, not your reading of it.",
  parameters: Schema.Struct({
    question: NamedTicket('The question.'),
    answer: Text,
  }),
  success: Acted,
} satisfies AnyTool

export const AnswerPermissionTool = {
  name: 'answer_permission',
  description:
    'Answers a permission request: allow it once, allow it for this run, or refuse it with a note. Allowing one takes a confirmation in one line first: refused with confirm_first, ask the maintainer that line and end your turn; call it again only once they have said yes.',
  parameters: Schema.Struct({
    id: PermissionId.annotate({
      description: "The request's ID, as open_requests gives it.",
    }),
    decision: PermissionDecision,
  }),
  success: Acted,
} satisfies AnyTool

export const OpenAnswerTalkTool = {
  name: 'open_answer_talk',
  description:
    'Opens the answer talk, on these questions or every open one, for the maintainer to answer there. Its answer names the talk.',
  parameters: Schema.Struct({
    questions: Schema.OptionFromOptionalKey(Schema.Array(TicketId)),
  }),
  success: AnswerTalkOpened,
} satisfies AnyTool
