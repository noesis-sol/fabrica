import { Array, Effect, Option, Schema } from 'effect'
import { Command, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { defineView } from 'foldkit/submodel'

import {
  type AttentionRequest,
  OpenedTalk,
  ProjectId,
  type ProjectSettings,
  TalkContext,
  TalkId,
  Text,
  TicketId,
  type TranscriptItem,
} from '@fabrica/contracts'

import { type EngineConnectionService, requestEngine } from '../app/connection'
import * as Conversation from './conversation'
import * as Sidebar from './sidebar'

// The console's talk panel (spec §15.3, §15.4, §18.3, H44; Appendix A.2): the scope's run talk, its
// header giving the talk's model and context use, its messages bottom-aligned, its composer sending to
// it. When questions in scope are open and their project's `questions` setting is `auto` (the
// default), the answer talk takes the panel by itself, without taking focus; with `key` it opens on the
// maintainer's action. Once the project has no open question it is closed and the run talk comes back.
// Under All projects the composer acts on the project a message names, or asks which.

/** A question open in scope, from the attention requests. */
export const OpenQuestion = Schema.Struct({
  project: ProjectId,
  ticket: TicketId,
})
export type OpenQuestion = typeof OpenQuestion.Type

/** How a project's answer talk opens (§15.3), its setting read from the engine. */
export const QuestionsMode = Schema.Literals(['auto', 'key'])
export type QuestionsMode = ProjectSettings['questions']

/** A project's `questions` setting: still being read, or read. */
export const QuestionsSetting = Schema.Struct({
  project: ProjectId,
  mode: Schema.Option(QuestionsMode),
})
export type QuestionsSetting = typeof QuestionsSetting.Type

/** The answer talk: none, being opened, open, or refused by the engine, for a project with questions. */
export const Answer = defineTaggedUnion({
  None: {},
  Opening: { project: ProjectId },
  Open: { conversation: Conversation.Conversation },
  Failed: { project: ProjectId, reason: Schema.String },
})
export type Answer = typeof Answer.Type

/** The run talk: none, being opened on a project, open, or refused by the engine. */
export const Run = defineTaggedUnion({
  None: {},
  Opening: { project: ProjectId },
  Open: { conversation: Conversation.Conversation },
  Failed: { project: ProjectId, reason: Schema.String },
})
export type Run = typeof Run.Type

/** Under All projects, a message on its way to a project's run talk: asking which, or opening it. */
export const Address = defineTaggedUnion({
  None: {},
  Asking: { text: Text },
  Opening: { project: ProjectId, text: Text },
})
export type Address = typeof Address.Type

export const Model = Schema.Struct({
  run: Run,
  answer: Answer,
  /** The open questions in scope, oldest first. */
  questions: Schema.Array(OpenQuestion),
  /** The `questions` setting of each project that has had questions. */
  settings: Schema.Array(QuestionsSetting),
  address: Address,
  composer: Conversation.Composer,
})
export type Model = typeof Model.Type

export const init = (): Model => ({
  run: Run.None(),
  answer: Answer.None(),
  questions: [],
  settings: [],
  address: Address.None(),
  composer: Conversation.emptyComposer,
})

export const Message = defineMessageUnion({
  OpenedRunTalk: { project: ProjectId, opened: OpenedTalk },
  FailedOpenRunTalk: { project: ProjectId, reason: Schema.String },
  OpenedAnswerTalk: { project: ProjectId, opened: OpenedTalk },
  FailedOpenAnswerTalk: { project: ProjectId, reason: Schema.String },
  LoadedQuestionsSetting: { project: ProjectId, mode: QuestionsMode },
  CompletedCloseTalk: {},
  TypedDraft: { text: Schema.String },
  SubmittedDraft: {},
  /** Under All projects, the project the maintainer chose for the message. */
  ChoseProject: { project: ProjectId },
  CancelledAsking: {},
  /** The answer talk opened by the maintainer's action (`questions: key`). */
  ClickedAnswerTalk: {},
  SucceededSend: {},
  FailedSend: { reason: Schema.String },
})
export type Message = typeof Message.Type

// The requests.

/**
 * Opens the project's run talk, one per project (§15.4): opened again, it is the same talk. The scope's
 * is opened by the subscriptions as the scope changes; another project's by `OpenRunTalk`.
 */
export const openRunTalk = (project: ProjectId) =>
  Conversation.openTalk(project, TalkContext.cases.run.make({})).pipe(
    Effect.map(opened => Message.OpenedRunTalk({ project, opened })),
    Effect.catch(reason =>
      Effect.succeed(Message.FailedOpenRunTalk({ project, reason })),
    ),
  )

/** Opens the run talk of a project a message under All projects named. */
export const OpenRunTalk = Command.define('OpenRunTalk', {
  args: { project: ProjectId },
  messages: [Message.OpenedRunTalk, Message.FailedOpenRunTalk],
  execute: ({ project }) => openRunTalk(project),
})

/** Opens the answer talk on every open question of the project (§15.3): those arriving later queue into it. */
export const OpenAnswerTalk = Command.define('OpenAnswerTalk', {
  args: { project: ProjectId },
  messages: [Message.OpenedAnswerTalk, Message.FailedOpenAnswerTalk],
  execute: ({ project }) =>
    Conversation.openTalk(
      project,
      TalkContext.cases.answer.make({ questions: [] }),
    ).pipe(
      Effect.map(opened => Message.OpenedAnswerTalk({ project, opened })),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedOpenAnswerTalk({ project, reason })),
      ),
    ),
})

/** Reads the project's `questions` setting; one the engine can't give is the default, `auto`. */
export const LoadQuestionsSetting = Command.define('LoadQuestionsSetting', {
  args: { project: ProjectId },
  messages: [Message.LoadedQuestionsSetting],
  execute: ({ project }) =>
    requestEngine(client =>
      client.rpc['projects.settings.get']({ project }),
    ).pipe(
      Effect.map(settings => settings.questions),
      Effect.orElseSucceed((): QuestionsMode => 'auto'),
      Effect.map(mode => Message.LoadedQuestionsSetting({ project, mode })),
    ),
})

export const SendToTalk = Command.define('SendToTalk', {
  args: { talk: TalkId, text: Text },
  messages: [Message.SucceededSend, Message.FailedSend],
  execute: ({ talk, text }) =>
    Conversation.sendToTalk(talk, text).pipe(
      Effect.as(Message.SucceededSend()),
      Effect.catch(reason => Effect.succeed(Message.FailedSend({ reason }))),
    ),
})

export const CloseTalk = Command.define('CloseTalk', {
  args: { talk: TalkId },
  messages: [Message.CompletedCloseTalk],
  execute: ({ talk }) =>
    Conversation.closeTalk(talk).pipe(Effect.as(Message.CompletedCloseTalk())),
})

type Return = Update.Return<Model, Message, EngineConnectionService>

/** What the panel's update reads of the console: the scope, and the projects by name. */
export interface Context {
  readonly scope: Option.Option<ProjectId>
  readonly projects: ReadonlyArray<ProjectName>
}

export interface ProjectName {
  readonly project: ProjectId
  readonly name: string
}

/** The projects the sidebar knows, by name: the run talk acts on the one a message names (§18.3). */
export const projectNames = (
  sidebar: Sidebar.Model,
): ReadonlyArray<ProjectName> =>
  Sidebar.rows(sidebar).map(row => ({
    project: row.status.project,
    name: row.status.name,
  }))

// What the panel shows.

/** The talk the panel shows: the answer talk while it is open, else the run talk. */
export const shownTalk = (
  model: Model,
): Option.Option<Conversation.Conversation> =>
  Answer.guards.Open(model.answer)
    ? Option.some(model.answer.conversation)
    : Run.guards.Open(model.run)
      ? Option.some(model.run.conversation)
      : Option.none()

/** The run talk, while it is open. */
export const runTalk = (
  model: Model,
): Option.Option<Conversation.Conversation> =>
  Run.guards.Open(model.run)
    ? Option.some(model.run.conversation)
    : Option.none()

/** The answer talk, while it is open. */
export const answerTalk = (
  model: Model,
): Option.Option<Conversation.Conversation> =>
  Answer.guards.Open(model.answer)
    ? Option.some(model.answer.conversation)
    : Option.none()

/** The talks the panel holds, whose transcripts are watched. */
export const heldTalks = (model: Model): ReadonlyArray<TalkId> =>
  [runTalk(model), answerTalk(model)].flatMap(talk =>
    Option.match(talk, {
      onNone: () => [],
      onSome: ({ talk, ended }) => (ended ? [] : [talk]),
    }),
  )

/** The projects with open questions, in the order their oldest was asked. */
const questionProjects = (model: Model): ReadonlyArray<ProjectId> =>
  Array.dedupe(model.questions.map(question => question.project))

const settingOf = (
  model: Model,
  project: ProjectId,
): Option.Option<QuestionsSetting> =>
  Array.findFirst(model.settings, setting => setting.project === project)

/** The project the answer talk is for, while it is opening, open or refused. */
const answerProject = (answer: Answer): Option.Option<ProjectId> =>
  Answer.match(answer, {
    None: () => Option.none(),
    Opening: ({ project }) => Option.some(project),
    Open: ({ conversation }) => Option.some(conversation.project),
    Failed: ({ project }) => Option.some(project),
  })

/** Closes the answer talk where it is open, and takes it from the panel. */
const dropAnswer = (model: Model): Return => ({
  model: modifyFields(model, { answer: () => Answer.None() }),
  commands: Answer.guards.Open(model.answer)
    ? [CloseTalk({ talk: model.answer.conversation.talk })]
    : [],
})

/** Opens the answer talk on `project`'s questions. */
const openAnswer = (model: Model, project: ProjectId): Return => ({
  model: modifyFields(model, { answer: () => Answer.Opening({ project }) }),
  commands: [OpenAnswerTalk({ project })],
})

/** `first`, then `next` on its model, their commands together. */
const andThen = (first: Return, next: (model: Model) => Return): Return => {
  const second = next(first.model)
  return {
    model: second.model,
    commands: [...(first.commands ?? []), ...(second.commands ?? [])],
  }
}

/**
 * The answer talk kept in step with the open questions (§15.3): kept while its project still has one,
 * closed once it has none; otherwise opened for the first project with questions whose setting is
 * `auto`, each project's setting read the first time it has questions.
 */
const reconcile = (model: Model): Return => {
  const projects = questionProjects(model)
  const kept: Return = Option.match(answerProject(model.answer), {
    onNone: () => ({ model }),
    onSome: project =>
      projects.includes(project) ? { model } : dropAnswer(model),
  })
  if (!Answer.guards.None(kept.model.answer)) {
    return kept
  }
  const unread = projects.filter(project =>
    Option.isNone(settingOf(kept.model, project)),
  )
  const reading: Return = {
    model: modifyFields(kept.model, {
      settings: settings => [
        ...settings,
        ...unread.map(project => ({ project, mode: Option.none() })),
      ],
    }),
    commands: [
      ...(kept.commands ?? []),
      ...unread.map(project => LoadQuestionsSetting({ project })),
    ],
  }
  return Option.match(
    Array.findFirst(projects, project =>
      Option.exists(settingOf(reading.model, project), setting =>
        Option.contains(setting.mode, 'auto'),
      ),
    ),
    {
      onNone: () => reading,
      onSome: project => andThen(reading, ready => openAnswer(ready, project)),
    },
  )
}

/** The open questions among the scope's attention requests, oldest first. */
export const openQuestions = (
  requests: ReadonlyArray<AttentionRequest>,
): ReadonlyArray<OpenQuestion> =>
  Array.sortWith(
    requests.flatMap(request => (request._tag === 'question' ? [request] : [])),
    request => request.openedAt,
    (first, second) => (first < second ? -1 : first > second ? 1 : 0),
  ).map(({ project, ticket }) => ({ project, ticket }))

/** The scope's open questions changed: the answer talk follows them. */
export const receivedQuestions = (
  model: Model,
  questions: ReadonlyArray<OpenQuestion>,
): Return => reconcile(modifyFields(model, { questions: () => questions }))

/** Opens the run talk on `project`, the panel showing nothing of another project's meanwhile. */
const openRun = (model: Model, project: ProjectId): Return => ({
  model: modifyFields(model, { run: () => Run.Opening({ project }) }),
  commands: [OpenRunTalk({ project })],
})

/** The project the run talk is for, whatever its state. */
const runProject = (run: Run): Option.Option<ProjectId> =>
  Run.match(run, {
    None: () => Option.none(),
    Opening: ({ project }) => Option.some(project),
    Open: ({ conversation }) => Option.some(conversation.project),
    Failed: ({ project }) => Option.some(project),
  })

/**
 * The panel for a new scope: a project's run talk being opened (the subscriptions open it), unless it is
 * the one held already; under All projects, the talk of the project last spoken to kept. An answer talk
 * for a project out of scope is closed, and questions out of scope are dropped.
 */
export const scoped = (
  model: Model,
  scope: Option.Option<ProjectId>,
): Return => {
  const cleared = modifyFields(model, {
    questions: questions =>
      Option.match(scope, {
        onNone: () => questions,
        onSome: project =>
          questions.filter(question => question.project === project),
      }),
    address: () => Address.None(),
    composer: composer =>
      modifyFields(composer, {
        sending: () => Conversation.Sending.cases.idle.make({}),
      }),
  })
  const inScope = Option.match(answerProject(cleared.answer), {
    onNone: () => ({ model: cleared }),
    onSome: project =>
      Option.isNone(scope) || Option.contains(scope, project)
        ? { model: cleared }
        : dropAnswer(cleared),
  })
  return Option.match(scope, {
    onNone: () => inScope,
    onSome: project =>
      Option.contains(runProject(inScope.model.run), project)
        ? inScope
        : {
            ...inScope,
            model: modifyFields(inScope.model, {
              run: () => Run.Opening({ project }),
            }),
          },
  })
}

/** The maintainer opened the answer talk (a key, a button, "Talk it through"): on `project`, or the first with questions. */
export const requestedAnswerTalk = (
  model: Model,
  project: Option.Option<ProjectId>,
): Return =>
  Option.match(
    Option.orElse(project, () => Array.head(questionProjects(model))),
    {
      onNone: () => ({ model }),
      onSome: wanted =>
        Option.contains(answerProject(model.answer), wanted) &&
        !Answer.guards.Failed(model.answer)
          ? { model }
          : andThen(dropAnswer(model), dropped => openAnswer(dropped, wanted)),
    },
  )

/** A frame of a talk's transcript, applied to the talk it is for. */
export const receivedTranscript = (
  model: Model,
  talk: TalkId,
  items: Array.NonEmptyReadonlyArray<TranscriptItem>,
): Model =>
  !heldTalks(model).includes(talk)
    ? model
    : modifyFields(model, {
        run: run =>
          Run.guards.Open(run) && run.conversation.talk === talk
            ? Run.Open({
                conversation: Conversation.applyTranscript(
                  run.conversation,
                  items,
                ),
              })
            : run,
        answer: answer =>
          Answer.guards.Open(answer) && answer.conversation.talk === talk
            ? Answer.Open({
                conversation: Conversation.applyTranscript(
                  answer.conversation,
                  items,
                ),
              })
            : answer,
      })

/** A talk's transcript ended: the engine no longer has it. An ended answer talk gives the panel back. */
export const endedTranscript = (model: Model, talk: TalkId): Model =>
  !heldTalks(model).includes(talk)
    ? model
    : modifyFields(model, {
        run: run =>
          Run.guards.Open(run) && run.conversation.talk === talk
            ? Run.Open({ conversation: { ...run.conversation, ended: true } })
            : run,
        answer: answer =>
          Answer.guards.Open(answer) && answer.conversation.talk === talk
            ? Answer.Failed({
                project: answer.conversation.project,
                reason: 'the talk has ended',
              })
            : answer,
      })

// Sending.

const sending = (model: Model, talk: TalkId, text: string): Return => ({
  model: modifyFields(model, {
    address: () => Address.None(),
    composer: composer =>
      modifyFields(composer, {
        sending: () => Conversation.Sending.cases.sending.make({}),
      }),
  }),
  commands: [SendToTalk({ talk, text })],
})

/** Sends `text` to `project`'s run talk, opening it first where it isn't the one open. */
const sendToProject = (
  model: Model,
  project: ProjectId,
  text: string,
): Return =>
  Run.guards.Open(model.run) &&
  model.run.conversation.project === project &&
  !model.run.conversation.ended
    ? sending(model, model.run.conversation.talk, text)
    : andThen(
        {
          model: modifyFields(model, {
            address: () => Address.Opening({ project, text }),
          }),
        },
        opening => openRun(opening, project),
      )

const escapeForPattern = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** Whether `text` names `name`, as a whole word, in any case. */
export const names = (text: string, name: string): boolean =>
  name.trim() !== '' &&
  new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeForPattern(name.trim())}($|[^\\p{L}\\p{N}])`,
    'iu',
  ).test(text)

/** The projects `text` names, by their name or their ID. */
export const namedProjects = (
  text: string,
  projects: ReadonlyArray<ProjectName>,
): ReadonlyArray<ProjectId> =>
  projects
    .filter(({ project, name }) => names(text, name) || names(text, project))
    .map(({ project }) => project)

const submitted = (model: Model, context: Context): Return =>
  Option.match(Conversation.sendable(model.composer.draft), {
    onNone: () => ({ model }),
    onSome: text => {
      if (model.composer.sending._tag === 'sending') {
        return { model }
      }
      if (Answer.guards.Open(model.answer)) {
        return sending(model, model.answer.conversation.talk, text)
      }
      return Option.match(context.scope, {
        onSome: project => sendToProject(model, project, text),
        onNone: () => {
          const named = namedProjects(text, context.projects)
          return named.length === 1
            ? sendToProject(model, Option.getOrThrow(Array.head(named)), text)
            : {
                model: modifyFields(model, {
                  address: () => Address.Asking({ text }),
                }),
              }
        },
      })
    },
  })

export const update = (
  model: Model,
  message: Message,
  context: Context,
): Return =>
  Message.match<Return>(message, {
    OpenedRunTalk: ({ project, opened }) => {
      // The scope's run talk, or the one a message under All projects is waiting on; not one opened for
      // a scope since left.
      if (
        !Option.contains(context.scope, project) &&
        !Option.contains(runProject(model.run), project)
      ) {
        return { model }
      }
      const open = modifyFields(model, {
        run: () =>
          Run.Open({
            conversation: Conversation.opened(project, 'run', opened),
          }),
      })
      return Address.guards.Opening(model.address) &&
        model.address.project === project
        ? sending(open, opened.talk, model.address.text)
        : { model: open }
    },
    FailedOpenRunTalk: ({ project, reason }) =>
      Option.contains(context.scope, project) ||
      Option.contains(runProject(model.run), project)
        ? {
            model: modifyFields(model, {
              run: () => Run.Failed({ project, reason }),
              address: () => Address.None(),
            }),
          }
        : { model },
    OpenedAnswerTalk: ({ project, opened }) =>
      Answer.guards.Opening(model.answer) && model.answer.project === project
        ? {
            model: modifyFields(model, {
              answer: () =>
                Answer.Open({
                  conversation: Conversation.opened(project, 'answer', opened),
                }),
            }),
          }
        : // Opened after its questions were answered, or another took its place: it isn't kept.
          { model, commands: [CloseTalk({ talk: opened.talk })] },
    FailedOpenAnswerTalk: ({ project, reason }) => ({
      model:
        Answer.guards.Opening(model.answer) && model.answer.project === project
          ? modifyFields(model, {
              answer: () => Answer.Failed({ project, reason }),
            })
          : model,
    }),
    LoadedQuestionsSetting: ({ project, mode }) =>
      reconcile(
        modifyFields(model, {
          settings: settings =>
            settings.map(setting =>
              setting.project === project
                ? { project, mode: Option.some(mode) }
                : setting,
            ),
        }),
      ),
    CompletedCloseTalk: () => ({ model }),
    TypedDraft: ({ text }) => ({
      model: modifyFields(model, {
        composer: composer => modifyFields(composer, { draft: () => text }),
      }),
    }),
    SubmittedDraft: () => submitted(model, context),
    ChoseProject: ({ project }) =>
      Address.guards.Asking(model.address)
        ? sendToProject(model, project, model.address.text)
        : { model },
    CancelledAsking: () => ({
      model: modifyFields(model, { address: () => Address.None() }),
    }),
    ClickedAnswerTalk: () => requestedAnswerTalk(model, Option.none()),
    SucceededSend: () => ({
      model: modifyFields(model, {
        composer: () => Conversation.emptyComposer,
      }),
    }),
    FailedSend: ({ reason }) => ({
      model: modifyFields(model, {
        composer: composer =>
          modifyFields(composer, {
            sending: () => Conversation.Sending.cases.failed.make({ reason }),
          }),
      }),
    }),
  })

// The drawing.

export interface ViewInputs {
  readonly scope: Option.Option<ProjectId>
  readonly live: boolean
  readonly projects: ReadonlyArray<ProjectName>
}

const projectNameOf = (
  projects: ReadonlyArray<ProjectName>,
  project: ProjectId,
): string =>
  Option.match(
    Array.findFirst(projects, entry => entry.project === project),
    { onNone: () => project, onSome: entry => entry.name },
  )

const smallButton =
  'rounded-button border border-line px-6 text-xs text-fg hover:brightness-[1.08]'

/** Under All projects, the projects to choose from for a message that named none, or more than one. */
const askingWhich = (
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  h.div(
    [
      h.Role('group'),
      h.AriaLabel('Which project?'),
      h.Class('flex flex-wrap items-center gap-6 text-xs'),
    ],
    [
      h.span([h.Class('text-muted')], ['Which project?']),
      ...inputs.projects.map(({ project, name }) =>
        h.keyed('button')(
          project,
          [
            h.Type('button'),
            h.OnClick(Message.ChoseProject({ project })),
            h.Class(smallButton),
          ],
          [name],
        ),
      ),
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.CancelledAsking()),
          h.Class('text-muted'),
        ],
        ['Cancel'],
      ),
    ],
  ),
]

/** What the panel says while it has no talk to show. */
const emptyWords = (model: Model, inputs: ViewInputs): string =>
  Run.match(model.run, {
    None: () =>
      Option.isNone(inputs.scope)
        ? 'Name a project in your message, or you’ll be asked which.'
        : 'No run talk yet.',
    Opening: ({ project }) =>
      `Opening the run talk of ${projectNameOf(inputs.projects, project)}…`,
    Open: () => 'Nothing said yet.',
    Failed: ({ reason }) => `Couldn’t open the run talk: ${reason}.`,
  })

/** The header's note: whose talk it is, and how many questions wait while the answer talk has the panel. */
const noteOf = (model: Model, inputs: ViewInputs): string => {
  const waiting = model.questions.length
  const asked = `${waiting} question${waiting === 1 ? '' : 's'}`
  const ofProject = (project: ProjectId): string =>
    Option.isNone(inputs.scope)
      ? ` · ${projectNameOf(inputs.projects, project)}`
      : ''
  return Answer.match(model.answer, {
    Open: ({ conversation }) =>
      `answer talk · ${asked}${ofProject(conversation.project)}`,
    Opening: () => `opening the answer talk · ${asked}`,
    None: () =>
      Option.match(runProject(model.run), {
        onNone: () => 'orchestrator',
        onSome: project => `orchestrator${ofProject(project)}`,
      }),
    Failed: () =>
      Option.match(runProject(model.run), {
        onNone: () => 'orchestrator',
        onSome: project => `orchestrator${ofProject(project)}`,
      }),
  })
}

/** The header's control: with questions waiting and no answer talk open, one to open it (§15.3). */
const controlsOf = (
  model: Model,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  model.questions.length > 0 &&
  (Answer.guards.None(model.answer) || Answer.guards.Failed(model.answer))
    ? [
        h.button(
          [
            h.Type('button'),
            h.OnClick(Message.ClickedAnswerTalk()),
            h.Class('rounded-button bg-c2 px-6 text-xs font-bold text-ink'),
          ],
          [`Answer talk · ${model.questions.length}`],
        ),
      ]
    : []

const failedAnswer = (
  model: Model,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Answer.guards.Failed(model.answer)
    ? [
        h.p(
          [h.Role('status'), h.Class('text-xs text-c3')],
          [`No answer talk: ${model.answer.reason}.`],
        ),
      ]
    : []

export const view = defineView<Model, Message, ViewInputs>(
  (model, inputs, h) => {
    const shown = shownTalk(model)
    const enabled =
      inputs.live &&
      !Address.guards.Opening(model.address) &&
      (Option.isNone(inputs.scope)
        ? inputs.projects.length > 0
        : Option.exists(shown, talk => !talk.ended))
    return Conversation.view(
      shown,
      {
        name: 'Fabrica',
        note: noteOf(model, inputs),
        placeholder: Answer.guards.Open(model.answer)
          ? 'Answer, or ask about the questions…'
          : 'Ask the agents or give an instruction…',
        composer: model.composer,
        typed: text => Message.TypedDraft({ text }),
        submitted: Message.SubmittedDraft(),
        controls: controlsOf(model, h),
        footer: [
          ...failedAnswer(model, h),
          ...(Address.guards.Asking(model.address)
            ? askingWhich(inputs, h)
            : []),
        ],
        empty: emptyWords(model, inputs),
      },
      enabled,
      h,
    )
  },
)
