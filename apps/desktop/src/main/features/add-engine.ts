import { Effect, Option, Schema } from 'effect'

import {
  type CheckAnswer,
  EngineHost,
  type InstallAnswer,
  InstallConsent,
  type UbuntuInstall,
  type WslSearch,
  checkedDistro,
  installedDistro,
} from '@fabrica/client'
import { findDistribution } from '@fabrica/client/node'

import { definedOf } from '../../connection/env'
import { channels } from '../../preload/api'
import type { MainContext } from '../context'
import { checkEngineOn, engineSource, installEngineOn } from '../engine-install'
import type { IpcRegistrar } from '../ipc'
import { installUbuntu } from '../wsl'

// Add engine and the update offer at connect (spec §9.2): a host checked for an engine and the app's
// installed or updated there as the user agreed; on Windows, the WSL2 distribution to run it in looked
// for, and Ubuntu installed in WSL (§7.6). An engine found or installed in WSL2 is the one the app
// reaches then.

/** What main does for Add engine. */
export interface AddEngineActions {
  /** Checks a host for an engine, and what installing the app's would do (§9.2). */
  readonly checkEngine: (host: EngineHost) => Promise<CheckAnswer>
  /** Installs or updates the engine on a host, as the user agreed. */
  readonly installEngine: (request: {
    readonly host: EngineHost
    readonly consent: InstallConsent
  }) => Promise<InstallAnswer>
  /** Looks for the WSL2 distribution to run the engine in (§7.6). */
  readonly findWsl: () => Promise<WslSearch>
  /** Installs Ubuntu in WSL, as the user agreed, and looks for the distribution again. */
  readonly installUbuntu: () => Promise<UbuntuInstall>
}

const decodeCheck = Schema.decodeUnknownOption(Schema.Tuple([EngineHost]))
const decodeInstall = Schema.decodeUnknownOption(
  Schema.Tuple([EngineHost, InstallConsent]),
)

/** Registers Add engine's channels on `ipc`, answered by `actions`. */
export const addEngineChannels = (
  ipc: IpcRegistrar,
  actions: AddEngineActions,
): void => {
  ipc.onInvoke(channels.findWsl, actions.findWsl)
  ipc.onInvoke(channels.installUbuntu, actions.installUbuntu)
  ipc.onRequest(channels.checkEngine, decodeCheck, ([host]) =>
    actions.checkEngine(host),
  )
  ipc.onRequest(channels.installEngine, decodeInstall, ([host, consent]) =>
    actions.installEngine({ host, consent }),
  )
}

/** Registers Add engine on `ipc`, with the app's engine source, the WSL2 runner and the broker. */
export const registerAddEngine = (
  ipc: IpcRegistrar,
  { app, version, wslRunner, reachWsl }: MainContext,
): void => {
  /**
   * The engine Add engine installs: a packaged app's own version, from its signed release folder where it
   * carries one, else from Fabrica's releases; a development build's, the latest release.
   */
  const installSource = () =>
    engineSource({
      resources: app.isPackaged
        ? Option.some(process.resourcesPath)
        : Option.none(),
      stage: app.getPath('temp'),
      release: app.isPackaged ? Option.some(version) : Option.none(),
    })

  addEngineChannels(ipc, {
    // A host checked, its engine found up to date in WSL2, is the engine the app reaches then.
    checkEngine: host =>
      Effect.runPromise(
        installSource().pipe(
          Effect.flatMap(source =>
            checkEngineOn({ host, source, env: definedOf(process.env) }),
          ),
          Effect.tap(answer =>
            Option.match(checkedDistro({ host, answer }), {
              onNone: () => Effect.void,
              onSome: reachWsl,
            }),
          ),
        ),
      ),
    // One installed in WSL2 is the engine the app reaches then.
    installEngine: request =>
      Effect.runPromise(
        installSource().pipe(
          Effect.flatMap(source =>
            installEngineOn({
              ...request,
              source,
              env: definedOf(process.env),
            }),
          ),
          Effect.tap(answer =>
            Option.match(installedDistro({ host: request.host, answer }), {
              onNone: () => Effect.void,
              onSome: reachWsl,
            }),
          ),
        ),
      ),
    findWsl: () => Effect.runPromise(findDistribution(wslRunner)),
    installUbuntu: () => Effect.runPromise(installUbuntu(wslRunner)),
  })
}
