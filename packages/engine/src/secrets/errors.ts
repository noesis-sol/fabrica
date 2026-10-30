import { Data } from 'effect'

import type { SecretName, SecretStoreKind } from './values'

// What can go wrong keeping a credential (spec §20.3). None of them carries a secret, a key command's
// output or a keyring CLI's output, which can echo what it was given: each says only what failed.

/** No credential is kept under the name. */
export class SecretMissing extends Data.TaggedError('SecretMissing')<{
  readonly name: SecretName
}> {
  override get message() {
    return `no credential is kept under ${this.name}`
  }
}

/** The secret store refused or failed an operation; `reason` never holds a secret. */
export class SecretStoreFailed extends Data.TaggedError('SecretStoreFailed')<{
  readonly store: SecretStoreKind
  readonly operation: string
  readonly reason: string
}> {
  override get message() {
    return `the ${this.store} secret store couldn't ${this.operation}: ${this.reason}`
  }
}

/** A key's command didn't give a key: it didn't start, failed, timed out, or printed nothing. */
export class KeyCommandFailed extends Data.TaggedError('KeyCommandFailed')<{
  readonly name: SecretName
  readonly reason: string
}> {
  override get message() {
    return `the command giving ${this.name}'s key ${this.reason}`
  }
}

/** The host has no keyring and the engine was given no passphrase for its encrypted file. */
export class PassphraseNeeded extends Data.TaggedError('PassphraseNeeded')<{
  readonly path: string
}> {
  override get message() {
    return `this host has no keyring: the engine keeps its credentials in ${this.path}, and needs a passphrase for it at its start`
  }
}

/** The passphrase doesn't open the encrypted file, or its file can't be used. */
export class PassphraseRefused extends Data.TaggedError('PassphraseRefused')<{
  readonly path: string
  readonly reason: string
}> {
  override get message() {
    return `${this.path}: ${this.reason}`
  }
}
