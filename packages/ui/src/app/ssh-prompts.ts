import {
  Array,
  Context,
  Effect,
  Layer,
  Option,
  Queue,
  Redacted,
  Schema,
  Stream,
} from 'effect'
import { Command } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'

import {
  SshAnswer,
  SshPrompt,
  SshPromptAnswer,
  SshPromptEvent,
  sshPromptsMember,
} from '@fabrica/client'

import { dialog } from './dialog'
import { Message, SshReply } from './message'

// What ssh asks as the app connects (spec §9.1), shown over the app: an unknown host's key with its
// fingerprint, to accept or refuse; a passphrase or a password, typed into a password field; a yes or
// no; a notice, dismissed. The connection process asks main, main asks the page through the preload
// (`window.fabrica.sshPrompts`), and the answer goes back the same way; a prompt ssh no longer waits on
// is withdrawn. The prompts queue, the first shown. A secret is held redacted, and crosses only as the
// answer's. The renderer alone in a browser is asked nothing.

/** The prompts as the program reaches them: what is asked and withdrawn, and the answers. */
export interface SshPromptHostShape {
  readonly events: Stream.Stream<SshPromptEvent>
  readonly answer: (answer: SshPromptAnswer) => Effect.Effect<void>
}

export class SshPromptHost extends Context.Service<
  SshPromptHost,
  SshPromptHostShape
>()('@fabrica/ui/SshPromptHost') {}

/** No app around the renderer: nothing is asked. */
export const noSshPromptHost: SshPromptHostShape = {
  events: Stream.never,
  answer: () => Effect.void,
}

const decodeEvent = Schema.decodeUnknownOption(SshPromptEvent)
const encodeAnswer = Schema.encodeSync(SshPromptAnswer)

/** `object`'s function `name`, where it has one. */
const functionOf = (
  object: unknown,
  name: string,
): Option.Option<(...args: ReadonlyArray<unknown>) => unknown> => {
  const value: unknown =
    typeof object === 'object' && object !== null
      ? Reflect.get(object, name)
      : undefined
  return typeof value === 'function'
    ? Option.some((...args) => Reflect.apply(value, object, args))
    : Option.none()
}

/** The prompts through what the preload of the window `target` exposes; none without it. */
export const sshPromptHostOf = (target: object): SshPromptHostShape => {
  const api: unknown = Reflect.get(
    Reflect.get(target, 'fabrica') ?? {},
    sshPromptsMember,
  )
  return Option.match(
    Option.all([functionOf(api, 'onEvent'), functionOf(api, 'answer')]),
    {
      onNone: () => noSshPromptHost,
      onSome: ([onEvent, answer]) => ({
        events: Stream.callback<SshPromptEvent>(queue =>
          Effect.acquireRelease(
            Effect.sync(() =>
              onEvent((raw: unknown) => {
                Option.map(decodeEvent(raw), event =>
                  Queue.offerUnsafe(queue, event),
                )
              }),
            ),
            stop =>
              Effect.sync(() => {
                if (typeof stop === 'function') {
                  Reflect.apply(stop, undefined, [])
                }
              }),
          ),
        ),
        answer: given => Effect.sync(() => answer(encodeAnswer(given))),
      }),
    },
  )
}

export const layerSshPromptHost = (
  host: SshPromptHostShape,
): Layer.Layer<SshPromptHost> => Layer.succeed(SshPromptHost, host)

/** A prompt asked, by its number. */
export const AskedPrompt = Schema.Struct({ id: Schema.Int, prompt: SshPrompt })
export type AskedPrompt = typeof AskedPrompt.Type

/** The prompts waiting, the first shown, and the secret typed for it. */
export const Model = Schema.Struct({
  asked: Schema.Array(AskedPrompt),
  secret: Schema.Redacted(Schema.String),
})
export type Model = typeof Model.Type

const noSecret = Redacted.make('')

export const init = (): Model => ({ asked: [], secret: noSecret })

/** `prompt` asked: queued behind those asked before it. */
export const ask = (model: Model, prompt: AskedPrompt): Model => ({
  ...model,
  asked: [...model.asked.filter(held => held.id !== prompt.id), prompt],
})

/** The prompt `id` gone, answered or withdrawn; the secret typed goes with the prompt shown. */
export const drop = (model: Model, id: number): Model =>
  Option.exists(Array.head(model.asked), shown => shown.id === id)
    ? { asked: model.asked.slice(1), secret: noSecret }
    : { ...model, asked: model.asked.filter(held => held.id !== id) }

/** Whether the prompt `id` is waiting. */
export const isAsked = (model: Model, id: number): boolean =>
  model.asked.some(held => held.id === id)

/** The notices waiting: a connection that came up needs them no longer. */
export const notices = (model: Model): ReadonlyArray<number> =>
  model.asked.flatMap(held =>
    SshPrompt.guards.Notice(held.prompt) ? [held.id] : [],
  )

/** Answers the prompt `id`, as the user replied: with `secret` for a secret entered. */
export const AnswerSshPrompt = Command.define('AnswerSshPrompt', {
  args: {
    id: Schema.Int,
    reply: SshReply,
    secret: Schema.Redacted(Schema.String),
  },
  messages: [Message.CompletedAnswerSsh],
  execute: ({ id, reply, secret }) =>
    Effect.gen(function* () {
      const host = yield* SshPromptHost
      yield* host.answer({
        id,
        answer:
          reply === 'Entered'
            ? SshAnswer.cases.Entered.make({ secret: Redacted.value(secret) })
            : reply === 'Accepted'
              ? SshAnswer.cases.Accepted.make({})
              : SshAnswer.cases.Declined.make({}),
      })
      return Message.CompletedAnswerSsh()
    }),
})

const primaryButton =
  'rounded-button bg-c1 px-12 py-6 text-sm font-bold text-ink'
const quietButton =
  'rounded-button border border-line px-10 py-6 text-sm text-fg'
const field =
  'rounded-button border border-line bg-bg px-10 py-6 text-sm text-fg'

const reply = (id: number, chosen: SshReply): Message =>
  Message.RepliedToSsh({ id, reply: chosen })

const button = (
  label: string,
  message: Message,
  style: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.button([h.Type('button'), h.OnClick(message), h.Class(style)], [label])

const paragraph = (text: string, h: HtmlBuilder<Message>): Html =>
  h.p([h.Class('whitespace-pre-wrap px-12 text-sm')], [text])

const heading = (text: string, h: HtmlBuilder<Message>): Html =>
  h.h2([h.Class('px-12 text-sm font-extrabold')], [text])

const actions = (buttons: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class('flex justify-end gap-8 px-12')], buttons)

/** The prompt shown's body. */
const promptBody = (
  model: Model,
  { id, prompt }: AskedPrompt,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  SshPrompt.match(prompt, {
    HostKey: ({ destination, host, fingerprint }) => [
      heading(`${destination}: an unknown host key`, h),
      paragraph(
        `ssh doesn't know ${host} yet. Accept its key only if the fingerprint is the one its administrator gave you: ssh then remembers it in known_hosts.`,
        h,
      ),
      ...Option.match(fingerprint, {
        onNone: () => [],
        onSome: key => [
          h.p(
            [
              h.AriaLabel('Fingerprint'),
              h.Class('break-all px-12 font-mono text-sm'),
            ],
            [key],
          ),
        ],
      }),
      actions(
        [
          button('Refuse', reply(id, 'Declined'), quietButton, h),
          button('Accept the key', reply(id, 'Accepted'), primaryButton, h),
        ],
        h,
      ),
    ],
    Secret: ({ destination, text }) => [
      heading(`${destination}: ssh asks`, h),
      h.form(
        [
          h.AriaLabel('SSH secret'),
          h.Class('flex flex-col gap-8'),
          h.OnSubmit(reply(id, 'Entered')),
        ],
        [
          h.label(
            [h.For('ssh-secret'), h.Class('whitespace-pre-wrap px-12 text-sm')],
            [text],
          ),
          h.div(
            [h.Class('flex px-12')],
            [
              h.input([
                h.Id('ssh-secret'),
                h.Type('password'),
                h.Value(Redacted.value(model.secret)),
                h.Autocomplete('off'),
                h.Autofocus(true),
                h.OnInput(secret =>
                  Message.ChangedSshSecret({ secret: Redacted.make(secret) }),
                ),
                h.Class(`w-full font-mono ${field}`),
              ]),
            ],
          ),
          actions(
            [
              button('Cancel', reply(id, 'Declined'), quietButton, h),
              h.button([h.Type('submit'), h.Class(primaryButton)], ['Send']),
            ],
            h,
          ),
        ],
      ),
    ],
    Confirm: ({ destination, text }) => [
      heading(`${destination}: ssh asks`, h),
      paragraph(text, h),
      actions(
        [
          button('No', reply(id, 'Declined'), quietButton, h),
          button('Yes', reply(id, 'Accepted'), primaryButton, h),
        ],
        h,
      ),
    ],
    Notice: ({ destination, text }) => [
      heading(`${destination}: ssh says`, h),
      paragraph(text, h),
      actions([button('OK', reply(id, 'Declined'), primaryButton, h)], h),
    ],
  })

/** The first prompt waiting, over the app: nothing while none waits. */
export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(Array.head(model.asked), {
    onNone: () => h.empty,
    onSome: shown =>
      dialog(`SSH ${shown.prompt.destination}`, promptBody(model, shown, h), h),
  })
