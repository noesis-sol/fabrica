import { Schema } from 'effect'

import { CommitHash, NoteId, TicketId, TreeHash } from './ids'
import {
  Edge,
  LabelName,
  Note,
  Priority,
  QuestionChoices,
  ResultKind,
  Text,
  Ticket,
  TicketResult,
} from './ticket'

// The tools agents answer through: the worker's control channel (spec §12.3), the verifier's verdict
// (§13.6) and the organs' forced answer (§16). Each tool is one value here, its name, its description
// (the rules about its action live there, not in the standing rules, §12.4), the schema of its
// arguments and the schema of what it answers. The Pi extension hands the arguments' JSON Schema to Pi
// (`json-schema.ts`, §12.2) and decodes the arguments again with `decodeArguments`; the engine's side
// answers with `success`, or refuses with a `ToolRefusal`. A tool's arguments are always an object.

/** A tool an agent calls: its arguments are a struct, decoded by `parameters`; it answers with `success`. */
export interface Tool<
  Parameters extends Schema.Struct<Schema.Struct.Fields>,
  Success extends Schema.Top,
> {
  readonly name: string
  readonly description: string
  readonly parameters: Parameters
  readonly success: Success
}

/** Any tool, whatever its schemas. */
export type AnyTool = Tool<Schema.Struct<Schema.Struct.Fields>, Schema.Top>

/**
 * Decodes a tool call's arguments with its schema, refusing keys the schema doesn't name, as its JSON
 * Schema does (`additionalProperties: false`).
 */
export const decodeArguments = <
  Parameters extends Schema.Struct<Schema.Struct.Fields>,
>(
  tool: Tool<Parameters, Schema.Top>,
) => Schema.decodeUnknownEffect(tool.parameters, { onExcessProperty: 'error' })

/** A ticket's title: one line, at most 60 characters, a plain summary of the change. */
export const Title = Text.check(
  Schema.isPattern(/^[^\n\r]*$/u, { expected: 'one line' }),
  Schema.isMaxLength(60),
).annotate({ description: 'One line, at most 60 characters.' })
export type Title = typeof Title.Type

/** A path in the repository: relative, `/`-separated, never climbing out with `..`. */
export const RepoPath = Schema.String.check(
  Schema.isPattern(/^(?!\/)(?!(?:.*\/)?\.\.(?:\/|$))[^\n\r]*[^\s/]$/u, {
    expected: 'a relative path in the repository',
  }),
)
export type RepoPath = typeof RepoPath.Type

/** The files a ticket will change, its footprint (§13.4, H70), or `unknown` when they can't be named yet. */
export const Files = Schema.Union([
  Schema.Array(RepoPath).check(Schema.isMinLength(1)),
  Schema.Literal('unknown'),
])
export type Files = typeof Files.Type

/** Lower-case words, for comparing a description's opening with a title. */
const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(word => word.length > 0)
    .join(' ')

// ---------------------------------------------------------------------------------------------------
// What the engine answers and refuses

/** A ticket linked to the worker's, with its hand-off once it has finished (§13.5). */
export class LinkedTicket extends Schema.Class<LinkedTicket>('LinkedTicket')({
  id: TicketId,
  title: Text,
  result: Schema.OptionFromNullOr(TicketResult),
}) {}

/** A ticket as `get_ticket` shows it: the ticket, its labels, notes and links, and the results of the tickets it depends on. */
export class TicketView extends Schema.Class<TicketView>('TicketView')({
  ticket: Ticket,
  labels: Schema.Array(LabelName),
  notes: Schema.Array(Note),
  edges: Schema.Array(Edge),
  dependencies: Schema.Array(LinkedTicket),
}) {}

/** The ticket a tool filed. */
export class Filed extends Schema.Class<Filed>('Filed')({ id: TicketId }) {}

/** The note `add_note` wrote. */
export class Noted extends Schema.Class<Noted>('Noted')({ id: NoteId }) {}

/** An outcome tool's answer: the turn is over, and the agent stops. */
export const Ended = Schema.Struct({})
export type Ended = typeof Ended.Type

/** What `ask_and_wait` ends with: the answer, or none within `question_wait`, which ends the turn as `ask_question` does. */
export const Awaited = Schema.TaggedUnion({
  answered: { question: TicketId, answer: Text },
  unanswered: { question: TicketId },
})
export type Awaited = typeof Awaited.Type

/** Why the engine refused a tool call; the agent sees it as the call's error and can try again. */
export const ToolRefusal = Schema.TaggedUnion({
  /** The arguments didn't decode. */
  invalid: { issue: Text },
  /** Not the worker's own ticket, nor one linked to it. */
  out_of_scope: { ticket: TicketId },
  /** The worktree has changes not committed (§13.7 names them). */
  worktree_dirty: {
    uncommitted: Schema.Array(RepoPath),
    untracked: Schema.Array(RepoPath),
  },
  /** No `check_own` pass is recorded on this tree (H89). */
  check_own_not_passed: { tree: TreeHash },
  /** The result isn't the one the ticket's `result_kind` asks for (§13.5). */
  wrong_result_kind: { expected: ResultKind, given: ResultKind },
})
export type ToolRefusal = typeof ToolRefusal.Type

// ---------------------------------------------------------------------------------------------------
// The worker's tools (§12.3)

export const GetTicketParameters = Schema.Struct({
  id: Schema.OptionFromOptionalKey(
    TicketId.annotate({
      description: 'The ticket to read; your own when left out.',
    }),
  ),
})

export const GetTicket = {
  name: 'get_ticket',
  description:
    'Reads your ticket, or one linked to it: its description, design, acceptance criteria, notes, ' +
    'labels and links, and the results of the tickets it depends on.',
  parameters: GetTicketParameters,
  success: TicketView,
} satisfies AnyTool

/** How a filed ticket links to the worker's own (an edge from the worker's ticket to the new one). */
export const FiledLink = Schema.Literals([
  'blocks',
  'discovered_from',
  'related',
]).annotate({
  description:
    'blocks: your ticket blocks it, for a follow-up that changes or builds on what your ticket adds; ' +
    'it waits until yours merges. discovered_from: found while working on yours, independent of its ' +
    'changes. related: touches the same files or functions as yours.',
})
export type FiledLink = typeof FiledLink.Type

export const FileTicketParameters = Schema.Struct({
  title: Title,
  description: Text.annotate({
    description:
      'Opens with the detail, not a restatement of the title. Name a file only where the ticket will change it.',
  }),
  type: Schema.Literals(['task', 'bug', 'feature', 'chore']),
  priority: Schema.OptionFromOptionalKey(
    Priority.annotate({
      description: '0 (most urgent) to 4 (backlog); 2 when left out.',
    }),
  ),
  files: Files.annotate({
    description:
      'The files it will change, its footprint, which keeps it apart from tickets changing the same files; "unknown" when they cannot be named yet.',
  }),
  labels: Schema.OptionFromOptionalKey(
    Schema.Array(LabelName).annotate({
      description:
        'Labels, such as solo for a change most tickets touch (splitting or moving a shared file), which runs with no other ticket beside it.',
    }),
  ),
  link: FiledLink,
}).check(
  Schema.makeFilter(({ title, description }) =>
    words(description).startsWith(words(title))
      ? {
          path: ['description'],
          issue:
            'the description opens with the detail, not a restatement of the title',
        }
      : undefined,
  ),
)

export const FileTicket = {
  name: 'file_ticket',
  description:
    'Files a follow-up or an issue you discovered, linked to your ticket. Keep the title a plain ' +
    'summary of the change, at most 60 characters; the details go in the description.',
  parameters: FileTicketParameters,
  success: Filed,
} satisfies AnyTool

export const AskQuestionParameters = Schema.Struct({
  title: Title.annotate({
    description: 'The question, one line, at most 60 characters.',
  }),
  description: Text.annotate({
    description:
      'The context, the options and your recommendation, for a maintainer who has not followed your work.',
  }),
  choices: QuestionChoices,
  consequential: Schema.Boolean.annotate({
    description:
      'true when an option would close, cancel, defer or freeze work, or change a decision the spec records: nothing answers it in a batch.',
  }),
  maintainerOnly: Schema.Boolean.annotate({
    description:
      'true when it asks the maintainer to do or give something (make a key, run a step by hand, act under their own account), or to approve something done in their name: nothing answers it for them.',
  }),
  blocks: Schema.OptionFromOptionalKey(
    TicketId.annotate({
      description:
        'The ticket the decision is about, which waits on the answer; your own when left out.',
    }),
  ),
})

export const AskQuestion = {
  name: 'ask_question',
  description:
    'Asks the maintainer a decision only they can make, blocking your ticket or the one it is about. ' +
    'Asked about your own ticket, it ends your turn: your session is resumed with the answer. Decide ' +
    'yourself what you can; a decision about another ticket blocks that ticket, and you go on with yours.',
  parameters: AskQuestionParameters,
  success: Filed,
} satisfies AnyTool

export const AddNoteParameters = Schema.Struct({ body: Text })

export const AddNote = {
  name: 'add_note',
  description:
    'Writes a note on your ticket: a decision you made, a gap you left, what a later session needs to know.',
  parameters: AddNoteParameters,
  success: Noted,
} satisfies AnyTool

/** The `check_own` pass a `finish` stands on: the tree it ran on, the commit, and the file its output is in (H89). */
export class CheckOwnPass extends Schema.Class<CheckOwnPass>('CheckOwnPass')({
  tree: TreeHash.annotate({
    description:
      "The tree check_own passed on, the tree you are finishing: HEAD's, as nothing is left uncommitted.",
  }),
  commit: CommitHash.annotate({
    description: 'The commit you are finishing, HEAD.',
  }),
  output: Text.annotate({
    description: 'The file the check wrote its whole output to.',
  }),
}) {}

const finishParameters = <Result extends Schema.Top>(result: Result) =>
  Schema.Struct({
    checkOwn: CheckOwnPass,
    result: result.annotate({
      description:
        "The hand-off: a summary, plus the fields the ticket's result_kind asks for; the tickets depending on yours read it.",
    }),
  })

export const FinishParameters = finishParameters(TicketResult)

const finishDescription =
  'Ends your work: your commits are on the branch and check_own passed on the tree you finish, ' +
  'with nothing uncommitted or untracked in the worktree. The verifier then checks your change, ' +
  'and the merge queue merges it.'

export const Finish = {
  name: 'finish',
  description: finishDescription,
  parameters: FinishParameters,
  success: Ended,
} satisfies AnyTool

/** `finish` for a ticket whose `result_kind` is `kind`: its result is that case of `TicketResult` alone. */
export const finishFor = (kind: ResultKind) =>
  ({
    name: 'finish',
    description: finishDescription,
    parameters: finishParameters(TicketResult.cases[kind]),
    success: Ended,
  }) satisfies AnyTool

export const DeferParameters = Schema.Struct({
  reason: Text.annotate({
    description:
      'Why you cannot finish, and what is done and committed so far.',
  }),
})

export const Defer = {
  name: 'defer',
  description:
    'Ends your turn without finishing, when you cannot: commit the work done so far first. The ticket ' +
    'is set aside with its worktree and session kept, and your reason as its note.',
  parameters: DeferParameters,
  success: Ended,
} satisfies AnyTool

export const WaitForParameters = Schema.Struct({
  ticket: TicketId.annotate({
    description: 'The ticket that must merge first.',
  }),
  needs: Text.annotate({
    description: 'What your ticket needs from it.',
  }),
})

export const WaitFor = {
  name: 'wait_for',
  description:
    'Ends your turn when your ticket needs work from another ticket that is not on your base yet. ' +
    'Never build on its branch or copy its code, and leave nothing uncommitted. Your ticket is linked ' +
    'as blocked by it, and comes back once it merges.',
  parameters: WaitForParameters,
  success: Ended,
} satisfies AnyTool

export const AskAndWait = {
  name: 'ask_and_wait',
  description:
    'Asks as ask_question does, for a quick choice you need now to go on, then waits for the answer ' +
    "up to the project's question_wait (15 minutes by default). Without an answer by then, it ends " +
    'your turn as ask_question does.',
  parameters: AskQuestionParameters,
  success: Awaited,
} satisfies AnyTool

/** The worker's tools, in the order the extension registers them. */
export const WorkerTools = [
  GetTicket,
  FileTicket,
  AskQuestion,
  AddNote,
  Finish,
  Defer,
  WaitFor,
  AskAndWait,
] as const

/** The tools that end a worker's turn: one of them, or `ask_question` on its own ticket, is its outcome (§12.3). */
export const OutcomeToolNames = [
  'finish',
  'defer',
  'wait_for',
  'ask_question',
  'ask_and_wait',
] as const

// ---------------------------------------------------------------------------------------------------
// The verifier's verdict (§13.6)

/** A verifier round, counted from 1. */
export const Round = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export type Round = typeof Round.Type

/** A gap the verifier found in the change. */
export class Finding extends Schema.Class<Finding>('Finding')({
  gap: Text.annotate({
    description: 'What is missing or wrong, with the file and line.',
  }),
  blocking: Schema.Boolean.annotate({
    description:
      "true when it affects correctness or the ticket's requirements; false for an optional improvement.",
  }),
  disagreesWithRound: Schema.OptionFromOptionalKey(
    Round.annotate({
      description:
        'The earlier round whose findings this one disagrees with (DISAGREES WITH ROUND <n>); the worker then asks the maintainer rather than going round again.',
    }),
  ),
}) {}

/** The verifier's verdict: `PASS`, its findings optional only, or `FAIL` with at least one blocking finding. */
export const Verdict = Schema.TaggedUnion({
  PASS: {
    summary: Text,
    findings: Schema.Array(Finding).check(
      Schema.makeFilter(findings =>
        findings.some(finding => finding.blocking)
          ? 'a PASS has no blocking findings'
          : undefined,
      ),
    ),
  },
  FAIL: {
    summary: Text,
    findings: Schema.Array(Finding).check(
      Schema.makeFilter(findings =>
        findings.some(finding => finding.blocking)
          ? undefined
          : 'a FAIL has at least one blocking finding',
      ),
    ),
  },
})
export type Verdict = typeof Verdict.Type

export const VerdictParameters = Schema.Struct({ verdict: Verdict })

export const VerdictTool = {
  name: 'verdict',
  description:
    'Gives your verdict on the change, once: PASS when it meets its ticket, or FAIL with the gaps ' +
    "that affect correctness or the ticket's requirements. Weigh the earlier rounds' findings; " +
    'where you disagree with one, say so in the finding.',
  parameters: VerdictParameters,
  success: Ended,
} satisfies AnyTool

// ---------------------------------------------------------------------------------------------------
// The organs' forced answer (§16)

/** The name of the one tool an organ's model is made to call. */
export const AnswerToolName = 'answer'

/**
 * An organ's forced answer tool: its arguments are the envelope `{ answer }` around the organ's own
 * schema, so that they are an object whatever the answer is (a list of files, a cause).
 */
export const answerTool = <Answer extends Schema.Top>(options: {
  readonly answer: Answer
  readonly description: string
}) =>
  ({
    name: AnswerToolName,
    description: options.description,
    parameters: Schema.Struct({ answer: options.answer }),
    success: Ended,
  }) satisfies AnyTool
