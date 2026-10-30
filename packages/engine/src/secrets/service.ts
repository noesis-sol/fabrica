import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Semaphore,
} from 'effect'
import * as NodePath from 'node:path'

import { CommandOutcome, ExitStatus, ProcessRunner } from '../process'
import {
  KeyCommandFailed,
  PassphraseNeeded,
  type PassphraseRefused,
  SecretMissing,
  SecretStoreFailed,
} from './errors'
import {
  type PassphraseSource,
  SECRETS_FILE,
  type ScryptCost,
  openSecretsFile,
} from './file'
import {
  type Keyring,
  KeyringCli,
  keychain,
  layerKeyringCli,
  libsecret,
} from './keyring'
import {
  ApiKey,
  type ItemStore,
  NAMES_ITEM,
  type SecretName,
  type SecretStoreKind,
  decodeApiKey,
  decodeNames,
  encodeApiKey,
  encodeNames,
} from './values'

// The engine's credentials (spec §20.3): model credentials kept by name in the host's secret store,
// read only by the model proxy (§12.9). The store is the host's keyring where one answers (the macOS
// Keychain; on Linux the Secret Service, GNOME Keyring's or KWallet's, through libsecret), or else the encrypted file, which the engine warns
// about. A key may be a command whose output is the key, run each time the key is needed. Nothing here
// logs a credential: secrets stay `Redacted`, and no error carries one.

export interface SecretsShape {
  /** The store the credentials are kept in. */
  readonly store: SecretStoreKind
  /** Keeps `key` under `name`, in place of what was kept there. */
  readonly set: (
    name: SecretName,
    key: ApiKey,
  ) => Effect.Effect<void, SecretStoreFailed>
  /** The names kept, sorted: never their keys. */
  readonly list: Effect.Effect<ReadonlyArray<SecretName>, SecretStoreFailed>
  /** The key kept under `name`; a key's command is run for it. */
  readonly get: (
    name: SecretName,
  ) => Effect.Effect<
    Redacted.Redacted<string>,
    SecretMissing | SecretStoreFailed | KeyCommandFailed
  >
  /** Removes what is kept under `name`; whether anything was. */
  readonly remove: (
    name: SecretName,
  ) => Effect.Effect<boolean, SecretStoreFailed>
}

export class Secrets extends Context.Service<Secrets, SecretsShape>()(
  '@fabrica/engine/secrets/Secrets',
) {}

/** How long a key's command may take, as Pi gives its own. */
const KEY_COMMAND_LIMIT = Duration.seconds(10)

/** What a key's command may print. */
const KEY_COMMAND_OUTPUT_LIMIT = 64 * 1024

/** Runs a key's command in `/bin/sh` and gives its output, trimmed, as the key. */
export const runKeyCommand = Effect.fn('Secrets.runKeyCommand')(
  function* (options: {
    readonly name: SecretName
    readonly command: string
    readonly cwd: string
  }) {
    const runner = yield* ProcessRunner
    const failed = (reason: string) =>
      new KeyCommandFailed({ name: options.name, reason })
    // Its output is the key, and what it writes to stderr can hold it too: neither is kept in a failure.
    const outcome = yield* runner.run({
      command: '/bin/sh',
      args: ['-c', options.command],
      cwd: options.cwd,
      timeLimit: KEY_COMMAND_LIMIT,
      outputLimit: KEY_COMMAND_OUTPUT_LIMIT,
    })
    return yield* CommandOutcome.$match(outcome, {
      Exited: ({ status, stdout }) =>
        ExitStatus.$match(status, {
          Code: ({ code }) => {
            if (code !== 0)
              return Effect.fail(failed(`exited with code ${code}`))
            const key = stdout.trim()
            return key === ''
              ? Effect.fail(failed('printed no key'))
              : Effect.succeed(Redacted.make(key))
          },
          Signal: ({ signal }) => Effect.fail(failed(`was ended by ${signal}`)),
        }),
      TimedOut: () => Effect.fail(failed('timed out')),
      Cut: () => Effect.fail(failed('printed more than a key')),
      FailedToStart: () => Effect.fail(failed("couldn't start")),
    })
  },
)

/** The Secrets service over `store`, running key commands in `cwd`. */
export const makeSecrets = Effect.fn('Secrets.make')(function* (options: {
  readonly store: ItemStore
  readonly cwd: string
}) {
  const { store } = options
  const runner = yield* ProcessRunner
  const lock = yield* Semaphore.make(1)

  const readNames = Effect.flatMap(
    store.read(NAMES_ITEM),
    Option.match({
      onNone: () => Effect.succeed<ReadonlyArray<SecretName>>([]),
      onSome: text =>
        Option.match(decodeNames(Redacted.value(text)), {
          onNone: () =>
            Effect.fail(
              new SecretStoreFailed({
                store: store.kind,
                operation: 'list its names',
                reason: 'the list of names it keeps is unreadable',
              }),
            ),
          onSome: names => Effect.succeed(names),
        }),
    }),
  )
  const writeNames = (names: ReadonlyArray<SecretName>) =>
    store.write(NAMES_ITEM, Redacted.make(encodeNames([...names].sort())))

  const set = Effect.fn('Secrets.set')(function* (
    name: SecretName,
    key: ApiKey,
  ) {
    yield* store.write(name, encodeApiKey(key))
    const names = yield* readNames
    if (!names.includes(name)) yield* writeNames([...names, name])
  }, lock.withPermit)

  const list = Effect.withSpan(readNames, 'Secrets.list')

  const get = Effect.fn('Secrets.get')(function* (name: SecretName) {
    const text = yield* store.read(name)
    if (Option.isNone(text)) return yield* new SecretMissing({ name })
    const key = decodeApiKey(text.value)
    if (Option.isNone(key))
      return yield* new SecretStoreFailed({
        store: store.kind,
        operation: 'read a credential',
        reason: `what is kept under ${name} isn't an API key this engine reads`,
      })
    return yield* ApiKey.$match(key.value, {
      Key: ({ key }) => Effect.succeed(key),
      Command: ({ command }) =>
        runKeyCommand({ name, command, cwd: options.cwd }).pipe(
          Effect.provideService(ProcessRunner, runner),
        ),
    })
  })

  const remove = Effect.fn('Secrets.remove')(function* (name: SecretName) {
    const [names, kept] = yield* Effect.all([readNames, store.read(name)], {
      concurrency: 'unbounded',
    })
    yield* store.remove(name)
    if (names.includes(name))
      yield* writeNames(names.filter(other => other !== name))
    return names.includes(name) || Option.isSome(kept)
  }, lock.withPermit)

  return Secrets.of({ store: store.kind, set, list, get, remove })
})

/** What the engine's secret store is chosen and opened from, each read once at its start. */
export interface SecretsConfig {
  readonly platform: NodeJS.Platform
  /** `<data>`: the encrypted file is under it, and keyring CLIs and key commands run in it. */
  readonly data: string
  /** For the encrypted file, where no keyring answers. */
  readonly passphrase: Option.Option<PassphraseSource>
  /** scrypt's cost for a new encrypted file; the default's where none is given. */
  readonly cost?: ScryptCost
}

/** The keyrings tried on a platform, in order. */
const keyringsOf = (
  platform: NodeJS.Platform,
  cli: KeyringCli['Service'],
): ReadonlyArray<Keyring> => {
  switch (platform) {
    case 'darwin':
      return [keychain(cli)]
    case 'linux':
      return [libsecret(cli)]
    default:
      return []
  }
}

/** The store the credentials are kept in: the first keyring that answers, or else the encrypted file, with a warning. */
export const chooseStore = Effect.fn('Secrets.chooseStore')(function* (
  config: SecretsConfig,
) {
  const cli = yield* KeyringCli
  for (const keyring of keyringsOf(config.platform, cli)) {
    if (yield* keyring.probe) return keyring.store
  }
  const source = config.passphrase
  if (Option.isNone(source))
    return yield* new PassphraseNeeded({
      path: NodePath.join(config.data, SECRETS_FILE),
    })
  const { store, path } = yield* openSecretsFile({
    data: config.data,
    passphrase: source.value,
    cost: config.cost,
  })
  yield* Effect.logWarning(
    `No keyring answers on this host: the engine keeps its credentials in ${path}, encrypted with its passphrase`,
  )
  return store
})

/** The Secrets service over the store `config` chooses, its keyring CLIs those `KeyringCli` runs. */
export const layer = (
  config: SecretsConfig,
): Layer.Layer<
  Secrets,
  PassphraseNeeded | PassphraseRefused | SecretStoreFailed,
  KeyringCli | ProcessRunner
> =>
  Layer.effect(
    Secrets,
    Effect.flatMap(chooseStore(config), store =>
      makeSecrets({ store, cwd: config.data }),
    ),
  )

/** The Secrets service with the keyring CLIs run by the engine's process runner. */
export const layerHost = (config: SecretsConfig) =>
  layer(config).pipe(Layer.provide(layerKeyringCli(config.data)))
