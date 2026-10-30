import {
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
  Semaphore,
} from 'effect'

import { EngineName, KnownEngine } from '@fabrica/client'
import { readFileText, writeFileWhole } from '@fabrica/engine/files'

// The app's own state (spec §5, §9.1): the engines it knows (a name, how to reach it, the engine's ID
// and protocol version), and the pairing tokens of those reached over TLS, encrypted with Electron's
// safeStorage (the Keychain, DPAPI, or the Linux keyring). It is one file in the app's data folder,
// written whole through the engine's writer, so a crash leaves the old state or the new one. The
// known engines' schemas are the client's, which the renderer decodes them with too.

export { EngineAddress, EngineName, KnownEngine } from '@fabrica/client'

/** The state file: the known engines, and each paired engine's token, encrypted, as base64. */
const StateFile = Schema.Struct({
  version: Schema.Literal(1),
  engines: Schema.Array(KnownEngine),
  tokens: Schema.Record(EngineName, Schema.String),
})
type StateFile = typeof StateFile.Type

const StateJson = Schema.fromJsonString(StateFile)
const decodeState = Schema.decodeUnknownEffect(StateJson)
const encodeState = Schema.encodeEffect(StateJson)

/** The state file's name in the app's data folder. */
export const stateFileName = 'state.json'

/** The most the state file may hold. */
const stateFileMaxBytes = 1024 * 1024

const emptyState: StateFile = { version: 1, engines: [], tokens: {} }

/** The state file couldn't be read or written, or isn't the app's. */
export class AppStateFailed extends Data.TaggedError('AppStateFailed')<{
  readonly operation: string
  readonly reason: string
}> {}

/** A secret can't be kept encrypted: no keyring (Linux), or safeStorage not ready. */
export class NoSecretStorage extends Data.TaggedError('NoSecretStorage')<{
  readonly reason: string
}> {}

/** No engine of that name is known. */
export class EngineUnknown extends Data.TaggedError('EngineUnknown')<{
  readonly name: EngineName
}> {}

/** What encrypts the app's secrets: safeStorage, or a stand-in in tests. */
export interface SecretBox {
  /** Why secrets can't be kept here, when they can't. */
  readonly unavailable: () => Option.Option<string>
  readonly encrypt: (text: string) => Uint8Array
  readonly decrypt: (bytes: Uint8Array) => string
}

/** The part of Electron's safeStorage a SecretBox uses. */
export interface SafeStorage {
  readonly isEncryptionAvailable: () => boolean
  readonly getSelectedStorageBackend?: () => string
  readonly encryptString: (text: string) => Uint8Array
  readonly decryptString: (bytes: Buffer) => string
}

/**
 * safeStorage as a SecretBox on `platform`. On Linux without a keyring, safeStorage encrypts with a
 * key written in Electron itself (its "basic_text" backend), which protects nothing, so a token isn't
 * kept there at all.
 */
export const safeStorageBox = (
  safeStorage: SafeStorage,
  platform: NodeJS.Platform,
): SecretBox => ({
  unavailable: () => {
    if (!safeStorage.isEncryptionAvailable()) {
      return Option.some('encryption is not available')
    }
    if (
      platform === 'linux' &&
      safeStorage.getSelectedStorageBackend?.() === 'basic_text'
    ) {
      return Option.some(
        'no keyring (Secret Service or KWallet) is running to keep it in',
      )
    }
    return Option.none()
  },
  encrypt: text => safeStorage.encryptString(text),
  decrypt: bytes => safeStorage.decryptString(Buffer.from(bytes)),
})

export interface AppStateShape {
  /** The known engines, in the order they were added. */
  readonly engines: Effect.Effect<ReadonlyArray<KnownEngine>, AppStateFailed>
  /** Adds `engine`, or replaces the one of its name. */
  readonly saveEngine: (
    engine: KnownEngine,
  ) => Effect.Effect<void, AppStateFailed>
  /** Forgets the engine named `name` and its token. */
  readonly removeEngine: (
    name: EngineName,
  ) => Effect.Effect<void, AppStateFailed>
  /** Keeps `token` for the known engine named `engine`, encrypted. */
  readonly saveToken: (input: {
    readonly engine: EngineName
    readonly token: Redacted.Redacted<string>
  }) => Effect.Effect<void, AppStateFailed | NoSecretStorage | EngineUnknown>
  /** The token kept for the engine named `engine`, if any. */
  readonly token: (
    engine: EngineName,
  ) => Effect.Effect<
    Option.Option<Redacted.Redacted<string>>,
    AppStateFailed | NoSecretStorage
  >
}

export class AppState extends Context.Service<AppState, AppStateShape>()(
  '@fabrica/desktop/AppState',
) {}

/** The app's state in `folder` (the app's data folder), its secrets kept by `secrets`. */
export const makeAppState = Effect.fn('AppState.make')(function* ({
  folder,
  secrets,
}: {
  readonly folder: string
  readonly secrets: SecretBox
}) {
  const location = { root: folder, path: stateFileName }
  const lock = yield* Semaphore.make(1)

  const read = readFileText(location, { maxBytes: stateFileMaxBytes }).pipe(
    Effect.flatMap(text => decodeState(text)),
    Effect.catchTag('FileMissing', () => Effect.succeed(emptyState)),
    Effect.mapError(
      failure =>
        new AppStateFailed({
          operation: `read ${stateFileName}`,
          reason: failure.message,
        }),
    ),
    Effect.withSpan('AppState.read'),
  )

  const write = (state: StateFile) =>
    encodeState(state).pipe(
      Effect.flatMap(text => writeFileWhole(location, text, { mode: 0o600 })),
      Effect.mapError(
        failure =>
          new AppStateFailed({
            operation: `write ${stateFileName}`,
            reason: failure.message,
          }),
      ),
      Effect.withSpan('AppState.write'),
    )

  /** Reads the state, changes it with `change`, and writes it, one change at a time. */
  const update = <E>(
    change: (state: StateFile) => Effect.Effect<StateFile, E>,
  ): Effect.Effect<void, AppStateFailed | E> =>
    lock.withPermits(1)(
      read.pipe(Effect.flatMap(change), Effect.flatMap(write)),
    )

  const secretsReady = Option.match(secrets.unavailable(), {
    onNone: () => Effect.void,
    onSome: reason => Effect.fail(new NoSecretStorage({ reason })),
  })

  const engines = read.pipe(Effect.map(state => state.engines))

  const saveEngine = Effect.fn('AppState.saveEngine')(function* (
    engine: KnownEngine,
  ) {
    yield* update(state =>
      Effect.succeed({
        ...state,
        engines: state.engines.some(known => known.name === engine.name)
          ? state.engines.map(known =>
              known.name === engine.name ? engine : known,
            )
          : [...state.engines, engine],
      }),
    )
  })

  const removeEngine = Effect.fn('AppState.removeEngine')(function* (
    name: EngineName,
  ) {
    yield* update(state =>
      Effect.succeed({
        ...state,
        engines: state.engines.filter(known => known.name !== name),
        tokens: Object.fromEntries(
          Object.entries(state.tokens).filter(([engine]) => engine !== name),
        ),
      }),
    )
  })

  const saveToken = Effect.fn('AppState.saveToken')(function* ({
    engine,
    token,
  }: {
    readonly engine: EngineName
    readonly token: Redacted.Redacted<string>
  }) {
    yield* secretsReady
    yield* update(state =>
      state.engines.some(known => known.name === engine)
        ? Effect.succeed({
            ...state,
            tokens: {
              ...state.tokens,
              [engine]: Buffer.from(
                secrets.encrypt(Redacted.value(token)),
              ).toString('base64'),
            },
          })
        : Effect.fail(new EngineUnknown({ name: engine })),
    )
  })

  const token = Effect.fn('AppState.token')(function* (engine: EngineName) {
    const state = yield* read
    const sealed = Option.fromUndefinedOr(state.tokens[engine])
    if (Option.isNone(sealed)) {
      return Option.none()
    }
    yield* secretsReady
    return yield* Effect.try({
      try: () =>
        Option.some(
          Redacted.make(secrets.decrypt(Buffer.from(sealed.value, 'base64'))),
        ),
      catch: cause =>
        new AppStateFailed({
          operation: `decrypt the token of ${engine}`,
          reason: String(cause),
        }),
    })
  })

  return AppState.of({ engines, saveEngine, removeEngine, saveToken, token })
})

/** The AppState service over `options`. */
export const layer = (options: {
  readonly folder: string
  readonly secrets: SecretBox
}) => Layer.effect(AppState, makeAppState(options))
