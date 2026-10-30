import { Effect, Option, Schema, Stream } from 'effect'
import {
  Command as SceneCommand,
  click,
  expect as expectScene,
  given as givenScene,
  role,
  scene,
  selector,
  submit,
  type as typeInto,
  within,
} from 'foldkit/scene'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import {
  AttentionRequest,
  EngineId,
  OpenedTalk,
  ProjectId,
  ProjectRunState,
  ProjectStatus,
  SessionId,
  StreamEpoch,
  TalkContext,
  TalkId,
  TranscriptItem,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { makeSubscriptions } from '../src/app/subscriptions'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Attention from '../src/console/attention'
import * as Conversation from '../src/console/conversation'
import * as TalkPanel from '../src/console/talk-panel'
import * as Talks from '../src/screens/talks'

// Talks in the app (spec §15.3, §15.4, §18.3, §18.4; Appendix A.2): the console's talk panel holds the
// scope's run talk, its header giving the model and context use, its messages bottom-aligned, its
// composer sending to it; the answer talk takes the panel when questions arrive (`questions: auto`,
// without taking focus) and gives it back once they are answered; under All projects a message goes
// to the project it names, or the panel asks which; the Talks screen holds the refine and feature
// talks, full height.

const engine = EngineId.make('e-1')
const auth = ProjectId.make('p-1')
const billing = ProjectId.make('p-2')
const runTalk = TalkId.make('t-run-1')
const billingTalk = TalkId.make('t-run-2')
const answerTalk = TalkId.make('t-answer-1')

/** Thursday 29 October 2026, 12:00 UTC. */
const at = Date.UTC(2026, 9, 29, 12, 0, 0)

const status = (project: ProjectId, name: string): ProjectStatus =>
  new ProjectStatus({
    project,
    name,
    base: 'main',
    setUp: true,
    trusted: true,
    run: ProjectRunState.cases.idle.make({}),
    ready: 0,
  })

const projects = Message.ReceivedProjects({
  engine,
  name: 'local',
  items: [
    {
      _tag: 'snapshot',
      epoch: StreamEpoch.make('epoch-1'),
      seq: 0,
      value: [status(auth, 'Auth refresh'), status(billing, 'Billing')],
    },
  ],
})

const received = (shown: Model, ...messages: ReadonlyArray<Message>): Model =>
  messages.reduce((before, next) => update(before, next).model, shown)

/** Connected, with two projects in the sidebar and every project in scope. */
const connected: Model = received(
  {
    ...initialModel({ platform: 'darwin', release: '0.0.0' }),
    connection: Connection.Up({
      engine,
      release: '0.1.0',
      protocol: protocolVersion,
    }),
  },
  projects,
)

const opened = (talk: TalkId, model = 'claude-opus-5-5'): OpenedTalk =>
  new OpenedTalk({ talk, session: SessionId.make(`s-${talk}`), model })

const panelMessage = (message: TalkPanel.Message): Message =>
  Message.GotTalkPanelMessage({ message })

const talksMessage = (message: Talks.Message): Message =>
  Message.GotTalksMessage({ message })

/** The auth project in scope, its run talk open. */
const scopedToAuth: Model = received(
  connected,
  Message.SelectedScope({ project: Option.some(auth) }),
  panelMessage(
    TalkPanel.Message.OpenedRunTalk({ project: auth, opened: opened(runTalk) }),
  ),
)

const decodeItem = Schema.decodeUnknownSync(Schema.toCodecJson(TranscriptItem))

/** The run talk's transcript so far: the handoff's two messages, and a turn that used 14k of context. */
const snapshot = decodeItem({
  _tag: 'snapshot',
  epoch: 'epoch-t',
  seq: 0,
  value: [
    {
      _tag: 'message',
      id: 'm-1',
      role: 'user',
      text: 'Hold the indexer work until the sessions-table migration is approved.',
      at,
    },
    {
      _tag: 'message',
      id: 'm-2',
      role: 'assistant',
      text: 'Paused fa-398.',
      at: at + 1_000,
    },
    {
      _tag: 'text',
      message: 'm-2',
      delta: ' It resumes once fa-377 is approved.',
    },
    {
      _tag: 'turn_end',
      at: at + 2_000,
      tokens: {
        input: 2_000,
        output: 400,
        cache_write: 1_600,
        cache_read: 10_000,
      },
    },
  ],
})

const transcript = (talk: TalkId): Message =>
  Message.ReceivedTranscript({ talk, items: [snapshot] })

const decodeRequest = Schema.decodeUnknownSync(
  Schema.toCodecJson(AttentionRequest),
)

const question = (project: ProjectId, ticket: string): AttentionRequest =>
  decodeRequest({
    _tag: 'question',
    project,
    ticket,
    title: 'Which store keeps the sessions?',
    description: 'The worker needs a store for the refresh tokens.',
    choices: {
      options: [
        { label: 'Redis', tradeOff: 'Fast; another service to run' },
        { label: 'Postgres', tradeOff: 'Already running; slower' },
      ],
      recommended: 1,
    },
    consequential: false,
    maintainerOnly: false,
    blocks: ['fa-7'],
    askedFrom: 'fa-7',
    openedAt: at,
  })

const attention = (...requests: ReadonlyArray<AttentionRequest>): Message =>
  Message.ReceivedAttention({
    engine: localEngineName,
    items: [
      {
        _tag: 'snapshot',
        epoch: StreamEpoch.make('epoch-a'),
        seq: 0,
        value: requests,
      },
    ],
  })

const shownTalk = (shown: Model) =>
  Option.map(TalkPanel.shownTalk(shown.console.talkPanel), talk => talk.talk)

describe('the run talk', () => {
  test('selecting a project opens its run talk; its header gives the model and the context used', () => {
    const { runTalk: opening } = makeSubscriptions({
      nextFrame: Effect.void,
      keys: Stream.empty,
      ticks: Stream.empty,
      replacedEnginePorts: Stream.empty,
    })
    expect(opening.modelToDependencies(connected).project).toEqual(
      Option.none(),
    )
    story(
      update,
      given(connected),
      message(Message.SelectedScope({ project: Option.some(auth) })),
      model(shown => {
        expect(shown.console.talkPanel.run).toEqual(
          TalkPanel.Run.Opening({ project: auth }),
        )
        // The subscriptions open the scope's run talk.
        expect(opening.modelToDependencies(shown).project).toEqual(
          Option.some(auth),
        )
      }),
      message(
        panelMessage(
          TalkPanel.Message.OpenedRunTalk({
            project: auth,
            opened: opened(runTalk),
          }),
        ),
      ),
      model(shown => {
        expect(shownTalk(shown)).toEqual(Option.some(runTalk))
      }),
      message(transcript(runTalk)),
      model(shown => {
        const talk = Option.getOrThrow(
          TalkPanel.shownTalk(shown.console.talkPanel),
        )
        expect(
          talk.lines.map(line => line._tag === 'said' && line.text),
        ).toEqual([
          'Hold the indexer work until the sessions-table migration is approved.',
          'Paused fa-398. It resumes once fa-377 is approved.',
        ])
        expect(Conversation.modelWords(talk)).toBe('claude-opus-5-5 · 14k ctx')
      }),
    )
  })

  test('the panel draws the header, the messages bottom-aligned and the composer', () => {
    scene(
      { update, view },
      givenScene(received(scopedToAuth, transcript(runTalk))),
      expectScene(
        within(
          role('region', { name: 'Run talk' }),
          role('heading', { level: 2 }),
        ),
      ).toHaveText('Fabrica'),
      expectScene(selector('[data-talk-model]')).toHaveText(
        'claude-opus-5-5 · 14k ctx',
      ),
      expectScene(role('log', { name: 'Messages' })).toHaveClass(
        'flex-col-reverse',
      ),
      expectScene(
        within(
          role('log', { name: 'Messages' }),
          selector('[data-line="said"]'),
        ),
      ).toContainText('You'),
      expectScene(role('textbox', { name: 'Message' })).toHaveAttr(
        'placeholder',
        'Ask the agents or give an instruction…',
      ),
    )
  })

  test('sending a message: the composer sends to the run talk, and empties once it is sent', () => {
    scene(
      { update, view },
      givenScene(scopedToAuth),
      expectScene(role('button', { name: 'Send' })).toBeDisabled(),
      typeInto(
        role('textbox', { name: 'Message' }),
        'Drain the run after fa-12',
      ),
      submit(role('form', { name: 'Composer' })),
      expectScene(role('button', { name: 'Send' })).toBeDisabled(),
      SceneCommand.resolve(
        TalkPanel.SendToTalk({
          talk: runTalk,
          text: 'Drain the run after fa-12',
        }),
        TalkPanel.Message.SucceededSend(),
      ),
      expectScene(role('textbox', { name: 'Message' })).toHaveValue(''),
    )
  })

  test('a send the engine refuses keeps the text and says why', () => {
    story(
      update,
      given(scopedToAuth),
      message(
        panelMessage(TalkPanel.Message.TypedDraft({ text: 'Stop the run' })),
      ),
      message(panelMessage(TalkPanel.Message.SubmittedDraft())),
      Command.resolve(
        TalkPanel.SendToTalk({ talk: runTalk, text: 'Stop the run' }),
        TalkPanel.Message.FailedSend({ reason: 'TalkNotFound' }),
      ),
      model(shown => {
        expect(shown.console.talkPanel.composer).toEqual({
          draft: 'Stop the run',
          sending: Conversation.Sending.cases.failed.make({
            reason: 'TalkNotFound',
          }),
        })
      }),
    )
  })

  test("the talks' transcripts are watched while connected, each once", () => {
    const { transcripts } = makeSubscriptions({
      nextFrame: Effect.void,
      keys: Stream.empty,
      ticks: Stream.empty,
      replacedEnginePorts: Stream.empty,
    })
    expect(transcripts.modelToDependencies(connected).talks).toEqual([])
    expect(transcripts.modelToDependencies(scopedToAuth).talks).toEqual([
      { engine: localEngineName, talk: runTalk },
    ])
    expect(
      transcripts.modelToDependencies({
        ...scopedToAuth,
        connection: Connection.Connecting(),
      }).talks,
    ).toEqual([])
  })
})

describe('the answer talk', () => {
  test('takes the panel by itself when a question arrives, without taking focus, and gives it back once it is answered', () => {
    story(
      update,
      given(scopedToAuth),
      message(attention(question(auth, 'fa-q1'))),
      Command.resolve(
        TalkPanel.LoadQuestionsSetting({ project: auth }),
        TalkPanel.Message.LoadedQuestionsSetting({
          project: auth,
          mode: 'auto',
        }),
      ),
      Command.resolve(
        TalkPanel.OpenAnswerTalk({ project: auth }),
        TalkPanel.Message.OpenedAnswerTalk({
          project: auth,
          opened: opened(answerTalk),
        }),
      ),
      model(shown => {
        expect(shownTalk(shown)).toEqual(Option.some(answerTalk))
        // Without taking focus: the console stays where it was.
        expect(shown.screen).toEqual(Screen.Console())
      }),
      // A second question queues into the same talk: nothing more is opened.
      message(attention(question(auth, 'fa-q1'), question(auth, 'fa-q2'))),
      Command.expectNone(),
      model(shown => {
        expect(shownTalk(shown)).toEqual(Option.some(answerTalk))
      }),
      // Both answered: the answer talk is closed and the run talk comes back.
      message(attention()),
      Command.resolve(
        TalkPanel.CloseTalk({ talk: answerTalk }),
        TalkPanel.Message.CompletedCloseTalk(),
      ),
      model(shown => {
        expect(shownTalk(shown)).toEqual(Option.some(runTalk))
      }),
    )
  })

  test('the composer sends to the answer talk while it has the panel', () => {
    story(
      update,
      given(scopedToAuth),
      message(attention(question(auth, 'fa-q1'))),
      Command.resolve(
        TalkPanel.LoadQuestionsSetting({ project: auth }),
        TalkPanel.Message.LoadedQuestionsSetting({
          project: auth,
          mode: 'auto',
        }),
      ),
      Command.resolve(
        TalkPanel.OpenAnswerTalk({ project: auth }),
        TalkPanel.Message.OpenedAnswerTalk({
          project: auth,
          opened: opened(answerTalk),
        }),
      ),
      message(panelMessage(TalkPanel.Message.TypedDraft({ text: 'Postgres' }))),
      message(panelMessage(TalkPanel.Message.SubmittedDraft())),
      Command.resolve(
        TalkPanel.SendToTalk({ talk: answerTalk, text: 'Postgres' }),
        TalkPanel.Message.SucceededSend(),
      ),
    )
  })

  test('with `questions: key` it waits for the maintainer’s key', () => {
    story(
      update,
      given(scopedToAuth),
      message(attention(question(auth, 'fa-q1'))),
      Command.resolve(
        TalkPanel.LoadQuestionsSetting({ project: auth }),
        TalkPanel.Message.LoadedQuestionsSetting({
          project: auth,
          mode: 'key',
        }),
      ),
      Command.expectNone(),
      model(shown => {
        expect(shownTalk(shown)).toEqual(Option.some(runTalk))
      }),
      message(
        Message.PressedKey({
          key: 'a',
          mod: false,
          alt: false,
          inField: false,
        }),
      ),
      Command.resolve(
        TalkPanel.OpenAnswerTalk({ project: auth }),
        TalkPanel.Message.OpenedAnswerTalk({
          project: auth,
          opened: opened(answerTalk),
        }),
      ),
      model(shown => {
        expect(shownTalk(shown)).toEqual(Option.some(answerTalk))
      }),
    )
  })

  test('an answer talk the engine refuses is said, and not asked for again until the maintainer asks', () => {
    story(
      update,
      given(scopedToAuth),
      message(attention(question(auth, 'fa-q1'))),
      Command.resolve(
        TalkPanel.LoadQuestionsSetting({ project: auth }),
        TalkPanel.Message.LoadedQuestionsSetting({
          project: auth,
          mode: 'auto',
        }),
      ),
      Command.resolve(
        TalkPanel.OpenAnswerTalk({ project: auth }),
        TalkPanel.Message.FailedOpenAnswerTalk({
          project: auth,
          reason: 'NotImplemented',
        }),
      ),
      message(attention(question(auth, 'fa-q1'), question(auth, 'fa-q2'))),
      Command.expectNone(),
      model(shown => {
        expect(shownTalk(shown)).toEqual(Option.some(runTalk))
        expect(shown.console.talkPanel.answer).toEqual(
          TalkPanel.Answer.Failed({ project: auth, reason: 'NotImplemented' }),
        )
      }),
    )
  })

  test('Talk it through opens the answer talk on the Talks screen', () => {
    story(
      update,
      given(scopedToAuth),
      message(
        Message.GotAttentionMessage({
          message: Attention.Message.ClickedTalkItThrough({
            project: auth,
            ticket: question(auth, 'fa-q1').ticket,
          }),
        }),
      ),
      Command.resolve(
        TalkPanel.OpenAnswerTalk({ project: auth }),
        TalkPanel.Message.OpenedAnswerTalk({
          project: auth,
          opened: opened(answerTalk),
        }),
      ),
      model(shown => {
        expect(shown.screen).toEqual(Screen.Talks())
        expect(
          Option.map(
            Talks.shownTalk(shown.screens.talks, {
              run: TalkPanel.runTalk(shown.console.talkPanel),
              answer: TalkPanel.answerTalk(shown.console.talkPanel),
            }),
            talk => talk.talk,
          ),
        ).toEqual(Option.some(answerTalk))
      }),
    )
  })

  test('with `questions: key`, the panel offers the answer talk, its questions counted', () => {
    scene(
      { update, view },
      givenScene(
        received(
          scopedToAuth,
          attention(question(auth, 'fa-q1')),
          panelMessage(
            TalkPanel.Message.LoadedQuestionsSetting({
              project: auth,
              mode: 'key',
            }),
          ),
        ),
      ),
      expectScene(role('button', { name: 'Answer talk · 1' })).toExist(),
    )
  })
})

describe('under All projects', () => {
  test('a message naming a project goes to that project’s run talk, opened first', () => {
    story(
      update,
      given(connected),
      message(
        panelMessage(
          TalkPanel.Message.TypedDraft({ text: 'Pause billing until Monday' }),
        ),
      ),
      message(panelMessage(TalkPanel.Message.SubmittedDraft())),
      Command.resolve(
        TalkPanel.OpenRunTalk({ project: billing }),
        TalkPanel.Message.OpenedRunTalk({
          project: billing,
          opened: opened(billingTalk),
        }),
      ),
      Command.resolve(
        TalkPanel.SendToTalk({
          talk: billingTalk,
          text: 'Pause billing until Monday',
        }),
        TalkPanel.Message.SucceededSend(),
      ),
      model(shown => {
        expect(shownTalk(shown)).toEqual(Option.some(billingTalk))
        expect(shown.scope).toEqual(Option.none())
      }),
    )
  })

  test('a message naming no project, or more than one, asks which', () => {
    scene(
      { update, view },
      givenScene(connected),
      typeInto(role('textbox', { name: 'Message' }), 'Start a run'),
      submit(role('form', { name: 'Composer' })),
      expectScene(role('group', { name: 'Which project?' })).toExist(),
      click(
        within(
          role('group', { name: 'Which project?' }),
          role('button', { name: 'Auth refresh' }),
        ),
      ),
      SceneCommand.resolve(
        TalkPanel.OpenRunTalk({ project: auth }),
        TalkPanel.Message.OpenedRunTalk({
          project: auth,
          opened: opened(runTalk),
        }),
      ),
      SceneCommand.resolve(
        TalkPanel.SendToTalk({ talk: runTalk, text: 'Start a run' }),
        TalkPanel.Message.SucceededSend(),
      ),
      expectScene(role('group', { name: 'Which project?' })).toBeAbsent(),
    )
    expect(
      TalkPanel.namedProjects('Move auth refresh and Billing along', [
        { project: auth, name: 'Auth refresh' },
        { project: billing, name: 'Billing' },
      ]),
    ).toEqual([auth, billing])
    expect(TalkPanel.names('rebilling', 'Billing')).toBe(false)
  })
})

describe('the Talks screen', () => {
  test('starts a refine talk on the scoped project and shows it full height', () => {
    story(
      update,
      given(scopedToAuth),
      message(Message.RequestedScreen({ screen: Screen.Talks() })),
      message(talksMessage(Talks.Message.ClickedStart({ mode: 'refine' }))),
      message(talksMessage(Talks.Message.TypedStart({ text: 'docs/spec.md' }))),
      message(talksMessage(Talks.Message.SubmittedStart({ project: auth }))),
      Command.resolve(
        Talks.OpenTalk({
          project: auth,
          mode: 'refine',
          context: TalkContext.cases.refine.make({ spec: 'docs/spec.md' }),
        }),
        Talks.Message.OpenedTalk({
          project: auth,
          mode: 'refine',
          opened: opened(TalkId.make('t-refine-1')),
        }),
      ),
      model(shown => {
        expect(Talks.heldTalks(shown.screens.talks)).toEqual([
          { project: auth, talk: TalkId.make('t-refine-1') },
        ])
      }),
    )
    scene(
      { update, view },
      givenScene(
        received(
          scopedToAuth,
          Message.RequestedScreen({ screen: Screen.Talks() }),
          talksMessage(
            Talks.Message.OpenedTalk({
              project: auth,
              mode: 'feature',
              opened: opened(TalkId.make('t-feature-1')),
            }),
          ),
        ),
      ),
      expectScene(selector('[data-layout="talks"]')).toExist(),
      expectScene(
        within(role('region', { name: 'Talk' }), role('heading', { level: 2 })),
      ).toHaveText('Fabrica'),
      expectScene(
        within(
          role('navigation', { name: 'Talks' }),
          role('button', { name: /Feature/ }),
        ),
      ).toHaveAttr('aria-current', 'true'),
      expectScene(
        within(
          role('navigation', { name: 'Talks' }),
          role('button', { name: /Run talk/ }),
        ),
      ).toExist(),
    )
  })

  test('a feature talk may start with nothing typed; a refine talk needs its spec', () => {
    expect(Talks.startContext('refine', '  ')).toEqual(Option.none())
    expect(Talks.startContext('feature', '')).toEqual(
      Option.some(TalkContext.cases.feature.make({ text: Option.none() })),
    )
  })
})
