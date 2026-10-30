import { Effect, Stream } from 'effect'
import { Subscription } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import { SshPromptEvent } from '@fabrica/client'

import type { Handlers, SubscriptionServices } from '../../feature'
import { Message } from '../../message'
import type { Model } from '../../model'
import * as SshPrompts from '../../ssh-prompts'
import type { messages } from './message'

// What ssh asks as the app connects (spec §9.1): each prompt, waiting for the user's answer, sent on to
// the connection process.

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  AskedSsh: ({ id, prompt }) => ({
    model: modifyFields(model, {
      sshPrompts: prompts => SshPrompts.ask(prompts, { id, prompt }),
    }),
  }),
  WithdrewSsh: ({ id }) => ({
    model: modifyFields(model, {
      sshPrompts: prompts => SshPrompts.drop(prompts, id),
    }),
  }),
  ChangedSshSecret: ({ secret }) => ({
    model: modifyFields(model, {
      sshPrompts: prompts => modifyFields(prompts, { secret: () => secret }),
    }),
  }),
  RepliedToSsh: ({ id, reply }) =>
    SshPrompts.isAsked(model.sshPrompts, id)
      ? {
          model: modifyFields(model, {
            sshPrompts: prompts => SshPrompts.drop(prompts, id),
          }),
          commands: [
            SshPrompts.AnswerSshPrompt({
              id,
              reply,
              secret: model.sshPrompts.secret,
            }),
          ],
        }
      : { model },
  CompletedAnswerSsh: () => ({ model }),
})

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  SshPrompts.view(model.sshPrompts, h)

export const subscriptions = () =>
  Subscription.make<Model, Message, SubscriptionServices>()(() => ({
    sshPrompts: Subscription.persistentEntry(
      Stream.unwrap(
        Effect.gen(function* () {
          const host = yield* SshPrompts.SshPromptHost
          return Stream.map(
            host.events,
            SshPromptEvent.match({
              Asked: ({ id, prompt }): Message =>
                Message.AskedSsh({ id, prompt }),
              Withdrawn: ({ id }): Message => Message.WithdrewSsh({ id }),
            }),
          )
        }),
      ),
    ),
  }))
