import { Effect, Exit, Option, Redacted } from 'effect'

import { describe, expect, it } from '@effect/vitest'
import { EngineId } from '@fabrica/contracts'
import { tempFolder } from '@fabrica/testkit'

import {
  EngineAddress,
  KnownEngine,
  type SafeStorage,
  makeAppState,
  safeStorageBox,
} from '../src/main/state'

// The app state is made before the app is ready, when safeStorage on Windows and Linux says encryption
// isn't available yet (spec §5, §9.3): whether a secret can be kept is asked at each use, so a token is
// kept once the app is ready.

/** A stand-in for safeStorage that becomes available when `ready` is called, as Electron's does. */
const readyLater = () => {
  let ready = false
  const storage: SafeStorage = {
    isEncryptionAvailable: () => ready,
    getSelectedStorageBackend: () => (ready ? 'gnome_libsecret' : 'unknown'),
    encryptString: text => Buffer.from(`sealed:${text}`),
    decryptString: bytes => bytes.toString().slice('sealed:'.length),
  }
  return {
    storage,
    ready: () => {
      ready = true
    },
  }
}

const paired = KnownEngine.make({
  name: 'paired',
  address: EngineAddress.cases.Tls.make({
    host: 'build.example.com',
    port: 7443,
    fingerprint: Array.from({ length: 32 }, () => 'AB').join(':'),
  }),
  engine: EngineId.make('engine-paired'),
  protocol: 1,
})

describe('secrets in the app state made before the app is ready', () => {
  it.effect(
    'can’t be kept before safeStorage is available, and are once it is',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const folder = yield* tempFolder('state-secrets-ready')
          const { storage, ready } = readyLater()
          const state = yield* makeAppState({
            folder,
            secrets: safeStorageBox(storage, 'linux'),
          })
          yield* state.saveEngine(paired)
          const token = Redacted.make('pairing-token')

          const before = yield* Effect.exit(state.secretsReady)
          expect(Exit.isFailure(before)).toBe(true)
          const early = yield* Effect.flip(
            state.saveToken({ engine: paired.name, token }),
          )
          expect(early._tag).toBe('NoSecretStorage')

          ready()
          yield* state.secretsReady
          yield* state.saveToken({ engine: paired.name, token })
          const kept = yield* state.token(paired.name)
          expect(Option.map(kept, Redacted.value)).toEqual(
            Option.some('pairing-token'),
          )
        }),
      ),
  )
})
