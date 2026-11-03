import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import { ProviderName } from '../events'
import { CommandLine } from '../settings'
import { Text } from '../ticket'
import { Name, optional } from './common'

// The Secrets group (spec §8.1, §20.3): model credentials in the engine host's secret store. A key is
// sent once, set by name; the engine lists names only. `credentials.login` runs a subscription's OAuth
// sign-in in the engine and streams what the client must show: that a provider's terms are the user's
// to check, the sign-in URL or the device code, and what the sign-in asks, answered through
// `credentials.answerLogin` under the id the question gives.

/** A credential's name. */
export const CredentialName = Name
export type CredentialName = typeof CredentialName.Type

/** What a credential is: a key, or a command whose output is the key (a password manager's CLI). */
export const CredentialValue = Schema.TaggedUnion({
  key: { key: Schema.RedactedFromValue(Text) },
  command: { command: CommandLine },
})
export type CredentialValue = typeof CredentialValue.Type

/** How a credential was given. */
export const CredentialKind = Schema.Literals(['key', 'command', 'oauth'])
export type CredentialKind = typeof CredentialKind.Type

/** A credential as it is listed: its name, never its value. */
export class CredentialInfo extends Schema.Class<CredentialInfo>(
  'CredentialInfo',
)({
  name: CredentialName,
  kind: CredentialKind,
  provider: Schema.OptionFromNullOr(ProviderName),
}) {}

/** The providers `credentials.login` signs in to, with what a client calls each sign-in (§20.3). */
export const SignInProviders: ReadonlyArray<{
  readonly provider: ProviderName
  readonly label: string
}> = [
  { provider: 'anthropic', label: 'Claude Pro or Max' },
  { provider: 'openai', label: 'ChatGPT' },
  { provider: 'github-copilot', label: 'GitHub Copilot' },
  { provider: 'openrouter', label: 'OpenRouter' },
]

/** A running sign-in's id, drawn by the engine: what answers its question names. */
export const LoginId = Name
export type LoginId = typeof LoginId.Type

/** One of the choices a sign-in's question offers: its answer is the choice's `id`. */
export const LoginChoice = Schema.Struct({ id: Text, label: Text })
export type LoginChoice = typeof LoginChoice.Type

/** A sign-in's progress, for the client to show. */
export const LoginStep = Schema.TaggedUnion({
  /** Said first at every sign-in: whether a provider's terms allow its subscription here is the user's to check. */
  terms: { text: Text },
  /** Open this URL in a browser. */
  open_url: { url: Text, instructions: Schema.OptionFromNullOr(Text) },
  /** Enter this code at this URL. */
  device_code: { url: Text, code: Text },
  /** Waiting on the provider, in words. */
  waiting: { text: Text },
  /**
   * The sign-in asks: answer with `credentials.answerLogin`. `choices` is what to choose from, where it
   * offers some; `secret` says the answer isn't to be shown as it is typed. A later step can overtake it,
   * as a browser's sign-in overtakes the code it offers to take instead.
   */
  asked: {
    login: LoginId,
    message: Text,
    placeholder: Schema.OptionFromNullOr(Text),
    secret: Schema.Boolean,
    choices: Schema.Array(LoginChoice),
  },
  /** Signed in; the stream ends. */
  signed_in: { account: Schema.OptionFromNullOr(Text) },
})
export type LoginStep = typeof LoginStep.Type

export class CredentialNotFound extends Schema.TaggedError<CredentialNotFound>()(
  'CredentialNotFound',
  { name: CredentialName },
) {}

/** The sign-in failed, or the provider has none in `pi-ai`. */
export class LoginFailed extends Schema.TaggedError<LoginFailed>()(
  'LoginFailed',
  { provider: ProviderName, reason: Text },
) {}

/** The engine's secret store refused or failed, or the engine has none. */
export class CredentialStoreFailed extends Schema.TaggedError<CredentialStoreFailed>()(
  'CredentialStoreFailed',
  { reason: Text },
) {
  override get message() {
    return this.reason
  }
}

/** No running sign-in has that id or is waiting on an answer: it has ended, or gone past its question. */
export class LoginNotWaiting extends Schema.TaggedError<LoginNotWaiting>()(
  'LoginNotWaiting',
  { login: LoginId },
) {}

export const SecretRpcs = RpcGroup.make(
  Rpc.make('credentials.set', {
    payload: {
      name: CredentialName,
      value: CredentialValue,
      provider: optional(ProviderName),
    },
    error: CredentialStoreFailed,
  }),
  Rpc.make('credentials.list', {
    success: Schema.Array(CredentialInfo),
    error: CredentialStoreFailed,
  }),
  Rpc.make('credentials.remove', {
    payload: { name: CredentialName },
    error: Schema.Union([CredentialNotFound, CredentialStoreFailed]),
  }),
  Rpc.make('credentials.login', {
    payload: { provider: ProviderName },
    success: LoginStep,
    error: LoginFailed,
    stream: true,
  }),
  // A blank answer is one: GitHub Copilot's sign-in takes it for github.com.
  Rpc.make('credentials.answerLogin', {
    payload: {
      login: LoginId,
      answer: Schema.RedactedFromValue(Schema.String),
    },
    error: LoginNotWaiting,
  }),
)
