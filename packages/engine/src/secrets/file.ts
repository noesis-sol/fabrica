import { Data, Effect, Option, Redacted, Schema } from 'effect'
import {
  type BinaryLike,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { readFileText, writeFileWhole } from '../files'
import { closeQuietly, openRegular } from '../files/open'
import { PassphraseRefused, SecretStoreFailed } from './errors'
import type { ItemStore } from './values'

// The encrypted file a host with no keyring keeps the credentials in (spec §20.3):
// `<data>/secrets/credentials.enc`, mode 0600 in a folder only the engine's user enters. Its items
// are one JSON object, sealed with AES-256-GCM under a key scrypt derives from the passphrase given
// at the engine's start, or read from a file only the user can read (for a service). The file is
// written whole through the engine's one writer (H84), and read afresh for every operation.

/** Where the passphrase comes from. */
export type PassphraseSource = Data.TaggedEnum<{
  /** Given at the engine's start (typed at its prompt, or by the CLI). */
  Given: { readonly passphrase: Redacted.Redacted<string> }
  /** A file only its user can read or write (mode 0600 or tighter), for an engine run as a service. */
  File: { readonly path: string }
}>
export const PassphraseSource = Data.taggedEnum<PassphraseSource>()

/** scrypt's cost: `N` a power of two. */
export interface ScryptCost {
  readonly N: number
  readonly r: number
  readonly p: number
}

/** 32 MiB and about 0.1 s a derivation: done once, at the engine's start. */
export const DEFAULT_SCRYPT_COST: ScryptCost = { N: 2 ** 15, r: 8, p: 1 }

/** The folder and file, under `<data>`. */
export const SECRETS_FOLDER = 'secrets'
export const SECRETS_FILE = NodePath.join(SECRETS_FOLDER, 'credentials.enc')

/** The largest secrets file the engine reads. */
const MAX_FILE_BYTES = 4 * 1024 * 1024

/** The largest passphrase file the engine reads. */
const MAX_PASSPHRASE_BYTES = 64 * 1024

const Base64 = Schema.String

const Envelope = Schema.Struct({
  format: Schema.Literal('fabrica-secrets'),
  version: Schema.Literal(1),
  kdf: Schema.Struct({
    name: Schema.Literal('scrypt'),
    N: Schema.Int,
    r: Schema.Int,
    p: Schema.Int,
    salt: Base64,
  }),
  cipher: Schema.Literal('aes-256-gcm'),
  iv: Base64,
  tag: Base64,
  sealed: Base64,
})
type Envelope = typeof Envelope.Type
const EnvelopeJson = Schema.fromJsonString(Envelope)
const decodeEnvelope = Schema.decodeUnknownOption(EnvelopeJson)
const encodeEnvelope = Schema.encodeSync(EnvelopeJson)

const ItemsJson = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.String),
)
const decodeItems = Schema.decodeUnknownOption(ItemsJson)
const encodeItems = Schema.encodeSync(ItemsJson)

/** A cost the engine will derive with: a power of two up to 2^20, and small `r` and `p`. */
const isSaneCost = ({ N, r, p }: ScryptCost): boolean =>
  N >= 2 &&
  N <= 2 ** 20 &&
  (N & (N - 1)) === 0 &&
  r >= 1 &&
  r <= 32 &&
  p >= 1 &&
  p <= 16

const deriveKey = (
  passphrase: Redacted.Redacted<string>,
  salt: BinaryLike,
  cost: ScryptCost,
): Effect.Effect<Buffer, Error> =>
  Effect.callback<Buffer, Error>(resume => {
    scrypt(
      Redacted.value(passphrase),
      salt,
      32,
      { ...cost, maxmem: 256 * cost.N * cost.r + 1024 * 1024 },
      (error, key) =>
        resume(error === null ? Effect.succeed(key) : Effect.fail(error)),
    )
  })

/** The items a sealed envelope holds, or none where the key doesn't open it. */
const unseal = (
  envelope: Envelope,
  key: Buffer,
): Option.Option<Record<string, string>> => {
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(envelope.iv, 'base64'),
    )
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.sealed, 'base64')),
      decipher.final(),
    ])
    return decodeItems(plain.toString('utf8'))
  } catch {
    return Option.none()
  }
}

/** The envelope sealing `items` under `key`, with a fresh IV. */
const seal = (
  items: Record<string, string>,
  key: Buffer,
  kdf: Envelope['kdf'],
): Envelope => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const sealed = Buffer.concat([
    cipher.update(Buffer.from(encodeItems(items), 'utf8')),
    cipher.final(),
  ])
  return {
    format: 'fabrica-secrets',
    version: 1,
    kdf,
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    sealed: sealed.toString('base64'),
  }
}

/** A passphrase file's text, where only its user can read or write it; one trailing newline is not part of it. */
export const readPassphraseFile = Effect.fn('Secrets.readPassphraseFile')(
  function* (path: string) {
    const refused = (reason: string) => new PassphraseRefused({ path, reason })
    const { handle, stats } = yield* openRegular(path, constants.O_RDONLY).pipe(
      Effect.mapError(error => refused(error.message)),
    )
    return yield* Effect.gen(function* () {
      if (stats.uid !== process.getuid?.())
        return yield* refused('the passphrase file belongs to another user')
      if ((stats.mode & 0o077) !== 0)
        return yield* refused(
          'others than its user can read or write the passphrase file: make it mode 0600',
        )
      if (stats.size > MAX_PASSPHRASE_BYTES)
        return yield* refused('the passphrase file is too large to be one')
      const bytes = yield* Effect.tryPromise({
        try: () => handle.readFile(),
        catch: error => refused(String(error)),
      })
      const passphrase = bytes.toString('utf8').replace(/\r?\n$/u, '')
      if (passphrase === '')
        return yield* refused('the passphrase file is empty')
      return Redacted.make(passphrase)
    }).pipe(Effect.ensuring(closeQuietly(handle)))
  },
)

/** Makes `<data>/secrets/` where it is missing, mode 0700, and refuses anything else standing there. */
const secretsFolder = Effect.fn('Secrets.secretsFolder')(function* (
  data: string,
) {
  const folder = NodePath.join(data, SECRETS_FOLDER)
  const failed = (error: unknown) =>
    new SecretStoreFailed({
      store: 'file',
      operation: 'make its folder',
      reason: error instanceof Error ? error.message : String(error),
    })
  const found = yield* Effect.tryPromise({
    try: () => lstat(folder).catch(() => undefined),
    catch: failed,
  })
  if (found === undefined) {
    yield* Effect.tryPromise({
      try: () => mkdir(folder, { mode: 0o700 }),
      catch: failed,
    })
    return
  }
  if (!found.isDirectory()) return yield* failed(`${folder} isn't a folder`)
})

/**
 * Opens the encrypted file under `data` with the passphrase `source` gives: a file already there
 * must open with it. A file that isn't there yet is written at the first credential set.
 */
export const openSecretsFile = Effect.fn('Secrets.openSecretsFile')(
  function* (options: {
    readonly data: string
    readonly passphrase: PassphraseSource
    readonly cost?: ScryptCost | undefined
  }) {
    const location = { root: options.data, path: SECRETS_FILE }
    const path = NodePath.join(options.data, SECRETS_FILE)
    const passphrase = yield* PassphraseSource.$match(options.passphrase, {
      Given: ({ passphrase }) => Effect.succeed(passphrase),
      File: ({ path }) => readPassphraseFile(path),
    })
    const refused = (reason: string) => new PassphraseRefused({ path, reason })
    const storeFailed = (operation: string) => (error: { message: string }) =>
      new SecretStoreFailed({ store: 'file', operation, reason: error.message })

    /** The file's envelope, or none where there is no file yet. */
    const readEnvelope: Effect.Effect<
      Option.Option<Envelope>,
      SecretStoreFailed
    > = Effect.gen(function* () {
      const text = yield* readFileText(location, {
        maxBytes: MAX_FILE_BYTES,
      }).pipe(
        Effect.map(Option.some),
        Effect.catchTag('FileMissing', () => Effect.succeedNone),
        Effect.mapError(storeFailed('read its file')),
      )
      if (Option.isNone(text)) return Option.none()
      const envelope = decodeEnvelope(text.value)
      if (Option.isNone(envelope))
        return yield* new SecretStoreFailed({
          store: 'file',
          operation: 'read its file',
          reason: `${path} isn't a secrets file this engine reads`,
        })
      return envelope
    })

    const found = yield* readEnvelope
    const kdf: Envelope['kdf'] = Option.match(found, {
      onNone: () => ({
        name: 'scrypt',
        ...(options.cost ?? DEFAULT_SCRYPT_COST),
        salt: randomBytes(16).toString('base64'),
      }),
      onSome: envelope => envelope.kdf,
    })
    if (!isSaneCost(kdf))
      return yield* refused('its key derivation asks for a cost out of bounds')
    const key = yield* deriveKey(
      passphrase,
      Buffer.from(kdf.salt, 'base64'),
      kdf,
    ).pipe(Effect.mapError(error => refused(error.message)))
    if (Option.isSome(found) && Option.isNone(unseal(found.value, key)))
      return yield* refused("the passphrase doesn't open it")

    const readItems = Effect.flatMap(
      readEnvelope,
      Option.match({
        onNone: () => Effect.succeed<Record<string, string>>({}),
        onSome: envelope =>
          Option.match(unseal(envelope, key), {
            onNone: () =>
              Effect.fail(
                new SecretStoreFailed({
                  store: 'file',
                  operation: 'read its file',
                  reason: `${path} no longer opens with the engine's passphrase`,
                }),
              ),
            onSome: items => Effect.succeed(items),
          }),
      }),
    )
    const writeItems = (items: Record<string, string>) =>
      Effect.gen(function* () {
        yield* secretsFolder(options.data)
        yield* writeFileWhole(location, encodeEnvelope(seal(items, key, kdf)), {
          mode: 0o600,
        }).pipe(Effect.mapError(storeFailed('write its file')))
      })

    const read = Effect.fn('SecretsFile.read')(function* (item: string) {
      const items = yield* readItems
      return Option.map(
        Option.fromUndefinedOr(
          Object.hasOwn(items, item) ? items[item] : undefined,
        ),
        value => Redacted.make(value),
      )
    })
    const write = Effect.fn('SecretsFile.write')(function* (
      item: string,
      value: Redacted.Redacted<string>,
    ) {
      const items = yield* readItems
      yield* writeItems({ ...items, [item]: Redacted.value(value) })
    })
    const remove = Effect.fn('SecretsFile.remove')(function* (item: string) {
      const items = yield* readItems
      if (!Object.hasOwn(items, item)) return
      yield* writeItems(
        Object.fromEntries(
          Object.entries(items).filter(([name]) => name !== item),
        ),
      )
    })
    const store: ItemStore = { kind: 'file', read, write, remove }
    return { store, path }
  },
)
