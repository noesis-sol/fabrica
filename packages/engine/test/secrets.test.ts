import { Duration, Effect, Layer, Logger, Option, Redacted } from 'effect'
import { mkdtempSync, realpathSync } from 'node:fs'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'

import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import {
  ApiKey,
  type KeyringCall,
  KeyringCli,
  KeyringOutcome,
  PassphraseSource,
  SECRETS_FILE,
  SecretName,
  Secrets,
  type SecretsConfig,
  layer as secretsLayer,
  layerHost as secretsLayerHost,
} from '../src/secrets'

// The secret store (spec §20.3): set, list (names only), get and remove against the encrypted file,
// and against each keyring through a stubbed CLI boundary; a key's command run for its key; the
// fallback to the file, with its warning; no secret on a command line or in a log.

let root = ''

beforeAll(() => {
  root = realpathSync(mkdtempSync(NodePath.join(tmpdir(), 'fabrica-secrets-')))
})

/** A new empty folder of the test's. */
const tempFolder = (prefix: string) =>
  Effect.sync(() => mkdtempSync(NodePath.join(root, `${prefix}-`)))

/** scrypt at a test's cost: the default's takes a tenth of a second a derivation. */
const COST = { N: 2 ** 10, r: 8, p: 1 }

const KEY = 'sk-test-0123456789abcdef'
const anthropic = SecretName.make('anthropic')
const openai = SecretName.make('openai.work')

/** A runner over `path` (the host's own shell tools), and nothing of the host's environment. */
const runner = (home: string, path = '/usr/bin:/bin') =>
  Layer.provide(
    runnerLayer({
      hostEnvironment: { PATH: path, HOME: home, LANG: 'C' },
      enginePriority: 0,
      priority: hostPriority,
      listProcesses,
      pipeHolders: hostHolders({
        platform: process.platform,
        self: process.pid,
      }),
      self: process.pid,
      killGrace: Duration.seconds(2),
      outputGrace: Duration.millis(200),
    } satisfies RunnerConfig),
    layerClock,
  )

/** Every message logged, for a test to look through. */
const capturedLogs = () => {
  const messages: Array<string> = []
  const logger = Logger.make(({ message }) => {
    messages.push(Array.isArray(message) ? message.join(' ') : String(message))
  })
  return { messages, layer: Logger.layer([logger]) }
}

/** Keyrings as their CLIs answer, kept in memory; `reachable` false answers as a host with none. */
const fakeKeyrings = (options: { readonly reachable: boolean }) => {
  const items = new Map<string, string>()
  const calls: Array<KeyringCall> = []
  const exited = (code: number, stdout = '', stderr = '') =>
    KeyringOutcome.Exited({
      code,
      stdout: Redacted.make(stdout),
      stderr: Redacted.make(stderr),
    })
  const after = (args: ReadonlyArray<string>, flag: string) =>
    args[args.indexOf(flag) + 1] ?? ''
  const input = (call: KeyringCall) =>
    Option.match(call.input, { onNone: () => '', onSome: Redacted.value })
  const security = (call: KeyringCall) => {
    const [operation] = call.args
    if (operation === '-i') {
      const words = input(call).trim().split(/\s+/u)
      if (words[0] !== 'add-generic-password') return exited(1)
      items.set(`keychain/${after(words, '-a')}`, after(words, '-w'))
      return exited(0)
    }
    const key = `keychain/${after(call.args, '-a')}`
    const value = items.get(key)
    if (value === undefined) return exited(44, '', 'could not be found')
    if (operation === 'delete-generic-password') items.delete(key)
    return exited(0, operation === 'find-generic-password' ? `${value}\n` : '')
  }
  const secretTool = (call: KeyringCall) => {
    const key = `libsecret/${after(call.args, 'account')}`
    switch (call.args[0]) {
      case 'store':
        items.set(key, input(call))
        return exited(0)
      case 'lookup': {
        const value = items.get(key)
        return value === undefined ? exited(1) : exited(0, value)
      }
      default:
        items.delete(key)
        return exited(0)
    }
  }
  const kwalletQuery = (call: KeyringCall) => {
    if (!call.args.includes('-f')) return exited(0)
    if (call.args[0] === '-l') {
      const entries = [...items.keys()]
        .filter(key => key.startsWith('kwallet/'))
        .map(key => key.slice('kwallet/'.length))
      return entries.length === 0 ? exited(1) : exited(0, entries.join('\n'))
    }
    const key = `kwallet/${call.args[1] ?? ''}`
    if (call.args[0] === '-w') {
      items.set(key, input(call))
      return exited(0)
    }
    return exited(0, `${items.get(key) ?? ''}\n`)
  }
  const call = (call: KeyringCall) =>
    Effect.sync(() => {
      calls.push(call)
      if (!options.reachable)
        return call.command === 'secret-tool'
          ? exited(1, '', 'Cannot autolaunch D-Bus without X11 $DISPLAY')
          : KeyringOutcome.Failed({
              reason: `${call.command} isn't on the PATH`,
            })
      switch (call.command) {
        case 'security':
          return security(call)
        case 'secret-tool':
          return secretTool(call)
        default:
          return kwalletQuery(call)
      }
    })
  const layer = Layer.succeed(KeyringCli, KeyringCli.of({ call }))
  return { items, calls, call, layer }
}

/** Sets two credentials, reads them back, lists them, and removes one, through `Secrets`. */
const roundTrip = Effect.gen(function* () {
  const secrets = yield* Secrets
  yield* secrets.set(anthropic, ApiKey.Key({ key: Redacted.make(KEY) }))
  yield* secrets.set(openai, ApiKey.Key({ key: Redacted.make('sk-other') }))
  expect(yield* secrets.list).toEqual([anthropic, openai])
  expect(Redacted.value(yield* secrets.get(anthropic))).toBe(KEY)
  // Set again, a name keeps its one place in the list and takes the new key.
  yield* secrets.set(openai, ApiKey.Key({ key: Redacted.make('sk-newer') }))
  expect(Redacted.value(yield* secrets.get(openai))).toBe('sk-newer')
  expect(yield* secrets.remove(openai)).toBe(true)
  expect(yield* secrets.remove(openai)).toBe(false)
  expect(yield* secrets.list).toEqual([anthropic])
  const missing = yield* Effect.flip(secrets.get(openai))
  expect(missing._tag).toBe('SecretMissing')
  return secrets.store
})

const fileConfig = (
  data: string,
  passphrase: PassphraseSource = PassphraseSource.Given({
    passphrase: Redacted.make('correct horse battery staple'),
  }),
): SecretsConfig => ({
  platform: 'linux',
  data,
  passphrase: Option.some(passphrase),
  cost: COST,
})

describe('the encrypted file', () => {
  it.effect(
    'keeps credentials by name, sealed, mode 0600, and warns that it is used',
    () =>
      Effect.gen(function* () {
        const data = yield* tempFolder('secrets-file')
        const logs = capturedLogs()
        const keyrings = fakeKeyrings({ reachable: false })
        const store = yield* roundTrip.pipe(
          Effect.provide(
            Layer.merge(
              secretsLayer(fileConfig(data)).pipe(
                Layer.provide(
                  Layer.mergeAll(keyrings.layer, runner(data), logs.layer),
                ),
              ),
              logs.layer,
            ),
          ),
        )
        expect(store).toBe('file')
        const path = NodePath.join(data, SECRETS_FILE)
        const text = yield* Effect.promise(() => readFile(path, 'utf8'))
        expect(text).not.toContain(KEY)
        expect(text).not.toContain('anthropic')
        const info = yield* Effect.promise(() => stat(path))
        expect(info.mode & 0o777).toBe(0o600)
        const folder = yield* Effect.promise(() => stat(NodePath.dirname(path)))
        expect(folder.mode & 0o777).toBe(0o700)
        expect(
          logs.messages.some(message => message.includes('No keyring answers')),
        ).toBe(true)
        expect(logs.messages.join('\n')).not.toContain(KEY)
      }),
  )

  it.effect(
    'opens again with its passphrase, from a file only its user reads',
    () =>
      Effect.gen(function* () {
        const data = yield* tempFolder('secrets-reopen')
        const passphraseFile = NodePath.join(data, 'passphrase')
        yield* Effect.promise(() =>
          writeFile(passphraseFile, 'correct horse battery staple\n', {
            mode: 0o600,
          }),
        )
        const open = (config: SecretsConfig) =>
          Effect.provide(
            secretsLayer(config).pipe(
              Layer.provide(
                Layer.merge(
                  fakeKeyrings({ reachable: false }).layer,
                  runner(data),
                ),
              ),
            ),
          )
        yield* Effect.gen(function* () {
          yield* (yield* Secrets).set(
            anthropic,
            ApiKey.Key({ key: Redacted.make(KEY) }),
          )
        }).pipe(open(fileConfig(data)))
        const fromFile = PassphraseSource.File({ path: passphraseFile })
        const key = yield* Effect.gen(function* () {
          return yield* (yield* Secrets).get(anthropic)
        }).pipe(open(fileConfig(data, fromFile)))
        expect(Redacted.value(key)).toBe(KEY)

        const wrong = yield* Effect.flip(
          Effect.gen(function* () {
            yield* Secrets
          }).pipe(
            open(
              fileConfig(
                data,
                PassphraseSource.Given({ passphrase: Redacted.make('wrong') }),
              ),
            ),
          ),
        )
        expect(wrong._tag).toBe('PassphraseRefused')

        yield* Effect.promise(() => chmod(passphraseFile, 0o644))
        const readable = yield* Effect.flip(
          Effect.gen(function* () {
            yield* Secrets
          }).pipe(open(fileConfig(data, fromFile))),
        )
        expect(readable._tag).toBe('PassphraseRefused')
        expect(readable.message).toContain('mode 0600')

        const none = yield* Effect.flip(
          Effect.gen(function* () {
            yield* Secrets
          }).pipe(open({ ...fileConfig(data), passphrase: Option.none() })),
        )
        expect(none._tag).toBe('PassphraseNeeded')
      }),
  )
})

describe('the keyrings, through their CLIs', () => {
  const keyringCases = [
    { platform: 'darwin', store: 'keychain', command: 'security' },
    { platform: 'linux', store: 'libsecret', command: 'secret-tool' },
  ] as const

  for (const { platform, store, command } of keyringCases) {
    it.effect(`keep credentials in ${store}, never on a command line`, () =>
      Effect.gen(function* () {
        const data = yield* tempFolder(`secrets-${store}`)
        const keyrings = fakeKeyrings({ reachable: true })
        const logs = capturedLogs()
        const kept = yield* roundTrip.pipe(
          Effect.provide(
            Layer.merge(
              secretsLayer({
                platform,
                data,
                passphrase: Option.none(),
              }).pipe(
                Layer.provide(
                  Layer.mergeAll(keyrings.layer, runner(data), logs.layer),
                ),
              ),
              logs.layer,
            ),
          ),
        )
        expect(kept).toBe(store)
        expect(keyrings.calls.every(call => call.command === command)).toBe(
          true,
        )
        const encoded = Buffer.from(KEY).toString('base64')
        for (const call of keyrings.calls) {
          expect(call.args.join(' ')).not.toContain(KEY)
          expect(call.args.join(' ')).not.toContain(encoded)
        }
        const item = keyrings.items.get(`${store}/anthropic`) ?? ''
        expect(
          JSON.parse(Buffer.from(item, 'base64').toString('utf8')),
        ).toEqual({ _tag: 'Key', key: KEY })
        expect(logs.messages).toEqual([])
      }),
    )
  }

  it.effect('fall back to KWallet where libsecret is unreachable', () =>
    Effect.gen(function* () {
      const data = yield* tempFolder('secrets-kwallet')
      const keyrings = fakeKeyrings({ reachable: true })
      const kwalletOnly = Layer.succeed(
        KeyringCli,
        KeyringCli.of({
          call: call =>
            call.command === 'secret-tool'
              ? Effect.succeed(
                  KeyringOutcome.Failed({
                    reason: "secret-tool isn't on the PATH",
                  }),
                )
              : keyrings.call(call),
        }),
      )
      const kept = yield* roundTrip.pipe(
        Effect.provide(
          secretsLayer({
            platform: 'linux',
            data,
            passphrase: Option.none(),
          }).pipe(Layer.provide(Layer.merge(kwalletOnly, runner(data)))),
        ),
      )
      expect(kept).toBe('kwallet')
      // kwallet-query can't delete: the removed entry is left empty, and reads as missing.
      expect(keyrings.items.get('kwallet/openai.work')).toBe('')
      for (const call of keyrings.calls)
        expect(call.args.join(' ')).not.toContain(KEY)
    }),
  )

  it.effect(
    'are run with the secret on stdin, through the process runner',
    () =>
      Effect.gen(function* () {
        const data = yield* tempFolder('secrets-cli')
        const bin = NodePath.join(data, 'bin')
        const home = NodePath.join(data, 'home')
        yield* Effect.promise(async () => {
          await mkdir(bin)
          await mkdir(home)
          // secret-tool as its manual has it: `store` reads the secret from stdin, `lookup` prints it.
          await writeFile(
            NodePath.join(bin, 'secret-tool'),
            [
              '#!/bin/sh',
              'echo "$*" >> "$HOME/argv"',
              'case "$1" in',
              '  store) /bin/cat > "$HOME/item-$6" ;;',
              '  lookup) [ -f "$HOME/item-$5" ] || exit 1; /bin/cat "$HOME/item-$5" ;;',
              '  clear) /bin/rm -f "$HOME/item-$5" ;;',
              'esac',
              '',
            ].join('\n'),
            { mode: 0o755 },
          )
        })
        const kept = yield* roundTrip.pipe(
          Effect.provide(
            secretsLayerHost({
              platform: 'linux',
              data,
              passphrase: Option.none(),
            }).pipe(Layer.provide(runner(home, `${bin}:/usr/bin:/bin`))),
          ),
        )
        expect(kept).toBe('libsecret')
        const argv = yield* Effect.promise(() =>
          readFile(NodePath.join(home, 'argv'), 'utf8'),
        )
        expect(argv).toContain('store --label=Fabrica: anthropic')
        expect(argv).not.toContain(KEY)
        const item = yield* Effect.promise(() =>
          readFile(NodePath.join(home, 'item-anthropic'), 'utf8'),
        )
        expect(item).not.toContain(KEY)
        expect(
          JSON.parse(Buffer.from(item, 'base64').toString('utf8')),
        ).toEqual({ _tag: 'Key', key: KEY })
      }),
  )
})

describe('a key given as a command', () => {
  it.effect('is run when the key is needed, its output the key', () =>
    Effect.gen(function* () {
      const data = yield* tempFolder('secrets-command')
      const counter = NodePath.join(data, 'runs')
      const secrets = yield* Effect.provide(
        Effect.gen(function* () {
          return yield* Secrets
        }),
        secretsLayer(fileConfig(data)).pipe(
          Layer.provide(
            Layer.merge(fakeKeyrings({ reachable: false }).layer, runner(data)),
          ),
        ),
      )
      yield* secrets.set(
        anthropic,
        ApiKey.Command({
          command: `echo run >> ${counter}; printf '  ${KEY}\\n'`,
        }),
      )
      expect(Redacted.value(yield* secrets.get(anthropic))).toBe(KEY)
      expect(Redacted.value(yield* secrets.get(anthropic))).toBe(KEY)
      const runs = yield* Effect.promise(() => readFile(counter, 'utf8'))
      expect(runs).toBe('run\nrun\n')

      yield* secrets.set(
        anthropic,
        ApiKey.Command({ command: `echo ${KEY} >&2; exit 3` }),
      )
      const failed = yield* Effect.flip(secrets.get(anthropic))
      expect(failed._tag).toBe('KeyCommandFailed')
      expect(failed.message).toContain('exited with code 3')
      expect(failed.message).not.toContain(KEY)

      yield* secrets.set(anthropic, ApiKey.Command({ command: 'true' }))
      const empty = yield* Effect.flip(secrets.get(anthropic))
      expect(empty.message).toContain('printed no key')
    }),
  )
})
