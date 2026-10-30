import type { Update } from 'foldkit'

import type * as Engines from '../screens/engines'
import type * as Insights from '../screens/insights'
import type * as Review from '../screens/review'
import type * as Settings from '../screens/settings'
import type { EngineServices } from './engine-route'
import type { AppHost } from './host'
import type { Message } from './message'
import type { Model } from './model'
import type { Notifier } from './notifier'
import type * as RemoteEngines from './remote-engines'
import type { SshPromptHost } from './ssh-prompts'
import type { ThemeHost } from './theme-host'

// What a feature of the app gives the root (spec §6, §18.1): each feature, under `features/`, keeps its
// Messages' fields in its own `message.ts` and its update branches, view and subscriptions in its own
// module, and the root's `message.ts`, `update.ts`, `view.ts` and `subscriptions.ts` only list the
// features, a line each in the order of their names, so two features never add lines side by side.

/** The services the root's Commands use: each feature's that has some. */
export type Requires =
  | Engines.Requires
  | EngineServices
  | Insights.Requires
  | Notifier
  | Review.Requires
  | Settings.Requires
  | SshPromptHost
  | ThemeHost

/** The services the root's subscriptions use. */
export type SubscriptionServices =
  | AppHost
  | EngineServices
  | Notifier
  | RemoteEngines.RemoteConnections
  | SshPromptHost

/** What an update branch returns: the root's Model, and Commands sending the root's Messages. */
export type Return = Update.Return<Model, Message, Requires>

/** What a feature's update reaches of the root: its whole update, for a Message a key or an entry runs. */
export interface Root {
  readonly update: (model: Model, message: Message) => Return
}

/** A feature's update branches: one for each of its Messages, given the Message. */
export type Handlers<Tag extends Message['_tag']> = {
  readonly [K in Tag]: (
    message: Extract<Message, { readonly _tag: K }>,
  ) => Return
}

/** `first`, then `next` on its model, their commands together. */
export const andThen = (
  first: Return,
  next: (model: Model) => Return,
): Return => {
  const second = next(first.model)
  return {
    model: second.model,
    commands: [...(first.commands ?? []), ...(second.commands ?? [])],
  }
}
