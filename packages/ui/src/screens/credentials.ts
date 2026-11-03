import { Data, Effect, Option, Redacted, Schema, Stream } from 'effect'
import { Command, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { defineView } from 'foldkit/submodel'

import type { EngineClientShape } from '@fabrica/client'
import {
  LoginChoice,
  LoginId,
  LoginStep,
  ProviderName,
  SignInProviders,
  Text,
} from '@fabrica/contracts'

import { failureText } from '../app/connection'
import { type EngineServices, requestEngine } from '../app/engine-route'

// The Engines screen's sign-ins (spec §18.4, §20.3): beside each engine's credentials, a button for each
// provider with a sign-in. The engine runs it, which may be another host's, and says what to show: that
// a provider's terms are the user's to check, a page to open here, a code to enter; what it asks is
// answered here and sent back, redacted in the Model as a key is. One sign-in at a time: leaving it, or a
// new one, ends the stream, and the engine ends the sign-in with it.

/** What the sign-in asks, waiting on an answer. */
export const Asked = Schema.Struct({
  login: LoginId,
  message: Text,
  placeholder: Schema.Option(Text),
  secret: Schema.Boolean,
  choices: Schema.Array(LoginChoice),
})
export type Asked = typeof Asked.Type

/** The page to open. */
export const OpenPage = Schema.Struct({
  url: Text,
  instructions: Schema.Option(Text),
})
export type OpenPage = typeof OpenPage.Type

/** The code to enter, and where. */
export const DeviceCode = Schema.Struct({ url: Text, code: Text })
export type DeviceCode = typeof DeviceCode.Type

/** A sign-in going, as far as the engine has said. */
export const Going = Schema.Struct({
  engine: Schema.String,
  provider: ProviderName,
  /** Told apart from the sign-in before it, which may have said something still on its way. */
  attempt: Schema.Int,
  terms: Schema.Option(Schema.String),
  page: Schema.Option(OpenPage),
  device: Schema.Option(DeviceCode),
  waiting: Schema.Option(Schema.String),
  asked: Schema.Option(Asked),
  answer: Schema.Redacted(Schema.String),
  /** What sending the last answer said where it failed. */
  problem: Schema.Option(Schema.String),
})
export type Going = typeof Going.Type

export const Flow = defineTaggedUnion({
  Closed: {},
  Going: { going: Going },
  Failed: {
    engine: Schema.String,
    provider: ProviderName,
    reason: Schema.String,
  },
  Done: { engine: Schema.String, provider: ProviderName },
})
export type Flow = typeof Flow.Type

export const Model = Schema.Struct({
  /** How many sign-ins were started, so each has its own stream. */
  attempts: Schema.Int,
  flow: Flow,
})
export type Model = typeof Model.Type

export const init = (): Model => ({ attempts: 0, flow: Flow.Closed() })

export const Message = defineMessageUnion({
  ClickedSignIn: { engine: Schema.String, provider: ProviderName },
  ClickedLeaveSignIn: {},
  ReceivedLoginStep: { attempt: Schema.Int, step: LoginStep },
  FailedLogin: { attempt: Schema.Int, reason: Schema.String },
  ChangedLoginAnswer: { answer: Schema.Redacted(Schema.String) },
  SubmittedLoginAnswer: {},
  ChoseLoginAnswer: { choice: Schema.String },
  SentLoginAnswer: { login: LoginId },
  FailedLoginAnswer: { login: LoginId, reason: Schema.String },
})
export type Message = typeof Message.Type

/** The sign-in the screen has going: what its stream is kept by. */
export const SignInRun = Schema.Struct({
  engine: Schema.String,
  provider: ProviderName,
  attempt: Schema.Int,
})
export type SignInRun = typeof SignInRun.Type

export const runOf = (model: Model): Option.Option<SignInRun> =>
  Flow.guards.Going(model.flow)
    ? Option.some({
        engine: model.flow.going.engine,
        provider: model.flow.going.provider,
        attempt: model.flow.going.attempt,
      })
    : Option.none()

/** The sign-in's steps as Messages; a failure says why. */
export const loginMessages = (
  client: EngineClientShape,
  run: SignInRun,
): Stream.Stream<Message> =>
  client.rpc['credentials.login']({ provider: run.provider }).pipe(
    Stream.map(step =>
      Message.ReceivedLoginStep({ attempt: run.attempt, step }),
    ),
    Stream.catch(error =>
      Stream.make(
        Message.FailedLogin({
          attempt: run.attempt,
          reason: failureText(error, 'the engine gave no reason'),
        }),
      ),
    ),
  )

/** What a sign-in's stream ending says: nothing once it signed in, or else that it ended (an engine not connected, gone). */
export const endedLogin = (run: SignInRun): Message =>
  Message.FailedLogin({
    attempt: run.attempt,
    reason:
      'the engine isn’t connected, or ended the sign-in before it was done',
  })

export const AnswerLogin = Command.define('AnswerLogin', {
  args: {
    engine: Schema.String,
    login: LoginId,
    answer: Schema.Redacted(Schema.String),
  },
  messages: [Message.SentLoginAnswer, Message.FailedLoginAnswer],
  execute: ({ engine, login, answer }) =>
    requestEngine(engine, client =>
      // A question the sign-in went past takes no answer, and needs none.
      client.rpc['credentials.answerLogin']({ login, answer }).pipe(
        Effect.catchTag('LoginNotWaiting', () => Effect.void),
      ),
    ).pipe(
      Effect.as(Message.SentLoginAnswer({ login })),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedLoginAnswer({ login, reason })),
      ),
    ),
})

export type Requires = EngineServices

/** What a step does to the sign-in going. */
export type Stepped = Data.TaggedEnum<{
  Goes: { readonly going: Going }
  SignedIn: {}
}>
export const Stepped = Data.taggedEnum<Stepped>()

const steppedBy = (going: Going, step: LoginStep): Stepped =>
  LoginStep.match(step, {
    terms: ({ text }): Stepped =>
      Stepped.Goes({ going: { ...going, terms: Option.some(text) } }),
    open_url: ({ url, instructions }) =>
      Stepped.Goes({
        going: { ...going, page: Option.some({ url, instructions }) },
      }),
    device_code: ({ url, code }) =>
      Stepped.Goes({ going: { ...going, device: Option.some({ url, code }) } }),
    waiting: ({ text }) =>
      Stepped.Goes({ going: { ...going, waiting: Option.some(text) } }),
    asked: ({ login, message, placeholder, secret, choices }) =>
      Stepped.Goes({
        going: {
          ...going,
          asked: Option.some({ login, message, placeholder, secret, choices }),
          answer: Redacted.make(''),
          problem: Option.none(),
        },
      }),
    signed_in: () => Stepped.SignedIn(),
  })

type Return = Update.Return<Model, Message, Requires>

/** The sign-in going, where `attempt` is it. */
const goingAt = (model: Model, attempt: number): Option.Option<Going> =>
  Flow.guards.Going(model.flow) && model.flow.going.attempt === attempt
    ? Option.some(model.flow.going)
    : Option.none()

const withFlow = (model: Model, flow: Flow): Model =>
  modifyFields(model, { flow: () => flow })

/** Sends `answer` to what `going` asks, taking the question off the form. */
const answered = (
  model: Model,
  going: Going,
  answer: Redacted.Redacted<string>,
): Return =>
  Option.match(going.asked, {
    onNone: () => ({ model }),
    onSome: ({ login }) => ({
      model: withFlow(
        model,
        Flow.Going({
          going: {
            ...going,
            asked: Option.none(),
            answer: Redacted.make(''),
            problem: Option.none(),
          },
        }),
      ),
      commands: [AnswerLogin({ engine: going.engine, login, answer })],
    }),
  })

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ClickedSignIn: ({ engine, provider }) => ({
      model: {
        attempts: model.attempts + 1,
        flow: Flow.Going({
          going: {
            engine,
            provider,
            attempt: model.attempts + 1,
            terms: Option.none(),
            page: Option.none(),
            device: Option.none(),
            waiting: Option.none(),
            asked: Option.none(),
            answer: Redacted.make(''),
            problem: Option.none(),
          },
        }),
      },
    }),
    ClickedLeaveSignIn: () => ({ model: withFlow(model, Flow.Closed()) }),
    ReceivedLoginStep: ({ attempt, step }) =>
      Option.match(goingAt(model, attempt), {
        onNone: () => ({ model }),
        onSome: going => ({
          model: withFlow(
            model,
            Stepped.$match(steppedBy(going, step), {
              Goes: ({ going }) => Flow.Going({ going }),
              SignedIn: () =>
                Flow.Done({
                  engine: going.engine,
                  provider: going.provider,
                }),
            }),
          ),
        }),
      }),
    FailedLogin: ({ attempt, reason }) =>
      Option.match(goingAt(model, attempt), {
        onNone: () => ({ model }),
        onSome: ({ engine, provider }) => ({
          model: withFlow(model, Flow.Failed({ engine, provider, reason })),
        }),
      }),
    ChangedLoginAnswer: ({ answer }) =>
      Flow.guards.Going(model.flow)
        ? {
            model: withFlow(
              model,
              Flow.Going({ going: { ...model.flow.going, answer } }),
            ),
          }
        : { model },
    SubmittedLoginAnswer: () =>
      Flow.guards.Going(model.flow)
        ? answered(model, model.flow.going, model.flow.going.answer)
        : { model },
    ChoseLoginAnswer: ({ choice }) =>
      Flow.guards.Going(model.flow)
        ? answered(model, model.flow.going, Redacted.make(choice))
        : { model },
    SentLoginAnswer: () => ({ model }),
    FailedLoginAnswer: ({ reason }) =>
      Flow.guards.Going(model.flow)
        ? {
            model: withFlow(
              model,
              Flow.Going({
                going: {
                  ...model.flow.going,
                  problem: Option.some(reason),
                },
              }),
            ),
          }
        : { model },
  })

/** The engine a message has just signed in on: the screen lists its credentials again. */
export const signedInOn = (
  before: Model,
  after: Model,
): Option.Option<string> =>
  Flow.guards.Done(after.flow) && !Flow.guards.Done(before.flow)
    ? Option.some(after.flow.engine)
    : Option.none()

const primaryButton =
  'rounded-button bg-c1 px-12 py-6 text-sm font-bold text-ink disabled:opacity-60'
const quietButton =
  'rounded-button border border-line px-10 py-4 text-xs text-fg disabled:opacity-60'
const field =
  'rounded-button border border-line bg-bg px-10 py-6 text-sm text-fg'

const problemLine = (text: string, h: HtmlBuilder<Message>): Html =>
  h.p([h.Role('alert'), h.Class('text-xs text-c3')], [text])

/** A link where the engine named a web page: the engine may be another host's, and the renderer opens only those. */
const pageLink = (url: string, words: string, h: HtmlBuilder<Message>): Html =>
  /^https?:\/\//iu.test(url)
    ? h.a(
        [
          h.Href(url),
          h.Target('_blank'),
          h.Rel('noreferrer'),
          h.Class('text-sm text-c1 underline'),
        ],
        [words],
      )
    : h.span([h.Class('font-mono text-sm')], [url])

const labelOf = (provider: ProviderName): string =>
  SignInProviders.find(known => known.provider === provider)?.label ?? provider

const askedForm = (going: Going, asked: Asked, h: HtmlBuilder<Message>): Html =>
  asked.choices.length > 0
    ? h.div(
        [
          h.Role('group'),
          h.AriaLabel(asked.message),
          h.Class('flex flex-wrap items-center gap-8'),
        ],
        [
          h.span([h.Class('text-sm')], [asked.message]),
          ...asked.choices.map(({ id, label }) =>
            h.keyed('button')(
              id,
              [
                h.Type('button'),
                h.OnClick(Message.ChoseLoginAnswer({ choice: id })),
                h.Class(quietButton),
              ],
              [label],
            ),
          ),
        ],
      )
    : h.form(
        [
          h.AriaLabel('Answer the sign-in'),
          h.OnSubmit(Message.SubmittedLoginAnswer()),
          h.Class('flex flex-col gap-8'),
        ],
        [
          h.label(
            [h.For('sign-in-answer'), h.Class('text-sm')],
            [asked.message],
          ),
          h.div(
            [h.Class('flex items-center gap-8')],
            [
              h.input([
                h.Id('sign-in-answer'),
                h.Type(asked.secret ? 'password' : 'text'),
                h.Value(Redacted.value(going.answer)),
                h.Autocomplete('off'),
                ...Option.toArray(Option.map(asked.placeholder, h.Placeholder)),
                h.OnInput(answer =>
                  Message.ChangedLoginAnswer({
                    answer: Redacted.make(answer),
                  }),
                ),
                h.Class(`min-w-0 flex-1 font-mono ${field}`),
              ]),
              h.button([h.Type('submit'), h.Class(primaryButton)], ['Send']),
            ],
          ),
        ],
      )

const goingView = (going: Going, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Role('group'),
      h.AriaLabel(`Signing in to ${labelOf(going.provider)}`),
      h.Class('flex flex-col gap-10 rounded-card border border-line bg-panel'),
      h.Style({ padding: '12px 16px' }),
    ],
    [
      h.h4(
        [h.Class('text-sm font-bold')],
        [`Signing in to ${labelOf(going.provider)}`],
      ),
      Option.match(going.terms, {
        onNone: () => h.empty,
        onSome: text => h.p([h.Class('text-xs text-muted')], [text]),
      }),
      Option.match(going.page, {
        onNone: () => h.empty,
        onSome: ({ url, instructions }) =>
          h.div(
            [h.Class('flex flex-col gap-4')],
            [
              pageLink(url, 'Open the sign-in page', h),
              Option.match(instructions, {
                onNone: () => h.empty,
                onSome: text => h.p([h.Class('text-xs text-muted')], [text]),
              }),
            ],
          ),
      }),
      Option.match(going.device, {
        onNone: () => h.empty,
        onSome: ({ url, code }) =>
          h.p(
            [h.Class('text-sm')],
            [
              'Enter ',
              h.code([h.Class('font-mono font-bold')], [code]),
              ' at ',
              pageLink(url, url, h),
            ],
          ),
      }),
      Option.match(going.asked, {
        onNone: () => h.empty,
        onSome: asked => askedForm(going, asked, h),
      }),
      Option.match(going.waiting, {
        onNone: () => h.empty,
        onSome: text => h.p([h.Class('text-xs text-muted')], [text]),
      }),
      Option.match(going.problem, {
        onNone: () => h.empty,
        onSome: text => problemLine(text, h),
      }),
      h.div(
        [h.Class('flex items-center gap-8')],
        [
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedLeaveSignIn()),
              h.Class(quietButton),
            ],
            ['Leave the sign-in'],
          ),
        ],
      ),
    ],
  )

export interface ViewInputs {
  /** The engine the buttons sign in on. */
  readonly engine: string
}

/** The sign-in buttons of the engine named `engine`, and its sign-in where one goes on it. */
export const view = defineView<Model, Message, ViewInputs>(
  (model, { engine }, h) => {
    const buttons = h.div(
      [
        h.Role('group'),
        h.AriaLabel(`Sign in on ${engine}`),
        h.Class('flex flex-wrap items-center gap-8'),
      ],
      [
        h.span([h.Class('text-xs text-muted')], ['Sign in with']),
        ...SignInProviders.map(({ provider, label }) =>
          h.keyed('button')(
            provider,
            [
              h.Type('button'),
              h.AriaLabel(`Sign in with ${label} on ${engine}`),
              h.Disabled(Flow.guards.Going(model.flow)),
              h.OnClick(Message.ClickedSignIn({ engine, provider })),
              h.Class(quietButton),
            ],
            [label],
          ),
        ),
      ],
    )
    return h.div(
      [h.Class('flex flex-col gap-8')],
      [
        buttons,
        Flow.match(model.flow, {
          Closed: () => h.empty,
          Going: ({ going }) =>
            going.engine === engine ? goingView(going, h) : h.empty,
          Failed: failed =>
            failed.engine === engine
              ? problemLine(
                  `The sign-in to ${labelOf(failed.provider)} failed: ${failed.reason}`,
                  h,
                )
              : h.empty,
          Done: done =>
            done.engine === engine
              ? h.p(
                  [h.Role('status'), h.Class('text-xs text-muted')],
                  [
                    `Signed in to ${labelOf(done.provider)}: the engine keeps it in its host’s secret store.`,
                  ],
                )
              : h.empty,
        }),
      ],
    )
  },
)
