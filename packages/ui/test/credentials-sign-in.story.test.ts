import { Option, Redacted } from 'effect'
import {
  Command as SceneCommand,
  click,
  expect as expectScene,
  given as givenScene,
  label,
  role,
  scene,
  text,
  type,
} from 'foldkit/scene'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import { LoginStep } from '@fabrica/contracts'

import { localEngineName } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Flags, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Credentials from '../src/screens/credentials'
import * as Engines from '../src/screens/engines'

// The Engines screen's sign-ins (spec §18.4, §20.3): a button for each provider beside each engine's
// credentials; what the engine says shown as it comes, the terms' words first; what it asks answered, the
// answer redacted in the Model; signed in, the engine's credentials listed again.

const attempt = 1

const going = (): Credentials.Model =>
  Credentials.update(
    Credentials.init(),
    Credentials.Message.ClickedSignIn({
      engine: localEngineName,
      provider: 'anthropic',
    }),
  ).model

const step = (loginStep: LoginStep) =>
  Credentials.Message.ReceivedLoginStep({ attempt, step: loginStep })

const asked = LoginStep.cases.asked.make({
  login: 'login-1',
  message: 'The code:',
  placeholder: Option.none(),
  secret: true,
  choices: [],
})

const goingOf = (shown: Credentials.Model): Credentials.Going =>
  Credentials.Flow.match(shown.flow, {
    Closed: () => expect.unreachable('no sign-in goes'),
    Failed: () => expect.unreachable('the sign-in failed'),
    Done: () => expect.unreachable('the sign-in is done'),
    Going: ({ going }) => going,
  })

describe('a sign-in', () => {
  test('keeps what the engine says, and keeps a stream only while it goes', () => {
    story(
      Credentials.update,
      given(Credentials.init()),
      message(
        Credentials.Message.ClickedSignIn({
          engine: localEngineName,
          provider: 'anthropic',
        }),
      ),
      model(shown => {
        expect(Credentials.runOf(shown)).toStrictEqual(
          Option.some({
            engine: localEngineName,
            provider: 'anthropic',
            attempt,
          }),
        )
      }),
      message(step(LoginStep.cases.terms.make({ text: 'Yours to check.' }))),
      message(
        step(
          LoginStep.cases.open_url.make({
            url: 'https://claude.test/oauth',
            instructions: Option.some('Paste the code.'),
          }),
        ),
      ),
      model(shown => {
        const { terms, page } = goingOf(shown)
        expect(terms).toStrictEqual(Option.some('Yours to check.'))
        expect(page).toStrictEqual(
          Option.some({
            url: 'https://claude.test/oauth',
            instructions: Option.some('Paste the code.'),
          }),
        )
      }),
      // A sign-in left says nothing more, whatever was still on its way.
      message(Credentials.Message.ClickedLeaveSignIn()),
      model(shown => {
        expect(Credentials.runOf(shown)).toStrictEqual(Option.none())
      }),
      message(step(LoginStep.cases.waiting.make({ text: 'Late.' }))),
      model(shown => {
        expect(Credentials.Flow.guards.Closed(shown.flow)).toBe(true)
      }),
    )
  })

  test('sends the answer, redacted, and takes the question off the form', () => {
    story(
      Credentials.update,
      given(going()),
      message(step(asked)),
      message(
        Credentials.Message.ChangedLoginAnswer({
          answer: Redacted.make('the-code'),
        }),
      ),
      model(shown => {
        expect(JSON.stringify(shown)).not.toContain('the-code')
      }),
      message(Credentials.Message.SubmittedLoginAnswer()),
      Command.expectExact(
        Credentials.AnswerLogin({
          engine: localEngineName,
          login: 'login-1',
          answer: Redacted.make('the-code'),
        }),
      ),
      Command.resolve(
        Credentials.AnswerLogin,
        Credentials.Message.SentLoginAnswer({ login: 'login-1' }),
      ),
      model(shown => {
        expect(goingOf(shown).asked).toStrictEqual(Option.none())
      }),
    )
  })

  test('says why it failed', () => {
    story(
      Credentials.update,
      given(going()),
      message(
        Credentials.Message.FailedLogin({
          attempt,
          reason: 'the code expired',
        }),
      ),
      model(shown => {
        expect(shown.flow).toStrictEqual(
          Credentials.Flow.Failed({
            engine: localEngineName,
            provider: 'anthropic',
            reason: 'the code expired',
          }),
        )
        expect(Credentials.runOf(shown)).toStrictEqual(Option.none())
      }),
    )
  })

  test('ignores what an earlier sign-in still says', () => {
    const second = Credentials.update(
      Credentials.update(going(), Credentials.Message.ClickedLeaveSignIn())
        .model,
      Credentials.Message.ClickedSignIn({
        engine: localEngineName,
        provider: 'openai',
      }),
    ).model
    const after = Credentials.update(
      second,
      Credentials.Message.FailedLogin({ attempt, reason: 'too late' }),
    ).model
    expect(goingOf(after).provider).toBe('openai')
  })

  test('lists the engine’s credentials again once signed in', () => {
    const shown = Engines.update(
      { ...Engines.init(), signIn: going() },
      Engines.Message.GotSignInMessage({
        message: step(
          LoginStep.cases.signed_in.make({
            account: Option.some('anthropic'),
          }),
        ),
      }),
    )
    expect(Credentials.Flow.guards.Done(shown.model.signIn.flow)).toBe(true)
    expect(shown.commands?.map(command => command.name)).toStrictEqual([
      'LoadCredentials',
    ])
  })
})

describe('the Engines screen', () => {
  const flags: Flags = { platform: 'darwin', release: '0.0.0' }

  test('offers each sign-in, says the terms, and shows what to open and answer', () => {
    const start = initialModel(flags)
    scene(
      { update, view },
      givenScene({ ...start, screen: Screen.Engines() }),
      expectScene(
        role('button', { name: `Sign in with ChatGPT on ${localEngineName}` }),
      ).toExist(),
      expectScene(
        role('button', {
          name: `Sign in with GitHub Copilot on ${localEngineName}`,
        }),
      ).toExist(),
      click(
        role('button', {
          name: `Sign in with Claude Pro or Max on ${localEngineName}`,
        }),
      ),
      expectScene(
        role('group', { name: 'Signing in to Claude Pro or Max' }),
      ).toExist(),
    )
    const answering = [
      LoginStep.cases.terms.make({ text: 'The terms are yours to check.' }),
      LoginStep.cases.open_url.make({
        url: 'https://claude.test/oauth',
        instructions: Option.none(),
      }),
      LoginStep.cases.device_code.make({
        url: 'https://device.test',
        code: 'ABCD-1234',
      }),
      asked,
    ].reduce(
      (shown, loginStep) =>
        update(
          shown,
          Message.GotEnginesMessage({
            message: Engines.Message.GotSignInMessage({
              message: step(loginStep),
            }),
          }),
        ).model,
      update(
        { ...start, screen: Screen.Engines() },
        Message.GotEnginesMessage({
          message: Engines.Message.GotSignInMessage({
            message: Credentials.Message.ClickedSignIn({
              engine: localEngineName,
              provider: 'anthropic',
            }),
          }),
        }),
      ).model,
    )
    scene(
      { update, view },
      givenScene(answering),
      expectScene(text('The terms are yours to check.')).toExist(),
      expectScene(role('link', { name: 'Open the sign-in page' })).toHaveAttr(
        'href',
        'https://claude.test/oauth',
      ),
      expectScene(text('ABCD-1234')).toExist(),
      type(label('The code:'), 'the-code'),
      click(role('button', { name: 'Send' })),
      SceneCommand.expectExact(
        Credentials.AnswerLogin({
          engine: localEngineName,
          login: 'login-1',
          answer: Redacted.make('the-code'),
        }),
      ),
      SceneCommand.resolve(
        Credentials.AnswerLogin,
        Credentials.Message.SentLoginAnswer({ login: 'login-1' }),
      ),
    )
  })
})
