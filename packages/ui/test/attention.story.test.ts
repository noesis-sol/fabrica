import { DateTime, Effect, Fiber, Option, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import {
  Command,
  all,
  click,
  expectAll,
  expect as expectScene,
  given,
  role,
  scene,
  selector,
  submit,
  type as typeInto,
  within,
} from 'foldkit/scene'
import {
  Command as StoryCommand,
  given as givenStory,
  message,
  model,
  story,
} from 'foldkit/story'

import { describe, expect, it, test } from '@effect/vitest'
import {
  AttentionAnswer,
  AttentionRequest,
  EngineId,
  PermissionDecision,
  PermissionId,
  ProjectId,
  QuestionAnswer,
  StreamEpoch,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import type { AttentionItem } from '../src/app/streams'
import { modelCommands, update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Attention from '../src/console/attention'
import * as TalkPanel from '../src/console/talk-panel'
import * as Review from '../src/screens/review'

// The console's Needs your attention column (spec §15.1, §18.3, H62, H92; Appendix A.2), from fixture
// requests: each kind's card with its tag and waiting time, a permission request's input shown whole
// for its tool and its three answers, a question's options inline (the recommended one first and
// marked, chosen unless the question is consequential), and keys 1–9, which answer only the request
// whose options are drawn, only 500 ms after they were drawn, the guard starting again when that
// request changes, counted on the injected clock.

const project = ProjectId.make('p-1')

/** Thursday 29 October 2026, 12:00 UTC: 14:00 in Athens. */
const at = Date.UTC(2026, 9, 29, 12, 0, 0)
const now = DateTime.makeZonedUnsafe(at, { timeZone: 'Europe/Athens' })

const decodeRequest = Schema.decodeUnknownSync(
  Schema.toCodecJson(AttentionRequest),
)

const questionJson = {
  _tag: 'question',
  project,
  ticket: 'fa-q1',
  title: 'Which store keeps the sessions?',
  description: 'The worker needs a store for the refresh tokens.',
  choices: {
    options: [
      { label: 'Redis', tradeOff: 'Fast; another service to run' },
      { label: 'Postgres', tradeOff: 'Already running; slower' },
      { label: 'Memory', tradeOff: 'Nothing to run; lost on restart' },
    ],
    recommended: 1,
  },
  consequential: false,
  maintainerOnly: false,
  blocks: ['fa-7'],
  askedFrom: 'fa-7',
  openedAt: at - 14 * 60_000,
}

const question = decodeRequest(questionJson)

const consequential = decodeRequest({
  ...questionJson,
  ticket: 'fa-q2',
  title: 'Close the old auth epic?',
  consequential: true,
})

const longLine = `echo ${'x'.repeat(400)} && tail -n 1`
const commandLines = [
  ...Array.from({ length: 30 }, (_, line) => `step ${line + 1}`),
  longLine,
  'rm -rf build/  # the last line, where tutti cut it off',
]

const permission = decodeRequest({
  _tag: 'permission',
  project,
  id: 'perm-1',
  ticket: 'fa-7',
  session: 's-1',
  tool: 'bash',
  input: { command: commandLines.join('\n') },
  shown: { _tag: 'command', lines: commandLines },
  why: 'rm is not on the allow list',
  openedAt: at - 3 * 60_000,
})

const edit = decodeRequest({
  _tag: 'permission',
  project,
  id: 'perm-2',
  ticket: 'fa-8',
  session: 's-2',
  tool: 'edit',
  input: { path: 'src/auth/refresh.ts' },
  shown: {
    _tag: 'edit',
    path: 'src/auth/refresh.ts',
    diff: '--- a/src/auth/refresh.ts\n+++ b/src/auth/refresh.ts\n-const ttl = 60\n+const ttl = 3600\n export { ttl }',
  },
  why: 'the file is outside the ticket',
  openedAt: at - 60_000,
})

const write = decodeRequest({
  _tag: 'permission',
  project,
  id: 'perm-3',
  ticket: 'fa-9',
  session: 's-3',
  tool: 'write',
  input: { path: '.env' },
  shown: { _tag: 'write', path: '.env', content: 'TOKEN=\nREGION=eu' },
  why: 'the file is ignored by git',
  openedAt: at - 60_000,
})

const call = decodeRequest({
  _tag: 'permission',
  project,
  id: 'perm-4',
  ticket: 'fa-9',
  session: 's-3',
  tool: 'fetch',
  input: { url: 'https://example.com', method: 'GET' },
  shown: {
    _tag: 'call',
    input: { url: 'https://example.com', method: 'GET' },
  },
  why: 'network access asks',
  openedAt: at - 60_000,
})

const review = decodeRequest({
  _tag: 'review',
  project,
  ticket: 'fa-11',
  title: 'Refresh tokens rotate',
  reason: 'CHECKS_FAILED',
  openedAt: at - 3_600_000,
})

const task = decodeRequest({
  _tag: 'task',
  project,
  ticket: 'fa-12',
  title: 'Make an API key for the staging bucket',
  openedAt: at - 120_000,
})

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(project),
  now: Option.some(now),
}

const withRequests = (
  requests: ReadonlyArray<AttentionRequest>,
  base: Model = connected,
): Model => ({ ...base, attention: Option.some(requests) })

const epoch = StreamEpoch.make('epoch-1')

const snapshotOf = (
  requests: ReadonlyArray<AttentionRequest>,
): typeof AttentionItem.Type => ({
  _tag: 'snapshot',
  epoch,
  seq: 0,
  value: requests,
})

const received = (requests: ReadonlyArray<AttentionRequest>) =>
  Message.ReceivedAttention({
    engine: localEngineName,
    items: [snapshotOf(requests)],
  })

const attentionMessage = (child: Attention.Message) =>
  Message.GotAttentionMessage({ message: child })

const key = (pressed: string) =>
  Message.PressedKey({ key: pressed, mod: false, alt: false, inField: false })

const questionKey = 'question:p-1:fa-q1'

const card = (name: string) => role('listitem', { name })

const answerWith = (index: number): AttentionAnswer =>
  AttentionAnswer.cases.question.make({
    project,
    ticket: TicketId.make('fa-q1'),
    answer: QuestionAnswer.cases.option.make({ index }),
  })

/** `messages` through update one after another, as the runtime sends them, with the last one's Commands. */
const sent = (start: Model, ...messages: ReadonlyArray<Message>) =>
  messages.reduce<{
    readonly model: Model
    readonly commands: ReadonlyArray<{
      readonly name: string
      readonly args?: unknown
    }>
  }>(
    (step, next) => {
      const result = update(step.model, next)
      return { model: result.model, commands: result.commands ?? [] }
    },
    { model: start, commands: [] },
  )

const commandsOf = (step: ReturnType<typeof sent>) =>
  step.commands.map(command => [command.name, command.args])

describe('the key guard', () => {
  it.effect(
    'passes 500 ms after the options are drawn, on the injected clock',
    () =>
      Effect.gen(function* () {
        const waiting = yield* Effect.forkChild(
          Attention.WaitGuard({ drawing: 1 }).effect,
        )
        yield* TestClock.adjust('499 millis')
        expect(waiting.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust('1 millis')
        expect(yield* Fiber.join(waiting)).toEqual(
          Attention.Message.PassedGuard({ drawing: 1 }),
        )
      }),
  )

  test('a key before 500 ms answers nothing; after it, the option at its place', () => {
    const drawn = sent(
      withRequests([question]),
      attentionMessage(Attention.Message.ClickedAnswer({ request: question })),
    )
    expect(commandsOf(drawn)).toEqual([['WaitGuard', { drawing: 1 }]])
    const early = sent(drawn.model, key('1'))
    expect(commandsOf(early)).toEqual([])
    expect(early.model.console.attention.sending).toEqual(
      Attention.Sending.None(),
    )
    // Key 1 is the recommended option, drawn first: Postgres, index 1 of the question's.
    const passed = sent(
      drawn.model,
      attentionMessage(Attention.Message.PassedGuard({ drawing: 1 })),
      key('1'),
    )
    expect(commandsOf(passed)).toEqual([
      ['Answer', { key: questionKey, answer: answerWith(1) }],
    ])
    story(
      update,
      givenStory(passed.model),
      message(
        attentionMessage(
          Attention.Message.SucceededAnswer({ key: questionKey }),
        ),
      ),
      model(shown => {
        expect(shown.console.attention.open).toEqual(Attention.Open.None())
        expect(shown.console.attention.guard).toEqual(Attention.Guard.Off())
        expect(shown.console.attention.sending).toEqual(
          Attention.Sending.None(),
        )
      }),
    )
  })

  test('the keys are the screen commands 1–9 only while the options are drawn', () => {
    const drawn = (shown: Model) =>
      modelCommands(shown)
        .filter(command => command.id.startsWith('answer.'))
        .map(command => command.title)
    story(
      update,
      givenStory(withRequests([question])),
      model(shown => {
        expect(drawn(shown)).toEqual([])
      }),
      message(
        attentionMessage(
          Attention.Message.ClickedAnswer({ request: question }),
        ),
      ),
      model(shown => {
        expect(drawn(shown)).toEqual([
          'Answer: Postgres',
          'Answer: Redis',
          'Answer: Memory',
        ])
      }),
      StoryCommand.resolve(
        Attention.WaitGuard,
        Attention.Message.PassedGuard({ drawing: 1 }),
      ),
    )
  })

  test('a change to the request drawn starts the guard again, and the old guard passes nothing', () => {
    const changed = decodeRequest({
      ...questionJson,
      choices: { ...questionJson.choices, recommended: 0 },
    })
    const passed = sent(
      withRequests([question]),
      received([question]),
      attentionMessage(Attention.Message.ClickedAnswer({ request: question })),
      attentionMessage(Attention.Message.PassedGuard({ drawing: 1 })),
    )
    expect(
      Attention.Guard.guards.Passed(passed.model.console.attention.guard),
    ).toBe(true)
    const redrawn = sent(passed.model, received([changed]))
    expect(commandsOf(redrawn)).toEqual([['WaitGuard', { drawing: 2 }]])
    expect(commandsOf(sent(redrawn.model, key('1')))).toEqual([])
    // The first drawing's guard, come late, doesn't pass the second's.
    expect(
      commandsOf(
        sent(
          redrawn.model,
          attentionMessage(Attention.Message.PassedGuard({ drawing: 1 })),
          key('1'),
        ),
      ),
    ).toEqual([])
    // Now the recommended option is Redis, index 0, drawn first.
    expect(
      commandsOf(
        sent(
          redrawn.model,
          attentionMessage(Attention.Message.PassedGuard({ drawing: 2 })),
          key('1'),
        ),
      ),
    ).toEqual([['Answer', { key: questionKey, answer: answerWith(0) }]])
    // The choice is made again from the changed request: its recommended option now.
    expect(redrawn.model.console.attention.open).toEqual(
      Attention.Open.Answering({
        key: questionKey,
        chosen: Option.some(0),
        text: '',
      }),
    )
    // While the maintainer's own words are typed, nothing is chosen for them.
    const typing = sent(
      passed.model,
      attentionMessage(
        Attention.Message.TypedAnswer({ key: questionKey, text: 'SQLite' }),
      ),
      received([changed]),
    )
    expect(typing.model.console.attention.open).toEqual(
      Attention.Open.Answering({
        key: questionKey,
        chosen: Option.none(),
        text: 'SQLite',
      }),
    )
    // The same request again, unchanged, keeps the guard passed.
    const same = sent(passed.model, received([question]))
    expect(commandsOf(same)).toEqual([])
    expect(
      Attention.Guard.guards.Passed(same.model.console.attention.guard),
    ).toBe(true)
  })

  test('a request answered elsewhere closes its options, and its keys answer nothing', () => {
    story(
      update,
      givenStory(withRequests([question, review])),
      message(
        attentionMessage(
          Attention.Message.ClickedAnswer({ request: question }),
        ),
      ),
      StoryCommand.resolve(
        Attention.WaitGuard,
        Attention.Message.PassedGuard({ drawing: 1 }),
      ),
      message(received([review])),
      model(shown => {
        expect(shown.console.attention.open).toEqual(Attention.Open.None())
        expect(Attention.keyedOptions(shown.console.attention)).toEqual(
          Option.none(),
        )
      }),
      message(Message.PressedAnswerKey({ key: questionKey, place: 0 })),
      StoryCommand.expectNone(),
    )
  })

  test('a key naming another request than the one drawn answers nothing', () => {
    story(
      update,
      givenStory(withRequests([question, consequential])),
      message(
        attentionMessage(
          Attention.Message.ClickedAnswer({ request: question }),
        ),
      ),
      StoryCommand.resolve(
        Attention.WaitGuard,
        Attention.Message.PassedGuard({ drawing: 1 }),
      ),
      message(
        Message.PressedAnswerKey({ key: 'question:p-1:fa-q2', place: 0 }),
      ),
      StoryCommand.expectNone(),
    )
  })

  test('a scope changed closes the options drawn', () => {
    story(
      update,
      givenStory(withRequests([question])),
      message(
        attentionMessage(
          Attention.Message.ClickedAnswer({ request: question }),
        ),
      ),
      StoryCommand.resolve(
        Attention.WaitGuard,
        Attention.Message.PassedGuard({ drawing: 1 }),
      ),
      message(Message.SelectedScope({ project: Option.none() })),
      model(shown => {
        expect(shown.console.attention.guard).toEqual(Attention.Guard.Off())
      }),
      message(key('1')),
      StoryCommand.expectNone(),
    )
  })
})

describe('a question', () => {
  test('its own title, the ticket waiting on it, its description, and how long it has waited', () => {
    scene(
      { update, view },
      given(withRequests([question])),
      expectScene(
        within(card('Question fa-q1'), selector('[data-kind="question"]')),
      ).toHaveText('Question'),
      expectScene(
        within(card('Question fa-q1'), selector('[data-kind="question"]')),
      ).toHaveClass('bg-c5'),
      expectScene(
        within(card('Question fa-q1'), role('heading', { level: 3 })),
      ).toHaveText('Which store keeps the sessions?'),
      expectScene(
        within(card('Question fa-q1'), selector('[data-blocks]')),
      ).toHaveText('fa-7 waits on it'),
      expectScene(
        within(card('Question fa-q1'), selector('[data-description]')),
      ).toHaveClass('line-clamp-3'),
      expectScene(
        within(card('Question fa-q1'), selector('[data-waiting]')),
      ).toHaveText('waiting 14m 00s'),
      expectScene(
        within(card('Question fa-q1'), selector('[data-waiting]')),
      ).toHaveClass('text-c2'),
    )
  })

  test('Answer opens its options inline, the recommended one first, marked and chosen', () => {
    scene(
      { update, view },
      given(withRequests([question])),
      click(within(card('Question fa-q1'), role('button', { name: 'Answer' }))),
      Command.resolve(
        Attention.WaitGuard({ drawing: 1 }),
        Attention.Message.PassedGuard({ drawing: 1 }),
      ),
      expectAll(all.role('radio')).toHaveCount(3),
      expectScene(selector('[data-option]')).toHaveAttr('data-option', '1'),
      expectScene(selector('[data-option]')).toContainText('Postgres'),
      expectScene(selector('[data-option="1"] [data-recommended]')).toHaveText(
        'Recommended',
      ),
      expectScene(selector('[data-option="1"]')).toHaveAttr(
        'aria-checked',
        'true',
      ),
      expectScene(selector('[data-option="0"]')).toHaveAttr(
        'aria-checked',
        'false',
      ),
      expectScene(role('textbox', { name: 'Your own answer' })).toExist(),
      expectScene(role('button', { name: 'Talk it through' })).toExist(),
      click(role('radio', { name: /Memory/ })),
      submit(role('form', { name: 'Answer' })),
      Command.resolve(
        Attention.Answer({ key: questionKey, answer: answerWith(2) }),
        Attention.Message.SucceededAnswer({ key: questionKey }),
      ),
      expectScene(role('form', { name: 'Answer' })).toBeAbsent(),
    )
  })

  test('a consequential question has nothing chosen, and says so', () => {
    scene(
      { update, view },
      given(withRequests([consequential])),
      click(within(card('Question fa-q2'), role('button', { name: 'Answer' }))),
      Command.resolve(
        Attention.WaitGuard({ drawing: 1 }),
        Attention.Message.PassedGuard({ drawing: 1 }),
      ),
      expectScene(selector('[data-consequential]')).toExist(),
      expectAll(all.selector('[aria-checked="true"]')).toHaveCount(0),
      expectScene(selector('[data-option="1"] [data-recommended]')).toExist(),
      expectScene(role('button', { name: 'Send answer' })).toBeDisabled(),
    )
    expect(Attention.preselected(consequential)).toEqual(Option.none())
    expect(Attention.preselected(question)).toEqual(Option.some(1))
  })

  test('an answer in the maintainer’s own words', () => {
    scene(
      { update, view },
      given(withRequests([question])),
      click(role('button', { name: 'Answer' })),
      Command.resolve(
        Attention.WaitGuard({ drawing: 1 }),
        Attention.Message.PassedGuard({ drawing: 1 }),
      ),
      typeInto(role('textbox', { name: 'Your own answer' }), 'SQLite, for now'),
      expectAll(all.selector('[aria-checked="true"]')).toHaveCount(0),
      submit(role('form', { name: 'Answer' })),
      Command.resolve(
        Attention.Answer({
          key: questionKey,
          answer: AttentionAnswer.cases.question.make({
            project,
            ticket: TicketId.make('fa-q1'),
            answer: QuestionAnswer.cases.text.make({ text: 'SQLite, for now' }),
          }),
        }),
        Attention.Message.FailedAnswer({
          key: questionKey,
          reason: 'already answered by cli',
        }),
      ),
      expectScene(within(card('Question fa-q1'), role('alert'))).toContainText(
        'already answered by cli',
      ),
    )
  })

  test('Talk it through opens the answer talk; Open session the asking worker', () => {
    story(
      update,
      givenStory(withRequests([question])),
      message(
        attentionMessage(
          Attention.Message.ClickedTalkItThrough({
            project,
            ticket: TicketId.make('fa-q1'),
          }),
        ),
      ),
      // The answer talk is opened on the question's project, by the maintainer's action.
      StoryCommand.resolve(
        TalkPanel.OpenAnswerTalk({ project }),
        TalkPanel.Message.FailedOpenAnswerTalk({
          project,
          reason: 'NotImplemented',
        }),
      ),
      model(shown => {
        expect(shown.screen).toEqual(Screen.Talks())
      }),
    )
    expect(Attention.sessionTicket(question)).toEqual(
      Option.some(TicketId.make('fa-7')),
    )
  })
})

describe('an approval', () => {
  test('a long command is shown whole, every line and the end of the longest', () => {
    scene(
      { update, view },
      given(withRequests([permission])),
      expectScene(
        within(card('Approval fa-7'), selector('[data-kind="approval"]')),
      ).toHaveClass('bg-c2'),
      expectScene(
        within(card('Approval fa-7'), selector('[data-reason]')),
      ).toHaveText('rm is not on the allow list'),
      expectAll(all.selector('[data-shown="command"] [data-line]')).toHaveCount(
        commandLines.length,
      ),
      expectScene(selector('[data-shown="command"]')).toContainText(longLine),
      expectScene(selector('[data-shown="command"]')).toContainText(
        'rm -rf build/  # the last line, where tutti cut it off',
      ),
      expectScene(selector('[data-shown="command"]')).toHaveClass(
        'whitespace-pre-wrap',
      ),
      expectScene(selector('[data-shown="command"]')).not.toHaveClass(
        'truncate',
      ),
    )
  })

  test('an edit as its diff, a write as its path and content, any other call as its arguments', () => {
    scene(
      { update, view },
      given(withRequests([edit, write, call])),
      expectScene(
        within(selector('[data-shown="edit"]'), selector('[data-path]')),
      ).toHaveText('src/auth/refresh.ts'),
      expectScene(selector('[data-diff="removed"]')).toHaveText(
        '-const ttl = 60',
      ),
      expectScene(selector('[data-diff="added"]')).toHaveText(
        '+const ttl = 3600',
      ),
      expectScene(
        within(selector('[data-shown="write"]'), selector('[data-path]')),
      ).toHaveText('.env'),
      expectScene(
        within(
          selector('[data-shown="write"]'),
          selector('[aria-label="Content"]'),
        ),
      ).toContainText('REGION=eu'),
      expectScene(selector('[data-shown="call"]')).toContainText(
        '"url": "https://example.com"',
      ),
    )
  })

  test('Approve allows it once, carrying its ID', () => {
    scene(
      { update, view },
      given(withRequests([permission])),
      click(role('button', { name: 'Approve' })),
      expectScene(role('button', { name: 'Approve' })).toBeDisabled(),
      Command.resolve(
        Attention.Answer({
          key: 'permission:p-1:perm-1',
          answer: AttentionAnswer.cases.permission.make({
            project,
            id: PermissionId.make('perm-1'),
            decision: PermissionDecision.cases.allow_once.make({}),
          }),
        }),
        Attention.Message.SucceededAnswer({ key: 'permission:p-1:perm-1' }),
      ),
      expectScene(role('button', { name: 'Approve' })).toBeEnabled(),
    )
  })

  test('its menu allows it for this run, or refuses it with a note', () => {
    scene(
      { update, view },
      given(withRequests([permission])),
      click(role('button', { name: 'More answers' })),
      click(role('menuitem', { name: 'Allow for this run' })),
      Command.resolve(
        Attention.Answer({
          key: 'permission:p-1:perm-1',
          answer: AttentionAnswer.cases.permission.make({
            project,
            id: PermissionId.make('perm-1'),
            decision: PermissionDecision.cases.allow_run.make({}),
          }),
        }),
        Attention.Message.SucceededAnswer({ key: 'permission:p-1:perm-1' }),
      ),
    )
    scene(
      { update, view },
      given(withRequests([permission])),
      click(role('button', { name: 'More answers' })),
      click(role('menuitem', { name: 'Refuse…' })),
      typeInto(role('textbox', { name: 'Note' }), 'Delete build/ by hand'),
      submit(role('form', { name: 'Refuse' })),
      Command.resolve(
        Attention.Answer({
          key: 'permission:p-1:perm-1',
          answer: AttentionAnswer.cases.permission.make({
            project,
            id: PermissionId.make('perm-1'),
            decision: PermissionDecision.cases.refuse.make({
              note: Option.some('Delete build/ by hand'),
            }),
          }),
        }),
        Attention.Message.SucceededAnswer({ key: 'permission:p-1:perm-1' }),
      ),
      expectScene(role('form', { name: 'Refuse' })).toBeAbsent(),
    )
  })

  test('Open session opens the worker view of its ticket', () => {
    scene(
      { update, view },
      given(withRequests([permission])),
      click(role('button', { name: 'Open session' })),
      expectScene(role('heading', { name: 'Worker fa-7' })).toExist(),
    )
  })
})

describe('reviews and tasks', () => {
  test('a set-aside ticket for review, with why, opening the Review screen', () => {
    scene(
      { update, view },
      given(withRequests([review])),
      expectScene(
        within(card('Review fa-11'), selector('[data-kind="review"]')),
      ).toHaveClass('bg-c4'),
      expectScene(
        within(card('Review fa-11'), selector('[data-reason]')),
      ).toHaveText('Its merge check failed'),
      click(within(card('Review fa-11'), role('button', { name: 'Review' }))),
      expectScene(role('heading', { name: 'Review' })).toExist(),
      // It opens on the ticket's branch diff, beside its project's report and log (review.story.test.ts).
      Command.expectExact(
        Review.LoadDiff({
          subject: Review.Subject.Ticket({
            project,
            ticket: TicketId.make('fa-11'),
          }),
        }),
        Review.LoadReport({ project }),
        Review.LoadLog({ project }),
      ),
      Command.resolveAll(
        [
          Review.LoadDiff,
          Review.Message.FailedLoadDiff({
            subject: Review.Subject.Ticket({
              project,
              ticket: TicketId.make('fa-11'),
            }),
            reason: 'the engine is not connected',
          }),
        ],
        [
          Review.LoadReport,
          Review.Message.FailedLoadReport({
            project,
            reason: 'the engine is not connected',
          }),
        ],
        [
          Review.LoadLog,
          Review.Message.FailedLoadLog({
            project,
            reason: 'the engine is not connected',
          }),
        ],
      ),
    )
  })

  test('a maintainer task, done when the maintainer closes it', () => {
    scene(
      { update, view },
      given(withRequests([task])),
      expectScene(
        within(card('Your task fa-12'), selector('[data-kind="task"]')),
      ).toHaveText('Your task'),
      expectScene(
        within(card('Your task fa-12'), selector('[data-kind="task"]')),
      ).toHaveClass('bg-c2'),
      expectScene(
        within(
          card('Your task fa-12'),
          role('button', { name: 'Open session' }),
        ),
      ).toBeAbsent(),
      click(role('button', { name: 'Done' })),
      Command.resolve(
        Attention.CloseTask({
          key: 'task:p-1:fa-12',
          project,
          ticket: TicketId.make('fa-12'),
        }),
        Attention.Message.SucceededAnswer({ key: 'task:p-1:fa-12' }),
      ),
    )
  })

  test('the column counts what waits', () => {
    scene(
      { update, view },
      given(withRequests([question, permission, review, task])),
      expectScene(
        within(
          role('region', { name: 'Needs your attention' }),
          selector('[data-count]'),
        ),
      ).toHaveText('4'),
      expectAll(all.selector('[data-card]')).toHaveCount(4),
    )
  })
})
