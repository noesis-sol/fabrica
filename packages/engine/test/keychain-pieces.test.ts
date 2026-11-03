import { Effect, Option, Redacted } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import {
  type KeyringCall,
  type KeyringCliShape,
  KeyringOutcome,
  keychain,
} from '../src/secrets'

// The macOS Keychain's long items (spec §20.3): `security -i` cuts a line past about 4,000 bytes, and a
// subscription's sign-in can be longer, a ChatGPT token being a long JWT. So a long item is kept in
// pieces, read back whole; a shorter one written over it, or its removal, leaves no piece behind.

const LINE_LIMIT = 4000

/** `security` as it answers, kept in memory, cutting a long line as it does. */
const fakeSecurity = () => {
  const items = new Map<string, string>()
  const exited = (code: number, stdout = '') =>
    KeyringOutcome.Exited({
      code,
      stdout: Redacted.make(stdout),
      stderr: Redacted.make(''),
    })
  const after = (args: ReadonlyArray<string>, flag: string) =>
    args[args.indexOf(flag) + 1] ?? ''
  const answer = (call: KeyringCall) => {
    const [operation] = call.args
    if (operation === '-i') {
      const line = Option.match(call.input, {
        onNone: () => '',
        onSome: Redacted.value,
      })
      if (Buffer.byteLength(line) > LINE_LIMIT) return exited(1)
      const words = line.trim().split(/\s+/u)
      items.set(after(words, '-a'), after(words, '-w'))
      return exited(0)
    }
    const account = after(call.args, '-a')
    const value = items.get(account)
    if (value === undefined) return exited(44)
    if (operation === 'delete-generic-password') items.delete(account)
    return exited(0, operation === 'find-generic-password' ? `${value}\n` : '')
  }
  const cli: KeyringCliShape = {
    call: call => Effect.sync(() => answer(call)),
  }
  return { items, store: keychain(cli).store }
}

const kept = (text: string) => Redacted.make(text)

const readBack = (
  store: ReturnType<typeof fakeSecurity>['store'],
  name: string,
) =>
  Effect.map(store.read(name), value =>
    Option.map(value, text => Redacted.value(text)),
  )

describe('a long item in the keychain', () => {
  it.effect('is kept in pieces and read back whole', () =>
    Effect.gen(function* () {
      const { items, store } = fakeSecurity()
      const long = 'x'.repeat(9000)
      yield* store.write('openai', kept(long))
      expect(items.get('openai')).toMatch(/^pieces:\d+$/u)
      expect(items.size).toBeGreaterThan(2)
      expect(yield* readBack(store, 'openai')).toStrictEqual(Option.some(long))
    }),
  )

  it.effect('leaves no piece behind once a shorter one is written', () =>
    Effect.gen(function* () {
      const { items, store } = fakeSecurity()
      yield* store.write('openai', kept('x'.repeat(9000)))
      yield* store.write('openai', kept('short'))
      expect([...items.keys()]).toStrictEqual(['openai'])
      expect(yield* readBack(store, 'openai')).toStrictEqual(
        Option.some('short'),
      )
    }),
  )

  it.effect('leaves no piece behind once removed', () =>
    Effect.gen(function* () {
      const { items, store } = fakeSecurity()
      yield* store.write('openai', kept('x'.repeat(9000)))
      yield* store.remove('openai')
      expect(items.size).toBe(0)
      expect(yield* readBack(store, 'openai')).toStrictEqual(Option.none())
    }),
  )

  it.effect(
    'says so where a piece is missing, rather than give part of it',
    () =>
      Effect.gen(function* () {
        const { items, store } = fakeSecurity()
        yield* store.write('openai', kept('x'.repeat(9000)))
        items.delete('openai~1')
        const failed = yield* Effect.flip(store.read('openai'))
        expect(failed.message).toContain('a piece of openai is missing')
      }),
  )

  it.effect('keeps a short item whole, under its name', () =>
    Effect.gen(function* () {
      const { items, store } = fakeSecurity()
      yield* store.write('anthropic', kept('sk-short'))
      expect(items.size).toBe(1)
      expect(items.get('anthropic')).toBe(
        Buffer.from('sk-short').toString('base64'),
      )
    }),
  )
})
