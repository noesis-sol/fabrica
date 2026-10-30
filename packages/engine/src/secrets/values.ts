import { Data, Effect, Option, Redacted, Schema } from 'effect'

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
export type SecretStoreKind = 'keychain' | 'libsecret' | 'kwallet' | 'file'

/** An API key: the key itself, or a command whose output is the key, run when it is needed (Pi's `!command`). */
export type ApiKey = Data.TaggedEnum<{
  Key: { readonly key: Redacted.Redacted<string> }
  /** A shell command line (a password manager's CLI: `op read op://Work/OpenAI/key`). */
  Command: { readonly command: string }
}>
export const ApiKey = Data.taggedEnum<ApiKey>()

/** An API key as a store keeps it: JSON text. */
const StoredKey = Schema.Union([
  Schema.TaggedStruct('Key', { key: Schema.String }),
  Schema.TaggedStruct('Command', { command: Schema.String }),
])
type StoredKey = typeof StoredKey.Type
const StoredKeyJson = Schema.fromJsonString(StoredKey)
const decodeStoredKey = Schema.decodeUnknownOption(StoredKeyJson)
const encodeStoredKey = Schema.encodeSync(StoredKeyJson)

/** The text a store keeps for `key`. */
export const encodeApiKey = (key: ApiKey): Redacted.Redacted<string> =>
  Redacted.make(
    encodeStoredKey(
      ApiKey.$match(key, {
        Key: ({ key }): StoredKey => ({
          _tag: 'Key',
          key: Redacted.value(key),
        }),
        Command: ({ command }): StoredKey => ({ _tag: 'Command', command }),
      }),
    ),
  )

/** The API key a store's text holds, or none where it holds no key of this form. */
export const decodeApiKey = (
  text: Redacted.Redacted<string>,
): Option.Option<ApiKey> =>
  Option.map(decodeStoredKey(Redacted.value(text)), stored =>
    stored._tag === 'Key'
      ? ApiKey.Key({ key: Redacted.make(stored.key) })
      : ApiKey.Command({ command: stored.command }),
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
