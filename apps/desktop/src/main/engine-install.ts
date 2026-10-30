import { Effect, Layer, Option } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { access } from 'node:fs/promises'
import * as NodePath from 'node:path'

import {
  type CheckAnswer,
  EngineHost,
  type InstallAnswer,
  type InstallConsent,
} from '@fabrica/client'
import {
  DistributionSource,
  HostShell,
  type HostShellShape,
  type LoginServiceUse,
  answerCheck,
  answerInstall,
  checkHost,
  installEngine,
  localShell,
  sshShell,
  wslShell,
} from '@fabrica/client/install'
import {
  CHECKSUMS,
  RELEASES,
  RELEASE_KEYS,
  type ReleaseChoice,
  SIGNATURE,
} from '@fabrica/engine/update'

// Add engine and the update offer at connect, in main (spec §9.2, H22): the renderer asks main to check
// a host, this machine, one over SSH or a WSL2 distribution (§7.6), for an engine, and to install or
// update it there as the user agreed; main runs the install's own steps (`@fabrica/client/install`) on
// the host's shell. The engine
// comes from the release folder a packaged app carries where it is signed (the Windows app's, for WSL2),
// else from Fabrica's releases, downloaded under the app's temp folder where the host can't download it
// itself. Either way checksums.txt is verified with the release keys. ssh asks nothing (`BatchMode`)
// until its prompts are relayed to the app (fab-mgi.71).

/** The release folder a packaged app carries, as `engine-release/` in its resources (build/engine.ts). */
export const bundledRelease = (resources: string): string =>
  NodePath.join(resources, 'engine-release')

const exists = (path: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    access(path).then(
      () => true,
      () => false,
    ),
  )

/**
 * Where the engine comes from: the packaged app's release folder where it holds checksums.txt and its
 * signature, else `release` of Fabrica's releases, its downloads staged under `stage`.
 */
export const engineSource = Effect.fn('EngineInstall.source')(function* ({
  resources,
  stage,
  release,
}: {
  /** The packaged app's resources: none in a development build. */
  readonly resources: Option.Option<string>
  readonly stage: string
  readonly release: ReleaseChoice
}) {
  const folder = Option.map(resources, bundledRelease)
  const signed = yield* Option.match(folder, {
    onNone: () => Effect.succeed(false),
    onSome: found =>
      Effect.map(
        Effect.all(
          [
            exists(NodePath.join(found, CHECKSUMS)),
            exists(NodePath.join(found, SIGNATURE)),
          ],
          { concurrency: 'unbounded' },
        ),
        ([checksums, signature]) => checksums && signature,
      ),
  })
  return Option.match(
    Option.filter(folder, () => signed),
    {
      onSome: found =>
        DistributionSource.Folder({ folder: found, keys: RELEASE_KEYS }),
      onNone: () =>
        DistributionSource.Releases({
          releases: RELEASES,
          keys: RELEASE_KEYS,
          release,
          stage,
        }),
    },
  )
})

/** The shell the install runs on `host` with: ssh to its destination, wsl.exe into its distribution, or this machine's. */
export const hostShellOf = ({
  host,
  env,
}: {
  readonly host: EngineHost
  /** The user's environment: ssh's, for their agent and config, and the local commands'. */
  readonly env: Readonly<Record<string, string>>
}): HostShellShape =>
  EngineHost.match(host, {
    Local: () => localShell({ env }),
    Ssh: ({ destination }) => sshShell({ destination, env }),
    Wsl: ({ distro }) => wslShell({ distro, env }),
  })

/**
 * Whether the engine on `host` runs as a login service: always, but in a WSL2 distribution only where
 * its systemd runs, since the bridge starts the engine there otherwise (§7.6).
 */
export const loginServiceOn = (host: EngineHost): LoginServiceUse =>
  EngineHost.match(host, {
    Local: (): LoginServiceUse => 'always',
    Ssh: (): LoginServiceUse => 'always',
    Wsl: (): LoginServiceUse => 'where-systemd-runs',
  })

/** The install's shell on `host`, with Node's fetch for the releases. */
const onHost = (options: Parameters<typeof hostShellOf>[0]) =>
  Layer.merge(
    Layer.succeed(HostShell, hostShellOf(options)),
    FetchHttpClient.layer,
  )

/** Checks `host` for the engine `source` offers: what it is, the engine there, and the plan. */
export const checkEngineOn = ({
  host,
  source,
  env,
}: {
  readonly host: EngineHost
  readonly source: DistributionSource
  readonly env: Readonly<Record<string, string>>
}): Effect.Effect<CheckAnswer> =>
  answerCheck(checkHost(source)).pipe(Effect.provide(onHost({ host, env })))

/** Installs or updates the engine on `host` from `source`, as `consent` agreed, and starts its service. */
export const installEngineOn = ({
  host,
  consent,
  source,
  env,
}: {
  readonly host: EngineHost
  readonly consent: InstallConsent
  readonly source: DistributionSource
  readonly env: Readonly<Record<string, string>>
}): Effect.Effect<InstallAnswer> =>
  answerInstall(
    installEngine({ source, consent, loginService: loginServiceOn(host) }),
  ).pipe(Effect.provide(onHost({ host, env })))
