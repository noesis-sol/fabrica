import { Effect, Option, Schema, Stream } from 'effect'
import {
  Command as SceneCommand,
  Subscription,
  expect as expectScene,
  given as givenScene,
  role,
  scene,
  selector,
  submit,
  type as typeInto,
} from 'foldkit/scene'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, it, test } from '@effect/vitest'
import {
  AttentionRequest,
  EngineId,
  OpenAnswerTalkTool,
  OpenedTalk,
  ProjectId,
  SessionId,
  StreamEpoch,
  TalkId,
  TranscriptItem,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { EngineSessions, makeEngineSessions } from '../src/app/engine-route'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { makeSubscriptions } from '../src/app/subscriptions'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as TalkPanel from '../src/console/talk-panel'

// The answer talk the run talk opened (spec §15.3, §15.4, §18.3): the panel takes up the talk the call's
// answer names, watching its transcript and sending to it, and opens none of its own, as a second would
// start a second agent. A snapshot reads the run talk's past again, which takes up nothing.

const auth = ProjectId.make('p-1')
const authHere: EngineProject = { engine: localEngineName, project: auth }
const runTalk = TalkId.make('t-run-1')
const namedTalk = TalkId.make('t-answer-named')
const panelsOwnTalk = TalkId.make('t-answer-own')
const talkModel = 'anthropic/claude-sonnet-5-5'

/** Thursday 29 October 2026, 12:00 UTC. */
const at = Date.UTC(2026, 9, 29, 12, 0, 0)

const opened = (talk: TalkId): OpenedTalk =>
  new OpenedTalk({
    talk,
    session: SessionId.make(`s-${talk}`),
    model: 'claude-opus-5-5',
  })

const panelMessage = (message: TalkPanel.Message): Message =>
  Message.GotTalkPanelMessage({ message })

const received = (shown: Model, ...messages: ReadonlyArray<Message>): Model =>
  messages.reduce((before, next) => update(before, next).model, shown)

/** The auth project in scope, its run talk open and its transcript begun. */
const scoped: Model = received(
  {
    ...initialModel({ platform: 'darwin', release: '0.0.0' }),
    connection: Connection.Up({
      engine: EngineId.make('e-1'),
      release: '0.1.0',
      protocol: protocolVersion,
    }),
  },
  Message.SelectedScope({ project: Option.some(authHere) }),
  panelMessage(
    TalkPanel.Message.OpenedRunTalk({
      project: authHere,
      opened: opened(runTalk),
    }),
  ),
)

const decodeItem = Schema.decodeUnknownSync(Schema.toCodecJson(TranscriptItem))

const itemOf = (
  tag: 'snapshot' | 'patch',
  seq: number,
  value: ReadonlyArray<unknown>,
): TranscriptItem => decodeItem({ _tag: tag, epoch: 'epoch-t', seq, value })

const call = (id: string, tool: string): unknown => ({
  _tag: 'tool_call',
  id,
  tool,
  input: null,
  at,
})

const output = (id: string, chunk: string): unknown => ({
  _tag: 'tool_output',
  id,
  chunk,
})

const end = (id: string, ok: boolean): unknown => ({
  _tag: 'tool_end',
  id,
  ok,
  at,
})

/** The tool's answer, as the Pi extension gives it to the transcript. */
const answerNaming = (talk: TalkId): string =>
  JSON.stringify(
    {
      text: `Run talk opened the answer talk ${talk}`,
      talk,
      model: talkModel,
    },
    null,
    2,
  )

const transcriptOf = (
  talk: TalkId,
  ...items: ReadonlyArray<TranscriptItem>
): Message =>
  Message.ReceivedTranscript({
    talk,
    items: [
      Option.getOrThrow(Option.fromUndefinedOr(items[0])),
      ...items.slice(1),
    ],
  })

/** The run talk's call of `open_answer_talk`, begun, then answered naming `talk`. */
const called = (seq: number, talk: TalkId, id = 'call-1'): TranscriptItem =>
  itemOf('patch', seq, [
    call(id, OpenAnswerTalkTool.name),
    output(id, answerNaming(talk)),
    end(id, true),
  ])

const waited = TalkPanel.WaitToDraw({ talk: runTalk })
const waitEnded = TalkPanel.Message.CompletedWaitToDraw({ talk: runTalk })
const kept = (talk: TalkId) =>
  TalkPanel.KeepAnswerTalk({ project: authHere, talk })

const shownTalk = (shown: Model) =>
  Option.map(TalkPanel.shownTalk(shown.console.talkPanel), talk => talk.talk)

const { transcripts } = makeSubscriptions({
  nextFrame: Effect.void,
  keys: Stream.empty,
  ticks: Stream.empty,
  replacedEnginePorts: Stream.empty,
})

/** A question open on the auth project. */
const question = Schema.decodeUnknownSync(Schema.toCodecJson(AttentionRequest))(
  {
    _tag: 'question',
    drafted: false,
    project: auth,
    ticket: 'fa-q1',
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
  },
)

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

describe('the answer talk the run talk opened', () => {
  test('takes the panel with no second agent: its transcript watched, its composer sending to it', () => {
    scene(
      { update, view },
      givenScene(scoped),
      Subscription.emit(transcriptOf(runTalk, called(1, namedTalk))),
      // Only what keeps it the engine's: no `OpenAnswerTalk` is left to run, as the scene fails on one.
      SceneCommand.resolveAll(
        [kept(namedTalk), TalkPanel.Message.CompletedKeepAnswerTalk()],
        [waited, waitEnded],
      ),
      expectScene(selector('[data-talk-model]')).toHaveText(talkModel),
      expectScene(role('textbox', { name: 'Message' })).toHaveAttr(
        'placeholder',
        'Answer, or ask about the questions…',
      ),
      Subscription.emit(
        transcriptOf(
          namedTalk,
          itemOf('snapshot', 0, [
            {
              _tag: 'message',
              id: 'm-1',
              role: 'assistant',
              text: 'First: which store keeps the sessions?',
              at,
            },
          ]),
        ),
      ),
      SceneCommand.resolve(
        TalkPanel.WaitToDraw({ talk: namedTalk }),
        TalkPanel.Message.CompletedWaitToDraw({ talk: namedTalk }),
      ),
      expectScene(role('log', { name: 'Messages' })).toContainText(
        'First: which store keeps the sessions?',
      ),
      typeInto(role('textbox', { name: 'Message' }), 'Postgres'),
      submit(role('form', { name: 'Composer' })),
      SceneCommand.resolve(
        TalkPanel.SendToTalk({ talk: namedTalk, text: 'Postgres' }),
        TalkPanel.Message.SucceededSend(),
      ),
    )
  })

  test('its transcript is watched beside the run talk’s', () => {
    const shown = received(scoped, transcriptOf(runTalk, called(1, namedTalk)))
    expect(shownTalk(shown)).toEqual(Option.some(namedTalk))
    expect(transcripts.modelToDependencies(shown).talks).toEqual([
      { engine: localEngineName, talk: runTalk },
      { engine: localEngineName, talk: namedTalk },
    ])
  })

  test('a call and its answer in frames of their own: taken up on the answer', () => {
    story(
      update,
      given(scoped),
      message(
        transcriptOf(
          runTalk,
          itemOf('patch', 1, [call('call-1', OpenAnswerTalkTool.name)]),
        ),
      ),
      model(shown => {
        expect(shownTalk(shown)).toEqual(Option.some(runTalk))
      }),
      Command.resolve(waited, waitEnded),
      message(
        transcriptOf(
          runTalk,
          itemOf('patch', 2, [
            output('call-1', answerNaming(namedTalk)),
            end('call-1', true),
          ]),
        ),
      ),
      Command.resolveAll(
        [kept(namedTalk), TalkPanel.Message.CompletedKeepAnswerTalk()],
        [waited, waitEnded],
      ),
      model(shown => {
        expect(shownTalk(shown)).toEqual(Option.some(namedTalk))
      }),
    )
  })

  test('a frame held for its draw: taken up as it is drawn', () => {
    story(
      update,
      given(received(scoped, transcriptOf(runTalk, itemOf('snapshot', 0, [])))),
      message(transcriptOf(runTalk, called(1, namedTalk))),
      Command.expectNone(),
      model(shown => {
        expect(shownTalk(shown)).toEqual(Option.some(runTalk))
      }),
      message(panelMessage(waitEnded)),
      Command.resolveAll(
        [kept(namedTalk), TalkPanel.Message.CompletedKeepAnswerTalk()],
        [waited, waitEnded],
      ),
      model(shown => {
        expect(shownTalk(shown)).toEqual(Option.some(namedTalk))
      }),
    )
  })

  test('a snapshot reads the past again: it takes up nothing', () => {
    story(
      update,
      given(scoped),
      message(
        transcriptOf(
          runTalk,
          itemOf('snapshot', 0, [
            call('call-1', OpenAnswerTalkTool.name),
            output('call-1', answerNaming(namedTalk)),
            end('call-1', true),
          ]),
        ),
      ),
      Command.resolve(waited, waitEnded),
      model(shown => {
        expect(shownTalk(shown)).toEqual(Option.some(runTalk))
      }),
    )
  })

  test('a refused call, or another tool’s answer, takes up nothing', () => {
    story(
      update,
      given(scoped),
      message(
        transcriptOf(
          runTalk,
          itemOf('patch', 1, [
            call('call-1', OpenAnswerTalkTool.name),
            output('call-1', 'Refused: no model for the talk'),
            end('call-1', false),
            call('call-2', 'drain_run'),
            output('call-2', answerNaming(namedTalk)),
            end('call-2', true),
          ]),
        ),
      ),
      Command.resolve(waited, waitEnded),
      model(shown => {
        expect(shownTalk(shown)).toEqual(Option.some(runTalk))
      }),
    )
  })

  test('with `questions: key`, and a question arriving after: it stays, and nothing more is opened', () => {
    story(
      update,
      given(scoped),
      message(transcriptOf(runTalk, called(1, namedTalk))),
      Command.resolveAll(
        [kept(namedTalk), TalkPanel.Message.CompletedKeepAnswerTalk()],
        [waited, waitEnded],
      ),
      message(attention(question)),
      Command.expectNone(),
      model(shown => {
        expect(shownTalk(shown)).toEqual(Option.some(namedTalk))
      }),
    )
  })

  test('the talk the panel held is closed in its place, so one agent answers', () => {
    story(
      update,
      given(
        received(
          scoped,
          attention(question),
          panelMessage(
            TalkPanel.Message.LoadedQuestionsSetting({
              project: authHere,
              mode: 'auto',
            }),
          ),
          panelMessage(
            TalkPanel.Message.OpenedAnswerTalk({
              project: authHere,
              opened: opened(panelsOwnTalk),
            }),
          ),
        ),
      ),
      message(transcriptOf(runTalk, called(1, namedTalk))),
      Command.resolveAll(
        [
          TalkPanel.CloseTalk({ talk: panelsOwnTalk }),
          TalkPanel.Message.CompletedCloseTalk(),
        ],
        [kept(namedTalk), TalkPanel.Message.CompletedKeepAnswerTalk()],
        [waited, waitEnded],
      ),
      model(shown => {
        expect(shownTalk(shown)).toEqual(Option.some(namedTalk))
      }),
    )
  })

  test('the talk the panel was opening is closed as it arrives', () => {
    story(
      update,
      given(
        received(
          scoped,
          attention(question),
          panelMessage(
            TalkPanel.Message.LoadedQuestionsSetting({
              project: authHere,
              mode: 'auto',
            }),
          ),
        ),
      ),
      message(transcriptOf(runTalk, called(1, namedTalk))),
      Command.resolveAll(
        [kept(namedTalk), TalkPanel.Message.CompletedKeepAnswerTalk()],
        [waited, waitEnded],
      ),
      message(
        panelMessage(
          TalkPanel.Message.OpenedAnswerTalk({
            project: authHere,
            opened: opened(panelsOwnTalk),
          }),
        ),
      ),
      Command.resolve(
        TalkPanel.CloseTalk({ talk: panelsOwnTalk }),
        TalkPanel.Message.CompletedCloseTalk(),
      ),
      model(shown => {
        expect(shownTalk(shown)).toEqual(Option.some(namedTalk))
      }),
    )
  })

  it.effect(
    'it is kept as its project’s engine’s, for what is sent to it',
    () =>
      Effect.gen(function* () {
        const sessions = yield* makeEngineSessions
        const onBox: EngineProject = { engine: 'build-box', project: auth }
        expect(yield* sessions.talkEngine(namedTalk)).toBe(localEngineName)
        yield* TalkPanel.KeepAnswerTalk({
          project: onBox,
          talk: namedTalk,
        }).effect.pipe(Effect.provideService(EngineSessions, sessions))
        expect(yield* sessions.talkEngine(namedTalk)).toBe('build-box')
      }),
  )
})
