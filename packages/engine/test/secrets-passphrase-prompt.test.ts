import { Effect, Layer, Option, Redacted } from 'effect'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'

import {
  KeyringCli,
  KeyringOutcome,
  PassphraseSource,
  SECRETS_FILE,
  chooseStore,
} from '../src/secrets'

// The passphrase typed at the engine's prompt (spec §20.3): asked only where no keyring answers, once
// for a file already there and twice for a new one, whose typo would lock its credentials; refused,
// saying why, where nothing or nothing alike was typed, or it doesn't open the file.

let root = ''

beforeAll(() => {
  root = realpathSync(
    mkdtempSync(NodePath.join(tmpdir(), 'fabrica-passphrase-prompt-')),
  )
})

const tempFolder = (prefix: string) =>
  Effect.sync(() => mkdtempSync(NodePath.join(root, `${prefix}-`)))

/** scrypt at a test's cost. */
const COST = { N: 2 ** 10, r: 8, p: 1 }

/** secret-tool as libsecret answers: with a Secret Service, an item it doesn't hold; without, D-Bus's refusal. */
const keyring = (options: { readonly answers: boolean }) =>
  Layer.succeed(
    KeyringCli,
    KeyringCli.of({
      call: ({ args }) =>
        Effect.succeed(
          KeyringOutcome.Exited({
            // `search` lists nothing and exits 0; `lookup` exits 1, saying nothing.
            code: options.answers && args[0] === 'search' ? 0 : 1,
            stdout: Redacted.make(''),
            stderr: Redacted.make(
              options.answers
                ? ''
                : 'Cannot autolaunch D-Bus without X11 $DISPLAY',
            ),
          }),
        ),
    }),
  )

/** A prompt answered from `typed` in turn, each message it shows kept; none once `typed` runs out. */
const scriptedPrompt = (typed: ReadonlyArray<string>) => {
  const asked: Array<string> = []
  const source = PassphraseSource.Prompted({
    ask: message =>
      Effect.sync(() => {
        const answer = typed[asked.length]
        asked.push(message)
        return Option.map(Option.fromUndefinedOr(answer), text =>
          Redacted.make(text),
        )
      }),
  })
  return { asked, source }
}

/** The store chosen on Linux for `data`, with the passphrase `source` gives. */
const open = (
  data: string,
  source: PassphraseSource,
  options: { readonly keyringAnswers: boolean } = { keyringAnswers: false },
) =>
  chooseStore({
    platform: 'linux',
    data,
    passphrase: Option.some(source),
    cost: COST,
  }).pipe(Effect.provide(keyring({ answers: options.keyringAnswers })))

describe('the passphrase typed at the prompt', () => {
  it.effect('is typed twice for a new file, then once to open it again', () =>
    Effect.gen(function* () {
      const data = yield* tempFolder('new')
      const path = NodePath.join(data, SECRETS_FILE)
      const first = scriptedPrompt(['tr0ub4dor', 'tr0ub4dor'])
      const store = yield* open(data, first.source)
      expect(store.kind).toBe('file')
      expect(first.asked).toStrictEqual([
        `A new passphrase for the engine's credentials, in ${path}: `,
        'The same passphrase again: ',
      ])
      yield* store.write('anthropic', Redacted.make('sk-typed'))

      const again = scriptedPrompt(['tr0ub4dor'])
      const reopened = yield* open(data, again.source)
      expect(again.asked).toStrictEqual([
        `The passphrase for the engine's credentials, in ${path}: `,
      ])
      const kept = yield* reopened.read('anthropic')
      expect(Option.map(kept, Redacted.value)).toStrictEqual(
        Option.some('sk-typed'),
      )
    }),
  )

  it.effect('is refused where the two typed for a new file differ', () =>
    Effect.gen(function* () {
      const data = yield* tempFolder('differ')
      const refused = yield* Effect.flip(
        open(data, scriptedPrompt(['tr0ub4dor', 'troubador']).source),
      )
      expect(refused._tag).toBe('PassphraseRefused')
      expect(refused.message).toContain("the two passphrases typed don't match")
      expect(existsSync(NodePath.join(data, SECRETS_FILE))).toBe(false)
    }),
  )

  it.effect(
    'is refused where nothing is typed, an empty one is, or it doesn’t open the file',
    () =>
      Effect.gen(function* () {
        const data = yield* tempFolder('refused')
        const ended = yield* Effect.flip(open(data, scriptedPrompt([]).source))
        expect(ended._tag).toBe('PassphraseRefused')
        expect(ended.message).toContain('no passphrase was typed')
        const empty = yield* Effect.flip(
          open(data, scriptedPrompt(['']).source),
        )
        expect(empty.message).toContain('the passphrase typed is empty')

        const made = yield* open(
          data,
          scriptedPrompt(['right', 'right']).source,
        )
        yield* made.write('anthropic', Redacted.make('sk-typed'))
        const wrong = yield* Effect.flip(
          open(data, scriptedPrompt(['wrong']).source),
        )
        expect(wrong._tag).toBe('PassphraseRefused')
        expect(wrong.message).toContain("the passphrase doesn't open it")
      }),
  )

  it.effect('is never asked where a keyring answers', () =>
    Effect.gen(function* () {
      const data = yield* tempFolder('keyring')
      const prompt = scriptedPrompt(['unused', 'unused'])
      const store = yield* open(data, prompt.source, { keyringAnswers: true })
      expect(store.kind).toBe('libsecret')
      expect(prompt.asked).toStrictEqual([])
    }),
  )
})
