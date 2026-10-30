import { Effect, Option, Redacted } from 'effect'
import { readFile, stat, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { EngineId } from '@fabrica/contracts'
import { tempFolder } from '@fabrica/testkit'

import {
  EngineAddress,
  KnownEngine,
  type SafeStorage,
  type SecretBox,
  makeAppState,
  safeStorageBox,
  stateFileName,
} from '../src/main/state'

// The app's own state (spec §5, §9.1): the known engines in its data folder, and the pairing tokens
// encrypted by safeStorage, never kept where there is no keyring.

/** A stand-in for safeStorage: reverses and marks the text, so a test can tell it was encrypted. */
const fakeSecrets = (
  unavailable: Option.Option<string> = Option.none(),
): SecretBox => ({
  unavailable: () => unavailable,
  encrypt: text => Buffer.from(`sealed:${[...text].toReversed().join('')}`),
  decrypt: bytes => {
    const text = Buffer.from(bytes).toString('utf8')
    if (!text.startsWith('sealed:')) {
      throw new Error('not sealed here')
    }
    return Array.from(text.slice('sealed:'.length)).toReversed().join('')
  },
})

const engine = (name: string, address: EngineAddress) =>
  KnownEngine.make({
    name,
    address,
    engine: EngineId.make(`engine-${name}`),
    protocol: 1,
  })

const local = engine('local', EngineAddress.cases.Local.make({}))
const server = engine(
  'server-1',
  EngineAddress.cases.Ssh.make({ destination: 'me@server-1' }),
)
const paired = engine(
  'paired',
  EngineAddress.cases.Tls.make({
    host: 'build.example.com',
    port: 7443,
    fingerprint: Array.from({ length: 32 }, () => 'AB').join(':'),
  }),
)

describe('the app state', () => {
  it.effect(
    'knows no engine at first, and keeps those it is given across starts, in order',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const folder = yield* tempFolder('state')
          const state = yield* makeAppState({ folder, secrets: fakeSecrets() })
          expect(yield* state.engines).toEqual([])
          yield* state.saveEngine(local)
          yield* state.saveEngine(server)
          const moved = engine(
            'local',
            EngineAddress.cases.Wsl.make({ distro: 'Ubuntu' }),
          )
          yield* state.saveEngine(moved)
          const again = yield* makeAppState({ folder, secrets: fakeSecrets() })
          expect(yield* again.engines).toEqual([moved, server])
          const mode = (yield* Effect.promise(() =>
            stat(NodePath.join(folder, stateFileName)),
          )).mode
          expect(mode & 0o777).toBe(0o600)
        }),
      ),
  )

  it.effect(
    'keeps a token encrypted, gives it back, and forgets it with its engine',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const folder = yield* tempFolder('state')
          const state = yield* makeAppState({ folder, secrets: fakeSecrets() })
          yield* state.saveEngine(paired)
          yield* state.saveToken({
            engine: 'paired',
            token: Redacted.make('fab_token_1234'),
          })
          const file = yield* Effect.promise(() =>
            readFile(NodePath.join(folder, stateFileName), 'utf8'),
          )
          expect(file).not.toContain('fab_token_1234')
          expect(file).not.toContain('4321_nekot_baf')
          const token = yield* state.token('paired')
          expect(Option.map(token, Redacted.value)).toEqual(
            Option.some('fab_token_1234'),
          )
          expect(yield* state.token('local')).toEqual(Option.none())
          yield* state.removeEngine('paired')
          expect(yield* state.engines).toEqual([])
          expect(yield* state.token('paired')).toEqual(Option.none())
        }),
      ),
  )

  it.effect(
    'keeps no token for an engine it doesn’t know, or with no keyring',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const folder = yield* tempFolder('state')
          const state = yield* makeAppState({ folder, secrets: fakeSecrets() })
          const unknown = yield* Effect.flip(
            state.saveToken({ engine: 'paired', token: Redacted.make('t') }),
          )
          expect(unknown).toMatchObject({
            _tag: 'EngineUnknown',
            name: 'paired',
          })

          const locked = yield* makeAppState({
            folder,
            secrets: fakeSecrets(Option.some('no keyring')),
          })
          yield* locked.saveEngine(paired)
          const refused = yield* Effect.flip(
            locked.saveToken({ engine: 'paired', token: Redacted.make('t') }),
          )
          expect(refused).toMatchObject({
            _tag: 'NoSecretStorage',
            reason: 'no keyring',
          })
        }),
      ),
  )

  it.effect(
    'fails on a state file that isn’t its own, rather than replacing it',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const folder = yield* tempFolder('state')
          const path = NodePath.join(folder, stateFileName)
          yield* Effect.promise(() => writeFile(path, '{"version": 9}'))
          const state = yield* makeAppState({ folder, secrets: fakeSecrets() })
          expect(yield* Effect.flip(state.engines)).toMatchObject({
            _tag: 'AppStateFailed',
          })
          expect(yield* Effect.flip(state.saveEngine(local))).toMatchObject({
            _tag: 'AppStateFailed',
          })
          expect(yield* Effect.promise(() => readFile(path, 'utf8'))).toBe(
            '{"version": 9}',
          )
        }),
      ),
  )
})

describe('safeStorage as the secret box', () => {
  const storage = (available: boolean, backend: string): SafeStorage => ({
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: text => Buffer.from(text),
    decryptString: bytes => bytes.toString(),
  })

  it('is there with a keyring, or on macOS and Windows once encryption is', () => {
    expect(
      safeStorageBox(storage(true, 'gnome_libsecret'), 'linux').unavailable(),
    ).toEqual(Option.none())
    expect(
      safeStorageBox(storage(true, 'unknown'), 'darwin').unavailable(),
    ).toEqual(Option.none())
  })

  it('isn’t with Linux’s basic_text backend, whose key is in Electron, or before encryption is ready', () => {
    expect(
      Option.isSome(
        safeStorageBox(storage(true, 'basic_text'), 'linux').unavailable(),
      ),
    ).toBe(true)
    expect(
      Option.isSome(
        safeStorageBox(storage(false, 'unknown'), 'win32').unavailable(),
      ),
    ).toBe(true)
  })
})
