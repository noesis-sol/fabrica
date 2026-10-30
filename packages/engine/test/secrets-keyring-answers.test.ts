import { Effect, Option, Redacted } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import {
  type KeyringCall,
  KeyringCli,
  KeyringOutcome,
  chooseStore,
  keychain,
  libsecret,
} from '../src/secrets'

// The keyrings as their CLIs were seen to answer on real hosts: secret-tool (libsecret 0.21.7) against
// GNOME Keyring 50 and KWallet 6.24, unlocked, locked and unreachable; `security` on a keychain it
// may not ask to unlock. Each test stubs the CLI boundary with those answers.

const exited = (code: number, stdout = '', stderr = '') =>
  KeyringOutcome.Exited({
    code,
    stdout: Redacted.make(stdout),
    stderr: Redacted.make(stderr),
  })

/** A keyring CLI giving `answer`'s outcome to each call, and every call made. */
const answering = (answer: (call: KeyringCall) => KeyringOutcome) => {
  const calls: Array<KeyringCall> = []
  const cli = KeyringCli.of({
    call: call =>
      Effect.sync(() => {
        calls.push(call)
        return answer(call)
      }),
  })
  return { cli, calls }
}

/** secret-tool's answers where its keyring holds `anthropic` in a collection it can't unlock. */
const lockedCollection = (call: KeyringCall) => {
  switch (call.args[0]) {
    case 'search':
      return exited(
        0,
        '[/org/freedesktop/secrets/collection/login/5]\nlabel = Fabrica: anthropic\n',
        'secret-tool: Cannot get secret of a locked object\nattribute.account = anthropic\n',
      )
    case 'store':
      return exited(
        1,
        '',
        'secret-tool: Cannot create an item in a locked collection\n',
      )
    default:
      return exited(1)
  }
}

describe('libsecret, as secret-tool answers', () => {
  it.effect(
    'reads an item in a locked collection as a failure, not as missing',
    () =>
      Effect.gen(function* () {
        const { cli, calls } = answering(lockedCollection)
        const { store } = libsecret(cli)
        const read = yield* Effect.flip(store.read('anthropic'))
        expect(read._tag).toBe('SecretStoreFailed')
        expect(read.message).toContain('locked')
        const removed = yield* Effect.flip(store.remove('anthropic'))
        expect(removed.message).toContain('locked')
        // The item is looked for without its secret and without asking to unlock it.
        expect(calls.filter(call => call.args[0] === 'search')).toEqual([
          {
            command: 'secret-tool',
            args: ['search', 'service', 'fabrica', 'account', 'anthropic'],
            input: Option.none(),
          },
          {
            command: 'secret-tool',
            args: ['search', 'service', 'fabrica', 'account', 'anthropic'],
            input: Option.none(),
          },
        ])
      }),
  )

  it.effect('reads an item missing where search finds none either', () =>
    Effect.gen(function* () {
      const { cli } = answering(call =>
        call.args[0] === 'search' ? exited(0) : exited(1),
      )
      const keyring = libsecret(cli)
      expect(yield* keyring.store.read('anthropic')).toEqual(Option.none())
      yield* keyring.store.remove('anthropic')
      expect(yield* keyring.probe).toBe(true)
    }),
  )

  it.effect("says it fails where the Secret Service can't be reached", () =>
    Effect.gen(function* () {
      for (const message of [
        'secret-tool: Could not connect: No such file or directory\n',
        'secret-tool: The name org.freedesktop.secrets was not provided by any .service files\n',
      ]) {
        const { cli, calls } = answering(() => exited(1, '', message))
        const keyring = libsecret(cli)
        const read = yield* Effect.flip(keyring.store.read('anthropic'))
        expect(read._tag).toBe('SecretStoreFailed')
        expect(yield* keyring.probe).toBe(false)
        expect(calls.every(call => call.args[0] === 'lookup')).toBe(true)
      }
    }),
  )

  it.effect(
    'refuses a credential secret-tool would cut, before it is run',
    () =>
      Effect.gen(function* () {
        const { cli, calls } = answering(() => exited(0))
        const { store } = libsecret(cli)
        // secret-tool keeps 8,191 bytes of its stdin whole: 6,141 bytes are 8,188 in base64, 6,142 are 8,192.
        yield* store.write('longest', Redacted.make('k'.repeat(6141)))
        expect(calls).toHaveLength(1)
        const [written] = calls
        expect(
          Option.map(written?.input ?? Option.none(), Redacted.value),
        ).toEqual(Option.some(Buffer.from('k'.repeat(6141)).toString('base64')))
        const refused = yield* Effect.flip(
          store.write('too-long', Redacted.make('k'.repeat(6142))),
        )
        expect(refused._tag).toBe('SecretStoreFailed')
        expect(refused.message).toContain('8191 bytes')
        expect(calls).toHaveLength(1)
      }),
  )

  it.effect('says a write to a locked collection failed', () =>
    Effect.gen(function* () {
      const { cli } = answering(lockedCollection)
      const { store } = libsecret(cli)
      const written = yield* Effect.flip(
        store.write('anthropic', Redacted.make('sk-test')),
      )
      expect(written._tag).toBe('SecretStoreFailed')
    }),
  )
})

describe('the keychain, as security answers', () => {
  it.effect('names a lock it may not ask to open, as over SSH', () =>
    Effect.gen(function* () {
      const { cli } = answering(() =>
        exited(36, '', 'User interaction is not allowed.\n'),
      )
      const { store } = keychain(cli)
      const read = yield* Effect.flip(store.read('anthropic'))
      expect(read.message).toContain('security unlock-keychain')
      const written = yield* Effect.flip(
        store.write('anthropic', Redacted.make('sk-test')),
      )
      expect(written.message).toContain('security unlock-keychain')
    }),
  )
})

describe('the store a Linux host chooses', () => {
  it.effect(
    'is the Secret Service or the encrypted file: no other keyring CLI is tried',
    () =>
      Effect.gen(function* () {
        const { cli, calls } = answering(() =>
          exited(1, '', 'secret-tool: Could not connect: No such file\n'),
        )
        const chosen = yield* Effect.flip(
          chooseStore({
            platform: 'linux',
            data: '/data',
            passphrase: Option.none(),
          }).pipe(Effect.provideService(KeyringCli, cli)),
        )
        expect(chosen._tag).toBe('PassphraseNeeded')
        expect(calls.map(call => call.command)).toEqual(['secret-tool'])
      }),
  )
})
