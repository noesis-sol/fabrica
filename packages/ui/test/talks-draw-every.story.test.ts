import { Effect, Fiber, Option, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, it, test } from '@effect/vitest'
import {
  EngineId,
  OpenedTalk,
  ProjectId,
  ProjectRunState,
  ProjectStatus,
  SessionId,
  StreamEpoch,
  TalkId,
  TranscriptItem,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import type * as Conversation from '../src/console/conversation'
import * as TalkPanel from '../src/console/talk-panel'
import * as Talks from '../src/screens/talks'

// A talk's streamed text is drawn at most every 33 ms (spec §18.5, H79), in the console's talk panel and
// on the Talks screen alike, as the Worker view's transcript is: a frame that arrives while no draw's
// wait runs is drawn at once; frames that arrive during the wait are drawn together at its end.

const engine = EngineId.make('e-1')
const auth = ProjectId.make('p-1')
const authHere: EngineProject = { engine: localEngineName, project: auth }
const runTalk = TalkId.make('t-run-1')
const refineTalk = TalkId.make('t-refine-1')

/** Thursday 29 October 2026, 12:00 UTC. */
const at = Date.UTC(2026, 9, 29, 12, 0, 0)

const received = (shown: Model, ...messages: ReadonlyArray<Message>): Model =>
  messages.reduce((before, next) => update(before, next).model, shown)

const opened = (talk: TalkId): OpenedTalk =>
  new OpenedTalk({
    talk,
    session: SessionId.make(`s-${talk}`),
    model: 'claude-opus-5-5',
  })

/** Connected, the auth project in scope, its run talk open. */
const scopedToAuth: Model = received(
  {
    ...initialModel({ platform: 'darwin', release: '0.0.0' }),
    connection: Connection.Up({
      engine,
      release: '0.1.0',
      protocol: protocolVersion,
    }),
  },
  Message.ReceivedProjects({
    engine,
    name: localEngineName,
    items: [
      {
        _tag: 'snapshot',
        epoch: StreamEpoch.make('epoch-1'),
        seq: 0,
        value: [
          new ProjectStatus({
            project: auth,
            name: 'Auth refresh',
            base: 'main',
            setUp: true,
            trusted: true,
            run: ProjectRunState.cases.idle.make({}),
            ready: 0,
          }),
        ],
      },
    ],
  }),
  Message.SelectedScope({ project: Option.some(authHere) }),
  Message.GotTalkPanelMessage({
    message: TalkPanel.Message.OpenedRunTalk({
      project: authHere,
      opened: opened(runTalk),
    }),
  }),
)

/** As `scopedToAuth`, with a refine talk of the Talks screen's own open too. */
const withRefineTalk: Model = received(
  scopedToAuth,
  Message.GotTalksMessage({
    message: Talks.Message.OpenedTalk({
      project: authHere,
      mode: 'refine',
      opened: opened(refineTalk),
    }),
  }),
)

const decodeItem = Schema.decodeUnknownSync(Schema.toCodecJson(TranscriptItem))

/** A talk's transcript so far: the agent's message, its text so far `text`. */
const snapshot = (text: string): TranscriptItem =>
  decodeItem({
    _tag: 'snapshot',
    epoch: 'epoch-t',
    seq: 0,
    value: [{ _tag: 'message', id: 'm-1', role: 'assistant', text, at }],
  })

/** The text streamed since the patch before `seq`. */
const delta = (seq: number, text: string): TranscriptItem =>
  decodeItem({
    _tag: 'patch',
    seq,
    value: [{ _tag: 'text', message: 'm-1', delta: text }],
  })

const frame = (talk: TalkId, item: TranscriptItem): Message =>
  Message.ReceivedTranscript({ talk, items: [item] })

const textOf = (conversation: Option.Option<Conversation.Conversation>) =>
  Option.getOrThrow(conversation).lines.map(
    line => line._tag === 'said' && line.text,
  )

/** A draw's wait for the run talk ended, and the refine talk's. */
const drawnPanel = Message.GotTalkPanelMessage({
  message: TalkPanel.Message.CompletedWaitToDraw({ talk: runTalk }),
})
const drawnScreen = Message.GotTalksMessage({
  message: Talks.Message.CompletedWaitToDraw({ talk: refineTalk }),
})

const runTalkOf = (shown: Model) => TalkPanel.runTalk(shown.console.talkPanel)

const refineTalkOf = (shown: Model) =>
  Option.fromNullishOr(
    shown.screens.talks.talks.find(talk => talk.talk === refineTalk),
  )

describe("a talk's streamed text", () => {
  const commandNames = (result: ReturnType<typeof update>) =>
    (result.commands ?? []).map(command => command.name)

  test('the talk panel draws it at once, then at most every 33 ms', () => {
    const first = update(scopedToAuth, frame(runTalk, snapshot('Pausing')))
    expect(textOf(runTalkOf(first.model))).toEqual(['Pausing'])
    expect(commandNames(first)).toEqual(['WaitToDraw'])
    // The frames that come during the draw's wait wait for its end.
    const during = received(
      first.model,
      frame(runTalk, delta(1, ' fa-398')),
      frame(runTalk, delta(2, ' now.')),
    )
    expect(textOf(runTalkOf(during))).toEqual(['Pausing'])
    expect(Option.getOrThrow(runTalkOf(during)).waiting).toHaveLength(2)
    story(
      update,
      given(during),
      message(drawnPanel),
      model(shown => {
        expect(textOf(runTalkOf(shown))).toEqual(['Pausing fa-398 now.'])
        expect(Option.getOrThrow(runTalkOf(shown)).waiting).toEqual([])
      }),
      // What was drawn starts the next wait; it ends with nothing come, and the next frame is drawn at once.
      Command.resolve(
        TalkPanel.WaitToDraw({ talk: runTalk }),
        TalkPanel.Message.CompletedWaitToDraw({ talk: runTalk }),
      ),
      Command.expectNone(),
      model(shown => {
        expect(Option.getOrThrow(runTalkOf(shown)).draw).toBe('Idle')
      }),
      message(frame(runTalk, delta(3, ' Done.'))),
      model(shown => {
        expect(textOf(runTalkOf(shown))).toEqual(['Pausing fa-398 now. Done.'])
      }),
      Command.resolve(
        TalkPanel.WaitToDraw({ talk: runTalk }),
        TalkPanel.Message.CompletedWaitToDraw({ talk: runTalk }),
      ),
    )
  })

  test('the Talks screen draws it at once, then at most every 33 ms', () => {
    const first = update(withRefineTalk, frame(refineTalk, snapshot('Reading')))
    expect(textOf(refineTalkOf(first.model))).toEqual(['Reading'])
    expect(commandNames(first)).toEqual(['WaitToDraw'])
    const during = received(
      first.model,
      frame(refineTalk, delta(1, ' the spec')),
    )
    expect(textOf(refineTalkOf(during))).toEqual(['Reading'])
    story(
      update,
      given(during),
      message(drawnScreen),
      model(shown => {
        expect(textOf(refineTalkOf(shown))).toEqual(['Reading the spec'])
      }),
      Command.resolve(
        Talks.WaitToDraw({ talk: refineTalk }),
        Talks.Message.CompletedWaitToDraw({ talk: refineTalk }),
      ),
      Command.expectNone(),
      model(shown => {
        expect(Option.getOrThrow(refineTalkOf(shown)).draw).toBe('Idle')
      }),
    )
  })

  test("a talk's wait holds back only that talk", () => {
    const panelWaits = received(
      withRefineTalk,
      frame(runTalk, snapshot('Pausing')),
    )
    const both = update(panelWaits, frame(refineTalk, snapshot('Reading')))
    expect(textOf(runTalkOf(both.model))).toEqual(['Pausing'])
    expect(textOf(refineTalkOf(both.model))).toEqual(['Reading'])
    expect(commandNames(both)).toEqual(['WaitToDraw'])
  })

  test("a wait's end for a talk no longer held changes nothing", () => {
    const closed = received(
      withRefineTalk,
      frame(refineTalk, snapshot('Reading')),
      frame(refineTalk, delta(1, ' the spec')),
      Message.GotTalksMessage({
        message: Talks.Message.ClickedClose({ talk: refineTalk }),
      }),
    )
    const waited = update(closed, drawnScreen)
    expect(waited.model).toEqual(closed)
    expect(waited.commands ?? []).toEqual([])
  })

  it.effect("the talk panel's draw waits 33 ms, on the injected clock", () =>
    Effect.gen(function* () {
      const waiting = yield* Effect.forkChild(
        TalkPanel.WaitToDraw({ talk: runTalk }).effect,
      )
      yield* TestClock.adjust('32 millis')
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust('1 millis')
      expect(yield* Fiber.join(waiting)).toEqual(
        TalkPanel.Message.CompletedWaitToDraw({ talk: runTalk }),
      )
    }),
  )

  it.effect("the Talks screen's draw waits 33 ms, on the injected clock", () =>
    Effect.gen(function* () {
      const waiting = yield* Effect.forkChild(
        Talks.WaitToDraw({ talk: refineTalk }).effect,
      )
      yield* TestClock.adjust('32 millis')
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust('1 millis')
      expect(yield* Fiber.join(waiting)).toEqual(
        Talks.Message.CompletedWaitToDraw({ talk: refineTalk }),
      )
    }),
  )
})
