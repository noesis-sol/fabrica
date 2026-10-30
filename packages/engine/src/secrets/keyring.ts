import {
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Stream,
} from 'effect'

import {
  CommandOutcome,
  ExitStatus,
  ProcessRunner,
  StartFailure,
} from '../process'
import { SecretStoreFailed } from './errors'
import type { ItemStore, SecretStoreKind } from './values'

// The host's keyrings (spec §20.3), reached through their CLIs so the engine adds no native module
// (§22.4): the macOS Keychain through `security`, the Secret Service through `secret-tool`. KWallet
// is reached through the Secret Service, which it serves by default since KDE Frameworks 5.97:
// `kwallet-query` can't make a folder or an entry, and exits 0 from a write it dropped (KF 6.24).
// Every CLI runs through `KeyringCli`, the boundary a test stubs. A secret never goes on a command
// line, which `ps` shows anyone on the host: it is written to the CLI's stdin. Each item is kept in
// base64, so no CLI splits, trims or reprints it as hex. secret-tool's answers were run against
// GNOME Keyring 50 and KWallet 6.24 (libsecret 0.21.7).

/** A keyring CLI's run: its stdin is `input`, then closed, or /dev/null. */
export interface KeyringCall {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly input: Option.Option<Redacted.Redacted<string>>
}

/** How a keyring CLI's run ended. Its output can echo what it was given, so it is kept redacted. */
export type KeyringOutcome = Data.TaggedEnum<{
  Exited: {
    readonly code: number
    readonly stdout: Redacted.Redacted<string>
    readonly stderr: Redacted.Redacted<string>
  }
  /** It didn't start, was ended by a signal, timed out, or printed past its cap. */
  Failed: { readonly reason: string }
}>
export const KeyringOutcome = Data.taggedEnum<KeyringOutcome>()

export interface KeyringCliShape {
  readonly call: (call: KeyringCall) => Effect.Effect<KeyringOutcome>
}

/** The boundary every keyring CLI is run through. */
export class KeyringCli extends Context.Service<KeyringCli, KeyringCliShape>()(
  '@fabrica/engine/secrets/KeyringCli',
) {}

/** How long a keyring CLI may take: a keyring that asks its user to unlock it waits on them. */
const CALL_LIMIT = Duration.seconds(30)

/** What a keyring CLI may print: an item, or a list of a folder's entries. */
const OUTPUT_LIMIT = 1024 * 1024

const startFailure = (reason: StartFailure): string =>
  StartFailure.$match(reason, {
    NotOnPath: ({ command }) => `${command} isn't on the PATH`,
    SpawnFailed: ({ command, message }) =>
      `${command} couldn't start: ${message}`,
  })

const exited = (
  status: ExitStatus,
  stdout: string,
  stderr: string,
): KeyringOutcome =>
  ExitStatus.$match(status, {
    Code: ({ code }) =>
      KeyringOutcome.Exited({
        code,
        stdout: Redacted.make(stdout),
        stderr: Redacted.make(stderr),
      }),
    Signal: ({ signal }) =>
      KeyringOutcome.Failed({ reason: `it was ended by ${signal}` }),
  })

const collectText = (stream: Stream.Stream<Uint8Array>) =>
  Effect.map(Stream.runCollect(stream), chunks =>
    Buffer.concat(chunks).toString('utf8'),
  )

/** The keyring CLIs run by the engine's process runner, in `cwd`. */
export const makeKeyringCli = Effect.fn('KeyringCli.make')(function* (
  cwd: string,
) {
  const runner = yield* ProcessRunner
  const withoutInput = (call: KeyringCall) =>
    Effect.map(
      runner.run({
        command: call.command,
        args: call.args,
        cwd,
        timeLimit: CALL_LIMIT,
        outputLimit: OUTPUT_LIMIT,
      }),
      CommandOutcome.$match({
        Exited: ({ status, stdout, stderr }) => exited(status, stdout, stderr),
        TimedOut: () => KeyringOutcome.Failed({ reason: 'it timed out' }),
        Cut: () =>
          KeyringOutcome.Failed({ reason: 'it printed more than it may' }),
        FailedToStart: ({ reason }) =>
          KeyringOutcome.Failed({ reason: startFailure(reason) }),
      }),
    )
  const withInput = (call: KeyringCall, input: Redacted.Redacted<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const running = yield* runner.start({
          command: call.command,
          args: call.args,
          cwd,
          stdin: 'pipe',
        })
        // A CLI that exits before reading its stdin closes the pipe: its exit status says why.
        const fed = running
          .write(Redacted.value(input))
          .pipe(Effect.andThen(running.closeStdin), Effect.ignore)
        const [stdout, stderr, status] = yield* Effect.all(
          [
            collectText(running.stdout),
            collectText(running.stderr),
            Effect.andThen(fed, running.exit),
          ],
          { concurrency: 'unbounded' },
        )
        return exited(status, stdout, stderr)
      }),
    ).pipe(
      Effect.timeoutOption(CALL_LIMIT),
      Effect.map(
        Option.getOrElse(() =>
          KeyringOutcome.Failed({ reason: 'it timed out' }),
        ),
      ),
      Effect.catchTag('StartFailed', ({ reason }) =>
        Effect.succeed(KeyringOutcome.Failed({ reason: startFailure(reason) })),
      ),
    )
  const call = Effect.fn('KeyringCli.call')(function* (call: KeyringCall) {
    return yield* Option.match(call.input, {
      onNone: () => withoutInput(call),
      onSome: input => withInput(call, input),
    })
  })
  return KeyringCli.of({ call })
})

/** The keyring CLIs run by the engine's process runner, in `cwd` (the data folder). */
export const layerKeyringCli = (
  cwd: string,
): Layer.Layer<KeyringCli, never, ProcessRunner> =>
  Layer.effect(KeyringCli, makeKeyringCli(cwd))

/** A keyring's item store, and whether the keyring answers on this host. */
export interface Keyring {
  readonly store: ItemStore
  readonly probe: Effect.Effect<boolean>
}

/** The service, collection or folder the engine's items are kept under, in every keyring. */
export const KEYRING_SERVICE = 'fabrica'

const toBase64 = (
  value: Redacted.Redacted<string>,
): Redacted.Redacted<string> =>
  Redacted.make(Buffer.from(Redacted.value(value), 'utf8').toString('base64'))

const fromBase64 = (
  printed: Redacted.Redacted<string>,
): Redacted.Redacted<string> =>
  Redacted.make(
    Buffer.from(Redacted.value(printed).trim(), 'base64').toString('utf8'),
  )

const isBlank = (printed: Redacted.Redacted<string>): boolean =>
  Redacted.value(printed).trim() === ''

/** A run of a keyring CLI for one operation: its exit code and output, or its failure as the store's. */
const runFor =
  (cli: KeyringCliShape, store: SecretStoreKind) =>
  (operation: string, call: KeyringCall) =>
    Effect.flatMap(
      cli.call(call),
      KeyringOutcome.$match({
        Exited: answer => Effect.succeed(answer),
        Failed: ({ reason }) =>
          Effect.fail(new SecretStoreFailed({ store, operation, reason })),
      }),
    )

const failedWith = (store: SecretStoreKind, operation: string, code: number) =>
  new SecretStoreFailed({
    store,
    operation,
    reason: `its CLI exited with code ${code}`,
  })

/** `security`'s code for an item that isn't in the keychain (errSecItemNotFound). */
const SECURITY_NOT_FOUND = 44

/**
 * `security`'s code for a locked keychain it may not ask to unlock, as over SSH
 * (errSecInteractionNotAllowed: `security` exits with an error's low byte, as 44 is -25300's).
 */
const SECURITY_INTERACTION_NOT_ALLOWED = 36

const keychainFailed = (operation: string, code: number) =>
  code === SECURITY_INTERACTION_NOT_ALLOWED
    ? new SecretStoreFailed({
        store: 'keychain',
        operation,
        reason:
          "the keychain is locked, and can't ask to be unlocked here (over SSH, run security unlock-keychain first)",
      })
    : failedWith('keychain', operation, code)

/**
 * `security -i` reads its commands a line at a time, into a buffer that cuts a longer line: a line
 * of 4,060 bytes was taken whole, one of 5,400 cut and refused (macOS 26).
 */
const SECURITY_LINE_LIMIT = 4000

/** The macOS Keychain, through `security`: a generic password per item, the service `fabrica`, the account the item's name. */
export const keychain = (cli: KeyringCliShape): Keyring => {
  const run = runFor(cli, 'keychain')
  const item = (operation: string, name: string, extra: Array<string> = []) =>
    run(operation, {
      command: 'security',
      args: [operation, '-s', KEYRING_SERVICE, '-a', name, ...extra],
      input: Option.none(),
    })
  const read = Effect.fn('Keychain.read')(function* (name: string) {
    const { code, stdout } = yield* item('find-generic-password', name, ['-w'])
    if (code === SECURITY_NOT_FOUND) return Option.none()
    if (code !== 0) return yield* keychainFailed('read an item', code)
    return Option.some(fromBase64(stdout))
  })
  const write = Effect.fn('Keychain.write')(function* (
    name: string,
    value: Redacted.Redacted<string>,
  ) {
    // Names and base64 hold no space or quote, so `security -i` splits the line as written.
    const line = `add-generic-password -U -s ${KEYRING_SERVICE} -a ${name} -w ${Redacted.value(toBase64(value))}\n`
    if (Buffer.byteLength(line) > SECURITY_LINE_LIMIT)
      return yield* new SecretStoreFailed({
        store: 'keychain',
        operation: 'write an item',
        reason: `the credential is longer than the security command takes (${SECURITY_LINE_LIMIT} bytes in all)`,
      })
    const { code } = yield* run('write an item', {
      command: 'security',
      args: ['-i'],
      input: Option.some(Redacted.make(line)),
    })
    if (code !== 0) return yield* keychainFailed('write an item', code)
  })
  const remove = Effect.fn('Keychain.remove')(function* (name: string) {
    const { code } = yield* item('delete-generic-password', name)
    if (code !== 0 && code !== SECURITY_NOT_FOUND)
      return yield* keychainFailed('remove an item', code)
  })
  return {
    store: { kind: 'keychain', read, write, remove },
    probe: Effect.isSuccess(read('.probe')),
  }
}

/**
 * What `secret-tool store` keeps of its stdin: it reads 8,192 bytes at most, and cuts a longer secret
 * to that, saying so on stderr but exiting 0 (libsecret 0.21.7); 8,191 is the longest kept whole.
 */
const SECRET_TOOL_INPUT_LIMIT = 8191

/** libsecret (GNOME Keyring, KWallet, KeePassXC: any Secret Service), through `secret-tool`: attributes `service fabrica`, `account <item>`. */
export const libsecret = (cli: KeyringCliShape): Keyring => {
  const run = runFor(cli, 'libsecret')
  const attributes = (name: string) => [
    'service',
    KEYRING_SERVICE,
    'account',
    name,
  ]
  /**
   * Fails where `lookup` or `clear`, exiting 1 saying nothing, didn't find the item missing: they say
   * the same of an item in a locked collection they couldn't unlock (no one answered the prompt, or
   * none can be shown), which `search` still lists, without its secret and without a prompt.
   */
  const confirmMissing = Effect.fn('Libsecret.confirmMissing')(function* (
    operation: string,
    name: string,
  ) {
    const { code, stdout } = yield* run(operation, {
      command: 'secret-tool',
      args: ['search', ...attributes(name)],
      input: Option.none(),
    })
    if (code !== 0) return yield* failedWith('libsecret', operation, code)
    if (!isBlank(stdout))
      return yield* new SecretStoreFailed({
        store: 'libsecret',
        operation,
        reason: 'its keyring is locked: unlock it, and try again',
      })
  })
  const read = Effect.fn('Libsecret.read')(function* (name: string) {
    const { code, stdout, stderr } = yield* run('read an item', {
      command: 'secret-tool',
      args: ['lookup', ...attributes(name)],
      input: Option.none(),
    })
    // `lookup` exits 1 saying nothing for an item it can't give, and 1 with a message when the
    // Secret Service can't be reached (no D-Bus session, no keyring daemon).
    if (code === 1 && isBlank(stderr)) {
      yield* confirmMissing('read an item', name)
      return Option.none()
    }
    if (code !== 0) return yield* failedWith('libsecret', 'read an item', code)
    return Option.some(fromBase64(stdout))
  })
  const write = Effect.fn('Libsecret.write')(function* (
    name: string,
    value: Redacted.Redacted<string>,
  ) {
    const encoded = toBase64(value)
    if (Redacted.value(encoded).length > SECRET_TOOL_INPUT_LIMIT)
      return yield* new SecretStoreFailed({
        store: 'libsecret',
        operation: 'write an item',
        reason: `the credential is longer than secret-tool keeps whole (${SECRET_TOOL_INPUT_LIMIT} bytes in base64)`,
      })
    const { code } = yield* run('write an item', {
      command: 'secret-tool',
      args: ['store', `--label=Fabrica: ${name}`, ...attributes(name)],
      input: Option.some(encoded),
    })
    if (code !== 0) return yield* failedWith('libsecret', 'write an item', code)
  })
  const remove = Effect.fn('Libsecret.remove')(function* (name: string) {
    const { code, stderr } = yield* run('remove an item', {
      command: 'secret-tool',
      args: ['clear', ...attributes(name)],
      input: Option.none(),
    })
    if (code === 1 && isBlank(stderr))
      return yield* confirmMissing('remove an item', name)
    if (code !== 0)
      return yield* failedWith('libsecret', 'remove an item', code)
  })
  return {
    store: { kind: 'libsecret', read, write, remove },
    probe: Effect.isSuccess(read('.probe')),
  }
}
