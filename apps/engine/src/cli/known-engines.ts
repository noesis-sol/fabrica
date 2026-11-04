import { Context, Data, Duration, Effect, Option, Schema } from 'effect'
import { mkdir } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { SshDestination, TlsEndpoint, WslDistro } from '@fabrica/client'
import { CertificateFingerprint, type Host } from '@fabrica/contracts'
import { Daemon } from '@fabrica/engine'
import { readFileText, writeFileWhole } from '@fabrica/engine/files'

import { hostConfigFolder, hostFacts } from '../host'

// The engines the CLI knows by name (spec §19, §9.1): its own, kept with `fabrica engine add|list|remove`
// so a host with no app knows some too; their names may differ from the app's, which keeps its own. They
// are one file in the user's config folder, `engines.json`, written whole through the engine's writer,
// so a crash leaves the old list or the new one, and each change holds `engines.lock` from its read to
// its write, so commands run side by side lose none of each other's. It holds the pairing tokens of those reached over TLS,
// so it is mode 0600, like a key under `~/.ssh`: there is no app's safeStorage here, and a host with no
// keyring has to work too.

/** The name `--engine` gives the local engine. */
export const localEngineName = 'local'

/**
 * A known engine's name: one word that `--engine` reads as no flag, and neither the local engine's name
 * nor a URI like the SSH destinations `--engine` takes as they are.
 */
export const KnownEngineName = Schema.String.check(
  Schema.isPattern(/^(?!-|.*:\/\/)[^\s\p{Cc}]+$/u),
  Schema.makeFilter(name => name !== localEngineName, {
    expected: `a name other than ${localEngineName}, which is the local engine's`,
  }),
)
export type KnownEngineName = typeof KnownEngineName.Type

/** How a known engine is reached. Only the file holds an engine's token: nothing prints this whole. */
export const EngineReach = Schema.TaggedUnion({
  /** Through the SSH stdio bridge: `user@host`, a host of `~/.ssh/config`, or `ssh://[user@]host[:port]`. */
  Ssh: { destination: SshDestination },
  /** Through the bridge in a WSL2 distribution, by `wsl.exe`. */
  Wsl: { distro: WslDistro },
  /** WebSocket over TLS, its certificate trusted by the fingerprint accepted as it was added. */
  Tls: {
    ...TlsEndpoint.fields,
    fingerprint: CertificateFingerprint,
    token: Schema.RedactedFromValue(Schema.NonEmptyString),
  },
})
export type EngineReach = typeof EngineReach.Type

/** An engine the CLI knows. */
export const KnownEngine = Schema.Struct({
  name: KnownEngineName,
  reach: EngineReach,
})
export type KnownEngine = typeof KnownEngine.Type

const EnginesFile = Schema.Struct({
  version: Schema.Literal(1),
  engines: Schema.Array(KnownEngine),
})
type EnginesFile = typeof EnginesFile.Type

const EnginesJson = Schema.fromJsonString(EnginesFile)
const decodeEngines = Schema.decodeUnknownEffect(EnginesJson)
const encodeEngines = Schema.encodeEffect(EnginesJson)

/** The file's name in the user's config folder. */
const enginesFileName = 'engines.json'

/** The file changes hold, in the same folder. */
const enginesLockName = 'engines.lock'

/** How long a change waits for another `fabrica`'s to end. */
const enginesLockWait = Duration.seconds(10)

/** The most the file may hold. */
const enginesFileMaxBytes = 1024 * 1024

/** Where the file is kept: the user's config folder on this host; a test gives its own. */
export const KnownEnginesFolder = Context.Reference<{
  readonly folder: Effect.Effect<string, Daemon.UnsupportedPlatform, Host>
}>('@fabrica/engine-app/KnownEnginesFolder', {
  defaultValue: () => ({
    folder: Effect.flatMap(hostFacts, hostConfigFolder),
  }),
})

/** The file couldn't be read or written, or isn't one this fabrica reads. */
export class KnownEnginesFailed extends Data.TaggedError('KnownEnginesFailed')<{
  readonly operation: 'read' | 'write'
  readonly folder: string
  readonly reason: string
}> {
  override get message() {
    return `couldn't ${this.operation} ${enginesFileName} in ${this.folder}: ${this.reason}`
  }
}

/** An engine of that name is known already. */
export class KnownEngineExists extends Data.TaggedError('KnownEngineExists')<{
  readonly name: KnownEngineName
}> {
  override get message() {
    return `an engine named ${this.name} is known already: remove it first, with \`fabrica engine remove ${this.name}\``
  }
}

/** No engine of that name is known. */
export class KnownEngineMissing extends Data.TaggedError('KnownEngineMissing')<{
  readonly name: KnownEngineName
}> {
  override get message() {
    return `no engine named ${this.name} is known: \`fabrica engine list\` says which are`
  }
}

/** What's wrong with a file that isn't one this fabrica reads: its text is left out, for its tokens. */
const notReadable = "it isn't a list of known engines this fabrica reads"

/** The engines in the file in `folder`; none where it isn't there yet. */
const readEngines = (folder: string) =>
  readFileText(
    { root: folder, path: enginesFileName },
    { maxBytes: enginesFileMaxBytes },
  ).pipe(
    Effect.flatMap(text =>
      decodeEngines(text).pipe(
        Effect.mapError(() => ({ message: notReadable })),
      ),
    ),
    Effect.map(({ engines }): ReadonlyArray<KnownEngine> => engines),
    Effect.catchTag('FileMissing', () =>
      Effect.succeed<ReadonlyArray<KnownEngine>>([]),
    ),
    Effect.mapError(
      failure =>
        new KnownEnginesFailed({
          operation: 'read',
          folder,
          reason: failure.message,
        }),
    ),
    Effect.withSpan('KnownEngines.read'),
  )

/** Writes `engines` as the file in `folder`. */
const writeEngines = (folder: string, engines: ReadonlyArray<KnownEngine>) =>
  encodeEngines({ version: 1, engines }).pipe(
    Effect.mapError(() => ({ message: notReadable })),
    Effect.flatMap(text =>
      writeFileWhole({ root: folder, path: enginesFileName }, text, {
        mode: 0o600,
      }),
    ),
    Effect.withSpan('KnownEngines.write'),
  )

/**
 * Changes the list in the file with `change`, one `fabrica` at a time, so one run beside this loses
 * nothing of its change or of this one. The folder is made, for its user alone, where it isn't there.
 */
const changeEngines = <E>(
  change: (
    engines: ReadonlyArray<KnownEngine>,
  ) => Effect.Effect<ReadonlyArray<KnownEngine>, E>,
) =>
  Effect.gen(function* () {
    const { folder: found } = yield* KnownEnginesFolder
    const folder = yield* found
    const failed = (failure: { readonly message: string }) =>
      new KnownEnginesFailed({
        operation: 'write',
        folder,
        reason: failure.message,
      })
    yield* Effect.tryPromise(() =>
      mkdir(folder, { recursive: true, mode: 0o700 }),
    ).pipe(Effect.mapError(failed))
    yield* Daemon.acquireFileLock({
      file: NodePath.join(folder, enginesLockName),
      wait: enginesLockWait,
    }).pipe(Effect.mapError(failed))
    const changed = yield* change(yield* readEngines(folder))
    yield* writeEngines(folder, changed).pipe(Effect.mapError(failed))
  }).pipe(Effect.scoped)

/** The known engines, in the order they were added. */
export const knownEngines = Effect.gen(function* () {
  const { folder } = yield* KnownEnginesFolder
  return yield* readEngines(yield* folder)
})

/** The known engine named `name`, if any. */
export const findKnownEngine = (name: string) =>
  Effect.map(knownEngines, engines =>
    Option.fromUndefinedOr(engines.find(engine => engine.name === name)),
  )

/** Keeps `engine` among the known engines, unless one of its name is known already. */
export const addKnownEngine = Effect.fn('KnownEngines.add')(function* (
  engine: KnownEngine,
) {
  yield* changeEngines(engines =>
    engines.some(known => known.name === engine.name)
      ? Effect.fail(new KnownEngineExists({ name: engine.name }))
      : Effect.succeed([...engines, engine]),
  )
})

/** Forgets the known engine named `name`, and its token. */
export const removeKnownEngine = Effect.fn('KnownEngines.remove')(function* (
  name: KnownEngineName,
) {
  yield* changeEngines(engines =>
    engines.some(known => known.name === name)
      ? Effect.succeed(engines.filter(known => known.name !== name))
      : Effect.fail(new KnownEngineMissing({ name })),
  )
})
