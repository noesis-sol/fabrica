import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import { ProviderName } from '../events'
import { CommandLine } from '../settings'
import { Text } from '../ticket'
import { Name, optional } from './common'

// The Secrets group (spec §8.1, §20.3): model credentials in the engine host's secret store. A key is
// sent once, set by name; the engine lists names only. `credentials.login` runs a subscription's OAuth
// sign-in in the engine and streams what the client must show: the sign-in URL or the device code.

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

/** A sign-in's progress, for the client to show. */
export const LoginStep = Schema.TaggedUnion({
  /** Open this URL in a browser. */
  open_url: { url: Text, instructions: Schema.OptionFromNullOr(Text) },
  /** Enter this code at this URL. */
  device_code: { url: Text, code: Text },
  /** Waiting on the provider, in words. */
  waiting: { text: Text },
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

export const SecretRpcs = RpcGroup.make(
  Rpc.make('credentials.set', {
    payload: {
      name: CredentialName,
      value: CredentialValue,
      provider: optional(ProviderName),
    },
  }),
  Rpc.make('credentials.list', { success: Schema.Array(CredentialInfo) }),
  Rpc.make('credentials.remove', {
    payload: { name: CredentialName },
    error: CredentialNotFound,
  }),
  Rpc.make('credentials.login', {
    payload: { provider: ProviderName },
    success: LoginStep,
    error: LoginFailed,
    stream: true,
  }),
)
