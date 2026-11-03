import { Data, Effect, Match, Option, Redacted, Schema } from 'effect'

import type { ProviderName } from '@fabrica/contracts'

import type { SecretStoreFailed } from './errors'

// The credentials the engine keeps (spec §20.3) and how a store holds them: each under its name, as
// an item of text the store keeps whole. Secrets are `Redacted` from where they are read to where the
// model proxy uses them, so no log, span or error shows one.

/** A credential's name: a provider's (`anthropic`), or one the user gives (`openai.work`). */
export const SecretName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
).pipe(Schema.brand('SecretName'))
export type SecretName = typeof SecretName.Type

/** Where the credentials are kept: a keyring, or the encrypted file on a host without one. */
export type SecretStoreKind = 'keychain' | 'libsecret' | 'file'

/** An API key: the key itself, or a command whose output is the key, run when it is needed (Pi's `!command`). */
export type ApiKey = Data.TaggedEnum<{
  Key: { readonly key: Redacted.Redacted<string> }
  /** A shell command line (a password manager's CLI: `op read op://Work/OpenAI/key`). */
  Command: { readonly command: string }
}>
export const ApiKey = Data.taggedEnum<ApiKey>()

/** What is kept under a name, as it was given: nothing here runs a key's command. */
export type Kept = Data.TaggedEnum<{
  Key: {
    readonly key: Redacted.Redacted<string>
    readonly provider: Option.Option<ProviderName>
  }
  Command: {
    readonly command: string
    readonly provider: Option.Option<ProviderName>
  }
  /** A subscription's sign-in: `pi-ai`'s OAuth credential, its tokens among it, as JSON text. */
  OAuth: {
    readonly provider: ProviderName
    readonly credential: Redacted.Redacted<string>
  }
}>
export const Kept = Data.taggedEnum<Kept>()

/** What the proxy has to use for a name (§12.9). */
export type Held = Data.TaggedEnum<{
  /** A key, its command run where it is given by one. */
  Key: { readonly key: Redacted.Redacted<string> }
  /** A subscription's sign-in: its current token comes from the proxy's OAuth refresh. */
  Subscription: { readonly provider: ProviderName }
}>
export const Held = Data.taggedEnum<Held>()

/** What is kept, as a store keeps it: JSON text. */
const Stored = Schema.Union([
  Schema.TaggedStruct('Key', {
    key: Schema.String,
    provider: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('Command', {
    command: Schema.String,
    provider: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('OAuth', {
    provider: Schema.String,
    credential: Schema.String,
  }),
])
type Stored = typeof Stored.Type
const StoredJson = Schema.fromJsonString(Stored)
const decodeStored = Schema.decodeUnknownOption(StoredJson)
const encodeStored = Schema.encodeSync(StoredJson)

const storedProvider = (provider: Option.Option<ProviderName>) =>
  Option.match(provider, {
    onNone: () => ({}),
    onSome: name => ({ provider: name }),
  })

/** The text a store keeps for `kept`. */
export const encodeKept = (kept: Kept): Redacted.Redacted<string> =>
  Redacted.make(
    encodeStored(
      Kept.$match(kept, {
        Key: ({ key, provider }): Stored => ({
          _tag: 'Key',
          key: Redacted.value(key),
          ...storedProvider(provider),
        }),
        Command: ({ command, provider }): Stored => ({
          _tag: 'Command',
          command,
          ...storedProvider(provider),
        }),
        OAuth: ({ provider, credential }): Stored => ({
          _tag: 'OAuth',
          provider,
          credential: Redacted.value(credential),
        }),
      }),
    ),
  )

/** What a store's text holds, or none where it holds nothing of these forms. */
export const decodeKept = (
  text: Redacted.Redacted<string>,
): Option.Option<Kept> =>
  Option.map(decodeStored(Redacted.value(text)), stored =>
    Match.valueTags(stored, {
      Key: ({ key, provider }): Kept =>
        Kept.Key({
          key: Redacted.make(key),
          provider: Option.fromUndefinedOr(provider),
        }),
      Command: ({ command, provider }): Kept =>
        Kept.Command({
          command,
          provider: Option.fromUndefinedOr(provider),
        }),
      OAuth: ({ provider, credential }): Kept =>
        Kept.OAuth({ provider, credential: Redacted.make(credential) }),
    }),
  )

/** The item holding the names of the credentials kept: a name can't start with a dot, so it is never one. */
export const NAMES_ITEM = '.names'

const NamesJson = Schema.fromJsonString(Schema.Array(SecretName))
export const decodeNames = Schema.decodeUnknownOption(NamesJson)
export const encodeNames = Schema.encodeSync(NamesJson)

/**
 * A store of items of text by name: a keyring (through its CLI) or the encrypted file. Removing an
 * item that isn't there succeeds.
 */
export interface ItemStore {
  readonly kind: SecretStoreKind
  readonly read: (
    item: string,
  ) => Effect.Effect<
    Option.Option<Redacted.Redacted<string>>,
    SecretStoreFailed
  >
  readonly write: (
    item: string,
    value: Redacted.Redacted<string>,
  ) => Effect.Effect<void, SecretStoreFailed>
  readonly remove: (item: string) => Effect.Effect<void, SecretStoreFailed>
}
