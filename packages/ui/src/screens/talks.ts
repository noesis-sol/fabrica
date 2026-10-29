import { Array, Effect, Option, Schema } from 'effect'
import { Command, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { defineView } from 'foldkit/submodel'

import {
  OpenedTalk,
  ProjectId,
  TalkContext,
  TalkId,
  Text,
  type TranscriptItem,
} from '@fabrica/contracts'

import type { EngineConnectionService } from '../app/connection'
import * as Conversation from '../console/conversation'

// The Talks screen (spec §15.4, §15.5, §18.4): the refine and feature talks, full height, started on
// the scoped project (refine on a spec's path, feature on what it is to do, or nothing yet); the
// console's run and answer talks listed beside them and opened here too. A list of the talks on the
// left, the one chosen on the right with its header, its messages and its composer.

/** The modes a talk is started in from this screen. */
export const StartMode = Schema.Literals(['refine', 'feature'])
export type StartMode = typeof StartMode.Type

/** The talk shown: one of the console's, which follows the panel's, or one of this screen's own. */
export const Selected = defineTaggedUnion({
  None: {},
  Console: { which: Schema.Literals(['run', 'answer']) },
  Own: { talk: TalkId },
})
export type Selected = typeof Selected.Type

/** Starting a talk: nothing, its spec or feature being typed, or the talk being opened. */
export const Start = defineTaggedUnion({
  Closed: {},
  Typing: { mode: StartMode, text: Schema.String },
  Opening: { mode: StartMode },
  Failed: { mode: StartMode, reason: Schema.String },
})
export type Start = typeof Start.Type

export const Model = Schema.Struct({
  /** The talks started here, newest last. */
  talks: Schema.Array(Conversation.Conversation),
  selected: Selected,
  start: Start,
  composer: Conversation.Composer,
})
export type Model = typeof Model.Type

export const init = (): Model => ({
  talks: [],
  selected: Selected.None(),
  start: Start.Closed(),
  composer: Conversation.emptyComposer,
})

export const Message = defineMessageUnion({
  ClickedStart: { mode: StartMode },
  TypedStart: { text: Schema.String },
  SubmittedStart: { project: ProjectId },
  CancelledStart: {},
  OpenedTalk: { project: ProjectId, mode: StartMode, opened: OpenedTalk },
  FailedOpenTalk: { mode: StartMode, reason: Schema.String },
  Selected: { selected: Selected },
  TypedDraft: { text: Schema.String },
  SubmittedDraft: { talk: TalkId },
  SucceededSend: {},
  FailedSend: { reason: Schema.String },
  ClickedClose: { talk: TalkId },
  CompletedCloseTalk: {},
})
export type Message = typeof Message.Type

const decodeText = Schema.decodeUnknownOption(Text)

/** The context a talk starts in from what was typed: a refine talk needs its spec, a feature talk nothing. */
export const startContext = (
  mode: StartMode,
  text: string,
): Option.Option<TalkContext> => {
  const typed = decodeText(text.trim())
  return mode === 'refine'
    ? Option.map(typed, spec => TalkContext.cases.refine.make({ spec }))
    : Option.some(TalkContext.cases.feature.make({ text: typed }))
}

export const OpenTalk = Command.define('OpenTalk', {
  args: { project: ProjectId, mode: StartMode, context: TalkContext },
  messages: [Message.OpenedTalk, Message.FailedOpenTalk],
  execute: ({ project, mode, context }) =>
    Conversation.openTalk(project, context).pipe(
      Effect.map(opened => Message.OpenedTalk({ project, mode, opened })),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedOpenTalk({ mode, reason })),
      ),
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

/** The talks this screen holds, whose transcripts are watched. */
export const heldTalks = (model: Model): ReadonlyArray<TalkId> =>
  model.talks.filter(talk => !talk.ended).map(({ talk }) => talk)

/** The screen opened on one of the console's talks: "Talk it through" shows the answer talk here. */
export const showConsoleTalk = (model: Model, which: 'run' | 'answer'): Model =>
  modifyFields(model, { selected: () => Selected.Console({ which }) })

const changeTalk = (
  model: Model,
  talk: TalkId,
  change: (
    conversation: Conversation.Conversation,
  ) => Conversation.Conversation,
): Model =>
  model.talks.some(held => held.talk === talk)
    ? modifyFields(model, {
        talks: talks =>
          talks.map(held => (held.talk === talk ? change(held) : held)),
      })
    : model

/** A frame of a talk's transcript, applied to the talk it is for. */
export const receivedTranscript = (
  model: Model,
  talk: TalkId,
  items: Array.NonEmptyReadonlyArray<TranscriptItem>,
): Model =>
  changeTalk(model, talk, held => Conversation.applyTranscript(held, items))

/** A talk's transcript ended: the engine no longer has it. */
export const endedTranscript = (model: Model, talk: TalkId): Model =>
  changeTalk(model, talk, held => ({ ...held, ended: true }))

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ClickedStart: ({ mode }) => ({
      model: modifyFields(model, {
        start: () => Start.Typing({ mode, text: '' }),
      }),
    }),
    TypedStart: ({ text }) => ({
      model: modifyFields(model, {
        start: start =>
          Start.guards.Typing(start) ? Start.Typing({ ...start, text }) : start,
      }),
    }),
    SubmittedStart: ({ project }) => {
      if (!Start.guards.Typing(model.start)) {
        return { model }
      }
      const { mode, text } = model.start
      return Option.match(startContext(mode, text), {
        onNone: () => ({ model }),
        onSome: context => ({
          model: modifyFields(model, { start: () => Start.Opening({ mode }) }),
          commands: [OpenTalk({ project, mode, context })],
        }),
      })
    },
    CancelledStart: () => ({
      model: modifyFields(model, { start: () => Start.Closed() }),
    }),
    OpenedTalk: ({ project, mode, opened }) => ({
      model: modifyFields(model, {
        talks: talks => [...talks, Conversation.opened(project, mode, opened)],
        selected: () => Selected.Own({ talk: opened.talk }),
        start: () => Start.Closed(),
        composer: () => Conversation.emptyComposer,
      }),
    }),
    FailedOpenTalk: ({ mode, reason }) => ({
      model: modifyFields(model, {
        start: () => Start.Failed({ mode, reason }),
      }),
    }),
    Selected: ({ selected }) => ({
      model: modifyFields(model, {
        selected: () => selected,
        composer: () => Conversation.emptyComposer,
      }),
    }),
    TypedDraft: ({ text }) => ({
      model: modifyFields(model, {
        composer: composer => modifyFields(composer, { draft: () => text }),
      }),
    }),
    SubmittedDraft: ({ talk }) =>
      Option.match(Conversation.sendable(model.composer.draft), {
        onNone: () => ({ model }),
        onSome: text =>
          model.composer.sending._tag === 'sending'
            ? { model }
            : {
                model: modifyFields(model, {
                  composer: composer =>
                    modifyFields(composer, {
                      sending: () =>
                        Conversation.Sending.cases.sending.make({}),
                    }),
                }),
                commands: [SendToTalk({ talk, text })],
              },
      }),
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
    ClickedClose: ({ talk }) => ({
      model: modifyFields(model, {
        talks: talks => talks.filter(held => held.talk !== talk),
        selected: selected =>
          Selected.guards.Own(selected) && selected.talk === talk
            ? Selected.None()
            : selected,
      }),
      commands: [CloseTalk({ talk })],
    }),
    CompletedCloseTalk: () => ({ model }),
  })

// The drawing.

export interface ViewInputs {
  /** The scoped project, on which a talk starts; none under All projects. */
  readonly scope: Option.Option<ProjectId>
  readonly live: boolean
  /** The console's talks, as its panel holds them. */
  readonly run: Option.Option<Conversation.Conversation>
  readonly answer: Option.Option<Conversation.Conversation>
  /** A project's name, as the sidebar has it. */
  readonly projectName: (project: ProjectId) => string
}

const startTitle: Record<StartMode, string> = {
  refine: 'Refine a spec',
  feature: 'Talk a feature through',
}

const startField: Record<StartMode, { label: string; placeholder: string }> = {
  refine: { label: 'Spec', placeholder: 'docs/spec.md' },
  feature: {
    label: 'Feature',
    placeholder: 'What the feature does (or say it in the talk)',
  },
}

const primaryButton =
  'rounded-button bg-c1 px-12 py-6 text-sm font-bold text-ink shadow-glow1 hover:brightness-[1.08] disabled:opacity-60'
const ghostButton =
  'rounded-button border border-line px-12 py-6 text-sm text-fg hover:brightness-[1.08] disabled:opacity-60'

/** The talk the screen shows: a console talk while the panel holds it, or one of its own. */
export const shownTalk = (
  model: Model,
  inputs: Pick<ViewInputs, 'run' | 'answer'>,
): Option.Option<Conversation.Conversation> =>
  Selected.match(model.selected, {
    None: () => Option.none(),
    // The answer talk gone (its questions answered), the run talk comes back in its place.
    Console: ({ which }) =>
      which === 'answer'
        ? Option.orElse(inputs.answer, () => inputs.run)
        : inputs.run,
    Own: ({ talk }) => Array.findFirst(model.talks, held => held.talk === talk),
  })

const listEntry = (
  key: string,
  title: string,
  note: string,
  selected: Selected,
  current: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('li')(
    key,
    [],
    [
      h.button(
        [
          h.Type('button'),
          h.AriaCurrent(current ? 'true' : 'false'),
          h.OnClick(Message.Selected({ selected })),
          h.Class(
            `flex w-full flex-col items-start border-l-[3px] px-12 py-6 text-left ${current ? 'border-c1 bg-panel' : 'border-transparent'}`,
          ),
        ],
        [
          h.span([h.Class('text-sm font-bold')], [title]),
          h.span([h.Class('text-xs text-muted')], [note]),
        ],
      ),
    ],
  )

const startForm = (
  start: Start,
  scope: Option.Option<ProjectId>,
  live: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(scope, {
    onNone: () =>
      h.p(
        [h.Class('px-12 text-xs text-muted')],
        ['Choose a project in the sidebar to start a talk on it.'],
      ),
    onSome: project =>
      Start.guards.Typing(start)
        ? h.form(
            [
              h.AriaLabel(startTitle[start.mode]),
              h.OnSubmit(Message.SubmittedStart({ project })),
              h.Class('flex flex-col gap-6 px-12'),
            ],
            [
              h.input([
                h.Type('text'),
                h.AriaLabel(startField[start.mode].label),
                h.Placeholder(startField[start.mode].placeholder),
                h.Value(start.text),
                h.OnInput(text => Message.TypedStart({ text })),
                h.Class(
                  'rounded-button border border-line bg-bg px-8 py-4 text-sm text-fg',
                ),
              ]),
              h.div(
                [h.Class('flex gap-6')],
                [
                  h.button(
                    [
                      h.Type('submit'),
                      h.Disabled(
                        !live ||
                          Option.isNone(startContext(start.mode, start.text)),
                      ),
                      h.Class(primaryButton),
                    ],
                    ['Start'],
                  ),
                  h.button(
                    [
                      h.Type('button'),
                      h.OnClick(Message.CancelledStart()),
                      h.Class(ghostButton),
                    ],
                    ['Cancel'],
                  ),
                ],
              ),
            ],
          )
        : h.div(
            [h.Class('flex flex-col gap-6 px-12')],
            [
              ...StartMode.literals.map(mode =>
                h.keyed('button')(
                  mode,
                  [
                    h.Type('button'),
                    h.Disabled(!live || Start.guards.Opening(start)),
                    h.OnClick(Message.ClickedStart({ mode })),
                    h.Class(ghostButton),
                  ],
                  [startTitle[mode]],
                ),
              ),
              ...(Start.guards.Opening(start)
                ? [
                    h.p(
                      [h.Role('status'), h.Class('text-xs text-muted')],
                      ['Opening the talk…'],
                    ),
                  ]
                : Start.guards.Failed(start)
                  ? [
                      h.p(
                        [h.Role('alert'), h.Class('text-xs text-c3')],
                        [`Couldn’t open the talk: ${start.reason}.`],
                      ),
                    ]
                  : []),
            ],
          ),
  })

const isSelected = (selected: Selected, wanted: Selected): boolean =>
  selected._tag === wanted._tag &&
  (Selected.guards.Console(selected) && Selected.guards.Console(wanted)
    ? selected.which === wanted.which
    : Selected.guards.Own(selected) && Selected.guards.Own(wanted)
      ? selected.talk === wanted.talk
      : true)

const listView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const consoleEntries = [
    ...Option.match(inputs.run, {
      onNone: () => [],
      onSome: run => [
        listEntry(
          'console.run',
          Conversation.modeTitle.run,
          inputs.projectName(run.project),
          Selected.Console({ which: 'run' }),
          isSelected(model.selected, Selected.Console({ which: 'run' })),
          h,
        ),
      ],
    }),
    ...Option.match(inputs.answer, {
      onNone: () => [],
      onSome: answer => [
        listEntry(
          'console.answer',
          Conversation.modeTitle.answer,
          inputs.projectName(answer.project),
          Selected.Console({ which: 'answer' }),
          isSelected(model.selected, Selected.Console({ which: 'answer' })),
          h,
        ),
      ],
    }),
  ]
  const ownEntries = model.talks.map(talk =>
    listEntry(
      talk.talk,
      Conversation.modeTitle[talk.mode],
      inputs.projectName(talk.project),
      Selected.Own({ talk: talk.talk }),
      isSelected(model.selected, Selected.Own({ talk: talk.talk })),
      h,
    ),
  )
  return h.nav(
    [
      h.AriaLabel('Talks'),
      h.Class(
        'flex min-h-0 flex-col gap-12 overflow-auto rounded-card border border-line bg-side py-12',
      ),
    ],
    [
      h.ul(
        [h.AriaLabel('Open talks'), h.Class('flex flex-col')],
        [...consoleEntries, ...ownEntries],
      ),
      ...(consoleEntries.length === 0 && ownEntries.length === 0
        ? [h.p([h.Class('px-12 text-xs text-muted')], ['No talks open.'])]
        : []),
      startForm(model.start, inputs.scope, inputs.live, h),
    ],
  )
}

export const view = defineView<Model, Message, ViewInputs>(
  (model, inputs, h) => {
    const shown = shownTalk(model, inputs)
    const own = Selected.guards.Own(model.selected)
    return h.div(
      [
        h.DataAttribute('layout', 'talks'),
        h.Class('grid min-h-0 flex-1 gap-16'),
        h.Style({ gridTemplateColumns: '240px minmax(0,1fr)' }),
      ],
      [
        listView(model, inputs, h),
        h.section(
          [
            h.AriaLabel('Talk'),
            h.Class(
              'flex min-h-0 flex-col overflow-hidden rounded-card border border-line bg-panel',
            ),
          ],
          [
            Option.match(shown, {
              onNone: () =>
                h.p(
                  [h.Class('text-xs text-muted'), h.Style({ padding: '12px' })],
                  ['Choose a talk, or start one.'],
                ),
              onSome: conversation =>
                Conversation.view(
                  Option.some(conversation),
                  {
                    name: 'Fabrica',
                    note: `${Conversation.modeTitle[conversation.mode].toLowerCase()} · ${inputs.projectName(conversation.project)}`,
                    placeholder: 'Say something to the talk…',
                    composer: model.composer,
                    typed: text => Message.TypedDraft({ text }),
                    submitted: Message.SubmittedDraft({
                      talk: conversation.talk,
                    }),
                    controls: own
                      ? [
                          h.button(
                            [
                              h.Type('button'),
                              h.OnClick(
                                Message.ClickedClose({
                                  talk: conversation.talk,
                                }),
                              ),
                              h.Class(
                                'rounded-button border border-line px-6 text-xs text-fg',
                              ),
                            ],
                            ['Close'],
                          ),
                        ]
                      : [],
                    empty: 'Nothing said yet.',
                  },
                  inputs.live && !conversation.ended,
                  h,
                ),
            }),
          ],
        ),
      ],
    )
  },
)
