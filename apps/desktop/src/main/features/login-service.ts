import { Effect } from 'effect'

import { ServiceInstall } from '@fabrica/ui/host'

import { channels } from '../../preload/api'
import type { MainContext } from '../context'
import type { IpcRegistrar } from '../ipc'
import { installLoginService } from '../local-engine'

// The local engine's login service (spec §7.1), installed as the user chose, from the distribution the
// app bundles.

/** What main does for the login service. */
export interface LoginServiceActions {
  /** Installs the local engine's login service, from the bundled distribution (spec §7.1). */
  readonly installLoginService: () => Promise<ServiceInstall>
}

/** Registers the login service's channel on `ipc`, answered by `actions`. */
export const loginServiceChannels = (
  ipc: IpcRegistrar,
  actions: LoginServiceActions,
): void =>
  ipc.onInvoke(channels.installLoginService, actions.installLoginService)

/** Registers the login service's install on `ipc`, from the app's local engine. */
export const registerLoginService = (
  ipc: IpcRegistrar,
  { localEngine }: MainContext,
): void =>
  loginServiceChannels(ipc, {
    installLoginService: () =>
      Effect.runPromise(
        installLoginService(localEngine).pipe(
          Effect.as(ServiceInstall.cases.Installed.make({})),
          Effect.catch(error =>
            Effect.succeed(
              ServiceInstall.cases.Failed.make({ reason: error.reason }),
            ),
          ),
        ),
      ),
  })
